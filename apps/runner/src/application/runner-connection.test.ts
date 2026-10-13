import type { McpCallRequest, McpListRequest, RunnerToServer, TaskOffer } from '@escritoriio/runner-protocol';
import { MAX_RUNNER_MESSAGE_BYTES, parseRunnerMessage, RUNNER_CLOSE, RUNNER_PING_MS, RUNNER_PROTOCOL_VERSION, TASK_LIMITS } from '@escritoriio/runner-protocol';
import { describe, expect, it } from 'vitest';
import { SLOW_RETRY_MS } from '../domain/backoff.ts';
import type { Inventory } from './ports.ts';
import type { McpHandling, RunnerEnd, TaskHandling } from './runner-connection.ts';
import { RunnerConnection, WELCOME_TIMEOUT_MS } from './runner-connection.ts';
import type { RunnerStatus } from './status.ts';
import { describeStatus } from './status.ts';
import { TaskJournal } from './task-journal.ts';
import { EVENT_BURST, EVENTS_PER_SECOND, OUTBOX_LIMIT } from './task-outbox.ts';
import type { AgentEvent } from './task-ports.ts';
import { ABORT_GRACE_MS, TaskService } from './task-service.ts';
import { FakeAgent, FakeIsolation, FakePolicyStore, FakeResolver, FakeTaskLock, MemoryJournalStore, surroundings } from './task-testing.ts';
import { FakeScheduler, FakeSocketFactory, flush, idleTasks, inventoryOf, pairedDevice, welcome } from './testing.ts';

const emptyInventory = inventoryOf({ agents: [], folders: [] });

function setup(inventory: Inventory = emptyInventory, stub?: TaskHandling, mcp: McpHandling = idleTasks.mcp) {
  const sockets = new FakeSocketFactory();
  const scheduler = new FakeScheduler();
  const statuses: RunnerStatus[] = [];
  const policy = new FakePolicyStore();
  const agent = new FakeAgent();
  const isolation = new FakeIsolation();
  const store = new MemoryJournalStore();
  const journal = new TaskJournal(store, () => scheduler.now(), () => undefined);
  const service = new TaskService({
    policy,
    resolver: new FakeResolver(),
    isolation,
    lock: new FakeTaskLock(),
    agents: { 'claude-code': agent },
    journal,
    scheduler,
    surroundings,
    parentEnvironment: { PATH: '/usr/bin' },
    report: () => undefined,
  });
  const connection = new RunnerConnection({ device: pairedDevice, runnerVersion: '0.1.0', os: 'darwin', sockets, scheduler, inventory, tasks: stub ?? service, mcp, journal, report: (status) => statuses.push(status) });
  let end: RunnerEnd | undefined;
  let crash: unknown;

  return {
    sockets,
    scheduler,
    statuses,
    connection,
    policy,
    agent,
    isolation,
    journal,
    service,
    get end() {
      return end;
    },
    get crash() {
      return crash;
    },
    /** Starts it and lets it dial. */
    async start() {
      connection.start().then((result) => (end = result), (error: unknown) => (crash = error));
      await flush();
    },
    /** The office opens the newest connection and welcomes the runner. */
    async connect(paused = false) {
      sockets.latest.open();
      sockets.latest.receive(welcome({ paused }));
      await flush();
    },
    reconnectWaits: () => statuses.flatMap((status) => (status.kind === 'reconnecting' ? [status.inMs] : [])),
    /** Lets the wait that was announced last pass, which is when the runner dials again. */
    async waitItOut() {
      const wait = statuses.flatMap((status) => (status.kind === 'reconnecting' ? [status.inMs] : [])).at(-1);
      await this.scheduler.advance(wait ?? 0);
    },
  };
}

describe('opening the connection', () => {
  it('dials the runner socket of the office the machine was paired with, with its token', async () => {
    const run = setup();
    await run.start();
    expect(run.sockets.sockets).toHaveLength(1);
    expect(run.sockets.latest.address).toBe('wss://office.example.com/runner');
    expect(run.sockets.latest.token).toBe(pairedDevice.token);
  });

  it('says nothing until the connection is open', async () => {
    const run = setup();
    await run.start();
    expect(run.sockets.latest.sent).toEqual([]);
  });

  it('says hello when it is open, with what it is and what it found on the machine', async () => {
    const found = { agents: [{ kind: 'claude-code' as const, version: '2.1.0', loggedIn: true }], folders: ['site', 'api'] };
    const run = setup(inventoryOf(found));
    await run.start();
    run.sockets.latest.open();
    expect(run.sockets.latest.sent).toEqual([{ type: 'hello', protocol: RUNNER_PROTOCOL_VERSION, runnerVersion: '0.1.0', os: 'darwin', ...found, mcpServers: [], paused: false, tasks: [] }]);
  });

  it('looks at the machine again at each connection', async () => {
    let reads = 0;
    const run = setup({ read: () => Promise.resolve({ agents: [], folders: [`read ${++reads}`], mcpServers: [], paused: false }) });
    await run.start();
    run.sockets.latest.open();
    run.sockets.latest.end({ kind: 'closed', code: 1006 });
    await run.scheduler.advance(1_000);
    run.sockets.latest.open();
    expect(run.sockets.sockets.map((socket) => socket.sent[0])).toMatchObject([{ folders: ['read 1'] }, { folders: ['read 2'] }]);
  });

  it('is refused a second start while it is running, and may start again once it has ended', async () => {
    const run = setup();
    await run.start();
    await expect(run.connection.start()).rejects.toThrow(/already running/i);
    expect(run.sockets.sockets).toHaveLength(1);

    run.connection.stop();
    await flush();
    expect(run.end).toEqual({ reason: 'stopped' });
    await run.start();
    expect(run.sockets.sockets).toHaveLength(2);
  });

  it('gives the error of a machine it could not look at, and does not dial', async () => {
    const run = setup({ read: () => Promise.reject(new Error('cannot look')) });
    await run.start();
    expect(run.crash).toEqual(new Error('cannot look'));
    expect(run.sockets.sockets).toHaveLength(0);
  });
});

describe('being welcomed', () => {
  it('tells whoever runs it that it is connected, with the names the office gave', async () => {
    const run = setup();
    await run.start();
    run.sockets.latest.open();
    run.sockets.latest.receive(welcome({ device: { id: 'device-1', name: 'Laptop (renamed)' } }));
    expect(run.statuses).toEqual([{ kind: 'connected', host: 'office.example.com', deviceName: 'Laptop (renamed)', agentName: 'Robo', workspaceName: 'Acme', paused: false }]);
  });

  it('does not let the office write more than a name into what is printed', async () => {
    const run = setup();
    await run.start();
    run.sockets.latest.open();
    run.sockets.latest.receive(welcome({ agent: { name: 'Robo\r\u001b[2Kat evil.example' } }));
    expect(run.statuses[0]).toMatchObject({ agentName: 'Robo [2Kat evil.example' });
  });

  it('gives up on a connection that is not welcomed in time, whether it never opened or never answered', async () => {
    const run = setup();
    await run.start();
    await run.scheduler.advance(WELCOME_TIMEOUT_MS);
    expect(run.sockets.sockets[0]?.closedByRunner).toBe(true);
    expect(run.reconnectWaits()).toHaveLength(1);

    await run.scheduler.advance(1_000);
    run.sockets.latest.open();
    await run.scheduler.advance(WELCOME_TIMEOUT_MS);
    expect(run.sockets.sockets[1]?.closedByRunner).toBe(true);
    expect(run.reconnectWaits()).toHaveLength(2);
  });

  it('does not give up on a connection that was welcomed', async () => {
    const run = setup();
    await run.start();
    await run.connect();
    await run.scheduler.advance(WELCOME_TIMEOUT_MS * 2);
    expect(run.sockets.latest.closedByRunner).toBe(false);
  });

  it('never has what proves it in what it tells', async () => {
    const run = setup();
    await run.start();
    await run.connect();
    run.sockets.latest.end({ kind: 'closed', code: 1006 });
    expect(JSON.stringify(run.statuses)).not.toContain(pairedDevice.token);
  });
});

describe('keeping the connection alive', () => {
  it('pings at the pace of the protocol once it is welcomed', async () => {
    const run = setup();
    await run.start();
    await run.connect();
    expect(run.sockets.latest.sentOfType('ping')).toHaveLength(0);
    await run.scheduler.advance(RUNNER_PING_MS);
    expect(run.sockets.latest.sentOfType('ping')).toHaveLength(1);
    run.sockets.latest.receive({ type: 'pong' });
    await run.scheduler.advance(RUNNER_PING_MS);
    expect(run.sockets.latest.sentOfType('ping')).toHaveLength(2);
  });

  it('keeps going as long as the office answers', async () => {
    const run = setup();
    await run.start();
    await run.connect();
    for (let ping = 0; ping < 10; ping++) {
      await run.scheduler.advance(RUNNER_PING_MS);
      run.sockets.latest.receive({ type: 'pong' });
    }
    expect(run.sockets.sockets).toHaveLength(1);
    expect(run.sockets.latest.closedByRunner).toBe(false);
  });

  it('takes the link for dead when two pings went unanswered, and goes to another connection', async () => {
    const run = setup();
    await run.start();
    await run.connect();
    await run.scheduler.advance(RUNNER_PING_MS * 2);
    expect(run.sockets.latest.sentOfType('ping')).toHaveLength(2);
    expect(run.sockets.latest.closedByRunner).toBe(false);

    await run.scheduler.advance(RUNNER_PING_MS);
    expect(run.sockets.sockets[0]?.closedByRunner).toBe(true);
    expect(run.reconnectWaits()).toHaveLength(1);
    await run.scheduler.advance(1_000);
    expect(run.sockets.sockets).toHaveLength(2);
  });

  it('does not take the link for dead when an answer came in between', async () => {
    const run = setup();
    await run.start();
    await run.connect();
    await run.scheduler.advance(RUNNER_PING_MS * 2);
    run.sockets.latest.receive({ type: 'pong' });
    await run.scheduler.advance(RUNNER_PING_MS * 2);
    expect(run.sockets.latest.closedByRunner).toBe(false);
  });

  it('counts only a pong as an answer: other things the office says do not show it is listening', async () => {
    const run = setup();
    await run.start();
    await run.connect();
    await run.scheduler.advance(RUNNER_PING_MS);
    run.sockets.latest.receive({ type: 'paused', paused: false });
    await run.scheduler.advance(RUNNER_PING_MS * 2);
    expect(run.sockets.sockets[0]?.closedByRunner).toBe(true);
  });
});

describe('reconnecting', () => {
  it('waits longer each time the connection fails, up to the cap, with the chance the scheduler gives', async () => {
    const run = setup();
    await run.start();
    for (let failure = 0; failure < 9; failure++) {
      run.sockets.latest.end({ kind: 'closed', code: 1006 });
      await run.waitItOut();
    }
    expect(run.reconnectWaits()).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    expect(run.sockets.sockets).toHaveLength(10);
  });

  it('is told how long it waits and why', async () => {
    const run = setup();
    await run.start();
    run.sockets.latest.end({ kind: 'failed', reason: 'connect ECONNREFUSED 127.0.0.1:8201' });
    expect(run.statuses).toEqual([{ kind: 'reconnecting', inMs: 500, slow: false, reason: 'connect ECONNREFUSED 127.0.0.1:8201' }]);
  });

  it('does not dial before the wait is over', async () => {
    const run = setup();
    await run.start();
    run.sockets.latest.end({ kind: 'closed', code: 1006 });
    await run.scheduler.advance(499);
    expect(run.sockets.sockets).toHaveLength(1);
    await run.scheduler.advance(1);
    expect(run.sockets.sockets).toHaveLength(2);
  });

  it('starts the waits over once a connection proved itself, by an answer to a ping', async () => {
    const run = setup();
    await run.start();
    for (let failure = 0; failure < 3; failure++) {
      run.sockets.latest.end({ kind: 'closed', code: 1006 });
      await run.waitItOut();
    }
    await run.connect();
    await run.scheduler.advance(RUNNER_PING_MS);
    run.sockets.latest.receive({ type: 'pong' });
    run.sockets.latest.end({ kind: 'closed', code: 1006 });
    expect(run.reconnectWaits()).toEqual([500, 1_000, 2_000, 500]);
  });

  it('keeps growing the waits of a link that is welcomed and cut straight away, as a proxy that drops it after a moment does', async () => {
    const run = setup();
    await run.start();
    for (let flap = 0; flap < 6; flap++) {
      await run.connect();
      run.sockets.latest.end({ kind: 'closed', code: 1011 });
      await run.waitItOut();
    }
    expect(run.reconnectWaits()).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(run.sockets.sockets).toHaveLength(7);
  });

  it('does not start the waits over for a connection that was welcomed and pinged, but never answered', async () => {
    const run = setup();
    await run.start();
    run.sockets.latest.end({ kind: 'closed', code: 1006 });
    await run.waitItOut();
    await run.connect();
    await run.scheduler.advance(RUNNER_PING_MS);
    run.sockets.latest.end({ kind: 'closed', code: 1006 });
    expect(run.reconnectWaits()).toEqual([500, 1_000]);
  });

  it.each([
    ['the office is down', { kind: 'refused' as const, status: 503 }],
    ['nobody answers', { kind: 'failed' as const, reason: 'timeout' }],
    ['the office closed the connection to restart', { kind: 'closed' as const, code: 1001 }],
  ])('tries again when %s', async (_name, end) => {
    const run = setup();
    await run.start();
    run.sockets.latest.end(end);
    await run.scheduler.advance(1_000);
    expect(run.sockets.sockets).toHaveLength(2);
    expect(run.end).toBeUndefined();
  });

  it('tries again slowly when the machine is not allowed for now, and that does not make the next ordinary wait longer', async () => {
    const run = setup();
    await run.start();
    run.sockets.latest.end({ kind: 'closed', code: RUNNER_CLOSE.notAllowed });
    expect(run.statuses.at(-1)).toEqual({ kind: 'reconnecting', inMs: SLOW_RETRY_MS, slow: true, reason: expect.stringContaining('not allowed to work for now') });
    await run.scheduler.advance(SLOW_RETRY_MS - 1);
    expect(run.sockets.sockets).toHaveLength(1);
    await run.scheduler.advance(1);
    expect(run.sockets.sockets).toHaveLength(2);

    run.sockets.latest.end({ kind: 'refused', status: 403 });
    expect(run.reconnectWaits()).toEqual([SLOW_RETRY_MS, SLOW_RETRY_MS]);
    await run.scheduler.advance(SLOW_RETRY_MS);

    run.sockets.latest.end({ kind: 'closed', code: 1006 });
    expect(run.reconnectWaits().at(-1)).toBe(500);
  });

  it('ignores what a connection it left says, such as being replaced by the one that took its place', async () => {
    const run = setup();
    await run.start();
    await run.connect();
    await run.scheduler.advance(RUNNER_PING_MS * 3);
    await run.scheduler.advance(1_000);
    const [abandoned, current] = run.sockets.sockets;
    expect(abandoned?.closedByRunner).toBe(true);
    await run.connect();

    abandoned?.end({ kind: 'closed', code: RUNNER_CLOSE.replaced });
    abandoned?.receive({ type: 'paused', paused: true });
    await flush();

    expect(run.end).toBeUndefined();
    expect(current?.closedByRunner).toBe(false);
    expect(run.statuses.filter((status) => status.kind === 'paused-by-office')).toEqual([]);
    await run.scheduler.advance(RUNNER_PING_MS);
    expect(current?.sentOfType('ping')).toHaveLength(1);
  });
});

describe('stopping for good', () => {
  it.each([
    [RUNNER_CLOSE.revoked, 'revoked', /removed in the office/],
    [RUNNER_CLOSE.unsupportedProtocol, 'unsupported-protocol', /update the runner/i],
    [RUNNER_CLOSE.replaced, 'replaced', /another process/i],
  ])('stops on close code %i, and says why', async (code, cause, message) => {
    const run = setup();
    await run.start();
    await run.connect();
    run.sockets.latest.end({ kind: 'closed', code });
    await flush();
    expect(run.end).toMatchObject({ reason: cause, message: expect.stringMatching(message) });
    await run.scheduler.advance(10 * 60_000);
    expect(run.sockets.sockets).toHaveLength(1);
    expect(run.scheduler.pending).toBe(0);
  });

  it('stops when the office does not know the token', async () => {
    const run = setup();
    await run.start();
    run.sockets.latest.end({ kind: 'refused', status: 401 });
    await flush();
    expect(run.end).toMatchObject({ reason: 'unknown-device', message: expect.stringMatching(/does not know this device/) });
    expect(run.sockets.sockets).toHaveLength(1);
  });

  it('stops when asked to, whatever it is doing, and leaves nothing running', async () => {
    const run = setup();
    await run.start();
    await run.connect();
    run.connection.stop();
    await flush();
    expect(run.end).toEqual({ reason: 'stopped' });
    expect(run.sockets.latest.closedByRunner).toBe(true);
    expect(run.scheduler.pending).toBe(0);
  });

  it('stops when asked to while it waits to reconnect', async () => {
    const run = setup();
    await run.start();
    run.sockets.latest.end({ kind: 'closed', code: 1006 });
    run.connection.stop();
    await flush();
    expect(run.end).toEqual({ reason: 'stopped' });
    await run.scheduler.advance(60_000);
    expect(run.sockets.sockets).toHaveLength(1);
  });

  it('stops when asked to while it looks at the machine, without dialing', async () => {
    let finishLooking: () => void = () => undefined;
    const run = setup({ read: () => new Promise((resolve) => (finishLooking = () => resolve({ agents: [], folders: [], mcpServers: [], paused: false }))) });
    await run.start();
    run.connection.stop();
    finishLooking();
    await flush();
    expect(run.end).toEqual({ reason: 'stopped' });
    expect(run.sockets.sockets).toHaveLength(0);
  });

  it('does nothing when told to stop and it is not running', () => {
    const run = setup();
    expect(() => run.connection.stop()).not.toThrow();
  });
});

describe('being paused from the office', () => {
  it('says so when it is paused and when it is resumed', async () => {
    const run = setup();
    await run.start();
    await run.connect();
    run.sockets.latest.receive({ type: 'paused', paused: true });
    run.sockets.latest.receive({ type: 'paused', paused: false });
    expect(run.statuses.slice(1)).toEqual([
      { kind: 'paused-by-office', paused: true },
      { kind: 'paused-by-office', paused: false },
    ]);
  });

  it('says so when the office had it paused already when it welcomed the machine', async () => {
    const run = setup();
    await run.start();
    await run.connect(true);
    expect(run.statuses[0]).toMatchObject({ kind: 'connected', paused: true });
  });
});

describe('what the office says besides', () => {
  it('has an error it reports as a state, without what it said', async () => {
    const run = setup();
    await run.start();
    await run.connect();
    run.sockets.latest.receive({ type: 'error', message: 'You are sending too fast' });
    expect(run.statuses.at(-1)).toEqual({ kind: 'office-complained' });
  });

  it('is ignored when it is not understood, as a newer office may say more than this runner knows', async () => {
    const run = setup();
    await run.start();
    await run.connect();
    const before = run.statuses.length;
    run.sockets.latest.receive('not json');
    run.sockets.latest.receive('{"type":"announcement","id":"1"}');
    run.sockets.latest.receive('{"type":"welcome"}');
    expect(run.statuses).toHaveLength(before);
    expect(run.end).toBeUndefined();
  });

  it('is welcomed once: a second welcome on the same connection changes nothing', async () => {
    const run = setup();
    await run.start();
    await run.connect();
    run.sockets.latest.receive(welcome());
    await run.scheduler.advance(RUNNER_PING_MS);
    expect(run.statuses.filter((status) => status.kind === 'connected')).toHaveLength(1);
    expect(run.sockets.latest.sentOfType('ping')).toHaveLength(1);
  });
});

const offer = (taskId = 't1', overrides: Partial<TaskOffer> = {}): TaskOffer => ({ type: 'task.offer', taskId, folder: 'site', agent: null, instruction: 'Fix the typo in the README', ...overrides });

/** A coding agent that is doing a long job: it says it began, and goes on until it is let go (`release`) or told to stop. */
function longJob() {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => (release = resolve));
  const script = async function* (_request: unknown, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    yield { kind: 'text', text: 'Working' };
    await Promise.race([released, new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))]);
    if (!signal.aborted) yield { kind: 'result', text: 'Finished.' };
  };
  return { release, script };
}

const typesSent = (messages: readonly RunnerToServer[]): string[] => messages.map((message) => message.type);

describe('the tasks the office offers', () => {
  it('are handed to the part that runs them, which answers through the connection: taken, what the coding agent did, how it ended', async () => {
    const run = setup();
    run.agent.script = async function* () {
      yield { kind: 'text', text: 'Looking' };
      yield { kind: 'result', text: 'Done.' };
    };
    await run.start();
    await run.connect();
    run.sockets.latest.receive(offer());
    await flush();
    expect(typesSent(run.sockets.latest.sent)).toEqual(['hello', 'task.accept', 'task.event', 'task.done']);
    expect(run.sockets.latest.sentOfType('task.accept')).toEqual([{ type: 'task.accept', taskId: 't1' }]);
    expect(run.sockets.latest.sentOfType('task.event')[0]).toMatchObject({ taskId: 't1', seq: 0, event: { kind: 'text', text: 'Looking' } });
    expect(run.sockets.latest.sentOfType('task.done')[0]).toMatchObject({ taskId: 't1', text: 'Done.', branch: 'escritoriio/task' });
    expect(run.agent.requests).toHaveLength(1);
  });

  it('are refused, with the reason, by the machine, whatever the office offers', async () => {
    const run = setup();
    await run.start();
    await run.connect();
    run.sockets.latest.receive(offer('t1', { folder: 'not-shared' }));
    await flush();
    expect(run.sockets.latest.sentOfType('task.reject')).toEqual([{ type: 'task.reject', taskId: 't1', reason: 'not-allowed', message: expect.any(String) }]);
    expect(run.agent.requests).toEqual([]);
  });

  it('are not heard before the office has welcomed the machine', async () => {
    const run = setup();
    await run.start();
    run.sockets.latest.open();
    run.sockets.latest.receive(offer());
    await flush();
    expect(typesSent(run.sockets.latest.sent)).toEqual(['hello']);
    expect(run.agent.requests).toEqual([]);
  });

  it('are cancelled when the office asks, and only the one that was asked for', async () => {
    const run = setup();
    const job = longJob();
    run.agent.script = job.script;
    await run.start();
    await run.connect();
    run.sockets.latest.receive(offer());
    await flush();
    run.sockets.latest.receive({ type: 'task.cancel', taskId: 'another' });
    await flush();
    expect(run.service.runningTask).toBe('t1');
    run.sockets.latest.receive({ type: 'task.cancel', taskId: 't1' });
    await flush();
    expect(run.sockets.latest.sentOfType('task.failed')[0]).toMatchObject({ taskId: 't1', reason: 'cancelled' });
    expect(run.service.runningTask).toBeUndefined();
  });

  it('are not cancelled by a cancel that comes before the welcome', async () => {
    const run = setup();
    const job = longJob();
    run.agent.script = job.script;
    await run.start();
    await run.connect();
    run.sockets.latest.receive(offer());
    await flush();
    run.sockets.sockets[0]?.end({ kind: 'closed', code: 1006 });
    await run.waitItOut();
    run.sockets.latest.open();
    run.sockets.latest.receive({ type: 'task.cancel', taskId: 't1' });
    await flush();
    expect(run.service.runningTask).toBe('t1');
    job.release();
    await flush();
  });
});

describe('pausing, from the office', () => {
  it('stops what runs and refuses what is offered, until it is resumed', async () => {
    const run = setup();
    const job = longJob();
    run.agent.script = job.script;
    await run.start();
    await run.connect();
    run.sockets.latest.receive(offer('t1'));
    await flush();

    run.sockets.latest.receive({ type: 'paused', paused: true });
    await flush();
    expect(run.sockets.latest.sentOfType('task.failed')[0]).toMatchObject({ taskId: 't1', reason: 'paused' });

    run.sockets.latest.receive(offer('t2'));
    await flush();
    expect(run.sockets.latest.sentOfType('task.reject')).toEqual([{ type: 'task.reject', taskId: 't2', reason: 'paused', message: expect.any(String) }]);

    run.agent.script = async function* () {
      yield { kind: 'result', text: 'Done.' };
    };
    run.sockets.latest.receive({ type: 'paused', paused: false });
    run.sockets.latest.receive(offer('t3'));
    await flush();
    expect(run.sockets.latest.sentOfType('task.done')[0]).toMatchObject({ taskId: 't3' });
  });

  it('refuses what is offered when the office had it paused already when it welcomed the machine', async () => {
    const run = setup();
    await run.start();
    await run.connect(true);
    run.sockets.latest.receive(offer());
    await flush();
    expect(run.sockets.latest.sentOfType('task.reject')[0]).toMatchObject({ reason: 'paused' });
    expect(run.agent.requests).toEqual([]);
  });

  it('is lifted by a welcome that says it is not paused any more', async () => {
    const run = setup();
    await run.start();
    await run.connect(true);
    run.sockets.latest.end({ kind: 'closed', code: 1006 });
    await run.waitItOut();
    await run.connect(false);
    run.sockets.latest.receive(offer());
    await flush();
    expect(run.sockets.latest.sentOfType('task.done')).toHaveLength(1);
  });
});

describe('pausing, on the machine', () => {
  const pauseOnTheMachine = (run: ReturnType<typeof setup>) => {
    // What the owner's own command does, and then what the runner makes of it.
    run.policy.policy = { ...run.policy.policy, paused: true };
    run.connection.localPauseChanged(true);
  };

  it('stops what runs, tells the office, and refuses what is offered', async () => {
    const run = setup();
    const job = longJob();
    run.agent.script = job.script;
    await run.start();
    await run.connect();
    run.sockets.latest.receive(offer('t1'));
    await flush();

    pauseOnTheMachine(run);
    await flush();
    expect(run.sockets.latest.sentOfType('paused')).toEqual([{ type: 'paused', paused: true }]);
    expect(run.sockets.latest.sentOfType('task.failed')[0]).toMatchObject({ taskId: 't1', reason: 'paused' });
    expect(run.statuses.at(-1)).toEqual({ kind: 'paused-on-machine', paused: true });

    run.sockets.latest.receive(offer('t2'));
    await flush();
    expect(run.sockets.latest.sentOfType('task.reject')[0]).toMatchObject({ taskId: 't2', reason: 'paused' });
  });

  it('is told to the office when it is lifted too', async () => {
    const run = setup();
    await run.start();
    await run.connect();
    run.connection.localPauseChanged(false);
    expect(run.sockets.latest.sentOfType('paused')).toEqual([{ type: 'paused', paused: false }]);
    expect(run.statuses.at(-1)).toEqual({ kind: 'paused-on-machine', paused: false });
  });

  it('stops what runs even when there is no connection to tell the office on, and says nothing on a connection that is not there', async () => {
    const run = setup();
    const job = longJob();
    run.agent.script = job.script;
    await run.start();
    await run.connect();
    run.sockets.latest.receive(offer('t1'));
    await flush();
    const first = run.sockets.latest;
    first.end({ kind: 'closed', code: 1006 });
    const sentBefore = first.sent.length;

    pauseOnTheMachine(run);
    await flush();

    expect(first.sent).toHaveLength(sentBefore);
    expect(run.service.runningTask).toBeUndefined();
    expect(run.journal.entries()).toEqual([expect.objectContaining({ taskId: 't1', state: 'failed', reason: 'paused' })]);
    expect(run.crash).toBeUndefined();
  });

  it('says nothing yet to a connection that is open but has not been welcomed, and tells it once it is, since what hello said is out of date', async () => {
    const run = setup();
    await run.start();
    run.sockets.latest.open();
    run.connection.localPauseChanged(true);
    expect(typesSent(run.sockets.latest.sent)).toEqual(['hello']);

    run.sockets.latest.receive(welcome());
    await flush();
    expect(typesSent(run.sockets.latest.sent)).toEqual(['hello', 'paused']);
    expect(run.sockets.latest.sentOfType('paused')).toEqual([{ type: 'paused', paused: true }]);
  });

  it('tells the last of what the owner did in that time, and nothing when that is what hello said', async () => {
    const run = setup();
    await run.start();
    run.sockets.latest.open();
    run.connection.localPauseChanged(true);
    run.connection.localPauseChanged(false);
    run.sockets.latest.receive(welcome());
    await flush();
    expect(typesSent(run.sockets.latest.sent)).toEqual(['hello']);

    const paused = setup(inventoryOf({ agents: [], folders: [], paused: true }));
    await paused.start();
    paused.sockets.latest.open();
    paused.connection.localPauseChanged(false);
    paused.sockets.latest.receive(welcome());
    await flush();
    expect(paused.sockets.latest.sentOfType('paused')).toEqual([{ type: 'paused', paused: false }]);
  });

  it('does not tell a connection that was left what was done after it, and the next one hears it in its own hello', async () => {
    const run = setup();
    await run.start();
    run.sockets.latest.open();
    run.sockets.latest.end({ kind: 'closed', code: 1006 });
    run.connection.localPauseChanged(true);
    expect(run.sockets.latest.sent).toHaveLength(1);
    await run.waitItOut();
    run.sockets.latest.open();
    run.sockets.latest.receive(welcome());
    await flush();
    expect(run.sockets.latest.sentOfType('paused')).toEqual([]);
  });
});

describe('what hello says of the tasks and of the pause', () => {
  it('has how the tasks ended, as the journal has them, and the pause of the machine itself', async () => {
    const run = setup(inventoryOf({ agents: [], folders: ['site'], paused: true }));
    await run.journal.done({ taskId: 'old-1', text: 'Done.', branch: 'escritoriio/old-1', diffStat: null, durationMs: 1_000, truncated: false });
    await run.journal.started('old-2');
    await run.start();
    run.sockets.latest.open();
    expect(run.sockets.latest.sentOfType('hello')[0]).toMatchObject({
      paused: true,
      tasks: [expect.objectContaining({ state: 'done', taskId: 'old-1', branch: 'escritoriio/old-1' }), { state: 'running', taskId: 'old-2' }],
    });
  });

  it('is never more than one frame of what the office takes, however much the tasks that ended said, and still tells of the ones that run and of the newest', async () => {
    const run = setup();
    const said = 'Conclu\u00eddo: a\u00e7\u00e3o, \u4f60\u597d, \u{1F600}\n'.repeat(1_000).slice(0, 8_000);
    for (let index = 0; index < 20; index++) {
      await run.journal.done({ taskId: `done-${index}`, text: said, branch: `escritoriio/done-${index}`, diffStat: ' a.txt | 1 +\n'.repeat(200).slice(0, 2_000), durationMs: 1, truncated: false });
    }
    await run.journal.started('still-running');
    await run.start();
    run.sockets.latest.open();
    const sent = JSON.stringify(run.sockets.latest.sentOfType('hello')[0]);
    expect(new TextEncoder().encode(sent).length).toBeLessThanOrEqual(MAX_RUNNER_MESSAGE_BYTES);
    expect(parseRunnerMessage(sent)).toMatchObject({ ok: true });
    const told = run.sockets.latest.sentOfType('hello')[0]?.tasks.map((entry) => entry.taskId) ?? [];
    expect(told).toContain('still-running');
    expect(told).toContain('done-19');
    expect(told).not.toContain('done-0');
  });

  it('is told again at each connection from the journal as it is then', async () => {
    const run = setup();
    await run.start();
    run.sockets.latest.open();
    expect(run.sockets.latest.sentOfType('hello')[0]).toMatchObject({ tasks: [] });
    run.sockets.latest.end({ kind: 'closed', code: 1006 });
    await run.journal.started('t9');
    await run.waitItOut();
    run.sockets.latest.open();
    expect(run.sockets.latest.sentOfType('hello')[0]).toMatchObject({ tasks: [{ state: 'running', taskId: 't9' }] });
  });
});

describe('a task that is running when the connection drops', () => {
  it('goes on, is reported as running by the next hello, and tells how it ended through the connection that is open then', async () => {
    const run = setup();
    const job = longJob();
    run.agent.script = job.script;
    await run.start();
    await run.connect();
    const first = run.sockets.latest;
    first.receive(offer());
    await flush();
    first.end({ kind: 'closed', code: 1006 });
    await run.waitItOut();
    await run.connect();
    const second = run.sockets.latest;
    expect(second).not.toBe(first);
    expect(second.sentOfType('hello')[0]).toMatchObject({ tasks: [{ state: 'running', taskId: 't1' }] });

    job.release();
    await flush();
    expect(second.sentOfType('task.done')[0]).toMatchObject({ taskId: 't1', text: 'Finished.' });
    expect(first.sentOfType('task.done')).toEqual([]);

    // And a connection after that is told how it came out, since the office may not have heard.
    second.end({ kind: 'closed', code: 1006 });
    await run.waitItOut();
    run.sockets.latest.open();
    expect(run.sockets.latest.sentOfType('hello')[0]).toMatchObject({ tasks: [{ state: 'done', taskId: 't1', text: 'Finished.' }] });
  });

  it('sends nothing on a connection it let go of, and is told how it ended by the journal and not by a message that cannot be sent', async () => {
    const run = setup();
    const job = longJob();
    run.agent.script = job.script;
    await run.start();
    await run.connect();
    const first = run.sockets.latest;
    const attempts: string[] = [];
    const send = first.send.bind(first);
    first.send = (message) => {
      attempts.push(message.type);
      send(message);
    };
    first.receive(offer());
    await flush();
    const before = attempts.length;

    first.end({ kind: 'closed', code: 1006 });
    job.release();
    await flush();

    expect(attempts).toHaveLength(before);
    expect(run.crash).toBeUndefined();
    expect(run.journal.entries()).toEqual([expect.objectContaining({ state: 'done', taskId: 't1' })]);
  });

  it('is not a reason for the next connection to refuse what it is offered: one at a time is the machine’s rule, whichever connection it is on', async () => {
    const run = setup();
    const job = longJob();
    run.agent.script = job.script;
    await run.start();
    await run.connect();
    run.sockets.latest.receive(offer('t1'));
    await flush();
    run.sockets.latest.end({ kind: 'closed', code: 1006 });
    await run.waitItOut();
    await run.connect();
    run.sockets.latest.receive(offer('t2'));
    await flush();
    expect(run.sockets.latest.sentOfType('task.reject')).toEqual([{ type: 'task.reject', taskId: 't2', reason: 'busy', message: expect.any(String) }]);
    job.release();
    await flush();
  });
});

describe('ending the run while a task runs', () => {
  it('stops the task, and does not end the run until the task is gone, with how it ended in the journal', async () => {
    const run = setup();
    const job = longJob();
    run.agent.script = job.script;
    await run.start();
    await run.connect();
    run.sockets.latest.receive(offer());
    await flush();

    run.connection.stop();
    await flush();

    expect(run.end).toEqual({ reason: 'stopped' });
    expect(run.service.runningTask).toBeUndefined();
    expect(run.journal.entries()).toEqual([expect.objectContaining({ taskId: 't1', state: 'failed', reason: 'interrupted' })]);
    expect(run.isolation.made[0]).toMatchObject({ discarded: true, finished: false });
  });

  it('waits for a coding agent that is slow to go, as long as the task itself does, and no longer', async () => {
    const run = setup();
    run.agent.script = async function* () {
      yield { kind: 'text', text: 'Working' };
      await new Promise(() => undefined);
    };
    await run.start();
    await run.connect();
    run.sockets.latest.receive(offer());
    await flush();

    run.connection.stop();
    await flush();
    expect(run.end).toBeUndefined();
    await run.scheduler.advance(ABORT_GRACE_MS);
    expect(run.end).toEqual({ reason: 'stopped' });
  });

  it('stops the task too when the office says that the run cannot go on', async () => {
    const run = setup();
    const job = longJob();
    run.agent.script = job.script;
    await run.start();
    await run.connect();
    run.sockets.latest.receive(offer());
    await flush();
    run.sockets.latest.end({ kind: 'closed', code: RUNNER_CLOSE.revoked });
    await flush();
    expect(run.end).toMatchObject({ reason: 'revoked' });
    expect(run.journal.entries()).toEqual([expect.objectContaining({ taskId: 't1', state: 'failed', reason: 'interrupted' })]);
  });

  it('leaves nothing waiting when there was no task', async () => {
    const run = setup();
    await run.start();
    await run.connect();
    run.connection.stop();
    await flush();
    expect(run.end).toEqual({ reason: 'stopped' });
    expect(run.scheduler.pending).toBe(0);
  });
});

describe('a mistake of the runner while it handles a task', () => {
  const failing = (answerFirst: boolean): TaskHandling => ({
    offer: (offered, send) => {
      if (answerFirst) send({ type: 'task.accept', taskId: offered.taskId });
      return Promise.reject(new Error('Something broke\u001b[2J inside'));
    },
    cancel: () => false,
    setPausedByOffice: () => undefined,
    localPauseChanged: () => undefined,
    stopAll: () => undefined,
  });

  it('is told, and does not stop the connection; the office, which waits for an answer, is told the task was not taken', async () => {
    const run = setup(emptyInventory, failing(false));
    await run.start();
    await run.connect();
    run.sockets.latest.receive(offer());
    await flush();

    expect(run.statuses.at(-1)).toEqual({ kind: 'task-error', message: 'Something broke [2J inside' });
    expect(run.sockets.latest.sentOfType('task.reject')).toEqual([{ type: 'task.reject', taskId: 't1', reason: 'not-allowed', message: expect.stringContaining('did not take the task') }]);
    expect(run.end).toBeUndefined();
    expect(run.crash).toBeUndefined();
    await run.scheduler.advance(RUNNER_PING_MS);
    expect(run.sockets.latest.sentOfType('ping')).toHaveLength(1);
  });

  it('says the task failed when it had been taken already', async () => {
    const run = setup(emptyInventory, failing(true));
    await run.start();
    await run.connect();
    run.sockets.latest.receive(offer());
    await flush();
    expect(typesSent(run.sockets.latest.sent)).toEqual(['hello', 'task.accept', 'task.failed']);
    expect(run.sockets.latest.sentOfType('task.failed')[0]).toMatchObject({ taskId: 't1', reason: 'error' });
    expect(run.end).toBeUndefined();
  });
});

describe('a task that cannot be read', () => {
  const unreadable = (fields: Record<string, unknown>): string => JSON.stringify({ ...offer('t7'), ...fields });

  it.each([
    ['an instruction that is too long', { instruction: 'x'.repeat(TASK_LIMITS.instruction + 1) }],
    ['a coding agent that this runner does not know', { agent: 'gpt-9' }],
    ['a field of a newer office that is of another kind', { folder: { path: '/somewhere' } }],
  ])('is answered with a refusal that says so, for an offer with %s, and is not run', async (_what, fields) => {
    const run = setup();
    await run.start();
    await run.connect();
    run.sockets.latest.receive(unreadable(fields));
    await flush();
    expect(run.sockets.latest.sentOfType('task.reject')).toEqual([
      { type: 'task.reject', taskId: 't7', reason: 'bad-offer', message: 'This machine could not read that task: update the runner or the office.' },
    ]);
    expect(run.statuses.at(-1)).toEqual({ kind: 'offer-unreadable', taskId: 't7' });
    expect(run.agent.requests).toEqual([]);
    expect(run.service.runningTask).toBeUndefined();
    expect(run.end).toBeUndefined();
  });

  it('is what the runner says in words that the person at the terminal reads: not what the office said, but its own', async () => {
    const run = setup();
    await run.start();
    await run.connect();
    run.sockets.latest.receive(unreadable({ agent: 'gpt-9', taskId: 'abc' }));
    await flush();
    expect(describeStatus({ kind: 'offer-unreadable', taskId: 'abc' })).toMatch(/task abc.*could not read.*updating/);
  });

  it.each([
    ['an id that cannot be trusted to be one', { taskId: '../x', agent: 'gpt-9' }],
    ['an id that is too long', { taskId: 'a'.repeat(TASK_LIMITS.taskId + 1), agent: 'gpt-9' }],
    ['a message that is not an offer', { type: 'task.something', agent: 'gpt-9' }],
  ])('is not answered when it is %s: it is ignored, as a newer office may say more than this runner knows', async (_what, fields) => {
    const run = setup();
    await run.start();
    await run.connect();
    run.sockets.latest.receive(unreadable(fields));
    await flush();
    expect(typesSent(run.sockets.latest.sent)).toEqual(['hello']);
    expect(run.statuses.map((status) => status.kind)).toEqual(['connected']);
  });

  it('is not answered before the office has welcomed the machine: nothing that comes before is the real office', async () => {
    const run = setup();
    await run.start();
    run.sockets.latest.open();
    run.sockets.latest.receive(unreadable({ agent: 'gpt-9' }));
    await flush();
    expect(typesSent(run.sockets.latest.sent)).toEqual(['hello']);
  });

  it('does not stop the next offer, which is read, from being run', async () => {
    const run = setup();
    await run.start();
    await run.connect();
    run.sockets.latest.receive(unreadable({ agent: 'gpt-9' }));
    run.sockets.latest.receive(offer('t8'));
    await flush();
    expect(run.sockets.latest.sentOfType('task.done')[0]).toMatchObject({ taskId: 't8' });
  });
});

describe('what happens to a task between the hello and the welcome', () => {
  /** A task that is running when its connection drops, and whose end is told by the connection that comes next: a script that goes on at the word of the test. */
  function heldTask(then: readonly AgentEvent[]) {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    const script = async function* (): AsyncGenerator<AgentEvent> {
      yield { kind: 'text', text: 'Working' };
      await released;
      yield* then;
    };
    return { release, script };
  }

  /** The task is running, the connection it was offered on is gone, and a new one is open: the hello is said, the office has not answered. */
  async function reconnectedWhileRunning(task: ReturnType<typeof heldTask>) {
    const run = setup();
    run.agent.script = task.script;
    await run.start();
    await run.connect();
    run.sockets.latest.receive(offer());
    await flush();
    run.sockets.latest.end({ kind: 'closed', code: 1006 });
    await run.waitItOut();
    run.sockets.latest.open();
    return run;
  }

  it('is told once the office has welcomed the machine, when the task ended in that time', async () => {
    const task = heldTask([{ kind: 'result', text: 'Finished.' }]);
    const run = await reconnectedWhileRunning(task);
    expect(run.sockets.latest.sentOfType('hello')[0]).toMatchObject({ tasks: [{ state: 'running', taskId: 't1' }] });

    task.release();
    await flush();
    expect(typesSent(run.sockets.latest.sent)).toEqual(['hello']);

    run.sockets.latest.receive(welcome());
    await flush();
    expect(typesSent(run.sockets.latest.sent)).toEqual(['hello', 'task.done']);
    expect(run.sockets.latest.sentOfType('task.done')[0]).toMatchObject({ taskId: 't1', text: 'Finished.' });
  });

  it('is told the same when the task failed in that time', async () => {
    const task = heldTask([{ kind: 'error', message: 'The coding agent crashed.' }]);
    const run = await reconnectedWhileRunning(task);
    task.release();
    await flush();
    run.sockets.latest.receive(welcome());
    await flush();
    expect(run.sockets.latest.sentOfType('task.failed')).toEqual([{ type: 'task.failed', taskId: 't1', reason: 'error', message: 'The coding agent crashed.', durationMs: expect.any(Number) }]);
  });

  it('is told what it said as it went, in order, before how it ended, and the events keep their numbers', async () => {
    const task = heldTask([
      { kind: 'text', text: 'one' },
      { kind: 'tool', name: 'Read', summary: './a.txt', denied: false },
      { kind: 'result', text: 'Finished.' },
    ]);
    const run = await reconnectedWhileRunning(task);
    task.release();
    await flush();
    run.sockets.latest.receive(welcome());
    await flush();
    expect(typesSent(run.sockets.latest.sent)).toEqual(['hello', 'task.event', 'task.event', 'task.done']);
    expect(run.sockets.latest.sentOfType('task.event').map((message) => message.seq)).toEqual([1, 2]);
  });

  it('is told in the ending that what the task said while nobody listened is lost', async () => {
    const task = heldTask([
      { kind: 'text', text: 'one' },
      { kind: 'result', text: 'Finished.' },
    ]);
    const run = setup();
    run.agent.script = task.script;
    await run.start();
    await run.connect();
    run.sockets.latest.receive(offer());
    await flush();
    run.sockets.latest.end({ kind: 'closed', code: 1006 });
    // It goes on while there is no connection: what it says is said to nobody.
    task.release();
    await flush();
    await run.waitItOut();
    run.sockets.latest.open();
    expect(run.sockets.latest.sentOfType('hello')[0]).toMatchObject({ tasks: [{ state: 'done', taskId: 't1', truncated: true }] });
  });

  it('is not told twice: what the journal has and what the task said are one ending', async () => {
    const task = heldTask([{ kind: 'result', text: 'Finished.' }]);
    const run = await reconnectedWhileRunning(task);
    task.release();
    await flush();
    run.sockets.latest.receive(welcome());
    await flush();
    await run.scheduler.advance(RUNNER_PING_MS);
    expect(run.sockets.latest.sentOfType('task.done')).toHaveLength(1);
    expect(run.journal.entries()).toEqual([expect.objectContaining({ state: 'done', taskId: 't1' })]);
  });

  it('is told from the journal when it ended and nothing was said of it', async () => {
    const run = setup();
    await run.journal.started('t9');
    await run.start();
    run.sockets.latest.open();
    expect(run.sockets.latest.sentOfType('hello')[0]).toMatchObject({ tasks: [{ state: 'running', taskId: 't9' }] });

    await run.journal.failed({ taskId: 't9', reason: 'interrupted', message: 'The runner stopped while this task was running.', durationMs: 5 });
    await run.journal.done({ taskId: 't10', text: 'Not one that hello said was running.', branch: null, diffStat: null, durationMs: 1, truncated: false });
    run.sockets.latest.receive(welcome());
    await flush();

    expect(run.sockets.latest.sentOfType('task.failed')).toEqual([{ type: 'task.failed', taskId: 't9', reason: 'interrupted', message: 'The runner stopped while this task was running.', durationMs: 5 }]);
    expect(run.sockets.latest.sentOfType('task.done')).toEqual([]);
  });

  it('is nothing that was said before the hello, which the hello told by itself', async () => {
    const run = setup();
    run.agent.script = async function* () {
      yield { kind: 'result', text: 'Done.' };
    };
    await run.start();
    await run.connect();
    run.sockets.latest.receive(offer());
    await flush();
    run.sockets.latest.end({ kind: 'closed', code: 1006 });
    await run.waitItOut();
    run.sockets.latest.open();
    expect(run.sockets.latest.sentOfType('hello')[0]).toMatchObject({ tasks: [{ state: 'done', taskId: 't1' }] });
    run.sockets.latest.receive(welcome());
    await flush();
    expect(typesSent(run.sockets.latest.sent)).toEqual(['hello']);
  });

  it('keeps no more than it can, dropping the oldest of what the task did as it went and never how it ended', async () => {
    const many: AgentEvent[] = Array.from({ length: 300 }, (_, index) => ({ kind: 'tool', name: 'Read', summary: `./file-${index}.txt`, denied: false }));
    const task = heldTask([...many, { kind: 'result', text: 'Finished.' }]);
    const run = await reconnectedWhileRunning(task);
    task.release();
    await flush();
    run.sockets.latest.receive(welcome());
    await flush();
    await run.scheduler.advance(30_000);

    const events = run.sockets.latest.sentOfType('task.event');
    expect(events.length).toBeLessThanOrEqual(OUTBOX_LIMIT);
    expect(events.length).toBeGreaterThan(OUTBOX_LIMIT - 5);
    // The newest are what is left, in order, up to the last.
    expect(events.at(-1)?.seq).toBe(300);
    expect(events.map((message) => message.seq)).toEqual([...events.map((message) => message.seq)].sort((a, b) => a - b));
    expect(run.sockets.latest.sentOfType('task.done')).toHaveLength(1);
    expect(typesSent(run.sockets.latest.sent).filter((type) => type !== 'ping').at(-1)).toBe('task.done');
  });
});

describe('a long answer', () => {
  const longAnswer = (pieces: number): AgentEvent[] => [
    ...Array.from({ length: pieces }, (_, index): AgentEvent => ({ kind: 'text', text: `${index}`.padEnd(TASK_LIMITS.eventText, '.') })),
    { kind: 'result', text: 'Done.' },
  ];
  /** Many small things that the coding agent did, which fit the output of a task by the hundred. */
  const manySteps = (count: number): AgentEvent[] => [
    ...Array.from({ length: count }, (_, index): AgentEvent => ({ kind: 'tool', name: 'Read', summary: `./file-${index}.txt`, denied: false })),
    { kind: 'result', text: 'Done.' },
  ];

  it('goes at a pace the office takes: the first events at once, the rest as the time goes, and the end of the task after them', async () => {
    const run = setup();
    run.agent.script = async function* () {
      yield* longAnswer(30);
    };
    await run.start();
    await run.connect();
    run.sockets.latest.receive(offer());
    await flush();

    const first = run.sockets.latest.sentOfType('task.event');
    expect(first).toHaveLength(EVENT_BURST);
    expect(run.sockets.latest.sentOfType('task.done')).toEqual([]);
    expect(run.scheduler.pending).toBeGreaterThan(0);

    await run.scheduler.advance(1_000);
    const events = run.sockets.latest.sentOfType('task.event');
    expect(events.map((message) => message.seq)).toEqual(Array.from({ length: 30 }, (_, index) => index));
    expect(typesSent(run.sockets.latest.sent)).toEqual(['hello', 'task.accept', ...Array.from({ length: 30 }, () => 'task.event'), 'task.done']);
  });

  it('is never faster than the pace once the first events have gone', async () => {
    const run = setup();
    run.agent.script = async function* () {
      yield* manySteps(60);
    };
    await run.start();
    await run.connect();
    run.sockets.latest.receive(offer());
    await flush();
    const sentAtOnce = run.sockets.latest.sentOfType('task.event').length;
    await run.scheduler.advance(1_000);
    const afterASecond = run.sockets.latest.sentOfType('task.event').length;
    expect(afterASecond - sentAtOnce).toBeLessThanOrEqual(EVENTS_PER_SECOND + 1);
    expect(run.sockets.latest.sentOfType('task.done')).toEqual([]);
    await run.scheduler.advance(10_000);
    expect(run.sockets.latest.sentOfType('task.event')).toHaveLength(60);
  });

  it('is not waited for by what is not an event of a task: a pause is told at once', async () => {
    const run = setup();
    run.agent.script = async function* () {
      yield* longAnswer(30);
    };
    await run.start();
    await run.connect();
    run.sockets.latest.receive(offer());
    await flush();
    run.connection.localPauseChanged(true);
    expect(run.sockets.latest.sentOfType('paused')).toEqual([{ type: 'paused', paused: true }]);
    await run.scheduler.advance(2_000);
  });

  it('is dropped with the connection, and leaves nothing waiting for a time', async () => {
    const run = setup();
    run.agent.script = async function* () {
      yield* manySteps(60);
    };
    await run.start();
    await run.connect();
    run.sockets.latest.receive(offer());
    await flush();
    const first = run.sockets.latest;
    const sent = first.sent.length;
    first.end({ kind: 'closed', code: 1006 });
    await run.scheduler.advance(5_000);
    expect(first.sent).toHaveLength(sent);
  });

  it('leaves no timer behind when the run is stopped while it waits', async () => {
    const run = setup();
    run.agent.script = async function* () {
      yield* manySteps(60);
    };
    await run.start();
    await run.connect();
    run.sockets.latest.receive(offer());
    await flush();
    run.connection.stop();
    await flush();
    expect(run.scheduler.pending).toBe(0);
  });
});

describe('the MCP servers of the machine', () => {
  const list: McpListRequest = { type: 'mcp.list', id: 'r1', server: 'notes' };
  const call: McpCallRequest = { type: 'mcp.call', id: 'r2', server: 'notes', tool: 'search', arguments: { q: 'milk' }, timeoutMs: 20_000 };

  /** An office side that records what it was asked and answers as a test says, one answer at a time. */
  function handling() {
    const asked: string[] = [];
    const pauses: boolean[] = [];
    let stopped = 0;
    const answers: ((value: Awaited<ReturnType<McpHandling['list'] | McpHandling['call']>>) => void)[] = [];
    const mcp: McpHandling = {
      list: (request) => {
        asked.push(`list ${request.server}`);
        return new Promise((resolve) => answers.push(resolve as never));
      },
      call: (request) => {
        asked.push(`call ${request.server} ${request.tool}`);
        return new Promise((resolve) => answers.push(resolve as never));
      },
      setPausedByOffice: (paused) => void pauses.push(paused),
      stopAll: () => void (stopped += 1),
    };
    return { mcp, asked, pauses, answers, stopped: () => stopped };
  }

  it('tells the office which servers it has, by label, in hello', async () => {
    const run = setup(inventoryOf({ agents: [], folders: [], mcpServers: ['notes', 'files'] }));
    await run.start();
    run.sockets.latest.open();
    expect(run.sockets.latest.sent[0]).toMatchObject({ type: 'hello', mcpServers: ['notes', 'files'] });
  });

  it('answers the office’s request to list the tools of a server, and its request to call one', async () => {
    const mcp = handling();
    const run = setup(emptyInventory, undefined, mcp.mcp);
    await run.start();
    await run.connect();
    run.sockets.latest.receive(list);
    run.sockets.latest.receive(call);
    await flush();
    expect(mcp.asked).toEqual(['list notes', 'call notes search']);
    mcp.answers[0]?.({ type: 'mcp.listed', id: 'r1', server: { name: 'Notes' }, tools: [], held: 0, omitted: 0 });
    mcp.answers[1]?.({ type: 'mcp.answered', id: 'r2', text: 'two notes', isError: false });
    await flush();
    expect(run.sockets.latest.sentOfType('mcp.listed')).toHaveLength(1);
    expect(run.sockets.latest.sentOfType('mcp.answered')).toEqual([{ type: 'mcp.answered', id: 'r2', text: 'two notes', isError: false }]);
  });

  it('serves nothing the office asks before it has welcomed the machine: that is what says a connection is the real one', async () => {
    const mcp = handling();
    const run = setup(emptyInventory, undefined, mcp.mcp);
    await run.start();
    run.sockets.latest.open();
    run.sockets.latest.receive(list);
    await flush();
    expect(mcp.asked).toEqual([]);
  });

  it('says that the program did not answer, and reports it, when it fails in a way nobody foresaw', async () => {
    const run = setup(emptyInventory, undefined, { ...idleTasks.mcp, list: () => Promise.reject(new Error('a mistake of this program')) });
    await run.start();
    await run.connect();
    run.sockets.latest.receive(list);
    await flush();
    expect(run.sockets.latest.sentOfType('mcp.failed')).toEqual([{ type: 'mcp.failed', id: 'r1', failure: 'unreachable' }]);
    expect(run.statuses).toContainEqual({ kind: 'mcp-error', message: 'a mistake of this program' });
  });

  it('says nothing of an answer that comes after its connection went, and not on the one that replaced it', async () => {
    const mcp = handling();
    const run = setup(emptyInventory, undefined, mcp.mcp);
    await run.start();
    await run.connect();
    const first = run.sockets.latest;
    first.receive(list);
    await flush();
    first.end({ kind: 'closed', code: 1006 });
    await run.waitItOut();
    await run.connect();
    mcp.answers[0]?.({ type: 'mcp.listed', id: 'r1', server: { name: 'Notes' }, tools: [], held: 0, omitted: 0 });
    await flush();
    expect(first.sentOfType('mcp.listed')).toEqual([]);
    expect(run.sockets.latest.sentOfType('mcp.listed')).toEqual([]);
  });

  it('is told when the office pauses the machine, and when it lets it work again', async () => {
    const mcp = handling();
    const run = setup(emptyInventory, undefined, mcp.mcp);
    await run.start();
    run.sockets.latest.open();
    run.sockets.latest.receive(welcome({ paused: true }));
    run.sockets.latest.receive({ type: 'paused', paused: false });
    await flush();
    expect(mcp.pauses).toEqual([true, false]);
  });

  it('ends the programs that run for the office when it is stopped', async () => {
    const mcp = handling();
    const run = setup(emptyInventory, undefined, mcp.mcp);
    await run.start();
    await run.connect();
    run.connection.stop();
    await flush();
    expect(mcp.stopped()).toBeGreaterThan(0);
  });
});
