import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { version } from '../package.json';
import { FakeOffice, FAKE_TOKEN } from './testing/fake-office.ts';
import { createRepository } from './testing/git-fixtures.ts';

const run = promisify(execFile);
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
let workspace: string;
let cli: string;
let library: string;
let office: FakeOffice;

// A subprocess of a machine that may be busy: generous, and never a pause that stands in for something to wait for.
const SLOW = 30_000;
const eventually = (check: () => void): Promise<void> => vi.waitFor(check, { timeout: SLOW, interval: 20 });

/**
 * Stands in for Claude Code: it says which version it is (one the runner can drive) and that nobody is logged in, and does nothing else.
 * The runner looks for the real one through the login shell of whoever runs the tests, and runs it, which is slow on a busy computer and
 * is not what this test is about: what it finds must not depend on what the developer has installed or logged in to.
 */
const FAKE_CLAUDE = `#!/bin/sh
case "$1" in
  --version) echo "2.1.250 (Claude Code)" ;;
  auth) echo '{"loggedIn": false}' ;;
esac
`;

const env = () => ({ ...process.env, ESCRITORIIO_RUNNER_HOME: join(workspace, 'state') });
const cliOf = (...args: string[]) => run(process.execPath, [cli, ...args], { env: env() });

// The file people run is the bundle, not the sources: it has to work on its own, as plain JavaScript, with nothing installed beside
// it. So it is built here, to a folder of its own, and run as a program against a real socket.
beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'escritoriio-runner-bundle-'));
  const outDir = join(workspace, 'dist');
  await build({ root: packageRoot, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
  cli = join(outDir, 'cli.js');
  await build({ root: packageRoot, mode: 'library', logLevel: 'silent', build: { outDir, emptyOutDir: false } });
  library = join(outDir, 'index.js');
  office = await FakeOffice.start();
  const claude = join(workspace, 'claude');
  await writeFile(claude, FAKE_CLAUDE, { mode: 0o755 });
  // Where the person says Claude Code is, so that nothing else is looked for.
  expect((await cliOf('agents', 'set-path', 'claude-code', claude)).stdout).toContain('claude-code will be looked for at');
}, 60_000);

afterAll(async () => {
  await office?.stop();
  await rm(workspace, { recursive: true, force: true });
});

describe('the bundle', () => {
  it('runs on its own and says its version', async () => {
    expect((await cliOf('--version')).stdout.trim()).toBe(version);
    expect((await cliOf('--help')).stdout).toContain('escritoriio-runner pair');
  });

  it('has a library entry that an app can load, which creates a runner and does nothing when it is loaded', async () => {
    const script = `
      const library = await import(${JSON.stringify(pathToFileURL(library).href)});
      const runner = await library.createRunner({
        env: process.env,
        confirmations: { pair: async () => false, shareFolder: async () => false, setUpMcpServer: async () => false, approveMcpTool: async () => false },
      });
      console.log(JSON.stringify({ exports: Object.keys(library).sort(), version: runner.version, state: runner.connection.current.state, home: runner.stateDirectory }));
    `;
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { env: env() });
    const said = JSON.parse(stdout) as { exports: string[]; version: string; state: string; home: string };
    expect(said.exports).toEqual(expect.arrayContaining(['createRunner', 'RUNNER_VERSION', 'describeDoctor']));
    expect(said).toMatchObject({ version, state: 'not-paired' });
    // Loading it printed nothing of its own and did not read the command line.
    expect(stdout.trim().split('\n')).toHaveLength(1);
  }, SLOW);

  it('shares a folder, lists it, pauses and says so in `status`, with nothing installed beside it and no office', async () => {
    const shared = join(workspace, 'shared-site');
    // A folder that is worked in a copy is one that git has.
    await createRepository(shared, { 'README.md': '# A site\n' });
    const added = await cliOf('folders', 'add', shared, '--label', 'site', '--access', 'edit', '--yes');
    expect(added.stdout).toContain('Requests from you to your AI member will have a coding agent read and change the files in');
    expect(added.stdout).toContain('Shared as "site".');
    expect((await cliOf('folders', 'list')).stdout).toContain(`site: ${shared}`);
    expect((await cliOf('pause')).stdout).toContain('Paused.');
    const status = (await cliOf('status')).stdout;
    expect(status).toContain('paused:    yes, on this machine');
    expect(status).toContain('folders:   1 shared: site');
    expect((await cliOf('resume')).stdout).toContain('Resumed.');
    expect((await cliOf('agents')).stdout).toMatch(/^claude-code\n {2}found: {8}yes, at .*claude \(the path you picked\)\n {2}version: {6}2\.1\.250\n/);
    expect((await cliOf('folders', 'remove', 'site')).stdout).toContain('Stopped sharing "site".');
  }, SLOW);

  it('refuses a folder that holds no git repository, in words, unless it is worked in place', async () => {
    const plain = join(workspace, 'not-a-repository');
    await mkdir(plain);
    const refused = await cliOf('folders', 'add', plain, '--yes').catch((error: { code?: number; stderr?: string }) => error);
    expect(refused).toMatchObject({ code: 1, stderr: expect.stringContaining('That folder holds no git repository') });
    expect((await cliOf('folders', 'add', plain, '--isolation', 'in-place', '--yes')).stdout).toContain('Shared as "not-a-repository".');
    expect((await cliOf('folders', 'remove', 'not-a-repository')).stdout).toContain('Stopped sharing');
  }, SLOW);

  it('says in words what is wrong with the machine, with the doctor, and ends with 1 when something fails', async () => {
    const failure = await cliOf('doctor').catch((error: { code?: number; stdout?: string }) => error);
    // The coding agent that stands in for Claude Code is not logged in: nothing on this machine can do any work.
    expect(failure).toMatchObject({ code: 1, stdout: expect.stringContaining('[FAIL] Coding agents:') });
    expect((failure as { stdout: string }).stdout).toContain('Something is failing');
  }, SLOW);

  it('refuses a task for a folder that is not shared, in words, with exit code 1', async () => {
    const failure = await cliOf('run', 'nowhere', 'Fix it').catch((error: { code?: number; stderr?: string }) => error);
    expect(failure).toMatchObject({ code: 1, stderr: expect.stringContaining('That folder is not one this machine shares.') });
  }, SLOW);

  it('pairs, and connects with the token that pairing gave, as a program with a real socket', async () => {
    const paired = await cliOf('pair', office.origin, 'ABCD-EFGH', '--yes', '--name', 'Bundle test');
    expect(paired.stdout).toContain('Paired with Robo of Acme');
    expect(paired.stdout + paired.stderr).not.toContain(FAKE_TOKEN);

    const started = spawn(process.execPath, [cli, 'start'], { env: env() });
    let output = '';
    started.stdout.on('data', (chunk: Buffer) => void (output += chunk.toString()));
    started.stderr.on('data', (chunk: Buffer) => void (output += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => started.once('close', resolve));

    await eventually(() => expect(output).toContain('connected to'));
    expect(office.sockets[0]?.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(output).not.toContain(FAKE_TOKEN);

    // A signal that ends a program is not one that Windows has.
    if (process.platform !== 'win32') {
      started.kill('SIGINT');
      expect(await exited).toBe(0);
    } else {
      started.kill();
      await exited;
    }
  }, SLOW);

  it('sets up an MCP server, approves a tool of it, and calls it for the office, as a program with nothing installed beside it', async () => {
    const server = fileURLToPath(new URL('./testing/fake-mcp-server.ts', import.meta.url));
    const added = await cliOf('mcp', 'add', 'notes', '--env', 'NOTES_KEY=k-a-key-that-is-never-sent', '--yes', '--', process.execPath, server);
    expect(added.stdout).toContain('Set up as "notes".');
    expect(added.stdout).not.toContain('k-a-key-that-is-never-sent');
    expect((await cliOf('mcp', 'approve', 'notes', 'echo', '--yes')).stdout).toContain('Approved: echo.');
    expect((await cliOf('mcp', 'list')).stdout).toContain('1 approved: echo');

    const socketsBefore = office.sockets.length;
    const started = spawn(process.execPath, [cli, 'start'], { env: env() });
    let output = '';
    started.stdout.on('data', (chunk: Buffer) => void (output += chunk.toString()));
    started.stderr.on('data', (chunk: Buffer) => void (output += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => started.once('close', resolve));
    await eventually(() => expect(output).toContain('connected to'));

    const socket = office.sockets[socketsBefore]!;
    expect(socket.messages[0]).toMatchObject({ type: 'hello', mcpServers: ['notes'] });
    socket.send({ type: 'mcp.call', id: 'c1', server: 'notes', tool: 'echo', arguments: { text: 'from the office' }, timeoutMs: 20_000 });
    await eventually(() => expect(socket.messages).toContainEqual({ type: 'mcp.answered', id: 'c1', text: 'echo: from the office', isError: false }));

    if (process.platform !== 'win32') {
      started.kill('SIGINT');
      expect(await exited).toBe(0);
    } else {
      started.kill();
      await exited;
    }
  }, SLOW);
});
