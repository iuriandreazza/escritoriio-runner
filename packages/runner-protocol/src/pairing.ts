import { z } from 'zod';
import { RUNNER_LIMITS, RUNNER_SOCKET_PATH } from './protocol.ts';
import { oneLine } from './text.ts';

/** How long a pairing code may be used after it was made. */
export const PAIRING_CODE_TTL_MS = 10 * 60_000;

/** Thirty-two characters, so that a random byte maps onto one with no bias; the ones that look alike (0 O 1 I) are left out, as the code is read off a screen and typed. */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 8;

/** The code as it is compared and stored: upper case, with the spaces and dashes of how it was shown or typed taken out. Undefined for anything that cannot be one. */
export function normalizePairingCode(input: string): string | undefined {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== PAIRING_CODE_LENGTH) return undefined;
  return [...code].every((character) => PAIRING_CODE_ALPHABET.includes(character)) ? code : undefined;
}

/** The code as it is shown: two groups of four. */
export const formatPairingCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The origin of a server as a person writes it: with or without the scheme (https is assumed, except for this machine), with a stray path or a slash at the
 * end. A token travels to it, so only https is accepted, and plain http only for this machine, where a server is being developed.
 */
export function normalizeServerAddress(input: string): string | undefined {
  const text = input.trim();
  if (text === '') return undefined;
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
    const url = new URL(hasScheme ? text : `https://${text}`);
    // Somebody who types `localhost:8201` means the server they are developing, which has no certificate to speak https with.
    if (!hasScheme && LOOPBACK_HOSTS.has(url.hostname)) url.protocol = 'http:';
    if (url.username !== '' || url.password !== '') return undefined;
    if (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) return url.origin;
    return undefined;
  } catch {
    return undefined;
  }
}

/** The address of the runner socket of a server, from its origin. */
export const runnerSocketAddress = (serverOrigin: string): string => {
  const url = new URL(RUNNER_SOCKET_PATH, serverOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};

const PAIR_LINK_SCHEME = 'escritoriio:';

/** The link a member opens to pair the machine they are on: it carries the server and the code, and nothing else. */
export function pairingLink(serverOrigin: string, code: string): string {
  const query = new URLSearchParams({ server: serverOrigin, code });
  return `${PAIR_LINK_SCHEME}//pair?${query.toString()}`;
}

/** What a pairing link says, or undefined for anything that is not one. What it says is only what to ask the person about: nothing in it is trusted. */
export function parsePairingLink(link: string): { readonly server: string; readonly code: string } | undefined {
  try {
    const url = new URL(link.trim());
    if (url.protocol !== PAIR_LINK_SCHEME || url.hostname !== 'pair') return undefined;
    const server = normalizeServerAddress(url.searchParams.get('server') ?? '');
    const code = normalizePairingCode(url.searchParams.get('code') ?? '');
    return server && code ? { server, code } : undefined;
  } catch {
    return undefined;
  }
}

const codeField = z.string().min(1).max(32);
// What a machine calls itself is shown to its owner and to admins, and later read by a model: one clean line, whatever the machine sent.
const nameField = oneLine(RUNNER_LIMITS.deviceName);

/** What a machine asks before it pairs: who is it being paired with. The code is not used up. */
export const pairingPreviewRequestSchema = z.object({ code: codeField });
export type PairingPreviewRequest = z.infer<typeof pairingPreviewRequestSchema>;

export const pairingPreviewSchema = z.object({ agentName: z.string(), workspaceName: z.string() });
export type PairingPreview = z.infer<typeof pairingPreviewSchema>;

/** What a machine says to turn a code into a device: the code is used up. */
export const pairRequestSchema = z.object({
  code: codeField,
  deviceName: nameField,
  os: oneLine(RUNNER_LIMITS.os),
  runnerVersion: oneLine(RUNNER_LIMITS.runnerVersion),
});
export type PairRequest = z.infer<typeof pairRequestSchema>;

/** The device the server made. The token is shown this once and never again: the server keeps only its hash. */
export const pairResponseSchema = z.object({
  deviceId: z.string(),
  token: z.string(),
  deviceName: z.string(),
  agentName: z.string(),
  workspaceName: z.string(),
});
export type PairResponse = z.infer<typeof pairResponseSchema>;

/** The body of a refusal. */
export const runnerApiErrorSchema = z.object({ error: z.string() });
