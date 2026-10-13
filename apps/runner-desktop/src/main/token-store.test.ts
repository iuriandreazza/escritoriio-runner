import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PairedDevice } from '@escritoriio/runner';
import { createFileDeviceStore, DEVICE_FILE_NAME, privateFile } from '@escritoriio/runner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SafeStorageLike } from './token-store.ts';
import { createSafeStorageDeviceStore, decideImport, decideKeeping, importPlainDevice, protectionOf } from './token-store.ts';

const device: PairedDevice = { server: 'https://office.example', deviceId: 'dev-1', token: 'secret-device-token-123', deviceName: 'Laptop', agentName: 'Ana', workspaceName: 'Acme' };

class FakeStorage implements SafeStorageLike {
  available = true;
  getSelectedStorageBackend: (() => string) | undefined;
  decrypts = 0;
  constructor(backend?: string) {
    if (backend !== undefined) this.getSelectedStorageBackend = () => backend;
  }
  isEncryptionAvailable = (): boolean => this.available;
  encryptString = (text: string): Buffer => Buffer.from(`sealed:${Buffer.from(text).toString('hex')}`);
  decryptString = (data: Buffer): string => {
    this.decrypts += 1;
    const text = data.toString();
    if (!text.startsWith('sealed:')) throw new Error('Decryption failed.');
    return Buffer.from(text.slice('sealed:'.length), 'hex').toString();
  };
}

describe('how well the system protects what it is given', () => {
  it('trusts the keychain of macOS and the data protection of Windows when encryption is there', () => {
    expect(protectionOf(new FakeStorage(), 'darwin')).toBe('system');
    expect(protectionOf(new FakeStorage(), 'win32')).toBe('system');
  });

  it('on Linux, trusts the keyrings it knows and not the fallback that has a fixed key', () => {
    for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) expect(protectionOf(new FakeStorage(backend), 'linux'), backend).toBe('system');
    expect(protectionOf(new FakeStorage('basic_text'), 'linux')).toBe('weak');
    expect(protectionOf(new FakeStorage('unknown'), 'linux')).toBe('weak');
  });

  it('says none when there is no encryption at all', () => {
    const storage = new FakeStorage('gnome_libsecret');
    storage.available = false;
    expect(protectionOf(storage, 'linux')).toBe('none');
    expect(protectionOf(storage, 'darwin')).toBe('none');
  });
});

describe('what is done with a token to keep', () => {
  it('is kept under the system’s protection when there is one', () => {
    expect(decideKeeping('system')).toBe('protected');
  });
  it('is not kept under a weak one until the owner has said so in words, every time', () => {
    expect(decideKeeping('weak')).toBe('ask');
  });
  it('is not kept at all when nothing can encrypt it', () => {
    expect(decideKeeping('none')).toBe('refuse');
  });
});

describe('whether to offer a pairing of the command line to the app', () => {
  it('offers it only when the app has none, a plain file is there, and the system protects it', () => {
    expect(decideImport({ hasAppToken: false, hasPlainFile: true, protection: 'system' })).toBe('offer');
    expect(decideImport({ hasAppToken: true, hasPlainFile: true, protection: 'system' })).toBe('skip');
    expect(decideImport({ hasAppToken: false, hasPlainFile: false, protection: 'system' })).toBe('skip');
    expect(decideImport({ hasAppToken: false, hasPlainFile: true, protection: 'weak' })).toBe('skip');
    expect(decideImport({ hasAppToken: false, hasPlainFile: true, protection: 'none' })).toBe('skip');
  });
});

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'escritoriio-desktop-token-'));
});
afterEach(() => rm(directory, { recursive: true, force: true }));

function storeWith(storage: SafeStorageLike, platform: NodeJS.Platform, answers: { weak: boolean }, now: () => number = () => 0) {
  const confirmWeakStorage = vi.fn(() => Promise.resolve(answers.weak));
  const store = createSafeStorageDeviceStore({ storage, platform, file: privateFile(directory, 'device.enc'), confirmWeakStorage, now });
  return { store, confirmWeakStorage };
}

describe('the token in the system’s protected storage', () => {
  it('is kept sealed in a file only its owner reads, and is read back', async () => {
    const { store, confirmWeakStorage } = storeWith(new FakeStorage(), 'darwin', { weak: false });
    await store.ensureWritable();
    await store.save(device);
    expect(await store.load()).toEqual(device);
    const path = join(directory, 'device.enc');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).not.toContain(device.token);
    expect(await readdir(directory)).not.toContain(DEVICE_FILE_NAME);
    expect(confirmWeakStorage).not.toHaveBeenCalled();
  });

  it('does not touch the system’s storage, which may ask for a password, when there is nothing to read', async () => {
    const storage = new FakeStorage();
    const { store } = storeWith(storage, 'darwin', { weak: false });
    expect(await store.load()).toBeUndefined();
    expect(storage.decrypts).toBe(0);
  });

  it('says in words that it is damaged when it cannot be opened', async () => {
    const { store } = storeWith(new FakeStorage(), 'darwin', { weak: false });
    await writeFile(join(directory, 'device.enc'), 'not what safeStorage wrote');
    await expect(store.load()).rejects.toThrow(/pair the machine again/i);
  });

  it('says in words that the system cannot open it when there is no encryption now', async () => {
    const storage = new FakeStorage();
    const { store } = storeWith(storage, 'darwin', { weak: false });
    await store.save(device);
    storage.available = false;
    await expect(store.load()).rejects.toThrow(/cannot be opened/i);
  });
});

describe('the token where the system gives it no protection', () => {
  it('is not kept, and the code is not spent, until the owner says so: ensureWritable asks first', async () => {
    const { store, confirmWeakStorage } = storeWith(new FakeStorage('basic_text'), 'linux', { weak: false });
    await expect(store.ensureWritable()).rejects.toThrow(/not paired|nothing was used up|keyring/i);
    expect(confirmWeakStorage).toHaveBeenCalledTimes(1);
    await expect(store.save(device)).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  it('is kept, sealed with what the system has and never as a plain device.json, after an explicit yes that is asked once for the pairing', async () => {
    const { store, confirmWeakStorage } = storeWith(new FakeStorage('basic_text'), 'linux', { weak: true });
    await store.ensureWritable();
    await store.save(device);
    expect(await store.load()).toEqual(device);
    expect(await readdir(directory)).toContain('device.enc');
    expect(await readdir(directory)).not.toContain(DEVICE_FILE_NAME);
    expect(await readFile(join(directory, 'device.enc'), 'utf8')).not.toContain(device.token);
    expect(confirmWeakStorage).toHaveBeenCalledTimes(1);
  });

  it('is never remembered: the next time the token is kept the owner is asked again, and nothing is written to the settings', async () => {
    const { store, confirmWeakStorage } = storeWith(new FakeStorage('basic_text'), 'linux', { weak: true });
    await store.ensureWritable();
    await store.save(device);
    await store.ensureWritable();
    await store.save(device);
    expect(confirmWeakStorage).toHaveBeenCalledTimes(2);
    expect(await readdir(directory)).not.toContain('app-settings.json');
  });

  it('asks at a save that was not prepared by ensureWritable, and a yes serves one save only', async () => {
    const { store, confirmWeakStorage } = storeWith(new FakeStorage('basic_text'), 'linux', { weak: true });
    await store.save(device);
    expect(confirmWeakStorage).toHaveBeenCalledTimes(1);
    await store.save(device);
    expect(confirmWeakStorage).toHaveBeenCalledTimes(2);
  });

  it('does not let a yes that was given long ago, for a pairing that never ended, keep a token later', async () => {
    let now = 0;
    const { store, confirmWeakStorage } = storeWith(new FakeStorage('basic_text'), 'linux', { weak: true }, () => now);
    await store.ensureWritable();
    now += 60 * 60_000;
    await store.save(device);
    expect(confirmWeakStorage).toHaveBeenCalledTimes(2);
  });

  it('does not keep the token when the owner says no at the save', async () => {
    const { store } = storeWith(new FakeStorage('basic_text'), 'linux', { weak: false });
    await expect(store.save(device)).rejects.toThrow(/not kept|keyring/i);
    expect(await readdir(directory)).toEqual([]);
  });

  it('is never kept when nothing can encrypt it, and the owner is not asked', async () => {
    const storage = new FakeStorage();
    storage.available = false;
    const { store, confirmWeakStorage } = storeWith(storage, 'linux', { weak: true });
    await expect(store.ensureWritable()).rejects.toThrow(/keyring|keychain/i);
    expect(confirmWeakStorage).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });
});

describe('moving the pairing of the command line into the app', () => {
  async function setUp(answer: boolean) {
    const plain = createFileDeviceStore(directory);
    await plain.save(device);
    const { store } = storeWith(new FakeStorage(), 'darwin', { weak: false });
    const confirm = vi.fn(() => Promise.resolve(answer));
    const run = () => importPlainDevice({ plain, plainFile: privateFile(directory, DEVICE_FILE_NAME), into: store, confirm });
    return { run, confirm, store };
  }

  it('asks with who it is for, and on a yes keeps it sealed and deletes the plain file', async () => {
    const { run, confirm, store } = await setUp(true);
    expect(await run()).toBe('imported');
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'Ana', workspaceName: 'Acme', host: 'office.example' }));
    expect(JSON.stringify(confirm.mock.calls)).not.toContain(device.token);
    expect(await store.load()).toEqual(device);
    expect(await readdir(directory)).not.toContain(DEVICE_FILE_NAME);
  });

  it('leaves the plain file where it is on a no', async () => {
    const { run, store } = await setUp(false);
    expect(await run()).toBe('declined');
    expect(await store.load()).toBeUndefined();
    expect(await readdir(directory)).toContain(DEVICE_FILE_NAME);
  });

  it('does not delete the plain file when what was sealed cannot be read back', async () => {
    const plain = createFileDeviceStore(directory);
    await plain.save(device);
    const broken = { load: () => Promise.resolve(undefined), ensureWritable: () => Promise.resolve(), save: () => Promise.resolve() };
    const outcome = importPlainDevice({ plain, plainFile: privateFile(directory, DEVICE_FILE_NAME), into: broken, confirm: () => Promise.resolve(true) });
    await expect(outcome).rejects.toThrow(/could not be kept/i);
    expect(await readdir(directory)).toContain(DEVICE_FILE_NAME);
  });

  it('has nothing to do when there is no plain file', async () => {
    const { store } = storeWith(new FakeStorage(), 'darwin', { weak: false });
    const outcome = await importPlainDevice({ plain: createFileDeviceStore(directory), plainFile: privateFile(directory, DEVICE_FILE_NAME), into: store, confirm: () => Promise.resolve(true) });
    expect(outcome).toBe('nothing');
  });
});
