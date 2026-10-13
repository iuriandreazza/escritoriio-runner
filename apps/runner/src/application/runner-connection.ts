import type { JournalEntry, McpCallRequest, McpListRequest, RunnerToServer, ServerToRunner, TaskOffer } from '@escritoriio/runner-protocol';
import { MAX_RUNNER_MESSAGE_BYTES, parseServerMessage, RUNNER_PING_MS, RUNNER_PROTOCOL_VERSION, runnerSocketAddress } from '@escritoriio/runner-protocol';
import { reconnectDelay, SLOW_RETRY_MS } from '../domain/backoff.ts';
import { byteLength } from '../domain/byte-length.ts';
import type { ConnectionEnd, Decision, StopCause } from '../domain/connection-end.ts';
import { decideAfter } from '../domain/connection-end.ts';
import type { PairedDevice } from '../domain/paired-device.ts';
import { serverHost } from '../domain/paired-device.ts';
import { displayName, plainText } from '../domain/plain-text.ts';
import { tasksThatFit } from '../domain/tasks-that-fit.ts';
import { idOfUnreadableOffer } from '../domain/unreadable-offer.ts';
import type { McpRequests } from './mcp-requests.ts';
import type { Inventory, MachineInventory, RunnerSocket, Scheduler, SocketFactory } from './ports.ts';
import type { RunnerStatus } from './status.ts';
import { TaskOutbox } from './task-outbox.ts';
import type { TaskJournal } from './task-journal.ts';
import type { TaskService } from './task-service.ts';

/** How long a connection has, from the moment it is dialed, to open, say hello and be welcomed. One time for all of it: a connection that hangs before it opens is no better than one that opens and stays silent. */
export const WELCOME_TIMEOUT_MS = 10_000;

/** What is left out of the size of a frame, for what may come to be counted differently. */
const HELLO_MARGIN_BYTES = 512;

/** A ping that nobody answered by the time of the second one after it means the link is dead, though the socket still looks open: a path that dropped it without a word. */
const UNANSWERED_PINGS_BEFORE_DEAD = 2;

/** How a run ended: because it was told to, or because trying again cannot help and a person has to act. */
export type RunnerEnd = { readonly reason: 'stopped' } | { readonly reason: StopCause; readonly message: string };

/** What the connection asks of the part of the runner that runs tasks. */
export type TaskHandling = Pick<TaskService, 'offer' | 'cancel' | 'setPausedByOffice' | 'localPauseChanged' | 'stopAll'>;

/** What the connection asks of the part of the runner that serves the office's requests for the MCP servers of the machine. */
export type McpHandling = Pick<McpRequests, 'list' | 'call' | 'setPausedByOffice' | 'stopAll'>;

export interface RunnerConnectionDeps {
  readonly device: PairedDevice;
  readonly runnerVersion: string;
  readonly os: string;
  readonly sockets: SocketFactory;
  readonly scheduler: Scheduler;
  readonly inventory: Inventory;
  readonly tasks: TaskHandling;
  readonly mcp: McpHandling;
  /** How the tasks ended, which `hello` tells the office when a connection comes back. */
  readonly journal: Pick<TaskJournal, 'entries'>;
  readonly report: (status: RunnerStatus) => void;
}

/** What `hello` said, so that what changed after it and before the welcome can be told once the office has welcomed the machine. */
interface Hello {
  /** Whether the machine was paused on the machine itself. */
  readonly paused: boolean;
  /** The tasks that it said were running: the office thinks of them as running until it hears otherwise. */
  readonly running: ReadonlySet<string>;
}

/** One try at a connection. What it holds is its own, so that whatever a try that was given up on says later is not taken for the one that replaced it. */
interface Session {
  socket: RunnerSocket | undefined;
  welcomed: boolean;
  unansweredPings: number;
  cancelWelcome: (() => void) | undefined;
  cancelPing: (() => void) | undefined;
  /** Set when `hello` is sent: before that, how the tasks end is in the journal, which `hello` tells. */
  hello: Hello | undefined;
  /** What is said of the tasks, from `hello` on. */
  outbox: TaskOutbox | undefined;
  /** The last time the owner paused or resumed the machine on the machine itself after the connection began, until the office has welcomed it. */
  pausedSince: boolean | undefined;
}

interface Settlement {
  readonly resolve: (end: RunnerEnd) => void;
  readonly reject: (error: unknown) => void;
}

const TASK_NOT_TAKEN = 'This machine could not check its own rules, so it did not take the task.';
const TASK_BROKE = 'The runner failed while it ran the task.';
const TASK_UNREADABLE = 'This machine could not read that task: update the runner or the office.';

/** What a journal says of a task that ended, as the message that tells the office. */
function endOf(entry: Exclude<JournalEntry, { state: 'running' }>): RunnerToServer {
  if (entry.state === 'done') {
    const { state: _state, ...done } = entry;
    return { type: 'task.done', ...done };
  }
  const { state: _state, ...failed } = entry;
  return { type: 'task.failed', ...failed };
}

/**
 * The runner's connection to its office: it dials out, says hello, keeps the link alive and, when it breaks, dials again with a growing
 * wait, until it is stopped or the office says that trying again cannot help. The tasks the office offers are handed to the part that
 * runs them, which answers through whatever connection is open at the time: a task goes on when the link drops, and how it ended is in
 * the journal, which the next `hello` tells.
 */
export class RunnerConnection {
  private readonly deps: RunnerConnectionDeps;
  private settlement: Settlement | undefined;
  private session: Session | undefined;
  private cancelRetry: (() => void) | undefined;
  private failures = 0;
  private readonly offers = new Set<Promise<void>>();
  /** The tasks that lost events that were not said, here or on a connection before: their ending says so. */
  private readonly tasksThatLostEvents = new Set<string>();

  constructor(deps: RunnerConnectionDeps) {
    this.deps = deps;
  }

  /** Connects and stays connected. The answer comes when the run ends: when it is stopped, or when the office says to stop. */
  start(): Promise<RunnerEnd> {
    if (this.settlement) return Promise.reject(new Error('The runner is already running'));
    this.failures = 0;
    return new Promise((resolve, reject) => {
      // What runs is stopped when the run ends, and the run is not over until it has: a coding agent that was told to stop is still being
      // taken away, with the copy of the folder it worked in, for a moment.
      this.settlement = {
        resolve: (end) => void this.tasksEnded().then(() => resolve(end)),
        reject: (error) => void this.tasksEnded().then(() => reject(error)),
      };
      this.connect();
    });
  }

  stop(): void {
    this.shutDown()?.resolve({ reason: 'stopped' });
  }

  /** Its owner paused or resumed the machine on the machine itself: what runs is stopped, and the office is told if it can be. */
  localPauseChanged(paused: boolean): void {
    this.deps.tasks.localPauseChanged(paused);
    const session = this.session;
    if (session?.welcomed) this.send(session, { type: 'paused', paused });
    // Not welcomed yet: what `hello` said may be out of date by the time the office hears it, and it is told when it is welcomed.
    else if (session) session.pausedSince = paused;
    this.deps.report({ kind: 'paused-on-machine', paused });
  }

  private connect(): void {
    this.attempt().catch((error: unknown) => this.shutDown()?.reject(error));
  }

  private async attempt(): Promise<void> {
    const { device, scheduler, sockets } = this.deps;
    const session: Session = { socket: undefined, welcomed: false, unansweredPings: 0, cancelWelcome: undefined, cancelPing: undefined, hello: undefined, outbox: undefined, pausedSince: undefined };
    this.session = session;
    const inventory = await this.deps.inventory.read();
    // It may have been stopped while it looked at the machine.
    if (this.session !== session) return;

    session.cancelWelcome = scheduler.after(WELCOME_TIMEOUT_MS, () => this.lose(session, 'the office did not welcome this machine in time'));
    session.socket = sockets.open(runnerSocketAddress(device.server), device.token, {
      onOpen: () => this.opened(session, inventory),
      onMessage: (raw) => this.received(session, raw),
      onEnd: (end) => this.ended(session, end),
    });
  }

  private opened(session: Session, inventory: MachineInventory): void {
    if (this.session !== session) return;
    const { runnerVersion, os, journal } = this.deps;
    const hello: Extract<RunnerToServer, { type: 'hello' }> = {
      type: 'hello',
      protocol: RUNNER_PROTOCOL_VERSION,
      runnerVersion,
      os,
      agents: [...inventory.agents],
      folders: [...inventory.folders],
      mcpServers: [...inventory.mcpServers],
      paused: inventory.paused,
      tasks: [],
    };
    // What the office takes is one frame at most, and a hello that is over it is refused again at every connection until the tasks age out.
    const told = journal.entries().map((entry) => (entry.state === 'done' && this.tasksThatLostEvents.has(entry.taskId) ? { ...entry, truncated: true } : entry));
    const tasks = tasksThatFit(told, byteLength(JSON.stringify(hello)), MAX_RUNNER_MESSAGE_BYTES - HELLO_MARGIN_BYTES);
    session.socket?.send({ ...hello, tasks });
    // From here what happens to a task is not in what `hello` said, so it is said, once the office has welcomed the machine.
    session.hello = { paused: hello.paused, running: new Set(tasks.filter((task) => task.state === 'running').map((task) => task.taskId)) };
    session.outbox = new TaskOutbox((message) => this.write(session, message), this.deps.scheduler, this.tasksThatLostEvents);
  }

  private received(session: Session, raw: string): void {
    if (this.session !== session) return;
    const parsed = parseServerMessage(raw);
    // What this runner does not understand is ignored, since a newer office may say more than it knows. Except a task that it was offered
    // and could not read: the office waits for an answer to that, so it is told, in the one word it has for it.
    if (!parsed.ok) return session.welcomed ? this.refuseUnreadableOffer(session, raw) : undefined;
    const message = parsed.message;
    switch (message.type) {
      case 'welcome':
        return this.welcomed(session, message);
      case 'pong':
        session.unansweredPings = 0;
        // The first answer to a ping is what shows that a connection held: a welcome alone does not, since a link that something in the
        // path cuts a moment after it, again and again, would be dialed every second for ever. The next failure is the first one again.
        this.failures = 0;
        return;
      case 'paused':
        this.deps.tasks.setPausedByOffice(message.paused);
        this.deps.mcp.setPausedByOffice(message.paused);
        return this.deps.report({ kind: 'paused-by-office', paused: message.paused });
      case 'error':
        return this.deps.report({ kind: 'office-complained' });
      // Nothing is offered or cancelled before the office has welcomed the machine: it is what says that a connection is the real one.
      case 'task.offer':
        return session.welcomed ? this.offered(message) : undefined;
      case 'task.cancel':
        if (session.welcomed) this.deps.tasks.cancel(message.taskId);
        return;
      case 'mcp.list':
      case 'mcp.call':
        return session.welcomed ? this.serveMcp(session, message) : undefined;
    }
  }

  /**
   * Answers a request of the office for a local MCP server, on the connection it came on: one that went meanwhile has nobody to hear it, and
   * what was asked on it is asked again by the office when it needs it. A mistake of this program is told here, and the office, which waits for
   * an answer, is told in the one word it has for it.
   */
  private serveMcp(session: Session, request: McpListRequest | McpCallRequest): void {
    const answering = (request.type === 'mcp.list' ? this.deps.mcp.list(request) : this.deps.mcp.call(request)).then(
      (answer) => this.send(session, answer),
      (error: unknown) => {
        this.deps.report({ kind: 'mcp-error', message: error instanceof Error ? plainText(error.message) : 'an error that is not an Error' });
        this.send(session, { type: 'mcp.failed', id: request.id, failure: 'unreachable' });
      },
    );
    this.offers.add(answering);
    void answering.finally(() => this.offers.delete(answering));
  }

  private refuseUnreadableOffer(session: Session, raw: string): void {
    const taskId = idOfUnreadableOffer(raw);
    if (taskId === undefined) return;
    this.send(session, { type: 'task.reject', taskId, reason: 'bad-offer', message: TASK_UNREADABLE });
    this.deps.report({ kind: 'offer-unreadable', taskId });
  }

  private offered(offer: TaskOffer): void {
    let answer: 'none' | 'accepted' | 'ended' = 'none';
    const send = (message: RunnerToServer): void => {
      if (message.type === 'task.accept') answer = 'accepted';
      else if (message.type === 'task.reject' || message.type === 'task.done' || message.type === 'task.failed') answer = 'ended';
      this.sendToOffice(message);
    };
    // Not a way a task ends but a mistake of this program: it is told here and never stops the connection, and the office, which waits
    // for an answer, gets the one that is left to give.
    const running = this.deps.tasks.offer(offer, send).catch((error: unknown) => {
      this.deps.report({ kind: 'task-error', message: error instanceof Error ? plainText(error.message) : 'an error that is not an Error' });
      if (answer === 'none') this.sendToOffice({ type: 'task.reject', taskId: offer.taskId, reason: 'not-allowed', message: TASK_NOT_TAKEN });
      else if (answer === 'accepted') this.sendToOffice({ type: 'task.failed', taskId: offer.taskId, reason: 'error', message: TASK_BROKE, durationMs: 0 });
    });
    this.offers.add(running);
    void running.finally(() => this.offers.delete(running));
  }

  /**
   * Tells the office of a task through the connection that is open, if there is one: it waits for the welcome when `hello` is said and the
   * office has not welcomed the machine yet. A task that outlives its connection says nothing until another opens, and how it ended is in the
   * journal, which the next `hello` tells.
   */
  private sendToOffice(message: RunnerToServer): void {
    const outbox = this.session?.outbox;
    if (outbox) return outbox.push(message);
    // Said to nobody: the gap in the numbers of its events is there, and the ending says so when it is said.
    if (message.type === 'task.event') this.tasksThatLostEvents.add(message.taskId);
  }

  /** Says something now, on a connection that is open. */
  private send(session: Session, message: RunnerToServer): void {
    if (this.session !== session) return;
    this.write(session, message);
  }

  private write(session: Session, message: RunnerToServer): void {
    try {
      session.socket?.send(message);
    } catch {
      // A link that is going down says so through its own handlers; what was sent on it meanwhile is lost, and the journal has how the task ended.
    }
  }

  private tasksEnded(): Promise<unknown> {
    return Promise.allSettled([...this.offers]);
  }

  private welcomed(session: Session, welcome: Extract<ServerToRunner, { type: 'welcome' }>): void {
    if (session.welcomed) return;
    session.welcomed = true;
    session.cancelWelcome?.();
    session.cancelWelcome = undefined;
    this.deps.tasks.setPausedByOffice(welcome.paused);
    this.deps.mcp.setPausedByOffice(welcome.paused);
    this.deps.report({
      kind: 'connected',
      host: serverHost(this.deps.device.server),
      deviceName: displayName(welcome.device.name),
      agentName: displayName(welcome.agent.name),
      workspaceName: displayName(welcome.workspace.name),
      paused: welcome.paused,
    });
    this.catchUp(session);
    this.keepAlive(session);
  }

  /** Tells what happened between `hello` and the welcome, which the office did not know when it welcomed the machine. */
  private catchUp(session: Session): void {
    const { hello, outbox } = session;
    if (!hello || !outbox) return;
    if (session.pausedSince !== undefined && session.pausedSince !== hello.paused) this.send(session, { type: 'paused', paused: session.pausedSince });
    // A task that `hello` said was running and that has ended since, with nothing said of it: what the journal has is what is told.
    for (const entry of this.deps.journal.entries()) {
      if (entry.state !== 'running' && hello.running.has(entry.taskId)) outbox.pushUnlessTold(endOf(entry));
    }
    outbox.welcome();
  }

  private keepAlive(session: Session): void {
    session.cancelPing = this.deps.scheduler.after(RUNNER_PING_MS, () => {
      if (session.unansweredPings >= UNANSWERED_PINGS_BEFORE_DEAD) return this.lose(session, 'the office stopped answering');
      session.socket?.send({ type: 'ping' });
      session.unansweredPings += 1;
      this.keepAlive(session);
    });
  }

  /** A connection that is open or being opened but that nothing comes through: it is hung up on and replaced. */
  private lose(session: Session, reason: string): void {
    this.ended(session, { kind: 'failed', reason });
  }

  private ended(session: Session, end: ConnectionEnd): void {
    if (this.session !== session) return;
    const decision = decideAfter(end);
    if (decision.action === 'stop') return void this.shutDown()?.resolve({ reason: decision.cause, message: decision.message });
    this.retryLater(decision);
  }

  private retryLater(decision: Extract<Decision, { action: 'retry' }>): void {
    const { scheduler, report } = this.deps;
    this.abandon();
    const inMs = decision.slow ? SLOW_RETRY_MS : reconnectDelay(this.failures++, () => scheduler.random());
    report({ kind: 'reconnecting', inMs, slow: decision.slow, reason: decision.reason });
    this.cancelRetry = scheduler.after(inMs, () => {
      this.cancelRetry = undefined;
      this.connect();
    });
  }

  /** Lets go of the connection that is in hand: its timers stop and the socket is hung up on, and nothing it says after is heard. */
  private abandon(): void {
    const session = this.session;
    this.session = undefined;
    session?.cancelWelcome?.();
    session?.cancelPing?.();
    session?.outbox?.close();
    session?.socket?.close();
  }

  /** Ends the run: nothing is left running or waiting. The way it ends is for the caller to say. */
  private shutDown(): Settlement | undefined {
    const settlement = this.settlement;
    this.settlement = undefined;
    this.deps.tasks.stopAll();
    this.deps.mcp.stopAll();
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    this.abandon();
    return settlement;
  }
}
