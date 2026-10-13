import { randomUUID } from 'node:crypto';
import { parsePairingLink } from '@escritoriio/runner-protocol';

const MAX_LINK_CHARS = 2_048;
export const PAIR_SCHEME = 'escritoriio';
const SCHEME_PREFIX = /^escritoriio:\/\//i;

export type DeepLink = { readonly ok: true; readonly server: string; readonly code: string } | { readonly ok: false; readonly reason: string };

/**
 * What a link the system handed to the app says. There is one link, `escritoriio://pair?server=…&code=…`, and the two fields it has: anything
 * else (another action, a path, a field more, a field twice) is ignored, and so is a server or a code the protocol's own readers refuse. A link
 * is something anybody can send or a page can open, so what comes out is only what to ask the owner about. The reason never holds the code.
 */
export function parseDeepLink(raw: string): DeepLink {
  if (raw.length > MAX_LINK_CHARS) return { ok: false, reason: 'the link is too long' };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'it is not a link' };
  }
  if (url.protocol !== 'escritoriio:' || url.hostname !== 'pair') return { ok: false, reason: 'it is not a pairing link' };
  if (url.pathname !== '' && url.pathname !== '/') return { ok: false, reason: 'the link has a path it should not have' };
  const names = [...url.searchParams.keys()].sort();
  if (names.length !== 2 || names[0] !== 'code' || names[1] !== 'server') return { ok: false, reason: 'the link does not have exactly a server and a code' };
  const link = parsePairingLink(raw);
  return link ? { ok: true, ...link } : { ok: false, reason: 'the server or the code in the link is not one the runner pairs with' };
}

/** The link among the arguments a second instance, or a first start on Windows and Linux, was given. */
export const linkFromArgv = (argv: readonly string[]): string | undefined => argv.find((argument) => SCHEME_PREFIX.test(argument));

/**
 * What `setAsDefaultProtocolClient` is given. Windows starts the app with the arguments registered and then the link, and `--` ends the switches, so that a
 * link that looks like one is not read as one by Chromium; the other systems take neither a path nor arguments.
 */
export function protocolRegistration(platform: NodeJS.Platform, executable: string): [scheme: string, path?: string, args?: string[]] {
  return platform === 'win32' ? [PAIR_SCHEME, executable, ['--']] : [PAIR_SCHEME];
}

/** What the window is told of a link that waits: which one, and the address it is for, and never the code. */
export interface PendingLinkView {
  readonly linkId: string;
  readonly host: string;
}

/**
 * The link that was opened and has not been used. The code stays here, in the main process; the window knows an id, asks to go on with it, and the
 * main process is the one that pairs, after the owner has read the office's own words in a dialog. Only the latest link waits: an older one is dropped.
 */
export class PendingLink {
  private held: { readonly linkId: string; readonly server: string; readonly code: string } | undefined;

  hold(link: { readonly server: string; readonly code: string }): PendingLinkView {
    this.held = { linkId: randomUUID(), ...link };
    return this.view(this.held);
  }

  current(): PendingLinkView | null {
    return this.held ? this.view(this.held) : null;
  }

  /** The link, for the id it was told by, which stays waiting: it is used up only when the pairing is made. */
  peek(linkId: string): { readonly server: string; readonly code: string } | undefined {
    return this.held && this.held.linkId === linkId ? { server: this.held.server, code: this.held.code } : undefined;
  }

  /** Gives the link and forgets it, for the id it was told by. */
  take(linkId: string): { readonly server: string; readonly code: string } | undefined {
    if (!this.held || this.held.linkId !== linkId) return undefined;
    const { server, code } = this.held;
    this.held = undefined;
    return { server, code };
  }

  private view({ linkId, server }: { readonly linkId: string; readonly server: string }): PendingLinkView {
    return { linkId, host: new URL(server).host };
  }
}
