import { posix, win32 } from 'node:path';
import { normalizeServerAddress } from '@escritoriio/runner-protocol';
import { z } from 'zod';
import type { DeviceStore } from '../application/ports.ts';
import type { PairedDevice } from '../domain/paired-device.ts';
import { isInside } from '../domain/paths.ts';
import { privateFile } from './private-file.ts';

/** Names a folder to keep the pairing in, instead of the one of the operating system: for tests, and for trying a second runner. */
export const STATE_DIRECTORY_VARIABLE = 'ESCRITORIIO_RUNNER_HOME';

const APP_DIRECTORY = 'escritoriio-runner';
/** The file of the pairing, in the state directory, when the token is kept in a plain file (the command line does). */
export const DEVICE_FILE_NAME = 'device.json';

export interface StateDirectoryInputs {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
}

/** Where the runner keeps what it must remember, as each operating system expects: the folder for the settings of a program of one person. */
export function stateDirectory({ platform, env, home }: StateDirectoryInputs): string {
  const chosen = env[STATE_DIRECTORY_VARIABLE];
  if (chosen) return chosen;
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', APP_DIRECTORY);
  if (platform === 'win32') return win32.join(env.APPDATA || win32.join(home, 'AppData', 'Roaming'), APP_DIRECTORY);
  // A relative XDG_CONFIG_HOME is not one: the specification says to ignore it.
  const config = env.XDG_CONFIG_HOME;
  return posix.join(config && posix.isAbsolute(config) ? config : posix.join(home, '.config'), APP_DIRECTORY);
}

/**
 * Where the runner makes the copies of folders that tasks work in. It is beside the state directory and never inside it: a task that
 * has no sandbox to keep it in its folder, as on Windows, must not find the token one `..` away. Each system has a place for what can be
 * made again: the cache of the user. Where `ESCRITORIIO_RUNNER_HOME` names the state directory, the copies go in a folder next to it with
 * `-worktrees` after its name, so that a second runner for a test or a trial does not share them. `state` is the state directory as it
 * is, with the links in it followed and the path made full.
 */
export function worktreesDirectory({ platform, env, home, state }: StateDirectoryInputs & { readonly state: string }): string {
  const windows = platform === 'win32';
  const path = windows ? win32 : posix;
  if (env[STATE_DIRECTORY_VARIABLE]) return path.join(path.dirname(state), `${path.basename(state)}-worktrees`);

  let cache: string;
  if (platform === 'darwin') cache = posix.join(home, 'Library', 'Caches');
  else if (windows) cache = env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local');
  // A relative XDG_CACHE_HOME is not one: the specification says to ignore it.
  else cache = env.XDG_CACHE_HOME && posix.isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : posix.join(home, '.cache');

  const copies = path.join(cache, APP_DIRECTORY, 'worktrees');
  // Where a person keeps their settings and their cache in one folder, the copies would come to be inside the settings: they go beside them.
  return isInside(state, copies, windows) ? path.join(cache, `${APP_DIRECTORY}-worktrees`) : copies;
}

const storedDeviceSchema = z.object({
  // The token travels to this address, so only what the runner would have written is read back.
  server: z.string().refine((server) => normalizeServerAddress(server) === server),
  deviceId: z.string().min(1),
  token: z.string().min(1),
  deviceName: z.string().min(1),
  agentName: z.string(),
  workspaceName: z.string(),
});

/** What a stored pairing says, or nothing for what is not one the runner would have written: the token travels to its address, so nothing else is read back. */
export function parseStoredDevice(json: unknown): PairedDevice | undefined {
  const device = storedDeviceSchema.safeParse(json);
  return device.success ? device.data : undefined;
}

/**
 * The pairing in a file, readable by the person who owns it and nobody else: the token is in it (see `privateFile` for how the folder
 * and the file are kept private). A place with more protection, such as the keychain of the operating system, can take its place: the
 * rest of the runner only knows the port.
 */
export function createFileDeviceStore(directory: string): DeviceStore {
  const file = privateFile(directory, DEVICE_FILE_NAME);

  return {
    async load() {
      const text = await file.read();
      if (text === undefined) return undefined;
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      const device = parseStoredDevice(json);
      if (!device) throw new Error(`The pairing kept in ${file.path} is damaged. Pair the machine again to replace it.`);
      return device;
    },

    ensureWritable: () => file.ensureWritable(),

    save: (device) => file.write(`${JSON.stringify(device, null, 2)}\n`),
  };
}
