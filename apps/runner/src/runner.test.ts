import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerToServer } from '@escritoriio/runner-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { version } from '../package.json';
import type { ApprovalPort } from './application/approvals.ts';
import type { ConnectionView } from './application/connection-view.ts';
import type { DeviceStore } from './application/ports.ts';
import { FakeAgent, FakeApprovals, FakeIsolation } from './application/task-testing.ts';
import { FakeLocalMcp } from './application/mcp-testing.ts';
import type { PairedDevice } from './domain/paired-device.ts';
import { STATE_DIRECTORY_VARIABLE } from './infrastructure/file-device-store.ts';
import type { Confirmations, Runner, RunnerEvent, RunnerOptions } from './runner.ts';
import { createRunner, resolveStateDirectory, RUNNER_VERSION } from './runner.ts';
import { eventually, FakeOffice, FAKE_TOKEN } from './testing/fake-office.ts';

// What an app does with the runner, against the real file system and an office that is a real socket: it supplies where the token is kept and where
// the owner is asked, reads the state as plain values, and follows it.

let office: FakeOffice;
let home: string;
let work: string;
let agent: FakeAgent;
let isolation: FakeIsolation;
let confirmed: string[];
let answers: { pair: boolean; folder: boolean };
let runners: Runner[];

beforeEach(async () => {
  office = await FakeOffice.start();
  home = await mkdtemp(join(tmpdir(), 'escritoriio-runner-embedded-'));
  work = await realpath(await mkdtemp(join(tmpdir(), 'escritoriio-runner-embedded-work-')));
  await mkdir(join(work, 'site'));
  agent = new FakeAgent();
  isolation = new FakeIsolation();
  confirmed = [];
  answers = { pair: true, folder: true };
  runners = [];
});

afterEach(async () => {
  for (const runner of runners) runner.connection.stop();
  await office.stop();
  await rm(home, { recursive: true, force: true });
  await rm(`${home}-worktrees`, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

const confirmations = (): Confirmations => ({
  pair: (question) => {
    confirmed.push(`pair ${question.agentName}`);
    return Promise.resolve(answers.pair);
  },
  shareFolder: (question) => {
    confirmed.push(`share ${question.folder.label}`);
    return Promise.resolve(answers.folder);
  },
  setUpMcpServer: () => Promise.resolve(true),
  approveMcpTool: () => Promise.resolve(true),
});

async function embed(options: Partial<RunnerOptions> = {}): Promise<Runner> {
  const runner = await createRunner({
    env: { [STATE_DIRECTORY_VARIABLE]: home, PATH: process.env.PATH ?? '' },
    confirmations: confirmations(),
    agents: { 'claude-code': agent },
    isolation,
    mcp: new FakeLocalMcp(),
    ...options,
  });
  runners.push(runner);
  return runner;
}

const pairedRunner = async (options: Partial<RunnerOptions> = {}): Promise<Runner> => {
  const runner = await embed(options);
  await runner.pairing.pair({ input: [office.origin, 'ABCDEFGH'], deviceName: 'Test laptop' });
  return runner;
};

const types = (messages: readonly RunnerToServer[]) => messages.map((message) => message.type);

describe('the runner as an app holds it', () => {
  it('says its version, and where the settings are kept', async () => {
    const runner = await embed();
    expect(runner.version).toBe(version);
    expect(RUNNER_VERSION).toBe(version);
    expect(runner.stateDirectory).toBe(await realpath(home));
  });

  it('is not paired, and offline once it is, with who it is paired with and never the token', async () => {
    const runner = await embed();
    expect(runner.connection.current).toMatchObject({ state: 'not-paired', device: null, paused: false });
    const seen: ConnectionView[] = [];
    runner.connection.subscribe((view) => void seen.push(view));
    const outcome = await runner.pairing.pair({ input: [office.origin, 'ABCDEFGH'], deviceName: 'Test laptop' });
    expect(outcome).toMatchObject({ paired: true, agentName: 'Robo' });
    expect(runner.connection.current).toMatchObject({ state: 'offline', device: { deviceName: 'Test laptop', agentName: 'Robo', workspaceName: 'Acme', host: new URL(office.origin).host } });
    expect(JSON.stringify([seen, await runner.pairing.current()])).not.toContain(FAKE_TOKEN);
    expect(confirmed).toEqual(['pair Robo']);
  });

  it('keeps nothing and uses no code when the owner says no', async () => {
    answers.pair = false;
    const runner = await embed();
    expect(await runner.pairing.pair({ input: [office.origin, 'ABCDEFGH'] })).toEqual({ paired: false });
    expect(runner.connection.current.state).toBe('not-paired');
    expect(await runner.pairing.current()).toBeNull();
  });

  it('keeps the token where the app says, and not in the settings folder', async () => {
    let saved: PairedDevice | undefined;
    const devices: DeviceStore = { load: () => Promise.resolve(saved), ensureWritable: () => Promise.resolve(), save: (device) => Promise.resolve(void (saved = device)) };
    const runner = await pairedRunner({ devices });
    expect(saved?.token).toBe(FAKE_TOKEN);
    expect((await runner.pairing.current())?.deviceName).toBe('Test laptop');
    const running = runner.connection.start();
    await eventually(() => expect(office.sockets[0]?.authorization).toBe(`Bearer ${FAKE_TOKEN}`));
    runner.connection.stop();
    await running;
  });

  it('does not pair again while it is connected', async () => {
    const runner = await pairedRunner();
    const running = runner.connection.start();
    await eventually(() => expect(runner.connection.current.state).toBe('connected'));
    await expect(runner.pairing.pair({ input: [office.origin, 'ABCDEFGH'] })).rejects.toThrow('Stop the connection');
    runner.connection.stop();
    await running;
  });
});

describe('the connection', () => {
  it('goes from connecting to connected, says who it works for, and ends as stopped, with the events a screen shows', async () => {
    const runner = await pairedRunner();
    const states: string[] = [];
    runner.connection.subscribe((view) => void states.push(view.state));
    const events: RunnerEvent[] = [];
    runner.events.subscribe((event) => void events.push(event));
    const running = runner.connection.start();
    await eventually(() => expect(runner.connection.current.state).toBe('connected'));
    expect(runner.connection.current).toMatchObject({ device: { agentName: 'Robo', workspaceName: 'Acme' }, paused: false, lastError: null });
    expect(events.map((event) => event.kind)).toEqual(['connecting', 'status']);
    runner.connection.stop();
    expect(await running).toEqual({ reason: 'stopped' });
    expect(states).toEqual(['connecting', 'connected', 'offline']);
  });

  it('says it is not paired, without connecting', async () => {
    const runner = await embed();
    expect(await runner.connection.start()).toMatchObject({ reason: 'not-paired' });
    expect(office.sockets).toEqual([]);
  });

  it('says why it ended, in words, when the office removed the device', async () => {
    const runner = await pairedRunner();
    const running = runner.connection.start();
    await eventually(() => expect(office.sockets).toHaveLength(1));
    office.sockets[0]?.close(4001, 'removed');
    expect(await running).toMatchObject({ reason: 'revoked' });
    expect(runner.connection.current).toMatchObject({ state: 'offline', lastError: expect.stringContaining('removed in the office') });
  });

  it('is reconnecting, with how long and why, when the connection drops', async () => {
    const runner = await pairedRunner();
    const running = runner.connection.start();
    await eventually(() => expect(office.sockets).toHaveLength(1));
    office.sockets[0]?.drop();
    await eventually(() => expect(runner.connection.current).toMatchObject({ state: 'reconnecting', lastError: 'the connection was lost' }));
    runner.connection.stop();
    await running;
  });

  it('keeps going when a screen that follows it throws, and says that a screen failed', async () => {
    const runner = await pairedRunner();
    runner.connection.subscribe(() => {
      throw new Error('could not draw');
    });
    const problems: string[] = [];
    runner.events.subscribe((event) => event.kind === 'problem' && problems.push(event.message));
    const running = runner.connection.start();
    await eventually(() => expect(runner.connection.current.state).toBe('connected'));
    expect(problems.some((message) => message.includes('A screen of the runner failed'))).toBe(true);
    runner.connection.stop();
    await running;
  });
});

describe('one connection to the office for a machine, whoever holds it', () => {
  it('does not take it from a runner that is connected already: the second says so, in words that name both, and the first stays', async () => {
    const first = await pairedRunner();
    const running = first.connection.start();
    await eventually(() => expect(first.connection.current.state).toBe('connected'));

    const second = await embed();
    const end = await second.connection.start();
    expect(end).toMatchObject({ reason: 'already-running', message: expect.stringMatching(/connected to the office already \(the app, or the command line\)/) });
    expect(second.connection.current).toMatchObject({ state: 'offline', lastError: end.reason === 'already-running' ? end.message : '' });
    // It never dialled: the office was not asked to replace the first connection.
    expect(office.sockets).toHaveLength(1);
    expect(first.connection.current.state).toBe('connected');

    first.connection.stop();
    await running;
    // Once the first is gone the second may connect.
    const next = second.connection.start();
    await eventually(() => expect(second.connection.current.state).toBe('connected'));
    expect(office.sockets).toHaveLength(2);
    second.connection.stop();
    expect(await next).toEqual({ reason: 'stopped' });
  });

  it('stops at once, and never dials, when it is told to stop before it is ready', async () => {
    const runner = await pairedRunner();
    const running = runner.connection.start();
    runner.connection.stop();
    expect(await running).toEqual({ reason: 'stopped' });
    expect(office.sockets).toEqual([]);
    expect(runner.connection.current).toMatchObject({ state: 'offline', lastError: null });
    // And nothing of that stop is left over for the next start.
    const next = runner.connection.start();
    await eventually(() => expect(runner.connection.current.state).toBe('connected'));
    runner.connection.stop();
    expect(await next).toEqual({ reason: 'stopped' });
  });

  it('stops, and never dials, when it is told to stop while it cleans up what an earlier run left', async () => {
    const runner = await pairedRunner();
    let sweeping = false;
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    isolation.sweep = async () => {
      sweeping = true;
      await gate;
      return { copies: 0, branches: 0 };
    };
    const running = runner.connection.start();
    await eventually(() => expect(sweeping).toBe(true));
    runner.connection.stop();
    finish();
    expect(await running).toEqual({ reason: 'stopped' });
    expect(office.sockets).toEqual([]);
  });

  it('does not start twice in one process', async () => {
    const runner = await pairedRunner();
    const running = runner.connection.start();
    expect(await runner.connection.start()).toMatchObject({ reason: 'already-running', message: 'This runner is connecting already.' });
    await eventually(() => expect(runner.connection.current.state).toBe('connected'));
    runner.connection.stop();
    await running;
  });

  it('does not leave the lock behind: a runner that stopped can be started again', async () => {
    const runner = await pairedRunner();
    for (let round = 0; round < 2; round++) {
      const running = runner.connection.start();
      await eventually(() => expect(runner.connection.current.state).toBe('connected'));
      runner.connection.stop();
      expect(await running).toEqual({ reason: 'stopped' });
    }
  });
});

describe('the tasks', () => {
  const share = async (runner: Runner, ...options: Partial<Parameters<Runner['folders']['add']>[0]>[]) =>
    runner.folders.add({ path: join(work, 'site'), label: undefined, access: 'edit', approval: 'auto', isolation: 'worktree', trusted: false, agent: null, ...Object.assign({}, ...options) });

  async function connect(runner: Runner) {
    const running = runner.connection.start();
    await eventually(() => expect(office.sockets).toHaveLength(1));
    await eventually(() => expect(runner.connection.current.state).toBe('connected'));
    return { running, socket: office.sockets[0]! };
  }

  it('shows the task that runs with a live tail, and the one that ended, with how it ended', async () => {
    const runner = await pairedRunner();
    await share(runner);
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    agent.script = async function* () {
      yield { kind: 'text', text: 'Reading the files' };
      yield { kind: 'tool', name: 'Read', summary: 'README.md', denied: false };
      await released;
      yield { kind: 'result', text: 'Fixed the typo.' };
    };
    const { running, socket } = await connect(runner);
    socket.send({ type: 'task.offer', taskId: 'task-1', folder: 'site', agent: null, instruction: 'Fix the typo' });
    await eventually(() => expect(runner.tasks.current.running[0]?.tail).toEqual(['Reading the files', '> Read: README.md']));
    expect(runner.tasks.current.running[0]).toMatchObject({ taskId: 'task-1', folder: 'site', waitingForApproval: false });
    expect(runner.tasks.runningTaskId).toBe('task-1');
    release();
    await eventually(() => expect(runner.tasks.current.running).toEqual([]));
    expect(runner.tasks.current.recent[0]).toMatchObject({ taskId: 'task-1', outcome: 'done', summary: 'Fixed the typo.', branch: 'escritoriio/task' });
    expect(runner.tasks.runningTaskId).toBeUndefined();
    runner.connection.stop();
    await running;
  });

  it('cancels the task that runs by its id, and not another', async () => {
    const runner = await pairedRunner();
    await share(runner);
    agent.script = async function* (_request, signal) {
      yield { kind: 'text', text: 'Working' };
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    };
    const { running, socket } = await connect(runner);
    socket.send({ type: 'task.offer', taskId: 'task-1', folder: 'site', agent: null, instruction: 'Do it' });
    await eventually(() => expect(runner.tasks.current.running).toHaveLength(1));
    expect(runner.tasks.cancel('another')).toBe(false);
    expect(runner.tasks.cancel('task-1')).toBe(true);
    await eventually(() => expect(socket.messages).toContainEqual(expect.objectContaining({ type: 'task.failed', taskId: 'task-1', reason: 'cancelled' })));
    expect(runner.tasks.current.recent[0]).toMatchObject({ taskId: 'task-1', outcome: 'cancelled' });
    runner.connection.stop();
    await running;
  });

  it('remembers, before it connects, what the journal has of the tasks of the last hour', async () => {
    const runner = await pairedRunner();
    await share(runner);
    const { running, socket } = await connect(runner);
    socket.send({ type: 'task.offer', taskId: 'task-1', folder: 'site', agent: null, instruction: 'Do it' });
    await eventually(() => expect(runner.tasks.current.recent).toHaveLength(1));
    runner.connection.stop();
    await running;

    const later = await embed();
    expect(later.tasks.current.recent).toMatchObject([{ taskId: 'task-1', outcome: 'done' }]);
  });

  describe('of a folder that asks before each one', () => {
    it('is taken at once, says it waits, shows the owner the exact text, and runs once the owner approves it', async () => {
      const owner = new FakeApprovals();
      const runner = await pairedRunner({ approvals: owner });
      await share(runner, { approval: 'ask' });
      const { running, socket } = await connect(runner);
      socket.send({ type: 'task.offer', taskId: 'task-1', folder: 'site', agent: null, instruction: 'Delete every test' });
      await eventually(() => expect(owner.requests).toEqual([{ taskId: 'task-1', folder: 'site', access: 'edit', instruction: 'Delete every test' }]));
      await eventually(() => expect(types(socket.messages).slice(-2)).toEqual(['task.accept', 'task.event']));
      expect(runner.tasks.current.running[0]).toMatchObject({ waitingForApproval: true });
      expect(agent.requests).toEqual([]);
      owner.answerWith('approved');
      await eventually(() => expect(types(socket.messages)).toContain('task.done'));
      expect(runner.tasks.current.recent[0]).toMatchObject({ outcome: 'done' });
      runner.connection.stop();
      await running;
    });

    it('is refused as before when the embedder supplies no place to ask', async () => {
      const runner = await pairedRunner();
      await share(runner, { approval: 'ask' });
      const { running, socket } = await connect(runner);
      socket.send({ type: 'task.offer', taskId: 'task-1', folder: 'site', agent: null, instruction: 'Delete every test' });
      await eventually(() => expect(socket.messages).toContainEqual({ type: 'task.reject', taskId: 'task-1', reason: 'needs-approval', message: expect.any(String) }));
      runner.connection.stop();
      await running;
    });

    it('ends as failed when the owner denies it, and the task is shown as ended', async () => {
      const owner = new FakeApprovals();
      const runner = await pairedRunner({ approvals: owner });
      await share(runner, { approval: 'ask' });
      const { running, socket } = await connect(runner);
      socket.send({ type: 'task.offer', taskId: 'task-1', folder: 'site', agent: null, instruction: 'Delete every test' });
      await eventually(() => expect(owner.waiting).toBe(true));
      owner.answerWith('denied');
      await eventually(() => expect(socket.messages).toContainEqual(expect.objectContaining({ type: 'task.failed', reason: 'cancelled' })));
      expect(runner.tasks.current.recent[0]).toMatchObject({ outcome: 'cancelled' });
      runner.connection.stop();
      await running;
    });

    it('takes the question away from the owner when the app stops the connection while it is asked', async () => {
      const owner = new FakeApprovals();
      const runner = await pairedRunner({ approvals: owner as ApprovalPort });
      await share(runner, { approval: 'ask' });
      const { running, socket } = await connect(runner);
      socket.send({ type: 'task.offer', taskId: 'task-1', folder: 'site', agent: null, instruction: 'Delete every test' });
      await eventually(() => expect(owner.waiting).toBe(true));
      runner.connection.stop();
      await running;
      expect(owner.taken).toBe(1);
    });
  });
});

describe('the folders', () => {
  it('are shared, listed, changed and removed through the same checks and questions as the command line', async () => {
    const runner = await embed();
    const added = await runner.folders.add({ path: join(work, 'site'), label: undefined, access: 'read-only', approval: 'auto', isolation: 'in-place', trusted: false, agent: null });
    expect(added).toMatchObject({ added: true, folder: { label: 'site', access: 'read-only' } });
    expect(confirmed).toEqual(['share site']);
    expect(await runner.folders.list()).toMatchObject([{ folder: { label: 'site', approval: 'auto' }, problem: undefined }]);

    expect(await runner.folders.update('site', { approval: 'ask', trusted: true })).toMatchObject({ updated: true, folder: { approval: 'ask', trusted: true } });
    expect(confirmed).toEqual(['share site', 'share site']);
    await expect(runner.folders.update('site', { approval: 'ask' })).rejects.toThrow('shared that way already');

    expect((await runner.folders.remove('site')).label).toBe('site');
    expect(await runner.folders.list()).toEqual([]);
  });

  it('keep nothing when the owner says no, and refuse what the command line refuses', async () => {
    const runner = await embed();
    answers.folder = false;
    expect(await runner.folders.add({ path: join(work, 'site'), label: undefined, access: 'read-only', approval: 'auto', isolation: 'in-place', trusted: false, agent: null })).toEqual({ added: false });
    await expect(runner.folders.add({ path: home, label: undefined, access: 'read-only', approval: 'auto', isolation: 'in-place', trusted: false, agent: null })).rejects.toThrow(/settings|runner/i);
    expect(await runner.folders.list()).toEqual([]);
  });

  it('show a folder that is not where it was, in words', async () => {
    const runner = await embed();
    await runner.folders.add({ path: join(work, 'site'), label: undefined, access: 'read-only', approval: 'auto', isolation: 'in-place', trusted: false, agent: null });
    await rm(join(work, 'site'), { recursive: true });
    expect(await runner.folders.list()).toMatchObject([{ problem: 'The folder is not there any more.' }]);
  });
});

describe('the coding agents, the pause and the MCP servers', () => {
  it('shows each coding agent, and keeps the path the owner picks', async () => {
    const runner = await embed();
    expect((await runner.agents.inspect()).map((view) => [view.kind, view.drivable, view.detection?.installed ?? null])).toEqual([
      ['claude-code', true, true],
      ['codex', false, null],
      ['kimi-code', false, null],
    ]);
    expect(await runner.agents.setPath('claude-code', '/opt/claude')).toMatchObject({ installed: true });
    expect((await runner.agents.inspect())[0]?.pickedPath).toBe('/opt/claude');
    expect(await runner.agents.clearPath('claude-code')).toBe(true);
    expect(await runner.agents.clearPath('claude-code')).toBe(false);
  });

  it('pauses on the machine, tells a runner that is connected at once, and shows it', async () => {
    const runner = await pairedRunner();
    const running = runner.connection.start();
    await eventually(() => expect(runner.connection.current.state).toBe('connected'));
    expect(await runner.pause.set(true)).toBe(true);
    expect(runner.connection.current).toMatchObject({ paused: true, pausedHere: true });
    await eventually(() => expect(office.sockets[0]?.messages).toContainEqual({ type: 'paused', paused: true }));
    expect(await runner.pause.set(true)).toBe(false);
    await runner.pause.set(false);
    expect(runner.connection.current.paused).toBe(false);
    runner.connection.stop();
    await running;
  });

  it('starts paused when the owner paused it before, whatever process did', async () => {
    const first = await embed();
    await first.pause.set(true);
    expect((await embed()).connection.current).toMatchObject({ paused: true, pausedHere: true });
  });

  it('lists the servers that are set up, with no value of their environment', async () => {
    const runner = await embed();
    expect(await runner.mcp.add({ label: 'notes', command: 'notes-server', args: [], env: ['KEY=k-the-secret-value-123456'], folder: null })).toEqual({ added: true, label: 'notes' });
    const views = await runner.mcp.list();
    expect(views).toMatchObject([{ label: 'notes', commandLine: 'notes-server', envNames: ['KEY'], approvedTools: [] }]);
    expect(JSON.stringify(views)).not.toContain('k-the-secret-value');
    expect(await runner.mcp.remove('notes')).toEqual({ label: 'notes' });
  });
});

describe('the doctor', () => {
  it('looks at everything and is healthy for a machine that is paired and can reach the office', async () => {
    const runner = await pairedRunner();
    const report = await runner.doctor();
    expect(report.healthy).toBe(true);
    expect(report.checks.find((one) => one.id === 'connection')).toMatchObject({ status: 'ok' });
    expect(report.checks.find((one) => one.id === 'clock')).toMatchObject({ status: 'ok' });
    expect(JSON.stringify(report)).not.toContain(FAKE_TOKEN);
  });

  it('fails when the office cannot be reached, and when the office needs a newer runner', async () => {
    const runner = await pairedRunner();
    office.minRunnerVersion = '99.0.0';
    expect((await runner.doctor()).checks.find((one) => one.id === 'version')).toMatchObject({ status: 'fail' });
    await office.stop();
    const report = await runner.doctor();
    expect(report.healthy).toBe(false);
    expect(report.checks.find((one) => one.id === 'connection')).toMatchObject({ status: 'fail' });
    office = await FakeOffice.start();
  });

  it('is not run against the office as the device: it never opens the socket', async () => {
    const runner = await pairedRunner();
    await runner.doctor();
    expect(office.sockets).toEqual([]);
  });
});

describe('the state directory, for whoever must know it before the runner exists', () => {
  it('is the one the runner keeps its settings in, as the file system names it', async () => {
    const env = { [STATE_DIRECTORY_VARIABLE]: home, PATH: process.env.PATH ?? '' };
    const runner = await embed({ env });
    expect(await resolveStateDirectory(env)).toBe(runner.stateDirectory);
  });
});
