import { join } from 'node:path';
import { createFileLock } from './file-lock.ts';
import { privateFile } from './private-file.ts';

/** How long a change waits for another one that is being made: a change is a read and a write of a small file. */
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 20;

export interface LockedJsonStoreOptions<T> {
  readonly directory: string;
  readonly fileName: string;
  readonly lockName: string;
  readonly lockWaitMs?: number;
  /** What the file holds, in the words that name it to the person: "settings", "MCP servers". */
  readonly noun: string;
  /** What comes of a file that cannot be read, in a sentence, for the person who has to mend it. */
  readonly whenDamaged: string;
  /** What there is before anything was kept. */
  readonly empty: T;
  /** What a file says, as the value it keeps; nothing when it is not one this runner reads. */
  readonly read: (json: unknown) => T | undefined;
  /** What is written for a value. It asks the same of what is about to be written as of what is read, so that a mistake of this program is never found by reading it back. */
  readonly write: (value: T) => unknown;
}

/** What a change comes to: the value to keep (the one that was given, as it is, keeps nothing and writes nothing), and whatever the one who changed it has to know. */
export interface LockedChange<T, R> {
  readonly value: T;
  readonly result: R;
}

export interface LockedJsonStore<T> {
  load(): Promise<T>;
  update<R>(change: (current: T) => LockedChange<T, R>): Promise<R>;
}

/** What the system said, with the file it was about: a path that is a folder, or a file nobody may read, is not what the owner is told in the system's own words. */
function explainFailure(noun: string, path: string, error: unknown): Error {
  const code = error instanceof Error && 'code' in error ? String(error.code) : '';
  const why = code === 'EISDIR' ? `it is a folder, and the ${noun} are a file` : code === 'EACCES' || code === 'EPERM' ? 'this user may not read or write it' : `the system said ${code || 'something it did not explain'}`;
  return new Error(`The ${noun} kept in ${path} cannot be used: ${why}. Move it away, or mend it, and try again.`, { cause: error });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What its owner decided, kept as a JSON file in the folder where the runner keeps its state, private to its owner like the pairing. Only the
 * owner's own commands write it: nothing that comes from the office does, and it is read again whenever it is needed.
 *
 * A file that is there and cannot be read is an error and not an empty value: an empty one would say, in its place, that nothing was decided,
 * and the next change would write over what the owner had.
 *
 * The owner's commands may run in several terminals at once, so a change is made under a lock of its own: it reads the file as it is when the
 * lock is held, so that what another command kept a moment ago is not written over.
 */
export function createLockedJsonStore<T>(options: LockedJsonStoreOptions<T>): LockedJsonStore<T> {
  const { directory, noun, empty } = options;
  const file = privateFile(directory, options.fileName);
  const lock = createFileLock(directory, options.lockName);
  const lockPath = join(directory, options.lockName);
  const lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;

  async function load(): Promise<T> {
    let text: string | undefined;
    try {
      text = await file.read();
    } catch (error) {
      throw explainFailure(noun, file.path, error);
    }
    if (text === undefined) return empty;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const value = options.read(json);
    if (value === undefined) {
      throw new Error(`The ${noun} kept in ${file.path} cannot be read: the file is damaged, or was written by a newer runner. Mend or remove it. ${options.whenDamaged}`);
    }
    return value;
  }

  async function save(value: T): Promise<void> {
    const content = options.write(value);
    try {
      await file.write(`${JSON.stringify(content, null, 2)}\n`);
    } catch (error) {
      throw explainFailure(noun, file.path, error);
    }
  }

  async function held(): Promise<() => Promise<void>> {
    for (let waited = 0; ; waited += LOCK_RETRY_MS) {
      const release = await lock.acquire();
      if (release) return release;
      if (waited >= lockWaitMs) throw new Error(`Another command of the runner is changing the ${noun}. Try again in a moment; if none is running, delete the file ${lockPath}.`);
      await sleep(LOCK_RETRY_MS);
    }
  }

  return {
    load,

    async update(change) {
      const release = await held();
      try {
        const current = await load();
        const { value, result } = change(current);
        if (value !== current) await save(value);
        return result;
      } finally {
        await release().catch(() => undefined);
      }
    },
  };
}
