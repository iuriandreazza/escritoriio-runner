import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pairedDevice } from '../application/testing.ts';
import { createFileDeviceStore, STATE_DIRECTORY_VARIABLE, stateDirectory, worktreesDirectory } from './file-device-store.ts';

const onWindows = process.platform === 'win32';
let root: string;
// A folder the store makes itself, not the one `mkdtemp` made: that one is private already, and would hide a mistake.
let directory: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'escritoriio-runner-test-'));
  directory = join(root, 'state');
});

afterEach(() => rm(root, { recursive: true, force: true }));

const mode = async (path: string) => (await stat(path)).mode & 0o777;

describe('the pairing kept in a file', () => {
  it('is nothing before there is one', async () => {
    expect(await createFileDeviceStore(directory).load()).toBeUndefined();
  });

  it('comes back as it was kept', async () => {
    const store = createFileDeviceStore(directory);
    await store.save(pairedDevice);
    expect(await store.load()).toEqual(pairedDevice);
    expect(await createFileDeviceStore(directory).load()).toEqual(pairedDevice);
  });

  it('is replaced by the next one that is kept, and leaves no other file behind', async () => {
    const store = createFileDeviceStore(directory);
    await store.save(pairedDevice);
    await store.save({ ...pairedDevice, deviceName: 'Desktop' });
    expect((await store.load())?.deviceName).toBe('Desktop');
    expect(await readdir(directory)).toEqual(['device.json']);
  });

  it.skipIf(onWindows)('is readable by its person only, in a folder that is theirs only', async () => {
    await createFileDeviceStore(directory).save(pairedDevice);
    expect(await mode(directory)).toBe(0o700);
    expect(await mode(join(directory, 'device.json'))).toBe(0o600);
  });

  it.skipIf(onWindows)('makes private every folder it has to make on the way', async () => {
    const deep = join(root, 'made', 'on', 'the', 'way');
    await createFileDeviceStore(deep).save(pairedDevice);
    for (const made of [join(root, 'made'), join(root, 'made', 'on'), join(root, 'made', 'on', 'the'), deep]) expect(await mode(made)).toBe(0o700);
  });

  it.skipIf(onWindows)('leaves the mode of a folder that was there as it is, such as one the person pointed it at, and still keeps the file private', async () => {
    await mkdir(directory, { mode: 0o755 });
    await chmod(directory, 0o755);
    await writeFile(join(directory, 'device.json'), '{}', { mode: 0o644 });
    await chmod(join(directory, 'device.json'), 0o644);
    const store = createFileDeviceStore(directory);
    await store.ensureWritable();
    await store.save(pairedDevice);
    expect(await mode(directory)).toBe(0o755);
    expect(await mode(join(directory, 'device.json'))).toBe(0o600);
    expect(await store.load()).toEqual(pairedDevice);
  });

  it('leaves nothing behind when the write fails, since what was written holds the token', async () => {
    await mkdir(join(directory, 'device.json'), { recursive: true });
    await expect(createFileDeviceStore(directory).save(pairedDevice)).rejects.toThrow();
    expect(await readdir(directory)).toEqual(['device.json']);
  });

  it.each([
    ['not json', 'this is not json'],
    ['not what the runner writes', '{"server":"https://office.example.com"}'],
    ['a token that goes to a server it would not be sent to over http', JSON.stringify({ ...pairedDevice, server: 'http://office.example.com' })],
    ['an address with more than the origin', JSON.stringify({ ...pairedDevice, server: 'https://office.example.com/path' })],
  ])('says it is damaged when it is %s, without showing what is in it', async (_name, content) => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'device.json'), content);
    const failure = createFileDeviceStore(directory).load();
    await expect(failure).rejects.toThrow(/damaged.*pair the machine again/i);
    await expect(failure).rejects.not.toThrow(/office\.example\.com|token/);
  });

  it('keeps the file as the person can read, with the token where the store reads it back from', async () => {
    await createFileDeviceStore(directory).save(pairedDevice);
    expect(JSON.parse(await readFile(join(directory, 'device.json'), 'utf8'))).toMatchObject({ token: pairedDevice.token });
  });
});

describe('knowing that a pairing can be kept before there is one', () => {
  it('makes the folder, which is private, and leaves no file in it', async () => {
    await createFileDeviceStore(directory).ensureWritable();
    expect(await readdir(directory)).toEqual([]);
    if (!onWindows) expect(await mode(directory)).toBe(0o700);
  });

  it('does not touch a pairing that is there', async () => {
    const store = createFileDeviceStore(directory);
    await store.save(pairedDevice);
    await store.ensureWritable();
    expect(await store.load()).toEqual(pairedDevice);
    expect(await readdir(directory)).toEqual(['device.json']);
  });

  it('fails when the folder cannot be made', async () => {
    await writeFile(join(root, 'a-file'), 'in the way');
    await expect(createFileDeviceStore(join(root, 'a-file', 'state')).ensureWritable()).rejects.toThrow();
  });

  it.skipIf(onWindows || process.getuid?.() === 0)('fails when the folder is there and takes no file', async () => {
    await mkdir(directory, { mode: 0o500 });
    await chmod(directory, 0o500);
    await expect(createFileDeviceStore(directory).ensureWritable()).rejects.toThrow(/EACCES/);
    await chmod(directory, 0o700);
  });
});

describe('where the runner keeps its state', () => {
  const home = '/home/ana';

  it.each([
    ['darwin', {}, '/home/ana/Library/Application Support/escritoriio-runner'],
    ['linux', {}, '/home/ana/.config/escritoriio-runner'],
    ['linux', { XDG_CONFIG_HOME: '/data/config' }, '/data/config/escritoriio-runner'],
    ['linux', { XDG_CONFIG_HOME: 'relative/config' }, '/home/ana/.config/escritoriio-runner'],
    ['linux', { XDG_CONFIG_HOME: '' }, '/home/ana/.config/escritoriio-runner'],
    ['win32', { APPDATA: 'C:\\Users\\Ana\\AppData\\Roaming' }, 'C:\\Users\\Ana\\AppData\\Roaming\\escritoriio-runner'],
    ['darwin', { [STATE_DIRECTORY_VARIABLE]: '/tmp/elsewhere' }, '/tmp/elsewhere'],
    ['linux', { [STATE_DIRECTORY_VARIABLE]: '/tmp/elsewhere', XDG_CONFIG_HOME: '/data/config' }, '/tmp/elsewhere'],
  ] as const)('on %s with %j it is %s', (platform, env, expected) => {
    expect(stateDirectory({ platform, env, home })).toBe(expected);
  });

  it('falls back, on Windows without APPDATA, to the folder where it would be', () => {
    expect(stateDirectory({ platform: 'win32', env: {}, home: 'C:\\Users\\Ana' })).toBe('C:\\Users\\Ana\\AppData\\Roaming\\escritoriio-runner');
  });
});

describe('where the runner makes its copies of folders', () => {
  const home = '/home/ana';

  it.each([
    ['darwin', {}, '/home/ana/Library/Application Support/escritoriio-runner', '/home/ana/Library/Caches/escritoriio-runner/worktrees'],
    ['linux', {}, '/home/ana/.config/escritoriio-runner', '/home/ana/.cache/escritoriio-runner/worktrees'],
    ['linux', { XDG_CACHE_HOME: '/data/cache' }, '/home/ana/.config/escritoriio-runner', '/data/cache/escritoriio-runner/worktrees'],
    ['linux', { XDG_CACHE_HOME: 'relative/cache' }, '/home/ana/.config/escritoriio-runner', '/home/ana/.cache/escritoriio-runner/worktrees'],
    ['linux', { XDG_CACHE_HOME: '' }, '/home/ana/.config/escritoriio-runner', '/home/ana/.cache/escritoriio-runner/worktrees'],
    ['win32', { LOCALAPPDATA: 'C:\\Users\\Ana\\AppData\\Local' }, 'C:\\Users\\Ana\\AppData\\Roaming\\escritoriio-runner', 'C:\\Users\\Ana\\AppData\\Local\\escritoriio-runner\\worktrees'],
    ['darwin', { [STATE_DIRECTORY_VARIABLE]: '/tmp/trial' }, '/tmp/trial', '/tmp/trial-worktrees'],
    ['linux', { [STATE_DIRECTORY_VARIABLE]: '/tmp/trial/', XDG_CACHE_HOME: '/data/cache' }, '/tmp/trial', '/tmp/trial-worktrees'],
    ['win32', { [STATE_DIRECTORY_VARIABLE]: 'D:\\trial' }, 'D:\\trial', 'D:\\trial-worktrees'],
  ] as const)('on %s with %j and the state in %s it is %s', (platform, env, state, expected) => {
    expect(worktreesDirectory({ platform, env, home, state })).toBe(expected);
  });

  it('falls back, on Windows without LOCALAPPDATA, to the folder where it would be', () => {
    expect(worktreesDirectory({ platform: 'win32', env: {}, home: 'C:\\Users\\Ana', state: 'C:\\Users\\Ana\\AppData\\Roaming\\escritoriio-runner' })).toBe('C:\\Users\\Ana\\AppData\\Local\\escritoriio-runner\\worktrees');
  });

  it('goes beside the settings, and not inside them, when the person keeps the settings and the cache in one folder', () => {
    expect(worktreesDirectory({ platform: 'linux', env: { XDG_CONFIG_HOME: '/data', XDG_CACHE_HOME: '/data' }, home, state: '/data/escritoriio-runner' })).toBe('/data/escritoriio-runner-worktrees');
    expect(worktreesDirectory({ platform: 'win32', env: { APPDATA: 'C:\\Data', LOCALAPPDATA: 'C:\\Data' }, home: 'C:\\Users\\Ana', state: 'C:\\Data\\escritoriio-runner' })).toBe('C:\\Data\\escritoriio-runner-worktrees');
  });

  it.each([
    ['darwin', {}, '/home/ana/Library/Application Support/escritoriio-runner'],
    ['linux', {}, '/home/ana/.config/escritoriio-runner'],
    ['linux', { XDG_CONFIG_HOME: '/data/cache', XDG_CACHE_HOME: '/data/cache' }, '/data/cache/escritoriio-runner'],
    ['win32', { APPDATA: 'C:\\Users\\Ana\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Ana\\AppData\\Roaming' }, 'C:\\Users\\Ana\\AppData\\Roaming\\escritoriio-runner'],
    ['linux', { [STATE_DIRECTORY_VARIABLE]: '/tmp/trial' }, '/tmp/trial'],
  ] as const)('is never inside the state directory, however they are set: on %s with %j', (platform, env, state) => {
    const copies = worktreesDirectory({ platform, env, home, state });
    const path = platform === 'win32' ? win32 : posix;
    expect(copies.startsWith(`${state}${path.sep}`)).toBe(false);
    expect(state.startsWith(`${copies}${path.sep}`)).toBe(false);
    expect(copies).not.toBe(state);
  });
});
