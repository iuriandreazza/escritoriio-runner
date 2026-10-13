import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import type { ProcessTable } from './process-table.ts';
import { createSystemProcessControl, createTaskProcesses, TASK_MARKER_NAME } from './task-processes.ts';
import type { ProcessControl, TaskScope } from './task-processes.ts';

const PID = 4242;
const GROUP = -PID;
const ENTRY = `${TASK_MARKER_NAME}=task-id-1`;

class FakeChild extends EventEmitter {
  readonly pid: number | undefined = PID;
  readonly stdin: PassThrough | null = new PassThrough();
  readonly stdout: PassThrough | null = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
}

/** The system, as a test says it is: which processes are there, which of them end when asked, what the table says, and a clock that only the waiting moves. */
class FakeControl implements ProcessControl {
  platform: NodeJS.Platform = 'darwin';
  readonly child = new FakeChild();
  readonly started: { command: string; args: readonly string[]; cwd: string | undefined; env: Readonly<Record<string, string | undefined>>; detached: boolean }[] = [];
  readonly signals: { id: number; signal: NodeJS.Signals | 0 }[] = [];
  readonly tableAsked: string[] = [];
  readonly treesEnded: number[] = [];
  readonly alive = new Set<number>();
  /** The ones that end when asked to. The others have to be made to. */
  readonly obeying = new Set<number>();
  time = 0;
  /** What the table says, one answer for each time it is asked. */
  environmentAnswers: number[][] = [];
  folderAnswers: number[][] = [];
  /** Called each time something waits: how the world moves on. */
  onSleep: (() => void) | undefined;

  table: ProcessTable = {
    withEnvironmentEntry: (entry) => {
      this.tableAsked.push(`environment ${entry}`);
      return Promise.resolve(this.environmentAnswers.shift() ?? []);
    },
    orphansWorkingIn: (folder) => {
      this.tableAsked.push(`folder ${folder}`);
      return Promise.resolve(this.folderAnswers.shift() ?? []);
    },
  };

  start: ProcessControl['start'] = (command, args, options) => {
    this.started.push({ command, args, ...options });
    return this.child as unknown as ChildProcess;
  };

  signal(id: number, signal: NodeJS.Signals | 0): boolean {
    this.signals.push({ id, signal });
    if (!this.alive.has(id)) return false;
    if (signal === 'SIGKILL' || (signal === 'SIGTERM' && this.obeying.has(id))) this.alive.delete(id);
    return true;
  }

  endTree(pid: number): Promise<void> {
    this.treesEnded.push(pid);
    return Promise.resolve();
  }

  sleep(ms: number): Promise<void> {
    this.time += ms;
    this.onSleep?.();
    return Promise.resolve();
  }

  now(): number {
    return this.time;
  }

  newId(): string {
    return 'task-id-1';
  }
}

const OPTIONS: SpawnOptions = { command: '/Users/ana/.local/bin/claude', args: ['--output-format', 'stream-json'], cwd: '/work/site', env: { PATH: '/usr/bin', HOME: '/Users/ana' }, signal: new AbortController().signal };
const COMMANDS: TaskScope = { commands: true, ownFolder: undefined };
const signalsTo = (control: FakeControl, id: number) => control.signals.filter((sent) => sent.id === id && sent.signal !== 0).map((sent) => sent.signal);

describe('starting Claude Code', () => {
  it('starts it as it was asked, as the leader of a group of its own, with the entry of the task in its environment, and the environment it was given otherwise', () => {
    const control = new FakeControl();
    createTaskProcesses(control, COMMANDS).spawn(OPTIONS);
    expect(control.started).toEqual([{ command: OPTIONS.command, args: OPTIONS.args, cwd: '/work/site', env: { PATH: '/usr/bin', HOME: '/Users/ana', [TASK_MARKER_NAME]: 'task-id-1' }, detached: true }]);
    expect(OPTIONS.env).not.toHaveProperty(TASK_MARKER_NAME);
  });

  it('does not start it as a group on Windows, which has none to signal', () => {
    const control = new FakeControl();
    control.platform = 'win32';
    createTaskProcesses(control, COMMANDS).spawn(OPTIONS);
    expect(control.started[0]?.detached).toBe(false);
  });

  it('gives the Agent SDK its pipes and what it asks of a process, as they are', () => {
    const control = new FakeControl();
    const process = createTaskProcesses(control, COMMANDS).spawn(OPTIONS);
    expect(process.stdin).toBe(control.child.stdin);
    expect(process.stdout).toBe(control.child.stdout);
    expect(process.exitCode).toBeNull();
    expect(process.signalCode).toBeNull();
    control.child.exitCode = 1;
    control.child.signalCode = 'SIGTERM';
    expect([process.exitCode, process.signalCode]).toEqual([1, 'SIGTERM']);
  });

  it('passes on the events of the process: its end and its errors, and taking a listener away', () => {
    const control = new FakeControl();
    const process = createTaskProcesses(control, COMMANDS).spawn(OPTIONS);
    const heard: string[] = [];
    const onExit = (code: number | null): void => void heard.push(`exit ${code}`);
    process.on('exit', onExit);
    process.once('exit', (code) => heard.push(`once ${code}`));
    process.on('error', (error) => heard.push(`error ${error.message}`));
    control.child.emit('exit', 0, null);
    control.child.emit('error', new Error('boom'));
    process.off('exit', onExit);
    control.child.emit('exit', 1, null);
    expect(heard).toEqual(['exit 0', 'once 0', 'error boom']);
  });

  it('ends the whole group when the Agent SDK asks it to end, and says it was killed', () => {
    const control = new FakeControl();
    control.alive.add(GROUP);
    const process = createTaskProcesses(control, COMMANDS).spawn(OPTIONS);
    expect(process.killed).toBe(false);
    expect(process.kill('SIGTERM')).toBe(true);
    expect(control.signals).toEqual([{ id: GROUP, signal: 'SIGTERM' }]);
    expect(process.killed).toBe(true);
    expect(createTaskProcesses(new FakeControl(), COMMANDS).spawn(OPTIONS).kill('SIGKILL')).toBe(false);
  });

  it('ends the tree when the Agent SDK asks it to end, on Windows', () => {
    const control = new FakeControl();
    control.platform = 'win32';
    const process = createTaskProcesses(control, COMMANDS).spawn(OPTIONS);
    expect(process.kill('SIGKILL')).toBe(true);
    expect(control.treesEnded).toEqual([PID]);
    expect(control.signals).toEqual([]);
  });

  it('does not kill what it never started: a process that could not be started has no group', () => {
    const control = new FakeControl();
    Object.assign(control.child, { pid: undefined });
    const process = createTaskProcesses(control, COMMANDS).spawn(OPTIONS);
    expect(process.kill('SIGTERM')).toBe(false);
    expect(control.signals).toEqual([]);
  });

  it('is an error, and not a process with no way to talk to, when it was started without its pipes', () => {
    const control = new FakeControl();
    Object.assign(control.child, { stdout: null });
    expect(() => createTaskProcesses(control, COMMANDS).spawn(OPTIONS)).toThrow('pipes');
  });
});

describe('ending what a task left', () => {
  it('has nothing to end when Claude Code was never started, and looks at nothing', async () => {
    const control = new FakeControl();
    await createTaskProcesses(control, COMMANDS).cleanUp();
    expect(control.signals).toEqual([]);
    expect(control.tableAsked).toEqual([]);
    expect(control.treesEnded).toEqual([]);
  });

  describe('the group of Claude Code', () => {
    function started(scope: TaskScope = COMMANDS) {
      const control = new FakeControl();
      const processes = createTaskProcesses(control, scope);
      processes.spawn(OPTIONS);
      control.child.exitCode = 0;
      return { control, processes };
    }

    it('is asked to end, and not made to when it does', async () => {
      const { control, processes } = started();
      control.alive.add(GROUP);
      control.obeying.add(GROUP);
      await processes.cleanUp();
      expect(signalsTo(control, GROUP)).toEqual(['SIGTERM']);
    });

    it('is made to end after a moment when something in it did not, and only then', async () => {
      const { control, processes } = started();
      control.alive.add(GROUP);
      await processes.cleanUp();
      expect(signalsTo(control, GROUP)).toEqual(['SIGTERM', 'SIGKILL']);
      const waited = control.time;
      expect(waited).toBeGreaterThanOrEqual(1_000);
      expect(waited).toBeLessThan(1_500);
    });

    it('is left alone when nothing is in it any more: the group of a process that ended on its own', async () => {
      const { control, processes } = started();
      await processes.cleanUp();
      // It is asked once, and nothing is there to answer.
      expect(control.signals).toEqual([{ id: GROUP, signal: 'SIGTERM' }]);
      expect(control.time).toBe(0);
    });

    it('is not ended before Claude Code had its moment to end by itself, which it is given when it is still running', async () => {
      const control = new FakeControl();
      const processes = createTaskProcesses(control, COMMANDS);
      processes.spawn(OPTIONS);
      control.alive.add(GROUP);
      control.obeying.add(GROUP);
      const signalledAtEachWait: number[] = [];
      control.onSleep = () => {
        signalledAtEachWait.push(control.signals.length);
        if (signalledAtEachWait.length === 5) control.child.exitCode = 0;
      };
      await processes.cleanUp();
      expect(signalledAtEachWait.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
      expect(control.signals[0]).toEqual({ id: GROUP, signal: 'SIGTERM' });
    });

    it('is ended after at most a few seconds even when Claude Code does not end by itself', async () => {
      const control = new FakeControl();
      const processes = createTaskProcesses(control, COMMANDS);
      processes.spawn(OPTIONS);
      control.alive.add(GROUP);
      control.obeying.add(GROUP);
      await processes.cleanUp();
      expect(control.time).toBeGreaterThanOrEqual(2_500);
      expect(control.time).toBeLessThan(3_000);
      expect(signalsTo(control, GROUP)).toEqual(['SIGTERM']);
    });

    it('is ended for a task that runs no commands as well, though nothing else is looked for', async () => {
      const { control, processes } = started({ commands: false, ownFolder: '/work/own' });
      control.alive.add(GROUP);
      control.obeying.add(GROUP);
      await processes.cleanUp();
      expect(signalsTo(control, GROUP)).toEqual(['SIGTERM']);
      expect(control.tableAsked).toEqual([]);
    });
  });

  describe('what left the group', () => {
    function started(scope: TaskScope = COMMANDS) {
      const control = new FakeControl();
      const processes = createTaskProcesses(control, scope);
      processes.spawn(OPTIONS);
      control.child.exitCode = 0;
      return { control, processes };
    }

    it('is looked for by the entry of the task, and what is found is asked to end, and made to when it does not', async () => {
      const { control, processes } = started();
      control.environmentAnswers = [[900, 901]];
      control.alive.add(900).add(901);
      control.obeying.add(900);
      await processes.cleanUp();
      expect(control.tableAsked).toEqual([`environment ${ENTRY}`, `environment ${ENTRY}`]);
      expect(signalsTo(control, 900)).toEqual(['SIGTERM']);
      expect(signalsTo(control, 901)).toEqual(['SIGTERM', 'SIGKILL']);
    });

    it('is looked for by the folder too, when the folder is one the runner made for the task alone', async () => {
      const { control, processes } = started({ commands: true, ownFolder: '/runner/worktrees/task-1' });
      control.environmentAnswers = [[900]];
      control.folderAnswers = [[900, 902]];
      control.alive.add(900).add(902);
      control.obeying.add(900).add(902);
      await processes.cleanUp();
      expect(control.tableAsked.slice(0, 2)).toEqual([`environment ${ENTRY}`, 'folder /runner/worktrees/task-1']);
      expect(signalsTo(control, 900)).toEqual(['SIGTERM']);
      expect(signalsTo(control, 902)).toEqual(['SIGTERM']);
    });

    it('is not looked for by folder when the folder is not one that was made for the task', async () => {
      const { control, processes } = started({ commands: true, ownFolder: undefined });
      await processes.cleanUp();
      expect(control.tableAsked.every((asked) => asked.startsWith('environment'))).toBe(true);
    });

    it('is looked for again after it was ended, since a command may have started others, and not more than a few times', async () => {
      const { control, processes } = started();
      control.environmentAnswers = [[900], [901], [902], [903], [904]];
      for (const pid of [900, 901, 902, 903, 904]) {
        control.alive.add(pid);
        control.obeying.add(pid);
      }
      await processes.cleanUp();
      expect(control.tableAsked).toHaveLength(3);
      expect(signalsTo(control, 903)).toEqual([]);
    });

    it('is not looked for again once nothing is found', async () => {
      const { control, processes } = started();
      control.environmentAnswers = [[900], []];
      control.alive.add(900);
      control.obeying.add(900);
      await processes.cleanUp();
      expect(control.tableAsked).toHaveLength(2);
    });

    it('is not looked for again after the time that the whole clean up is allowed, however much is found', async () => {
      const { control, processes } = started();
      control.environmentAnswers = [[900], [901], [902]];
      for (const pid of [900, 901, 902]) control.alive.add(pid);
      control.onSleep = () => {
        control.time += 5_000;
      };
      await processes.cleanUp();
      expect(control.tableAsked).toHaveLength(1);
    });

    it('is not looked for at all by a task that runs no commands', async () => {
      const { control, processes } = started({ commands: false, ownFolder: '/runner/worktrees/task-1' });
      control.environmentAnswers = [[900]];
      control.alive.add(900);
      await processes.cleanUp();
      expect(control.tableAsked).toEqual([]);
      expect(signalsTo(control, 900)).toEqual([]);
    });

    it('is not an error, and ends nothing, when the table cannot say', async () => {
      const { control, processes } = started();
      control.table = { withEnvironmentEntry: () => Promise.reject(new Error('ps is not there')), orphansWorkingIn: () => Promise.resolve([]) };
      await expect(processes.cleanUp()).resolves.toBeUndefined();
    });
  });

  it('is done once: asked again, it is the same clean up, and nothing is signalled twice', async () => {
    const control = new FakeControl();
    const processes = createTaskProcesses(control, COMMANDS);
    processes.spawn(OPTIONS);
    control.child.exitCode = 0;
    control.alive.add(GROUP);
    control.obeying.add(GROUP);
    const first = processes.cleanUp();
    const second = processes.cleanUp();
    expect(second).toBe(first);
    await first;
    const signalled = control.signals.length;
    await processes.cleanUp();
    expect(control.signals).toHaveLength(signalled);
  });

  it('ends the tree of Claude Code on Windows, at once, and looks for nothing: its parent is only there to be found while it runs', async () => {
    const control = new FakeControl();
    control.platform = 'win32';
    const processes = createTaskProcesses(control, { commands: true, ownFolder: 'C:\\runner\\worktrees\\task-1' });
    processes.spawn(OPTIONS);
    await processes.cleanUp();
    expect(control.treesEnded).toEqual([PID]);
    expect(control.signals).toEqual([]);
    expect(control.tableAsked).toEqual([]);
    expect(control.time).toBe(0);
  });
});

// The real thing, with real processes: no coding agent, only a program that starts what a command of one could start.
describe.skipIf(process.platform === 'win32')('ending real processes', () => {
  // It starts one process in its own group, as it is, and one that left the group on purpose, as a command can; both keep running, and both
  // are told to the test. Then it waits for its input to end, as Claude Code does, and ends, leaving them.
  const PROGRAM = `
    const { spawn } = require('node:child_process');
    const forever = ['-e', 'setInterval(() => {}, 1000)'];
    const inGroup = spawn(process.execPath, forever, { stdio: 'ignore' });
    const away = spawn(process.execPath, forever, { stdio: 'ignore', detached: true });
    // What nohup and a trap make of a command: it leaves the group and does not hear the signals that ask a program to end.
    const deaf = spawn(process.execPath, ['-e', "for (const s of ['SIGHUP', 'SIGTERM', 'SIGINT']) process.on(s, () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore', detached: true });
    console.log(JSON.stringify({ inGroup: inGroup.pid, away: away.pid, deaf: deaf.pid }));
    process.stdin.on('end', () => process.exit(0));
    process.stdin.resume();
  `;

  const isRunning = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  async function until(done: () => boolean): Promise<void> {
    for (let waited = 0; !done() && waited < 5_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  }

  it('ends Claude Code, what it started in its group, and what it started and left the group with', { timeout: 20_000 }, async () => {
    const processes = createTaskProcesses(createSystemProcessControl(), { commands: true, ownFolder: undefined });
    const started = processes.spawn({ command: process.execPath, args: ['-e', PROGRAM], cwd: undefined, env: { ...process.env }, signal: new AbortController().signal });
    const told = await new Promise<{ inGroup: number; away: number; deaf: number }>((resolve) => started.stdout.once('data', (data: Buffer) => resolve(JSON.parse(data.toString()) as { inGroup: number; away: number; deaf: number })));
    expect([told.inGroup, told.away, told.deaf].every(isRunning)).toBe(true);
    started.stdin.end();
    await processes.cleanUp();
    await until(() => !isRunning(told.inGroup) && !isRunning(told.away) && !isRunning(told.deaf));
    expect({ inGroup: isRunning(told.inGroup), away: isRunning(told.away), deaf: isRunning(told.deaf) }).toEqual({ inGroup: false, away: false, deaf: false });
  });
});
