import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpServers } from '../application/mcp-ports.ts';
import { NO_MCP_SERVERS } from '../application/mcp-ports.ts';
import type { LocalMcpServer } from '../domain/mcp-server.ts';
import { createFileLock } from './file-lock.ts';
import { createFileMcpStore, MCP_FILE_NAME, MCP_LOCK_FILE_NAME } from './file-mcp-store.ts';

const onWindows = process.platform === 'win32';
const HASH = 'a'.repeat(64);

let root: string;
// A folder the store makes itself, not the one `mkdtemp` made: that one is private already, and would hide a mistake.
let directory: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'escritoriio-runner-mcp-'));
  directory = join(root, 'state');
});
afterEach(() => rm(root, { recursive: true, force: true }));

const file = () => join(directory, MCP_FILE_NAME);
const server: LocalMcpServer = { label: 'notes', command: 'notes-server', args: ['--stdio'], env: { NOTES_API_KEY: 'k-the-secret-123456' }, folder: null, approved: { search: HASH } };
const servers: McpServers = { servers: [server, { ...server, label: 'files', folder: 'site', env: {}, approved: {} }] };
const keep = (store: ReturnType<typeof createFileMcpStore>, value: McpServers): Promise<void> => store.update(() => ({ servers: value, result: undefined }));
const mode = async (path: string) => (await stat(path)).mode & 0o777;
const written = (content: unknown) => mkdir(directory, { recursive: true }).then(() => writeFile(file(), typeof content === 'string' ? content : JSON.stringify(content)));
const valid = { version: 1, servers: [server] };

describe('the MCP servers kept in a file', () => {
  it('are none before there are any, and nothing is made to say so', async () => {
    expect(await createFileMcpStore(directory).load()).toEqual(NO_MCP_SERVERS);
    expect(await readdir(root)).toEqual([]);
  });

  it('come back as they were kept, from another store of the same folder too', async () => {
    await keep(createFileMcpStore(directory), servers);
    expect(await createFileMcpStore(directory).load()).toEqual(servers);
  });

  it('are written as a file a person can read and mend', async () => {
    await keep(createFileMcpStore(directory), servers);
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({ version: 1, ...servers });
  });

  it.skipIf(onWindows)('are readable by their owner only, in a folder that is theirs only, since what a server is given is a secret', async () => {
    await keep(createFileMcpStore(directory), servers);
    expect(await mode(directory)).toBe(0o700);
    expect(await mode(file())).toBe(0o600);
  });

  it.skipIf(onWindows)('keep the mode of a folder that was there, and keep the file private anyway', async () => {
    await mkdir(directory, { mode: 0o755 });
    await chmod(directory, 0o755);
    await keep(createFileMcpStore(directory), servers);
    expect(await mode(directory)).toBe(0o755);
    expect(await mode(file())).toBe(0o600);
  });

  it('are kept apart from the folder settings, so that what a task reads holds none of their secrets', async () => {
    await keep(createFileMcpStore(directory), servers);
    expect(await readdir(directory)).toEqual([MCP_FILE_NAME]);
  });

  it('refuse to keep what could not be read back, before anything is written', async () => {
    const store = createFileMcpStore(directory);
    await expect(keep(store, { servers: [{ ...server, label: 'a/b' }] })).rejects.toThrow();
    await expect(keep(store, { servers: [server, { ...server, label: 'NOTES' }] })).rejects.toThrow();
    await expect(keep(store, { servers: [{ ...server, command: '' }] })).rejects.toThrow();
    await expect(keep(store, { servers: [{ ...server, approved: { search: 'not a hash' } }] })).rejects.toThrow();
    await expect(keep(store, { servers: [{ ...server, env: { 'NOT-A-NAME': 'x' } }] })).rejects.toThrow();
    expect(await readdir(directory).catch(() => [])).toEqual([]);
  });
});

describe('changing the MCP servers', () => {
  it('is made on what is kept when it is made, and gives what the change says', async () => {
    const store = createFileMcpStore(directory);
    await keep(store, { servers: [server] });
    const result = await store.update((current) => ({ servers: { servers: [...current.servers, { ...server, label: 'files' }] }, result: current.servers.length }));
    expect(result).toBe(1);
    expect((await store.load()).servers.map((one) => one.label)).toEqual(['notes', 'files']);
  });

  it('is made one at a time when several are made at once: none is lost', async () => {
    const names = ['one', 'two', 'three', 'four', 'five'];
    await Promise.all(names.map((label) => createFileMcpStore(directory).update((current) => ({ servers: { servers: [...current.servers, { ...server, label }] }, result: undefined }))));
    expect((await createFileMcpStore(directory).load()).servers.map((one) => one.label).sort()).toEqual([...names].sort());
    expect(await readdir(directory)).toEqual([MCP_FILE_NAME]);
  });

  it('writes nothing when the change gives back what it was given', async () => {
    const store = createFileMcpStore(directory);
    await store.update((current) => ({ servers: current, result: undefined }));
    expect(await readdir(directory)).toEqual([]);
  });

  it('keeps nothing when the change throws, and says what it threw', async () => {
    const store = createFileMcpStore(directory);
    await keep(store, servers);
    await expect(
      store.update(() => {
        throw new Error('The change refused itself.');
      }),
    ).rejects.toThrow('The change refused itself.');
    expect(await store.load()).toEqual(servers);
  });

  it('says so, naming the file, when another command is still changing them after a while', async () => {
    const store = createFileMcpStore(directory, { lockWaitMs: 100 });
    const release = await createFileLock(directory, MCP_LOCK_FILE_NAME).acquire();
    await expect(keep(store, servers)).rejects.toThrow(/Another command of the runner is changing the MCP servers/);
    await release?.();
    await keep(store, servers);
  });
});

describe('MCP servers that are there and cannot be read', () => {
  it.each([
    ['not json', 'this is not json'],
    ['empty', ''],
    ['without a version', { servers: [] }],
    ['of a version this runner does not know', { ...valid, version: 2 }],
    ['with something this runner does not know', { ...valid, somethingNew: true }],
    ['with a server that has something it does not know', { ...valid, servers: [{ ...server, shell: true }] }],
    ['with a label that is a path', { ...valid, servers: [{ ...server, label: 'a/b' }] }],
    ['with two servers of one label', { ...valid, servers: [server, server] }],
    ['with labels that differ only in case', { ...valid, servers: [server, { ...server, label: 'NOTES' }] }],
    ['with an approval that is not a hash', { ...valid, servers: [{ ...server, approved: { search: 'yes' } }] }],
    ['with a program that is not named', { ...valid, servers: [{ ...server, command: '' }] }],
    ['with an environment name that is not one', { ...valid, servers: [{ ...server, env: { '1X': 'y' } }] }],
    ['with too many servers', { ...valid, servers: Array.from({ length: 21 }, (_, index) => ({ ...server, label: `s${index}` })) }],
  ])('are an error that says so and does not guess, when they are %s', async (_what, content) => {
    await written(content);
    const failure = createFileMcpStore(directory).load();
    await expect(failure).rejects.toThrow(/cannot be read.*damaged.*newer runner.*Mend or remove it.*no MCP server is used/);
    await expect(failure).rejects.toThrow(file());
  });

  it('are left as they were, and what is in them is not shown', async () => {
    await written({ ...valid, servers: [{ ...server, shell: true }] });
    const failure = createFileMcpStore(directory).load();
    await expect(failure).rejects.not.toThrow(/k-the-secret/);
    expect(await readFile(file(), 'utf8')).toContain('k-the-secret-123456');
  });

  it('are said to be a folder when they are, with the file', async () => {
    await mkdir(file(), { recursive: true });
    await expect(createFileMcpStore(directory).load()).rejects.toThrow(`The MCP servers kept in ${file()} cannot be used: it is a folder, and the MCP servers are a file.`);
  });
});
