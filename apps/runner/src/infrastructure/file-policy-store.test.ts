import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_POLICY } from '../application/task-ports.ts';
import type { RunnerPolicy } from '../application/task-ports.ts';
import { site } from '../application/task-testing.ts';
import { createFileLock } from './file-lock.ts';
import { createFilePolicyStore, POLICY_FILE_NAME, POLICY_LOCK_FILE_NAME } from './file-policy-store.ts';

const onWindows = process.platform === 'win32';
let root: string;
// A folder the store makes itself, not the one `mkdtemp` made: that one is private already, and would hide a mistake.
let directory: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'escritoriio-runner-policy-'));
  directory = join(root, 'state');
});

afterEach(() => rm(root, { recursive: true, force: true }));

const file = () => join(directory, POLICY_FILE_NAME);
/** Keeps a policy as it is, whatever was there: what a store that is only written to is for. */
const keep = (store: ReturnType<typeof createFilePolicyStore>, policy: RunnerPolicy): Promise<void> => store.update(() => ({ policy, result: undefined }));
const mode = async (path: string) => (await stat(path)).mode & 0o777;
const policy: RunnerPolicy = {
  folders: [site, { ...site, label: 'api', path: '/Users/ana/work/api', realPath: '/Users/ana/work/api', access: 'read-only', approval: 'ask', isolation: 'in-place', trusted: true, agent: 'claude-code' }],
  agentPaths: { 'claude-code': '/opt/claude/bin/claude' },
  paused: true,
};
const written = (content: unknown) => mkdir(directory, { recursive: true }).then(() => writeFile(file(), typeof content === 'string' ? content : JSON.stringify(content)));
const valid = { version: 1, folders: [site], agentPaths: {}, paused: false };

describe('the folder settings kept in a file', () => {
  it('are the empty ones before there are any: nothing is shared, and the machine is not paused', async () => {
    expect(await createFilePolicyStore(directory).load()).toEqual(EMPTY_POLICY);
    expect(await readdir(root)).toEqual([]);
  });

  it('come back as they were kept, from another store of the same folder too', async () => {
    await keep(createFilePolicyStore(directory), policy);
    expect(await createFilePolicyStore(directory).load()).toEqual(policy);
  });

  it('are replaced whole by the next ones, with no other file left beside them', async () => {
    const store = createFilePolicyStore(directory);
    await keep(store, policy);
    await keep(store, EMPTY_POLICY);
    expect(await store.load()).toEqual(EMPTY_POLICY);
    expect(await readdir(directory)).toEqual([POLICY_FILE_NAME]);
  });

  it('can be kept twice at once without one write undoing the other halfway', async () => {
    const store = createFilePolicyStore(directory);
    await Promise.all([keep(store, policy), keep(store, { ...policy, paused: false })]);
    expect([true, false]).toContain((await store.load()).paused);
    expect(await readdir(directory)).toEqual([POLICY_FILE_NAME]);
  });

  it.skipIf(onWindows)('are readable by their owner only, in a folder that is theirs only', async () => {
    await keep(createFilePolicyStore(directory), policy);
    expect(await mode(directory)).toBe(0o700);
    expect(await mode(file())).toBe(0o600);
  });

  it.skipIf(onWindows)('leave the mode of a folder that was there as it is, and keep the file private anyway', async () => {
    await mkdir(directory, { mode: 0o755 });
    await chmod(directory, 0o755);
    await keep(createFilePolicyStore(directory), policy);
    expect(await mode(directory)).toBe(0o755);
    expect(await mode(file())).toBe(0o600);
  });

  it('are written as a file a person can read and mend', async () => {
    await keep(createFilePolicyStore(directory), policy);
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({ version: 1, ...policy });
  });

  it('refuse to keep what could not be read back, before anything is written', async () => {
    const store = createFilePolicyStore(directory);
    await expect(keep(store, { ...policy, folders: [{ ...site, label: 'a/b' }] })).rejects.toThrow();
    await expect(keep(store, { ...policy, folders: [site, { ...site, label: 'SITE' }] })).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });
});

describe('the kind of a folder', () => {
  const workspace = { ...site, label: 'build', path: '/Users/ana/work/build', realPath: '/Users/ana/work/build', access: 'edit' as const, isolation: 'in-place' as const, kind: 'workspace' as const };

  it('is absent in a file written before workspaces, and the folder is a plain one', async () => {
    await written(valid);
    const [folder] = (await createFilePolicyStore(directory).load()).folders;
    expect(folder).toEqual(site);
    expect(folder?.kind).toBeUndefined();
  });

  it('is kept and read back for a workspace, and for a folder that says it is plain', async () => {
    const store = createFilePolicyStore(directory);
    await keep(store, { ...EMPTY_POLICY, folders: [workspace, { ...site, kind: 'plain' }] });
    expect((await createFilePolicyStore(directory).load()).folders.map((folder) => folder.kind)).toEqual(['workspace', 'plain']);
  });

  it.each([
    { access: 'read-only' as const, isolation: 'in-place' as const },
    { access: 'edit' as const, isolation: 'worktree' as const },
  ])('refuses a workspace that is $access and $isolation, in what is kept and in a file that was mended by hand', async (way) => {
    await expect(keep(createFilePolicyStore(directory), { ...EMPTY_POLICY, folders: [{ ...workspace, ...way }] })).rejects.toThrow();
    await written({ ...valid, folders: [{ ...workspace, ...way }] });
    await expect(createFilePolicyStore(directory).load()).rejects.toThrow();
  });

  it('refuses a kind it does not know', async () => {
    await written({ ...valid, folders: [{ ...site, kind: 'shared' }] });
    await expect(createFilePolicyStore(directory).load()).rejects.toThrow();
  });
});

describe('changing the folder settings', () => {
  it('is made on what is kept when it is made, and gives what the change says', async () => {
    const store = createFilePolicyStore(directory);
    await keep(store, { ...EMPTY_POLICY, paused: true });
    const result = await store.update((current) => ({ policy: { ...current, agentPaths: { 'claude-code': '/opt/claude' } }, result: current.paused }));
    expect(result).toBe(true);
    expect(await store.load()).toEqual({ ...EMPTY_POLICY, paused: true, agentPaths: { 'claude-code': '/opt/claude' } });
  });

  it('does not undo what another command kept in the time it took to be asked: it reads again when it is made, and not before', async () => {
    const store = createFilePolicyStore(directory);
    await keep(store, { ...EMPTY_POLICY, folders: [site] });
    const seen = await store.load();
    // The owner pauses the machine in another terminal while this one waits for an answer.
    await keep(createFilePolicyStore(directory), { ...seen, paused: true });
    await store.update((current) => ({ policy: { ...current, folders: [...current.folders, { ...site, label: 'api', path: '/srv/api', realPath: '/srv/api' }] }, result: undefined }));
    expect(await store.load()).toMatchObject({ paused: true, folders: [{ label: 'site' }, { label: 'api' }] });
  });

  it('is made one at a time when several are made at once: none is lost', async () => {
    const store = createFilePolicyStore(directory);
    const agents = ['one', 'two', 'three', 'four', 'five'];
    await Promise.all(agents.map((name) => createFilePolicyStore(directory).update((current) => ({ policy: { ...current, folders: [...current.folders, { ...site, label: name, path: `/srv/${name}`, realPath: `/srv/${name}` }] }, result: undefined }))));
    expect((await store.load()).folders.map((folder) => folder.label).sort()).toEqual([...agents].sort());
    expect(await readdir(directory)).toEqual([POLICY_FILE_NAME]);
  });

  it('writes nothing when the change gives back what it was given', async () => {
    const store = createFilePolicyStore(directory);
    await store.update((current) => ({ policy: current, result: undefined }));
    expect(await readdir(directory)).toEqual([]);
    await keep(store, policy);
    const before = await readFile(file(), 'utf8');
    await store.update((current) => ({ policy: current, result: undefined }));
    expect(await readFile(file(), 'utf8')).toBe(before);
  });

  it('keeps nothing when the change throws, says what it threw, and gives the lock up', async () => {
    const store = createFilePolicyStore(directory);
    await keep(store, policy);
    await expect(
      store.update(() => {
        throw new Error('The change refused itself.');
      }),
    ).rejects.toThrow('The change refused itself.');
    expect(await store.load()).toEqual(policy);
    expect(await readdir(directory)).toEqual([POLICY_FILE_NAME]);
  });

  it('waits for a change that another command is making, and says so when it is still being made after a while', async () => {
    const store = createFilePolicyStore(directory, { lockWaitMs: 100 });
    const release = await createFileLock(directory, POLICY_LOCK_FILE_NAME).acquire();
    await expect(keep(store, policy)).rejects.toThrow(/Another command of the runner is changing the settings/);
    await release?.();
    await keep(store, policy);
    expect(await store.load()).toEqual(policy);
  });

  it('is made after the one that was being made is over', async () => {
    const store = createFilePolicyStore(directory, { lockWaitMs: 5_000 });
    const release = await createFileLock(directory, POLICY_LOCK_FILE_NAME).acquire();
    const waiting = keep(store, policy);
    setTimeout(() => void release?.(), 150);
    await waiting;
    expect(await store.load()).toEqual(policy);
  });

  it('takes over a lock that was left by a command that was killed', async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, POLICY_LOCK_FILE_NAME), JSON.stringify({ pid: 2_147_483_646, startedAt: 1, token: 'left-behind' }));
    await keep(createFilePolicyStore(directory), policy);
    expect(await createFilePolicyStore(directory).load()).toEqual(policy);
  });
});

describe('settings that are a folder', () => {
  it('are said to be one, with the file, and are neither read nor written over', async () => {
    await mkdir(file(), { recursive: true });
    const store = createFilePolicyStore(directory);
    await expect(store.load()).rejects.toThrow(`The settings kept in ${file()} cannot be used: it is a folder, and the settings are a file. Move it away, or mend it, and try again.`);
    await expect(keep(store, policy)).rejects.toThrow(/it is a folder, and the settings are a file/);
    await expect(keep(store, policy)).rejects.not.toThrow(/EISDIR/);
    expect((await stat(file())).isDirectory()).toBe(true);
  });
});

describe('settings that are there and cannot be read', () => {
  it.each([
    ['not json', 'this is not json'],
    ['empty', ''],
    ['an array', '[]'],
    ['without a version', { folders: [], agentPaths: {}, paused: false }],
    ['of a version this runner does not know', { ...valid, version: 2 }],
    ['with something this runner does not know', { ...valid, somethingNew: true }],
    ['with a folder that has something it does not know', { ...valid, folders: [{ ...site, somethingNew: true }] }],
    ['with a folder that is not one', { ...valid, folders: [{ label: 'site' }] }],
    ['with a label that is a path', { ...valid, folders: [{ ...site, label: 'work/site' }] }],
    ['with a label that has a line break', { ...valid, folders: [{ ...site, label: 'a\nb' }] }],
    ['with a label that is empty', { ...valid, folders: [{ ...site, label: '' }] }],
    ['with two folders of one label', { ...valid, folders: [site, { ...site, path: '/other', realPath: '/other' }] }],
    ['with labels that differ only in case', { ...valid, folders: [site, { ...site, label: 'SITE' }] }],
    ['with an access it does not know', { ...valid, folders: [{ ...site, access: 'root' }] }],
    ['with a setting for a shell, which edit now includes and no setting can narrow', { ...valid, folders: [{ ...site, shell: false }] }],
    ['with an isolation it does not know', { ...valid, folders: [{ ...site, isolation: 'none' }] }],
    ['with a coding agent it does not know', { ...valid, folders: [{ ...site, agent: 'gpt' }] }],
    ['with a path of an agent that is empty', { ...valid, agentPaths: { 'claude-code': '' } }],
    ['with a path for an agent it does not know', { ...valid, agentPaths: { gpt: '/bin/gpt' } }],
    ['with paused as a word', { ...valid, paused: 'yes' }],
    ['with too many folders', { ...valid, folders: Array.from({ length: 101 }, (_, index) => ({ ...site, label: `f${index}` })) }],
  ])('are an error that says so and does not guess, when they are %s', async (_what, content) => {
    await written(content);
    const failure = createFilePolicyStore(directory).load();
    await expect(failure).rejects.toThrow(/cannot be read.*damaged.*newer runner.*Mend or remove it/);
    await expect(failure).rejects.toThrow(file());
  });

  it('are not turned into an empty policy, which would have un-paused a machine that was paused', async () => {
    await keep(createFilePolicyStore(directory), { ...EMPTY_POLICY, paused: true });
    await writeFile(file(), '{"version": 1, "folders": [', 'utf8');
    await expect(createFilePolicyStore(directory).load()).rejects.toThrow(/cannot be read/);
  });

  it('are left as they were: a damaged file is the owner’s to mend, and is not written over by reading it', async () => {
    await written('{"damaged": true}');
    await expect(createFilePolicyStore(directory).load()).rejects.toThrow();
    expect(await readFile(file(), 'utf8')).toBe('{"damaged": true}');
  });

  it('do not show what is in the file', async () => {
    await written({ ...valid, folders: [{ ...site, path: '/Users/ana/secret-project', realPath: '/Users/ana/secret-project', access: 'root' }] });
    await expect(createFilePolicyStore(directory).load()).rejects.not.toThrow(/secret-project/);
  });
});
