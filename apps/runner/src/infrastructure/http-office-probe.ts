import { normalizeServerAddress, officeReachSchema, RUNNER_REACH_PATH } from '@escritoriio/runner-protocol';
import type { OfficeProbe } from '../application/ports.ts';
import { describeNetworkError } from './network-error.ts';

const REQUEST_TIMEOUT_MS = 10_000;

export interface HttpOfficeProbeOptions {
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/**
 * A plain GET of the office's health, to the origin the machine was paired with and nowhere else, with no token and no redirect followed.
 * It is how the office is asked whether it is there and what time it is, since opening the runner's socket would be taken for a second
 * connection of the device and would replace the first.
 */
export function createHttpOfficeProbe({ timeoutMs = REQUEST_TIMEOUT_MS, now = Date.now }: HttpOfficeProbeOptions = {}): OfficeProbe {
  return {
    async reach(server) {
      const origin = normalizeServerAddress(server);
      if (!origin) return { reached: false, reason: 'that is not an address the runner can reach' };
      const sentAt = now();
      try {
        const response = await fetch(new URL(RUNNER_REACH_PATH, origin), { headers: { Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
        const receivedAt = now();
        const text = await response.text();
        let minimum: string | undefined;
        try {
          const parsed = officeReachSchema.safeParse(JSON.parse(text));
          minimum = parsed.success ? parsed.data.minRunnerVersion : undefined;
        } catch {
          // Not JSON: an office that answers with something else says no minimum, and is still there.
        }
        return { reached: true, status: response.status, date: response.headers.get('date'), sentAt, receivedAt, minRunnerVersion: minimum };
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') return { reached: false, reason: 'it did not answer in time' };
        return { reached: false, reason: describeNetworkError(error) };
      }
    },
  };
}
