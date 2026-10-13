import { chmod, link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface PrivateFile {
  readonly path: string;
  /** What is in the file, or undefined when there is no file. Anything else that goes wrong is thrown. */
  read(): Promise<string | undefined>;
  /** Fails when the file could not be written, which is better known before something is done that cannot be undone. */
  ensureWritable(): Promise<void>;
  /** Replaces what is in the file as a whole: what is read afterwards is all of the old or all of the new, never half of one. */
  write(text: string): Promise<void>;
  /**
   * Makes the file with this text only if there is none, and says whether it did. The file is whole from the moment it is there: it is
   * written beside and then linked into its place, which fails when something is there already, so nobody reads half of it or an empty one.
   */
  createIfAbsent(text: string): Promise<boolean>;
  /** Takes the file away. Nothing is the same as there being none. */
  remove(): Promise<void>;
}

// Two writes of one file in a row, as the journal makes, must not share the place they are written to before they are moved.
let writes = 0;

/**
 * A file that only its owner reads, in a folder that only its owner enters, for what is not for anybody else: a token, the folders a
 * person shares, what they asked their AI member to do. The folder is made private when this makes it. One that was there already is
 * left as it is, whatever its mode: it may be a folder the person chose with `ESCRITORIIO_RUNNER_HOME`, such as their home, and changing
 * who can enter it is not for the runner to do. The file is private in any case.
 */
export function privateFile(directory: string, name: string): PrivateFile {
  const path = join(directory, name);

  async function prepareDirectory(): Promise<void> {
    // The first folder that was made, if any was. `mkdir` gives a folder its mode less the umask, so what it made is set exactly.
    const made = await mkdir(directory, { recursive: true, mode: 0o700 });
    if (made !== undefined) await chmod(directory, 0o700);
  }

  /** Writes the text in a file of its own beside the one it is for, and says where. Nothing of it is left if that fails: it may be what is not for anybody else. */
  async function writeBeside(text: string): Promise<string> {
    const temporary = `${path}.${process.pid}.${writes++}.tmp`;
    try {
      // The mode of a file is only given when it is made, and a leftover of a run that died may be there: it is set again.
      await writeFile(temporary, text, { mode: 0o600 });
      await chmod(temporary, 0o600);
      return temporary;
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  return {
    path,

    async read() {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },

    async ensureWritable() {
      await prepareDirectory();
      // A folder can be there and still take no file: it is tried, with a file beside the one that will be written.
      const probe = `${path}.${process.pid}.${writes++}.tmp`;
      await writeFile(probe, '', { mode: 0o600 });
      await rm(probe);
    },

    async write(text) {
      await prepareDirectory();
      // Written beside the file and moved over it.
      const temporary = await writeBeside(text);
      try {
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },

    async createIfAbsent(text) {
      await prepareDirectory();
      const temporary = await writeBeside(text);
      try {
        await link(temporary, path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    },

    async remove() {
      await rm(path, { force: true });
    },
  };
}
