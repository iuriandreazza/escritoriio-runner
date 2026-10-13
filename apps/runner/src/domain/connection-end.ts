import { RUNNER_CLOSE } from '@escritoriio/runner-protocol';
import { plainText } from './plain-text.ts';

/** How the connection to the office came to an end, whatever the library under it calls it. */
export type ConnectionEnd =
  /** It was open, or was being opened, and the office closed it with this code. The words the office gives with a close are not kept: they are never shown. */
  | { readonly kind: 'closed'; readonly code: number }
  /** The office answered the request to open it with an HTTP status instead of opening it. */
  | { readonly kind: 'refused'; readonly status: number }
  /** There was nobody to answer, or the connection was lost without a close. The reason is the network's, a code such as ECONNREFUSED, and not the office's. */
  | { readonly kind: 'failed'; readonly reason: string };

/** Why a runner stops for good: trying again cannot help, and a person has to do something. */
export type StopCause = 'unsupported-protocol' | 'revoked' | 'replaced' | 'unknown-device';

export type Decision =
  | { readonly action: 'stop'; readonly cause: StopCause; readonly message: string }
  | { readonly action: 'retry'; readonly slow: boolean; readonly reason: string };

const PAIR_AGAIN = 'Pair it again with: escritoriio-runner pair <server> <code>';
const NOT_ALLOWED = 'this machine is not allowed to work for now (its AI member may be off, or you may no longer share an office with it)';

// The runner's own words, not the office's. Nothing the office writes with a close or a refusal is shown, whatever the code: what a
// person is told to do is for the runner to say. The only words of the office that are ever shown are the names it gives a device,
// an AI member and a workspace, and the words of a refusal to pair (see `plainText`).
const STOPS: Record<StopCause, string> = {
  revoked: `This machine was removed in the office, so its pairing no longer works. ${PAIR_AGAIN}`,
  'unsupported-protocol': 'The office does not accept this version of the runner: it is too old, or the office is newer than it knows. Update the runner (the latest version is on the My machines panel of the office) and start it again.',
  replaced: 'Another process of this device connected to the office, so this one stopped. Run only one runner for a device.',
  'unknown-device': `The office does not know this device: it was removed, or it was never paired. ${PAIR_AGAIN}`,
};

const stop = (cause: StopCause): Decision => ({ action: 'stop', cause, message: STOPS[cause] });

/**
 * What to do when the connection ends. A device that was removed, that the office does not know, that speaks a protocol the office does
 * not, or that another connection replaced, stops: trying again would be the same. One that is not allowed for now (its AI member
 * was turned off, say) tries again slowly, since only somebody in the office can change that. Everything else is a connection that
 * went wrong, and is tried again with a growing wait.
 */
export function decideAfter(end: ConnectionEnd): Decision {
  switch (end.kind) {
    case 'refused':
      if (end.status === 401) return stop('unknown-device');
      if (end.status === 403) return { action: 'retry', slow: true, reason: NOT_ALLOWED };
      return { action: 'retry', slow: false, reason: `the office answered ${end.status}` };
    case 'closed':
      switch (end.code) {
        case RUNNER_CLOSE.revoked:
          return stop('revoked');
        case RUNNER_CLOSE.unsupportedProtocol:
          return stop('unsupported-protocol');
        case RUNNER_CLOSE.replaced:
          return stop('replaced');
        case RUNNER_CLOSE.notAllowed:
          return { action: 'retry', slow: true, reason: NOT_ALLOWED };
        default:
          return { action: 'retry', slow: false, reason: 'the connection was lost' };
      }
    case 'failed':
      return { action: 'retry', slow: false, reason: plainText(end.reason) || 'the office could not be reached' };
  }
}
