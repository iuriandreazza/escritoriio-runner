import { normalizePairingCode, normalizeServerAddress, parsePairingLink } from '@escritoriio/runner-protocol';

export type PairInput = { readonly ok: true; readonly server: string; readonly code: string } | { readonly ok: false; readonly error: string };

const HOW = 'Give a pairing link, or a server and a code: escritoriio-runner pair <server> <code>';

/**
 * What the person typed after `pair`: the link the office shows (`escritoriio://pair?...`), or the address of the server and the code,
 * the code being allowed to come in the groups it is shown in. What comes out is what is asked about, and nothing in it is trusted.
 */
export function parsePairInput(args: readonly string[]): PairInput {
  const [first, ...rest] = args;
  if (first === undefined) return { ok: false, error: HOW };

  if (rest.length === 0) {
    const link = parsePairingLink(first);
    return link ? { ok: true, ...link } : { ok: false, error: `That is not a pairing link. ${HOW}` };
  }

  const server = normalizeServerAddress(first);
  if (!server) return { ok: false, error: `"${first}" is not an address the runner can pair with: it must be https, or http for localhost. ${HOW}` };
  const code = normalizePairingCode(rest.join(''));
  if (!code) return { ok: false, error: 'That is not a pairing code: it has eight letters and digits, as the office shows it.' };
  return { ok: true, server, code };
}
