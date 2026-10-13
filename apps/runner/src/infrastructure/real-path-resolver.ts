import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { FolderResolver } from '../application/task-ports.ts';

/**
 * Where the file system says a folder really is: links followed, and every part of the path in the case the file system keeps it in
 * (the same folder is written two ways on a system that does not tell upper case from lower). Undefined when nothing is there, or
 * when what is there is not a folder.
 */
export const realPathResolver: FolderResolver = {
  async resolve(path) {
    try {
      const real = await realpath(path);
      return (await stat(real)).isDirectory() ? real : undefined;
    } catch {
      return undefined;
    }
  },
};

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');

/**
 * Where a path really is once its links are followed, for a path that may not be there yet (a file about to be written, the place the
 * runner will keep its settings): the nearest folder that exists is resolved, and the names below it are put back. A link that leads
 * nowhere is refused: writing through it would make whatever it points at, which may be anywhere.
 */
export async function realPathOfNearest(path: string): Promise<string> {
  const missing: string[] = [];
  let existing = path;
  for (;;) {
    try {
      return join(await realpath(existing), ...missing.reverse());
    } catch (error) {
      if (!isMissing(error)) throw error;
      const isLink = await lstat(existing).then(
        (found) => found.isSymbolicLink(),
        () => false,
      );
      if (isLink) throw new Error('A link that leads nowhere.', { cause: error });
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.push(basename(existing));
      existing = parent;
    }
  }
}
