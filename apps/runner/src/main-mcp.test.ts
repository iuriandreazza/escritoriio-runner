import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAgent, FakeIsolation } from './application/task-testing.ts';
import { MCP_FILE_NAME } from './infrastructure/file-mcp-store.ts';
import { STATE_DIRECTORY_VARIABLE } from './infrastructure/file-device-store.ts';
import { runCli } from './main.ts';
import { eventually, FakeOffice } from './testing/fake-office.ts';
import { FakeTerminal } from './testing/fake-terminal.ts';

// These run the commands of the runner as a program does, against the real file system, with the real programs of the MCP servers (a fake
// one, written for the tests, that speaks the protocol on its standard input and output) and an office that is a real socket: what is shown
// is what a person at a terminal would see, and what the office is told is what crosses a network.

const FAKE_SERVER = fileURLToPath(new URL('./testing/fake-mcp-server.ts', import.meta.url));
const SECRET = 'k-the-secret-value-123456';
const SLOW = 30_000;

let office: FakeOffice;
let home: string;
let terminal: FakeTerminal;
const agent = new FakeAgent();

beforeEach(async () => {
  office = await FakeOffice.start();
  home = await mkdtemp(join(tmpdir(), 'escritoriio-runner-mcp-cli-'));
  terminal = new FakeTerminal();
});

afterEach(async () => {
  await office.stop();
  await rm(home, { recursive: true, force: true });
});

const environment = () => ({ [STATE_DIRECTORY_VARIABLE]: home, PATH: process.env.PATH ?? '', RUNNER_ONLY_SECRET: 'the runner’s own' });
const run = (...argv: string[]) => runCli(argv, { terminal, env: environment(), agents: { 'claude-code': agent }, isolation: new FakeIsolation() });
const reset = (): void => {
  terminal = new FakeTerminal();
};
const shown = (): string => terminal.shown;
const types = (messages: readonly { readonly type: string }[]): string[] => messages.map((message) => message.type);

/** Sets the fake server up, as a person would, and approves the tools it names (or every one). */
async function setUp(tools: readonly string[] = ['echo', 'environment', 'where', 'structured']): Promise<void> {
  terminal.answers = ['y'];
  expect(await run('mcp', 'add', 'notes', '--env', `NOTES_KEY=${SECRET}`, '--env', 'REGION=eu', '--', process.execPath, FAKE_SERVER)).toBe(0);
  reset();
  expect(await run('mcp', 'approve', 'notes', ...tools, '--yes')).toBe(0);
  reset();
}

describe('setting up an MCP server', () => {
  it('says what it means, asks, and keeps what was written in a file that only its owner reads, without ever showing the values of the environment', async () => {
    terminal.answers = ['y'];
    expect(await run('mcp', 'add', 'notes', '--env', `NOTES_KEY=${SECRET}`, '--', process.execPath, FAKE_SERVER)).toBe(0);
    expect(terminal.questions).toEqual(['Set this server up? [y/N] ']);
    expect(shown()).toContain('MCP server "notes"');
    expect(shown()).toContain('NOTES_KEY (the values stay on this machine)');
    expect(shown()).toContain('No tool is available to the office until you approve it');
    expect(shown()).not.toContain(SECRET);
    expect(terminal.stdout.join('\n')).toContain('Set up as "notes".');

    const file = join(home, MCP_FILE_NAME);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ servers: [{ label: 'notes', command: process.execPath, args: [FAKE_SERVER], env: { NOTES_KEY: SECRET }, approved: {} }] });
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);

    reset();
    expect(await run('mcp', 'list')).toBe(0);
    expect(shown()).toContain('notes:');
    expect(shown()).toContain('none approved yet: escritoriio-runner mcp approve notes');
    expect(shown()).not.toContain(SECRET);
  });

  it('keeps nothing on anything but a yes', async () => {
    for (const answer of ['', 'n', 'no', 'maybe']) {
      reset();
      terminal.answers = [answer];
      expect(await run('mcp', 'add', 'notes', '--', process.execPath, FAKE_SERVER)).toBe(1);
      expect(terminal.stderr).toEqual(['Not set up.']);
    }
    reset();
    await run('mcp', 'list');
    expect(shown()).toContain('No MCP servers are set up');
  });

  it('refuses what is not a server, in words, before it asks', async () => {
    expect(await run('mcp', 'add', 'a/b', '--', 'node')).toBe(1);
    expect(terminal.stderr.join('\n')).toContain('A label is a name and not a path');
    reset();
    expect(await run('mcp', 'add', 'notes', '--env', 'NOT-VALID=1', '--', 'node')).toBe(1);
    expect(terminal.stderr.join('\n')).toContain('is not the name of an environment variable');
    expect(terminal.questions).toEqual([]);
  });

  it('is said, by `status`, to be there', async () => {
    await setUp();
    expect(await run('status')).toBe(0);
    expect(terminal.stdout.join('\n')).toContain('mcp:       1 set up: notes');
  });
});

describe('approving the tools of an MCP server on this machine', () => {
  it('lists what the program has, starting it, and says that nothing is approved', async () => {
    terminal.answers = ['y'];
    await run('mcp', 'add', 'notes', '--', process.execPath, FAKE_SERVER);
    reset();
    expect(await run('mcp', 'tools', 'notes')).toBe(0);
    expect(shown()).toMatch(/echo\s+not approved\s+Says back what it is given\./);
    expect(shown()).toContain('Approve what the office may use: escritoriio-runner mcp approve notes');
  }, SLOW);

  it('shows each tool as the program describes it and approves the ones the person says yes to', async () => {
    terminal.answers = ['y'];
    await run('mcp', 'add', 'notes', '--', process.execPath, FAKE_SERVER);
    reset();
    terminal.answers = ['y', 'n', 'n', 'n', 'n', 'n'];
    expect(await run('mcp', 'approve', 'notes')).toBe(0);
    expect(terminal.questions[0]).toBe('Let the office use "echo"? [y/N] ');
    expect(shown()).toContain('Says back what it is given.');
    expect(terminal.stdout.join('\n')).toContain('Approved: echo.');
    reset();
    await run('mcp', 'tools', 'notes');
    expect(shown()).toMatch(/echo\s+approved\s/);
    expect(shown()).toMatch(/hang\s+not approved\s/);
  }, SLOW);

  it('is taken back, and the server is forgotten, by the person', async () => {
    await setUp(['echo']);
    expect(await run('mcp', 'deny', 'notes', 'echo')).toBe(0);
    expect(terminal.stdout.join('\n')).toContain('The office cannot use echo any more');
    reset();
    expect(await run('mcp', 'remove', 'notes')).toBe(0);
    reset();
    await run('mcp', 'list');
    expect(shown()).toContain('No MCP servers are set up');
  }, SLOW);

  it('says in words when the program cannot be started, and does not guess', async () => {
    terminal.answers = ['y'];
    await run('mcp', 'add', 'ghost', '--', join(home, 'no-such-program'));
    reset();
    expect(await run('mcp', 'tools', 'ghost')).toBe(1);
    expect(terminal.stderr.join('\n')).toContain('The program could not be started. There is no such program');
  }, SLOW);
});

describe('start, with MCP servers', () => {
  const pairIt = () => run('pair', office.origin, 'ABCDEFGH', '--yes', '--name', 'Test laptop');

  /** Starts the runner as a program of its own and waits until the office has heard from it. */
  async function started(tools?: readonly string[]) {
    await pairIt();
    await setUp(tools);
    const running = run('start');
    await eventually(() => expect(types(office.sockets[0]?.messages ?? [])).toContain('hello'));
    const socket = office.sockets[0]!;
    await eventually(() => expect(terminal.stdout.join('\n')).toContain('connected to'));
    return { running, socket };
  }

  const answerTo = async (socket: NonNullable<(typeof office.sockets)[number]>, id: string) => {
    await eventually(() => expect(socket.messages.some((message) => 'id' in message && message.id === id)).toBe(true));
    return socket.messages.find((message) => 'id' in message && message.id === id)!;
  };

  it('tells the office which servers it has, by label and nothing else, and lists only the tools its owner approved here', async () => {
    const { running, socket } = await started(['echo', 'environment']);
    const hello = socket.messages[0]!;
    expect(hello).toMatchObject({ type: 'hello', mcpServers: ['notes'] });
    expect(JSON.stringify(hello)).not.toContain(SECRET);
    expect(JSON.stringify(hello)).not.toContain(FAKE_SERVER);

    socket.send({ type: 'mcp.list', id: 'l1', server: 'notes' });
    const listed = await answerTo(socket, 'l1');
    expect(listed).toMatchObject({ type: 'mcp.listed', id: 'l1', server: { name: 'Fake notes' }, held: 4, omitted: 0 });
    expect((listed as { tools: { name: string }[] }).tools.map((tool) => tool.name)).toEqual(['echo', 'environment']);
    terminal.pressCtrlC();
    expect(await running).toBe(0);
  }, SLOW);

  it('calls a tool its owner approved, with the arguments the office gives, and gives back what it answered', async () => {
    const { running, socket } = await started();
    socket.send({ type: 'mcp.call', id: 'c1', server: 'notes', tool: 'echo', arguments: { text: 'hello' }, timeoutMs: 20_000 });
    expect(await answerTo(socket, 'c1')).toEqual({ type: 'mcp.answered', id: 'c1', text: 'echo: hello', isError: false });
    terminal.pressCtrlC();
    await running;
  }, SLOW);

  it('takes the environment its owner typed out of what the program answers, so that a key it echoes never leaves the machine', async () => {
    const { running, socket } = await started();
    socket.send({ type: 'mcp.call', id: 'c1', server: 'notes', tool: 'environment', arguments: { name: 'NOTES_KEY' }, timeoutMs: 20_000 });
    const answer = await answerTo(socket, 'c1');
    expect(answer).toMatchObject({ type: 'mcp.answered', text: '[removed]' });
    expect(JSON.stringify(socket.messages)).not.toContain(SECRET);
    // What the runner itself holds is not the program's: it is given its own environment and what its owner typed, and nothing else.
    socket.send({ type: 'mcp.call', id: 'c2', server: 'notes', tool: 'environment', arguments: { name: 'RUNNER_ONLY_SECRET' }, timeoutMs: 20_000 });
    expect(await answerTo(socket, 'c2')).toMatchObject({ text: '(not set)' });
    terminal.pressCtrlC();
    await running;
  }, SLOW);

  it('refuses a tool its owner did not approve here, whatever the office says, and does not start the program for it', async () => {
    const { running, socket } = await started(['echo']);
    socket.send({ type: 'mcp.call', id: 'c1', server: 'notes', tool: 'flood', arguments: {}, timeoutMs: 20_000 });
    expect(await answerTo(socket, 'c1')).toEqual({ type: 'mcp.failed', id: 'c1', failure: 'not-approved' });
    terminal.pressCtrlC();
    await running;
  }, SLOW);

  it('is not told by the office what to run: a command, arguments and an environment in the request are not read, and a label it does not have is refused', async () => {
    const { running, socket } = await started();
    socket.send({ type: 'mcp.call', id: 'c1', server: 'notes', tool: 'echo', arguments: { text: 'hi' }, timeoutMs: 20_000, command: '/bin/sh', args: ['-c', 'echo pwned > /tmp/pwned'], env: { PATH: '/tmp' } } as never);
    expect(await answerTo(socket, 'c1')).toMatchObject({ type: 'mcp.answered', text: 'echo: hi' });
    socket.send({ type: 'mcp.call', id: 'c2', server: '/bin/sh', tool: 'echo', arguments: {}, timeoutMs: 20_000 });
    expect(await answerTo(socket, 'c2')).toEqual({ type: 'mcp.failed', id: 'c2', failure: 'no-server' });
    terminal.pressCtrlC();
    await running;
  }, SLOW);

  it('takes no request while the office has paused it, or its owner has on this machine, and works again when it is let to', async () => {
    const { running, socket } = await started();
    socket.send({ type: 'paused', paused: true });
    await eventually(() => expect(terminal.stdout.join('\n')).toContain('paused from the office'));
    socket.send({ type: 'mcp.list', id: 'l1', server: 'notes' });
    expect(await answerTo(socket, 'l1')).toEqual({ type: 'mcp.failed', id: 'l1', failure: 'paused' });

    socket.send({ type: 'paused', paused: false });
    await eventually(() => expect(terminal.stdout.join('\n')).toContain('resumed from the office'));
    const elsewhere = new FakeTerminal();
    await runCli(['pause'], { terminal: elsewhere, env: environment(), agents: { 'claude-code': agent }, isolation: new FakeIsolation() });
    socket.send({ type: 'mcp.list', id: 'l2', server: 'notes' });
    expect(await answerTo(socket, 'l2')).toEqual({ type: 'mcp.failed', id: 'l2', failure: 'paused' });
    terminal.pressCtrlC();
    await running;
  }, SLOW);

  it('stops a tool that does not answer when the time it was given is over, and the program with it', async () => {
    const { running, socket } = await started(['hang']);
    socket.send({ type: 'mcp.call', id: 'c1', server: 'notes', tool: 'hang', arguments: {}, timeoutMs: 700 });
    expect(await answerTo(socket, 'c1')).toEqual({ type: 'mcp.failed', id: 'c1', failure: 'timeout' });
    terminal.pressCtrlC();
    await running;
  }, SLOW);

  it('is not made to say what the program holds that is too large for a frame: the answer is cut', async () => {
    const { running, socket } = await started(['flood']);
    socket.send({ type: 'mcp.call', id: 'c1', server: 'notes', tool: 'flood', arguments: {}, timeoutMs: 20_000 });
    const answer = (await answerTo(socket, 'c1')) as { text: string };
    expect(answer.text.length).toBeLessThanOrEqual(64 * 1024);
    expect(answer.text).toContain('cut');
    terminal.pressCtrlC();
    await running;
  }, SLOW);
});
