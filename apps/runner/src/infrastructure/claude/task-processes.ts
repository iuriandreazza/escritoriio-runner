import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { createProcessTable } from './process-table.ts';
import type { ProcessTable } from './process-table.ts';

/** The name of the entry that every process of a task carries in its environment. It names the task and is no secret: it is there to be found. */
export const TASK_MARKER_NAME = 'ESCRITORIIO_TASK';

/** How long Claude Code is left to end by itself once it was told to: the Agent SDK closes its input, waits two seconds, and then ends it. */
const EXIT_GRACE_MS = 2_500;
/** How long what was asked to end is left to do so before it is made to. */
const END_GRACE_MS = 1_000;
const POLL_MS = 50;
const END_TREE_TIMEOUT_MS = 5_000;
/**
 * How long all of it may take, counted from the start of the clean up: no new look for what was left is begun after that. Whoever runs a
 * task gives up on a coding agent that is slow to stop, and then takes the folder of the task away, so what has to be found is found
 * while it is still there, and a search that is slow is not worth more than that.
 */
const CLEAN_UP_BUDGET_MS = 6_000;
/** Looking again after ending what was found: a command that starts others as fast as they end is not ended by looking once. */
const SWEEP_ROUNDS = 3;

/** What the runner needs of the system to start the program of a task and to end what it left, apart so that none of it has to be real in a test. */
export interface ProcessControl {
  readonly platform: NodeJS.Platform;
  readonly table: ProcessTable;
  start(command: string, args: readonly string[], options: { readonly cwd: string | undefined; readonly env: Readonly<Record<string, string | undefined>>; readonly detached: boolean }): ChildProcess;
  /** Sends a signal to a process, or to every process of a group when the id is negative. False when there is no such process; 0 only asks. */
  signal(id: number, signal: NodeJS.Signals | 0): boolean;
  /** Ends a process and every process it started, as far as it is still their parent (Windows). It never rejects. */
  endTree(pid: number): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** Milliseconds, from any starting point. */
  now(): number;
  newId(): string;
}

export interface TaskScope {
  /** Whether the task can run commands. Only then is there anything to look for after Claude Code itself has ended. */
  readonly commands: boolean;
  /** The folder of the task when the runner made it for this task alone, so that no process has a reason to work in it once the task is over, unless it was left there. */
  readonly ownFolder: string | undefined;
}

/** The processes of one task: how Claude Code is started, and how everything it left behind is ended. */
export interface TaskProcesses {
  readonly spawn: (options: SpawnOptions) => SpawnedProcess;
  /** Ends Claude Code, if it has not ended, and everything of the task that is still running. It never rejects, and what it does the first time it does not do again. */
  cleanUp(): Promise<void>;
}

/** Asks each to end, gives them a moment, and then makes the ones that are left. */
async function endProcesses(ids: readonly number[], control: ProcessControl): Promise<void> {
  let alive = ids.filter((id) => control.signal(id, 'SIGTERM'));
  for (let waited = 0; alive.length > 0 && waited < END_GRACE_MS; waited += POLL_MS) {
    await control.sleep(POLL_MS);
    alive = alive.filter((id) => control.signal(id, 0));
  }
  for (const id of alive) control.signal(id, 'SIGKILL');
  if (alive.length > 0) await control.sleep(POLL_MS);
}

async function until(done: () => boolean, ms: number, control: ProcessControl): Promise<void> {
  for (let waited = 0; !done() && waited < ms; waited += POLL_MS) await control.sleep(POLL_MS);
}

const hasEnded = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;

/**
 * Claude Code as a process that the runner can end with all of its own. It is started as the leader of a group, so that one signal reaches
 * the group; and it is started with an entry in its environment that its descendants inherit, so that those that left the group on
 * purpose, as a command can, are found afterwards by the entry. What neither reaches is left to the system: see `ProcessTable`.
 */
export function createTaskProcesses(control: ProcessControl, scope: TaskScope): TaskProcesses {
  const entry = `${TASK_MARKER_NAME}=${control.newId()}`;
  const windows = control.platform === 'win32';
  let child: ChildProcess | undefined;
  let cleaning: Promise<void> | undefined;

  // Windows has no groups to signal: a tree can be ended only while its parent is there, and it is ended whole.
  const end = (signal: NodeJS.Signals): boolean => {
    if (child?.pid === undefined) return false;
    if (windows) {
      void control.endTree(child.pid);
      return true;
    }
    return control.signal(-child.pid, signal);
  };

  function spawnClaude(options: SpawnOptions): SpawnedProcess {
    const started = control.start(options.command, options.args, { cwd: options.cwd, env: { ...options.env, [TASK_MARKER_NAME]: entry.slice(TASK_MARKER_NAME.length + 1) }, detached: !windows });
    child = started;
    const { stdin, stdout } = started;
    if (!stdin || !stdout) throw new Error('Claude Code was started without its pipes.');
    let signalled = false;
    const events: NodeJS.EventEmitter = started;
    const subscribing = (method: 'on' | 'once' | 'off') => ((event: 'exit' | 'error', listener: (...args: unknown[]) => void): void => void events[method](event, listener)) as SpawnedProcess['on'];
    return {
      stdin,
      stdout,
      get killed() {
        return signalled || started.killed;
      },
      get exitCode() {
        return started.exitCode;
      },
      get signalCode() {
        return started.signalCode;
      },
      // What the Agent SDK sends to end it reaches the whole group.
      kill(signal) {
        signalled = true;
        return end(signal);
      },
      on: subscribing('on'),
      once: subscribing('once'),
      off: subscribing('off'),
    };
  }

  async function sweep(since: number): Promise<void> {
    const { table } = control;
    for (let round = 0; round < SWEEP_ROUNDS && control.now() - since < CLEAN_UP_BUDGET_MS; round++) {
      const [carrying, working] = await Promise.all([table.withEnvironmentEntry(entry), scope.ownFolder === undefined ? [] : table.orphansWorkingIn(scope.ownFolder)]);
      const found = [...new Set([...carrying, ...working])];
      if (found.length === 0) return;
      await endProcesses(found, control);
    }
  }

  async function endTask(): Promise<void> {
    const started = child;
    if (started?.pid === undefined) return;
    const since = control.now();
    if (windows) return control.endTree(started.pid);
    // The group is ended even when Claude Code has gone: it lasts as long as one process is in it.
    await until(() => hasEnded(started), EXIT_GRACE_MS, control);
    await endProcesses([-started.pid], control);
    if (scope.commands) await sweep(since);
  }

  return {
    spawn: spawnClaude,
    cleanUp: () => (cleaning ??= endTask().catch(() => undefined)),
  };
}

function signalProcess(id: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(id, signal);
    return true;
  } catch (error) {
    // A process that may not be signalled is there all the same.
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

export function createSystemProcessControl(platform: NodeJS.Platform = process.platform): ProcessControl {
  return {
    platform,
    table: createProcessTable(platform),
    // Its error output is dropped: the runner says nothing of what Claude Code printed, and nothing reads the pipe.
    start: (command, args, { cwd, env, detached }) => spawn(command, [...args], { cwd, env, detached, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }),
    signal: signalProcess,
    endTree: (pid) =>
      new Promise((resolve) => {
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: END_TREE_TIMEOUT_MS }, () => resolve());
      }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    newId: () => randomBytes(16).toString('hex'),
  };
}
