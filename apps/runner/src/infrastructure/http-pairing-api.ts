import { normalizeServerAddress, pairingPreviewSchema, pairResponseSchema, RUNNER_PAIR_PATHS, runnerApiErrorSchema } from '@escritoriio/runner-protocol';
import type { ZodType } from 'zod';
import type { PairingApi } from '../application/ports.ts';
import { serverHost } from '../domain/paired-device.ts';
import { plainText } from '../domain/plain-text.ts';
import { describeNetworkError } from './network-error.ts';

const REQUEST_TIMEOUT_MS = 15_000;

export interface HttpPairingOptions {
  readonly timeoutMs?: number;
}

/**
 * The two pairing calls over HTTP. What it sends goes only to the origin of the address the person gave (https, or http for this
 * machine), and a redirect is not followed: the code, and in the answer the token, are for that host and no other.
 */
export function createHttpPairingApi({ timeoutMs = REQUEST_TIMEOUT_MS }: HttpPairingOptions = {}): PairingApi {
  async function call<T>(server: string, path: string, body: object, schema: ZodType<T>): Promise<T> {
    const origin = normalizeServerAddress(server);
    if (!origin) throw new Error(`"${server}" is not an address the runner can pair with: it must be https, or http for localhost`);
    const host = serverHost(origin);

    let status: number;
    let text: string;
    try {
      const response = await fetch(new URL(path, origin), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') throw new Error(`${host} did not answer in time`, { cause: error });
      throw new Error(`Could not reach ${host} (${describeNetworkError(error)})`, { cause: error });
    }

    if (status >= 300 && status < 400) throw new Error(`${host} answered with a redirect, which the runner does not follow. Use the address it redirects to`);
    const json = parseJson(text);
    if (status < 200 || status >= 300) {
      const refusal = runnerApiErrorSchema.safeParse(json);
      throw new Error((refusal.success && plainText(refusal.data.error)) || `${host} answered with HTTP ${status}`);
    }
    const answer = schema.safeParse(json);
    if (!answer.success) throw new Error(`${host} answered with something the runner does not understand. Is it an office, and is the runner up to date?`);
    return answer.data;
  }

  return {
    preview: (server, code) => call(server, RUNNER_PAIR_PATHS.preview, { code }, pairingPreviewSchema),
    pair: (server, request) => call(server, RUNNER_PAIR_PATHS.pair, request, pairResponseSchema),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
