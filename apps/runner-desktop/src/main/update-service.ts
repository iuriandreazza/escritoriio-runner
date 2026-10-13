import type { ConfirmDialog } from './confirmations.ts';
import { restartRequest, updateRequest } from './confirmations.ts';

/** What the app needs of an updater: to look, to download what it was told to, and to install. The adapter is the one that checks signatures. */
export interface UpdaterPort {
  /** The version that is on offer, if one is newer than this one. */
  check(): Promise<{ readonly version: string } | undefined>;
  download(): Promise<void>;
  installAndRestart(): void;
}

export interface UpdateState {
  readonly state: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'downloaded' | 'unavailable' | 'error';
  readonly version?: string;
  readonly message?: string;
}

const UNAVAILABLE = 'Updates are looked for by an installed app. This one runs from its sources, and is updated by installing a new version.';
const wordsOf = (error: unknown): string => (error instanceof Error && error.message !== '' ? error.message : 'The update failed.');

export interface UpdateService {
  readonly current: UpdateState;
  subscribe(listener: (state: UpdateState) => void): () => void;
  /** Looks for an update, and never downloads one. */
  check(): Promise<UpdateState>;
  /** Asks the owner whether to download what was found, and only a yes does; after it, asks again whether to install. */
  accept(): Promise<UpdateState>;
}

/**
 * Updates of the app, only as its owner says. An app that holds the keys of a coding agent to a machine does not replace itself on its own: looking is
 * automatic, but downloading is one native question and installing is another, each with no as the answer it takes by default.
 */
export function createUpdateService({ port, dialog, log }: { readonly port: UpdaterPort | undefined; readonly dialog: ConfirmDialog; readonly log: (line: string) => void }): UpdateService {
  let state: UpdateState = { state: 'idle' };
  const listeners = new Set<(state: UpdateState) => void>();
  const set = (next: UpdateState): UpdateState => {
    state = next;
    for (const listener of [...listeners]) listener(next);
    return next;
  };

  let accepting: Promise<UpdateState> | undefined;

  const service: UpdateService = {
    get current() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    async check() {
      if (!port) return set({ state: 'unavailable', message: UNAVAILABLE });
      set({ state: 'checking' });
      try {
        const found = await port.check();
        return set(found ? { state: 'available', version: found.version } : { state: 'none' });
      } catch (error) {
        log(`Looking for an update failed: ${wordsOf(error)}`);
        return set({ state: 'error', message: wordsOf(error) });
      }
    },

    accept() {
      // A second call while the first is on (a dialog open, a download going) is the first: no second dialog, no second download.
      accepting ??= accept().finally(() => {
        accepting = undefined;
      });
      return accepting;
    },
  };

  async function accept(): Promise<UpdateState> {
    if (!port) return set({ state: 'unavailable', message: UNAVAILABLE });
    const { version } = state;
    if ((state.state !== 'available' && state.state !== 'downloaded') || version === undefined) return state;
    try {
      if (state.state === 'available') {
        if (!(await dialog.confirm(updateRequest(version)))) return state;
        set({ state: 'downloading', version });
        await port.download();
        set({ state: 'downloaded', version });
      }
      if (await dialog.confirm(restartRequest(version))) port.installAndRestart();
      return state;
    } catch (error) {
      log(`The update failed: ${wordsOf(error)}`);
      return set({ state: 'error', version, message: wordsOf(error) });
    }
  }

  return service;
}
