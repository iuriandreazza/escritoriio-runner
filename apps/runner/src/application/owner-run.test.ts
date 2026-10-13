import { TASK_LIMITS } from '@escritoriio/runner-protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeTerminal } from '../testing/fake-terminal.ts';
import { EXIT_AFTER_SIGNAL, runByHand } from './owner-run.ts';
import { TaskJournal } from './task-journal.ts';
import type { AgentEvent } from './task-ports.ts';
import { TaskService } from './task-service.ts';
import { FakeAgent, FakeIsolation, FakePolicyStore, FakeResolver, FakeTaskLock, MemoryJournalStore, site, surroundings } from './task-testing.ts';
import { FakeScheduler, flush } from './testing.ts';

function setup() {
  const policy = new FakePolicyStore();
  const agent = new FakeAgent();
  const isolation = new FakeIsolation();
  const scheduler = new FakeScheduler();
  const terminal = new FakeTerminal();
  const service = new TaskService({
    policy,
    resolver: new FakeResolver(),
    isolation,
    lock: new FakeTaskLock(),
    agents: { 'claude-code': agent },
    journal: new TaskJournal(new MemoryJournalStore(), () => scheduler.now(), () => undefined),
    scheduler,
    surroundings,
    parentEnvironment: { PATH: '/usr/bin' },
    report: () => undefined,
  });
  let ids = 0;
  const run = (task: Partial<Parameters<typeof runByHand>[1]> = {}) =>
    runByHand({ service, policy, terminal, newTaskId: () => `local-${++ids}` }, { folder: 'site', instruction: 'Fix the typo in the README', agent: null, approve: false, ...task });
  return { policy, agent, isolation, scheduler, terminal, service, run };
}

let world: ReturnType<typeof setup>;
beforeEach(() => void (world = setup()));

describe('a task given by hand', () => {
  it('runs, shows what the coding agent does as it goes and how it ended, and ends with 0', async () => {
    world.agent.script = async function* () {
      yield { kind: 'text', text: 'I will look at the README.' };
      yield { kind: 'tool', name: 'Read', summary: './README.md', denied: false };
      yield { kind: 'tool', name: 'Bash', summary: 'rm -rf node_modules', denied: true };
      yield { kind: 'usage', inputTokens: 1_200, outputTokens: 300 };
      yield { kind: 'result', text: 'I fixed the typo.' };
    };
    expect(await world.run()).toBe(0);
    expect(world.terminal.stdout).toEqual([
      'Working. Press Ctrl-C to stop it.',
      'I will look at the README.',
      '  > Read: ./README.md',
      '  > Bash: rm -rf node_modules (not allowed)',
      '',
      'Done in 1s.',
      '\nI fixed the typo.',
      '',
      'The work is on the branch escritoriio/task, in the repository of that folder. Nothing was pushed.',
      ' README.md | 2 +-',
      `Look at it with: git log --stat escritoriio/task (in ${site.path})`,
      'Tokens: 1200 in, 300 out.',
    ]);
    expect(world.terminal.stderr).toEqual([]);
  });

  it('is given to the machine as the owner’s own, with an id of its own, and for the folder and the tool asked for', async () => {
    await world.run({ agent: 'claude-code', instruction: '  Fix it  ' });
    expect(world.isolation.made[0]?.taskId).toBe('local-1');
    expect(world.agent.requests[0]).toMatchObject({ instruction: 'Fix it', access: 'edit' });
  });

  it('says that no files were changed when none were', async () => {
    world.isolation.result = { branch: null, diffStat: null };
    expect(await world.run()).toBe(0);
    expect(world.terminal.stdout.at(-1)).toBe('It changed no files.');
  });

  it('says that the work is in the folder itself when it was done in place', async () => {
    world.policy.policy = { ...world.policy.policy, folders: [{ ...site, isolation: 'in-place' }] };
    expect(await world.run()).toBe(0);
    expect(world.terminal.stdout.at(-1)).toBe('The work was done in place: whatever it changed is in the folder now, and nothing was committed.');
  });

  it('says that some of what was said was left out, when it was', async () => {
    world.agent.script = async function* () {
      yield { kind: 'result', text: 'z'.repeat(TASK_LIMITS.finalText + 10) };
    };
    await world.run();
    expect(world.terminal.shown).toContain('Some of what the coding agent said was left out');
  });

  it('ends with 1, and says why, when the coding agent failed', async () => {
    world.agent.script = async function* () {
      yield { kind: 'error', message: 'It could not reach its servers.' };
    };
    expect(await world.run()).toBe(1);
    expect(world.terminal.stderr).toEqual(['The task failed (error) after 1s: It could not reach its servers.']);
  });
});

describe('a task that the machine does not run', () => {
  it('ends with 1, and says why in the machine’s words, for a folder that is not shared, and where to see the ones that are', async () => {
    expect(await world.run({ folder: 'nowhere' })).toBe(1);
    expect(world.terminal.stderr).toEqual(['The task was not run: That folder is not one this machine shares.', 'See the folders that are shared with: escritoriio-runner folders list']);
    expect(world.agent.requests).toEqual([]);
  });

  it('ends with 1 while the machine is paused', async () => {
    world.policy.policy = { ...world.policy.policy, paused: true };
    expect(await world.run()).toBe(1);
    expect(world.terminal.stderr).toEqual(['The task was not run: This machine is paused.']);
  });

  it('ends with 1 when the coding agent is not logged in', async () => {
    world.agent.detection = { ...world.agent.detection, loggedIn: false };
    expect(await world.run()).toBe(1);
    expect(world.terminal.stderr[0]).toMatch(/nobody is logged in/);
  });

  it.each([
    ['nothing', ''],
    ['nothing but spaces', '   \n '],
  ])('is refused, with words, for an instruction of %s, before anything is asked', async (_what, instruction) => {
    await expect(world.run({ instruction })).rejects.toThrow('Say what the coding agent should do.');
    expect(world.terminal.questions).toEqual([]);
  });

  it('is refused for an instruction longer than an instruction may be', async () => {
    await expect(world.run({ instruction: 'x'.repeat(TASK_LIMITS.instruction + 1) })).rejects.toThrow(/at most 8000 characters/);
  });

  it('is an error, with the words of the settings, when they cannot be read', async () => {
    world.policy.load = () => Promise.reject(new Error('The settings cannot be read.'));
    await expect(world.run()).rejects.toThrow('The settings cannot be read.');
  });
});

describe('a folder that asks before each task', () => {
  beforeEach(() => {
    world.policy.policy = { ...world.policy.policy, folders: [{ ...site, approval: 'ask' }] };
  });

  it('asks with the exact text, and runs on a yes', async () => {
    world.terminal.answers = ['y'];
    expect(await world.run({ instruction: 'Delete every test' })).toBe(0);
    expect(world.terminal.stdout[0]).toBe('The folder "site" asks you to approve each task. This is the exact text the coding agent would be given:\n\nDelete every test\n');
    expect(world.terminal.questions).toEqual(['Approve it and run it? [y/N] ']);
    expect(world.agent.requests).toHaveLength(1);
  });

  it.each([[''], ['n'], ['no'], ['maybe']])('runs nothing on an answer of %j', async (answer) => {
    world.terminal.answers = [answer];
    expect(await world.run()).toBe(1);
    expect(world.terminal.stderr).toEqual(['Not approved. Nothing was run.']);
    expect(world.agent.requests).toEqual([]);
    expect(world.isolation.made).toEqual([]);
  });

  it('does not ask when the person already approved it', async () => {
    expect(await world.run({ approve: true })).toBe(0);
    expect(world.terminal.questions).toEqual([]);
  });

  it('does not ask for a folder that does not', async () => {
    world.policy.policy = { ...world.policy.policy, folders: [site] };
    await world.run();
    expect(world.terminal.questions).toEqual([]);
  });
});

describe('the label of the folder, as the person types it', () => {
  it('finds the folder in whatever case it was typed, and the machine is given the label as it is kept', async () => {
    expect(await world.run({ folder: 'SITE' })).toBe(0);
    expect(world.isolation.made[0]?.folder.label).toBe('site');
  });

  it('is the label as typed for a folder that is not shared, which the machine refuses with its own words', async () => {
    expect(await world.run({ folder: 'NOWHERE' })).toBe(1);
    expect(world.terminal.stderr[0]).toBe('The task was not run: That folder is not one this machine shares.');
  });
});

describe('stopping a task with Ctrl-C', () => {
  const patient = async function* (_request: unknown, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    yield { kind: 'text', text: 'Working' };
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
  };

  it('cancels it, gives its work up, and ends with 130', async () => {
    world.agent.script = patient;
    const running = world.run();
    await flush();
    world.terminal.pressCtrlC();
    expect(await running).toBe(EXIT_AFTER_SIGNAL.SIGINT);
    expect(world.terminal.stdout).toContain('Stopping the task.');
    expect(world.terminal.stderr).toEqual(['The task was cancelled.']);
    expect(world.isolation.made[0]).toMatchObject({ discarded: true, finished: false });
    expect(world.service.runningTask).toBeUndefined();
  });

  it('ends with 130 for Ctrl-C and 143 for the program being asked to end, as a shell says them', async () => {
    expect(EXIT_AFTER_SIGNAL).toEqual({ SIGINT: 130, SIGTERM: 143 });
    world.agent.script = patient;
    const running = world.run();
    await flush();
    world.terminal.pressCtrlC('SIGTERM');
    expect(await running).toBe(143);
    expect(world.terminal.stderr).toEqual(['The task was cancelled.']);
  });

  it('is not listened for any more once the task is over', async () => {
    await world.run();
    world.terminal.pressCtrlC();
    expect(world.terminal.stdout).not.toContain('Stopping the task.');
  });

  it('ends with 1, not 130, for a task that timed out, since nobody pressed Ctrl-C', async () => {
    world.agent.script = patient;
    const running = world.run();
    await flush();
    await world.scheduler.advance(30 * 60_000);
    expect(await running).toBe(1);
    expect(world.terminal.stderr[0]).toMatch(/failed \(timeout\)/);
  });
});
