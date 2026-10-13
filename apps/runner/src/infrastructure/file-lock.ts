import { randomUUID } from 'node:crypto';
import { privateFile } from './private-file.ts';

export interface FileLockOptions {
  /** The process that takes the lock: this one. */
  readonly pid?: number;
  readonly now?: () => number;
  /** Whether a process is alive: asked of the system. */
  readonly isAlive?: (pid: number) => boolean;
}

/** `kill` with signal 0 sends nothing: it only says whether there is such a process. One that is not ours to signal is alive all the same. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

// What this process holds right now, by what it wrote in the lock. A lock with this process's own number that is not among them was left by
// a release that failed, and nobody is holding it: the process is alive, and that would keep it held for as long as the runner runs.
const heldHere = new Set<string>();

const RELEASE_ATTEMPTS = 3;
const RELEASE_RETRY_MS = 50;
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The process that holds a lock, from what is in the file. Nothing for what is not what this writes: a pid of 0 or less would be a signal to a whole group. */
function holderOf(text: string): number | undefined {
  try {
    const pid = (JSON.parse(text) as { pid?: unknown }).pid;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** What a lock gives: the way to let go of it once it is held, and nothing when another process holds it. */
export interface FileLock {
  acquire(): Promise<(() => Promise<void>) | undefined>;
}

/**
 * A lock as a file in a folder of the runner, with the process that holds it written in it. It is made whole and linked into its place,
 * so it exists or it does not, and nobody reads half of it. A lock whose process is not alive was left by a run that was killed, and the
 * next one takes it over. Taking over is one process at a time, behind a file of its own (`<name>.takeover`), and only a takeover takes
 * away a lock that is not its own: two processes that find the same dead lock cannot both take it, and neither takes away the one the
 * other has just made. Giving up a lock takes away only a file that is exactly what this process wrote.
 *
 * A process that ended and whose number another process has taken since is taken for the holder, so the lock stays held until that one
 * ends too: the wrong way to be wrong, since what it guards is then refused and nothing happens twice. The refusals name the file, so that
 * its owner can take it away when no runner is running.
 */
export function createFileLock(directory: string, name: string, options: FileLockOptions = {}): FileLock {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const isAlive = options.isAlive ?? processIsAlive;
  const lock = privateFile(directory, name);
  const takeover = privateFile(directory, `${name}.takeover`);

  const heldByLiveProcess = (text: string): boolean => {
    const holder = holderOf(text);
    if (holder === undefined) return false;
    return holder === pid ? heldHere.has(text) : isAlive(holder);
  };

  /** Takes a lock that is held by nobody alive, if it is still the one that was seen. Says whether it was taken. */
  async function takeOver(seen: string, mine: string): Promise<boolean> {
    if (!(await takeover.createIfAbsent(JSON.stringify({ pid, startedAt: now() })))) {
      // Somebody else is at it. Unless they died in the middle, in which case their file is what is in the way.
      const other = await takeover.read();
      if (other !== undefined && !heldByLiveProcess(other)) await takeover.remove();
      return false;
    }
    try {
      if ((await lock.read()) !== seen) return false;
      await lock.remove();
      return await lock.createIfAbsent(mine);
    } finally {
      await takeover.remove();
    }
  }

  return {
    async acquire() {
      const mine = JSON.stringify({ pid, startedAt: now(), token: randomUUID() });
      // A file that is busy for a moment (a scanner on Windows, a full table of files) is tried again; one that cannot be taken away at all is
      // no longer held by this process, and is taken over by the next acquire of it.
      const release = async (): Promise<void> => {
        try {
          for (let attempt = 1; ; attempt++) {
            try {
              if ((await lock.read()) === mine) await lock.remove();
              return;
            } catch (error) {
              if (attempt >= RELEASE_ATTEMPTS) throw error;
              await wait(RELEASE_RETRY_MS);
            }
          }
        } finally {
          heldHere.delete(mine);
        }
      };
      // A few tries, since what is seen can change between looking and acting: a lock that was given up, or taken over by somebody else.
      for (let attempt = 0; attempt < 5; attempt++) {
        heldHere.add(mine);
        if (await lock.createIfAbsent(mine)) return release;
        const seen = await lock.read();
        if (seen === undefined) continue;
        if (heldByLiveProcess(seen)) {
          heldHere.delete(mine);
          return undefined;
        }
        if (await takeOver(seen, mine)) return release;
      }
      heldHere.delete(mine);
      return undefined;
    },
  };
}
