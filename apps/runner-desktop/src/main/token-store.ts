import type { DeviceStore, DeviceView, PairedDevice, PrivateFile } from '@escritoriio/runner';
import { OwnerError, parseStoredDevice } from '@escritoriio/runner';

/** What of `safeStorage` the app uses: the system's own encryption, with the keychain on macOS, data protection on Windows and a keyring on Linux. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(data: Buffer): string;
  /** Linux only: which of the keyrings (or the fallback) the system gave. */
  getSelectedStorageBackend?: () => string;
}

/**
 * How well the system keeps what the app seals. `system` is a keychain, a keyring or the data protection of the account; `weak` is a fallback with a
 * key that is not secret (Linux with no keyring: `basic_text`), which seals the file but protects it from nothing that runs as the same person; `none` is
 * no encryption at all.
 */
export type Protection = 'system' | 'weak' | 'none';

const KEYRINGS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);

export function protectionOf(storage: SafeStorageLike, platform: NodeJS.Platform): Protection {
  if (!storage.isEncryptionAvailable()) return 'none';
  if (platform !== 'linux') return 'system';
  const backend = storage.getSelectedStorageBackend?.();
  // A backend that is not named is not vouched for.
  return backend !== undefined && KEYRINGS.has(backend) ? 'system' : 'weak';
}

export type Keeping = 'protected' | 'ask' | 'refuse';

/** What is done with a token that is to be kept: never kept under a weak protection without the owner's explicit word each time it is kept, and never where nothing can encrypt it. */
export function decideKeeping(protection: Protection): Keeping {
  if (protection === 'system') return 'protected';
  return protection === 'none' ? 'refuse' : 'ask';
}

/** Whether to offer to move the pairing of the command line into the app: only when the app has none, and the place it would go protects it. */
export function decideImport({ hasAppToken, hasPlainFile, protection }: { readonly hasAppToken: boolean; readonly hasPlainFile: boolean; readonly protection: Protection }): 'offer' | 'skip' {
  return !hasAppToken && hasPlainFile && protection === 'system' ? 'offer' : 'skip';
}

const NO_PROTECTION = 'This system has no keychain or keyring the app can use to protect the token that lets this machine work for your AI member, so nothing was paired and no code was used. Set up or unlock one (for example GNOME Keyring or KWallet) and try again.';
const NOT_KEPT_WEAK = 'Nothing was paired and no code was used: the token was not kept, since this system has no keyring to protect it and you chose not to keep it without one.';
const CANNOT_OPEN = 'The pairing is kept with the protection of this system, which cannot be opened now (a locked keychain or keyring, or none set up). Unlock it and try again.';
const DAMAGED = 'The pairing kept by the app is damaged. Pair the machine again to replace it.';

export interface SafeStorageDeviceStoreDeps {
  readonly storage: SafeStorageLike;
  readonly platform: NodeJS.Platform;
  /** Where the sealed pairing is kept. */
  readonly file: PrivateFile;
  /** Asks the owner, in words and with no as the answer that is the default, whether the token may be kept where the system gives it no protection. */
  readonly confirmWeakStorage: () => Promise<boolean>;
  readonly now?: () => number;
}

/** How long a yes to keeping the token without protection serves the save that follows it: the time of one pairing, and not of any that comes later. */
export const WEAK_YES_MS = 10 * 60_000;

/**
 * Keeps the pairing sealed by the system and nowhere else: a file of the state directory holds the token as the system's own encryption made it, never
 * in the clear. Where the system has nothing better than a fallback the owner has to say so, in words, each time a token is kept: the yes is
 * never written down, and serves the one save that follows it; where the system has nothing it is not kept. This is decided in `ensureWritable`, which the runner calls before it spends a pairing code, so that a refusal wastes nothing.
 */
export function createSafeStorageDeviceStore({ storage, platform, file, confirmWeakStorage, now = Date.now }: SafeStorageDeviceStoreDeps): DeviceStore {
  // Only in memory: a yes given before the code is spent, for the save that follows it.
  let yesUntil = 0;

  async function authorize({ useYes }: { readonly useYes: boolean }): Promise<void> {
    const keeping = decideKeeping(protectionOf(storage, platform));
    if (keeping === 'protected') return;
    if (keeping === 'refuse') throw new OwnerError(NO_PROTECTION);
    if (useYes && now() < yesUntil) {
      yesUntil = 0;
      return;
    }
    yesUntil = 0;
    if (!(await confirmWeakStorage())) throw new OwnerError(NOT_KEPT_WEAK);
    if (!useYes) yesUntil = now() + WEAK_YES_MS;
  }

  return {
    async load() {
      // Nothing is opened when nothing was kept, so that a first run never asks the keychain for anything.
      const sealed = await file.read();
      if (sealed === undefined) return undefined;
      if (protectionOf(storage, platform) === 'none') throw new OwnerError(CANNOT_OPEN);
      let device: PairedDevice | undefined;
      try {
        device = parseStoredDevice(JSON.parse(storage.decryptString(Buffer.from(sealed, 'base64'))));
      } catch {
        device = undefined;
      }
      if (!device) throw new OwnerError(DAMAGED);
      return device;
    },

    async ensureWritable() {
      await authorize({ useYes: false });
      await file.ensureWritable();
    },

    async save(device) {
      await authorize({ useYes: true });
      await file.write(storage.encryptString(JSON.stringify(device)).toString('base64'));
    },
  };
}

export interface ImportDeps {
  /** The plain pairing of the command line. */
  readonly plain: DeviceStore;
  readonly plainFile: PrivateFile;
  /** The sealed store of the app. */
  readonly into: DeviceStore;
  readonly confirm: (device: DeviceView) => Promise<boolean>;
}

/**
 * Moves the pairing of the command line into the sealed store, on the owner's yes: it is kept, read back to be sure it can be, and only then is the plain file deleted.
 * 'nothing' when there is no plain file, 'declined' on a no, which leaves everything as it was.
 */
export async function importPlainDevice({ plain, plainFile, into, confirm }: ImportDeps): Promise<'nothing' | 'declined' | 'imported'> {
  const device = await plain.load();
  if (!device) return 'nothing';
  const view: DeviceView = { host: new URL(device.server).host, deviceName: device.deviceName, agentName: device.agentName, workspaceName: device.workspaceName };
  if (!(await confirm(view))) return 'declined';
  await into.ensureWritable();
  await into.save(device);
  if ((await into.load())?.token !== device.token) throw new OwnerError('The pairing could not be kept by the app, so the file of the command line was left as it was.');
  await plainFile.remove();
  return 'imported';
}
