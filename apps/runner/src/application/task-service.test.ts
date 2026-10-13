import type { RunnerToServer, TaskOffer } from '@escritoriio/runner-protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Surroundings } from '../domain/folder-policy.ts';
import { EMPTY_POLICY, IsolationError } from './task-ports.ts';
import type { AgentEvent } from './task-ports.ts';
import { TaskJournal } from './task-journal.ts';
import type { TaskNote, TaskRequest } from './task-service.ts';
import { ABORT_GRACE_MS, KEEP_WORK_MS, PREPARE_COPY_MS, TaskService, WAITING_FOR_APPROVAL } from './task-service.ts';
import { WAITING_FOR_CLONE_APPROVAL } from './workspace-session.ts';
import { FakeWorkspaceOps } from './workspace-testing.ts';
import type { ApprovalPort } from './approvals.ts';
import { APPROVAL_WAIT_MS } from './approvals.ts';
import { build, detected, FakeAgent, FakeApprovals, FakeGitSettingsScan, FakeIsolation, FakePolicyStore, FakeResolver, FakeTaskLock, MemoryJournalStore, RecordingSink, site, surroundings } from './task-testing.ts';
import { FakeScheduler, flush } from './testing.ts';

const request: TaskRequest = { taskId: 't1', folder: 'site', agent: null, instruction: 'Fix the typo in the README' };

function setup(parentEnvironment: Readonly<Record<string, string | undefined>> = { PATH: '/usr/bin', HOME: '/Users/ana', ANTHROPIC_API_KEY: 'sk-ant-in-the-shell', GITHUB_TOKEN: 'ghp_x' }, where: Surroundings = surroundings, approvals?: ApprovalPort) {
  const policy = new FakePolicyStore();
  const resolver = new FakeResolver();
  const isolation = new FakeIsolation();
  const lock = new FakeTaskLock();
  const agent = new FakeAgent();
  const scheduler = new FakeScheduler();
  const store = new MemoryJournalStore();
  const journal = new TaskJournal(store, () => scheduler.now(), (error) => void errors.push(error));
  const notes: TaskNote[] = [];
  const errors: unknown[] = [];
  const deps = {
    policy,
    resolver,
    isolation,
    lock,
    agents: { 'claude-code': agent },
    journal,
    scheduler,
    surroundings: where,
    parentEnvironment,
    report: (note: TaskNote) => void notes.push(note),
    approvals,
  };
  const service = new TaskService(deps);
  return { deps, policy, resolver, isolation, lock, agent, scheduler, store, journal, notes, errors, service };
}

let world: ReturnType<typeof setup>;
beforeEach(() => void (world = setup()));

const runFor = async (taskRequest: TaskRequest = request, approved = false) => {
  const sink = new RecordingSink();
  await world.service.runForOwner(taskRequest, sink, approved);
  return sink;
};

describe('a task that is rejected, with the reason, before anything is begun', () => {
  const rejection = (sink: RecordingSink) => sink.of('rejected')[0] as { reason: string; message: string };

  it('is refused for a folder that is not on the list, however the office names it', async () => {
    for (const folder of ['nowhere', '/Users/ana/work/site', '../site', 'SITE']) {
      const sink = await runFor({ ...request, folder });
      expect(rejection(sink)).toMatchObject({ reason: 'not-allowed' });
      expect(sink.kinds).toEqual(['rejected']);
    }
    expect(world.agent.requests).toEqual([]);
  });

  it('is refused, before anything else, when the instruction holds characters that cannot be seen: what the owner reads is what runs', async () => {
    world.policy.policy = { ...world.policy.policy, folders: [{ ...site, approval: 'ask' }] };
    const hidden = `Fix the typo${String.fromCodePoint(0xe0041)}`;
    const sink = await runFor({ ...request, instruction: hidden }, true);
    expect(rejection(sink)).toMatchObject({ reason: 'bad-offer', message: 'The instruction contains characters that cannot be seen, so the task was not taken.' });
    const messages: unknown[] = [];
    await world.service.offer({ type: 'task.offer', taskId: 't3', folder: 'site', agent: null, instruction: 'a\u202Eb' }, (message) => void messages.push(message));
    expect(messages).toEqual([{ type: 'task.reject', taskId: 't3', reason: 'bad-offer', message: expect.any(String) }]);
    expect(world.agent.requests).toEqual([]);
    expect(world.isolation.made).toEqual([]);
  });

  it('takes an instruction of several lines and tabs', async () => {
    expect((await runFor({ ...request, instruction: 'First\n\tsecond\r\nthird' })).kinds).toContain('done');
  });

  it('is refused while the machine is paused, by the office or by its owner on the machine', async () => {
    world.service.setPausedByOffice(true);
    expect(rejection(await runFor())).toMatchObject({ reason: 'paused' });
    world.service.setPausedByOffice(false);
    world.policy.policy = { ...world.policy.policy, paused: true };
    expect(rejection(await runFor())).toMatchObject({ reason: 'paused' });
    expect(world.agent.requests).toEqual([]);
  });

  it('is refused, with words that say nothing of the file, when the settings cannot be read, and an empty policy is not what it falls back to', async () => {
    world.policy.load = () => Promise.reject(new Error('The settings kept in /Users/ana/secret/policy.json cannot be read.'));
    const sink = await runFor();
    expect(rejection(sink)).toMatchObject({ reason: 'not-allowed', message: expect.stringMatching(/could not read its own settings/) });
    expect(JSON.stringify(sink.told)).not.toContain('/Users/ana');
    expect(world.agent.requests).toEqual([]);
  });

  it('is refused for a folder that asks for approval, unless its owner approved it at the terminal', async () => {
    world.policy.policy = { ...world.policy.policy, folders: [{ ...site, approval: 'ask' }] };
    expect(rejection(await runFor())).toMatchObject({ reason: 'needs-approval' });
    const offered = new RecordingSink();
    const messages: unknown[] = [];
    await world.service.offer({ type: 'task.offer', taskId: 't2', folder: 'site', agent: null, instruction: 'x' }, (message) => void messages.push(message));
    expect(messages).toEqual([{ type: 'task.reject', taskId: 't2', reason: 'needs-approval', message: expect.any(String) }]);
    expect(offered.kinds).toEqual([]);
    expect((await runFor(request, true)).kinds).toContain('done');
  });

  it.each([
    ['gone', null, 'The folder is not there any more.'],
    ['moved', '/Users/ana/work/other', 'it was moved'],
    ['now a link to home', '/Users/ana', 'it was moved'],
    ['now a link to the whole disk', '/', 'it was moved'],
  ])('is refused when the folder is %s', async (_what, resolvesTo, words) => {
    world.resolver.answers.set(site.path, resolvesTo);
    const sink = await runFor();
    expect(rejection(sink)).toMatchObject({ reason: 'not-allowed' });
    expect(rejection(sink).message).toContain(words);
    expect(world.isolation.made).toEqual([]);
    expect(world.agent.requests).toEqual([]);
  });

  it('is refused when what was allowed has become home, or what holds the runner’s own settings', async () => {
    world.policy.policy = { ...world.policy.policy, folders: [{ ...site, realPath: '/Users/ana', path: '/Users/ana' }] };
    expect(rejection(await runFor())).toMatchObject({ reason: 'not-allowed' });
  });

  it('is refused when the coding agent is not installed, or cannot be driven in this version', async () => {
    world.agent.detection = { ...detected, installed: false, path: undefined, version: undefined };
    expect(rejection(await runFor())).toMatchObject({ reason: 'agent-missing' });
    world.agent.detection = { ...detected, supported: false, problem: 'Update Claude Code to 2.1.248 or later.' };
    const sink = await runFor();
    expect(rejection(sink)).toMatchObject({ reason: 'agent-missing', message: 'Update Claude Code to 2.1.248 or later.' });
  });

  it('is refused when nobody is logged in to the coding agent, and tried when the tool cannot tell', async () => {
    world.agent.detection = { ...detected, loggedIn: false };
    expect(rejection(await runFor())).toMatchObject({ reason: 'not-logged-in' });
    world.agent.detection = { ...detected, loggedIn: null };
    expect((await runFor()).kinds).toContain('done');
  });

  it('is refused for a coding agent this runner has no adapter for', async () => {
    expect(rejection(await runFor({ ...request, agent: 'codex' }))).toMatchObject({ reason: 'agent-missing' });
  });

  it('is refused when the coding agent cannot be contained here and the folder is not one its owner trusts', async () => {
    world.agent.detection = { ...detected, containment: 'none' };
    expect(rejection(await runFor())).toMatchObject({ reason: 'not-contained' });
    world.policy.policy = { ...world.policy.policy, folders: [{ ...site, access: 'read-only', trusted: true }] };
    expect((await runFor()).kinds).toContain('done');
  });

  it('is refused, in a trusted folder too, when the folder is edited and the system has no sandbox to run commands in', async () => {
    world.agent.detection = { ...detected, containment: 'none' };
    // Not trusted: it is the sandbox that is missing that the owner is told about, since trusting the folder would not help.
    world.policy.policy = { ...world.policy.policy, folders: [{ ...site, access: 'edit', trusted: false }] };
    expect(rejection(await runFor())).toMatchObject({ reason: 'not-contained', message: expect.stringContaining('share it again read-only') });
    world.policy.policy = { ...world.policy.policy, folders: [{ ...site, access: 'edit', trusted: true }] };
    expect(rejection(await runFor({ ...request, taskId: 't2' }))).toMatchObject({ reason: 'not-contained', message: expect.stringContaining('share it again read-only') });
    // Where there is nothing to offer, as on Windows, trusting the folder is what lifts it.
    const onWindows: Surroundings = { home: 'C:\\Users\\ana', stateDirectory: 'C:\\Users\\ana\\AppData\\Roaming\\escritoriio-runner', worktreesDirectory: 'C:\\Users\\ana\\AppData\\Local\\escritoriio-runner\\worktrees', windows: true };
    const path = 'C:\\Users\\ana\\work\\site';
    world = setup(undefined, onWindows);
    world.agent.detection = { ...detected, containment: 'none' };
    world.policy.policy = { ...world.policy.policy, folders: [{ ...site, path, realPath: path, access: 'edit', trusted: true }] };
    expect((await runFor()).kinds).toContain('done');
  });

  it('is refused, with the reason in words, when the work cannot be isolated', async () => {
    world.isolation.refuseWith = new IsolationError('That folder holds no git repository.');
    expect(rejection(await runFor())).toMatchObject({ reason: 'cannot-isolate', message: 'That folder holds no git repository.' });
    world.isolation.refuseWith = new Error('spawn git ENOENT /Users/ana/secret');
    const sink = await runFor();
    expect(rejection(sink).reason).toBe('cannot-isolate');
    expect(rejection(sink).message).not.toContain('/Users/ana');
  });

  it('never runs two tasks at once, even when two offers arrive together', async () => {
    let finish: () => void = () => undefined;
    world.agent.script = async function* () {
      await new Promise<void>((resolve) => (finish = resolve));
      yield { kind: 'result', text: 'Done.' };
    };
    const first = new RecordingSink();
    const second = new RecordingSink();
    const running = world.service.runForOwner(request, first, false);
    await world.service.runForOwner({ ...request, taskId: 't2' }, second, false);
    expect(second.of('rejected')[0]).toMatchObject({ reason: 'busy' });
    expect(world.service.runningTask).toBe('t1');
    await flush();
    finish();
    await running;
    expect(first.kinds).toContain('done');
    expect(world.service.runningTask).toBeUndefined();
    // The machine is free again for the next one.
    world.agent.script = async function* () {
      yield { kind: 'result', text: 'Done.' };
    };
    expect((await runFor({ ...request, taskId: 't3' })).kinds).toContain('done');
  });
});

describe('a task that is run', () => {
  it('is accepted, told as it goes, and ends with the branch the work was left on', async () => {
    world.agent.script = async function* () {
      yield { kind: 'text', text: 'Looking at the README.' };
      yield { kind: 'tool', name: 'Edit', summary: 'README.md', denied: false };
      yield { kind: 'usage', inputTokens: 100, outputTokens: 20 };
      yield { kind: 'result', text: 'I fixed the typo.' };
    };
    const sink = await runFor();
    expect(sink.kinds).toEqual(['accepted', 'event', 'event', 'event', 'done']);
    expect(sink.of('event')).toEqual([
      { kind: 'text', text: 'Looking at the README.' },
      { kind: 'tool', name: 'Edit', summary: 'README.md', denied: false },
      { kind: 'usage', inputTokens: 100, outputTokens: 20 },
    ]);
    expect(sink.of('done')[0]).toEqual({ text: 'I fixed the typo.', branch: 'escritoriio/task', diffStat: ' README.md | 2 +-', durationMs: 0, truncated: false });
    expect(world.isolation.made[0]).toMatchObject({ taskId: 't1', finished: true, discarded: false });
    // What the owner reads of a task: how it ended, never what it was or what came of it.
    expect(world.notes).toEqual([{ kind: 'ended', taskId: 't1', outcome: 'done', durationMs: 0 }]);
  });

  it('works in the worktree, never in the folder itself, with the narrowest access the folder gives, and the instruction as it was said', async () => {
    await runFor();
    const [asked] = world.agent.requests;
    expect(asked).toMatchObject({ instruction: request.instruction, access: 'edit', executable: '/usr/local/bin/claude' });
    expect(asked?.folder).toBe('/Users/ana/Library/Caches/escritoriio-runner/worktrees/t1');
    expect(asked?.folder).not.toBe(site.realPath);

    world.policy.policy = { ...world.policy.policy, folders: [{ ...site, access: 'read-only' }] };
    await runFor({ ...request, taskId: 't2' });
    expect(world.agent.requests[1]?.access).toBe('read-only');
  });

  it('works on the folder itself only when its owner chose it, and then leaves no branch', async () => {
    world.policy.policy = { ...world.policy.policy, folders: [{ ...site, isolation: 'in-place' }] };
    const sink = await runFor();
    expect(world.isolation.made).toEqual([]);
    expect(world.agent.requests[0]?.folder).toBe(site.realPath);
    expect(sink.of('done')[0]).toMatchObject({ branch: null, diffStat: null });
  });

  it('starts the coding agent with an environment built from nothing: no key of the shell the runner was started from', async () => {
    await runFor();
    expect(world.agent.requests[0]?.environment).toEqual({ PATH: '/usr/bin', HOME: '/Users/ana' });
  });

  it('uses the coding agent the task asks for, else the folder’s own, else the first there is, and the path its owner picked', async () => {
    world.policy.policy = { ...world.policy.policy, agentPaths: { 'claude-code': '/opt/claude/bin/claude' } };
    await runFor();
    expect(world.agent.detects).toEqual(['/opt/claude/bin/claude']);
    await runFor({ ...request, taskId: 't2', agent: 'claude-code' });
    expect(world.agent.requests).toHaveLength(2);
  });

  it('says nothing of this machine’s layout: the paths in what the coding agent says are the folder’s own, or ~', async () => {
    const worktree = '/Users/ana/Library/Caches/escritoriio-runner/worktrees/t1';
    world.agent.script = async function* () {
      yield { kind: 'text', text: `Reading ${worktree}/README.md and /Users/ana/.zshrc` };
      yield { kind: 'tool', name: 'Edit', summary: `${worktree}/src/index.ts`, denied: false };
      yield { kind: 'result', text: `Edited ${worktree}/README.md in /Users/ana/work/site` };
    };
    world.isolation.result = { branch: 'escritoriio/t1', diffStat: ` ${worktree}/README.md | 2 +-` };
    const sink = await runFor();
    expect(sink.of('event')).toEqual([
      { kind: 'text', text: 'Reading ./README.md and ~/.zshrc' },
      { kind: 'tool', name: 'Edit', summary: './src/index.ts', denied: false },
    ]);
    expect(sink.of('done')[0]).toMatchObject({ text: 'Edited ./README.md in .', diffStat: ' ./README.md | 2 +-' });
  });

  it('says nothing of the home the coding agent was told of either, when that is not the one the file system names', async () => {
    const behindALink = setup({ PATH: '/usr/bin', HOME: '/home/ana' });
    behindALink.agent.script = async function* () {
      yield { kind: 'text', text: 'Read /home/ana/.config/tool/token and %2Fhome%2Fana%2F.ssh' };
      yield { kind: 'result', text: 'Done in /home/ana/work/site/../x' };
    };
    const sink = new RecordingSink();
    await behindALink.service.runForOwner(request, sink, false);
    expect(sink.of('event')).toEqual([{ kind: 'text', text: 'Read ~/.config/tool/token and ~%2F.ssh' }]);
    expect(sink.of('done')[0]).toMatchObject({ text: 'Done in ~/work/site/../x' });
  });

  it('keeps the lines of what the coding agent said and drops what hides text', async () => {
    world.agent.script = async function* () {
      yield { kind: 'text', text: 'one\ntwo\u202Eevil' };
      yield { kind: 'result', text: 'a\nb' };
    };
    const sink = await runFor();
    expect(sink.of('event')[0]).toEqual({ kind: 'text', text: 'one\ntwo evil' });
    expect(sink.of('done')[0]).toMatchObject({ text: 'a\nb' });
  });

  it('is a failure, with the coding agent’s words cleaned of paths, when it says it failed, and what was made for it goes', async () => {
    world.agent.script = async function* () {
      yield { kind: 'error', message: 'Could not read /Users/ana/work/site/secret.txt' };
    };
    const sink = await runFor();
    expect(sink.of('failed')[0]).toEqual({ reason: 'error', message: 'Could not read ./secret.txt', durationMs: 0 });
    expect(world.isolation.made[0]).toMatchObject({ finished: false, discarded: true });
  });

  it('is a failure when the coding agent ends without an answer, or breaks', async () => {
    world.agent.script = async function* () {
      yield { kind: 'text', text: 'Thinking' };
    };
    expect((await runFor()).of('failed')[0]).toMatchObject({ reason: 'error' });
    world.agent.script = () => {
      throw new Error('spawn failed');
    };
    expect((await runFor({ ...request, taskId: 't2' })).of('failed')[0]).toMatchObject({ reason: 'error', message: 'spawn failed' });
  });

  it('is a failure, and gives the work up, when what was done cannot be kept', async () => {
    world.isolation.finishFails = new Error('git commit failed in /Users/ana/work/site');
    const sink = await runFor();
    expect(sink.of('failed')[0]).toMatchObject({ reason: 'error', message: 'git commit failed in .' });
    expect(world.isolation.made[0]?.discarded).toBe(true);
  });
});

describe('what a task may say in all', () => {
  const chatter = (pieces: number, size: number) =>
    async function* (): AsyncGenerator<AgentEvent> {
      for (let piece = 0; piece < pieces; piece++) yield { kind: 'text', text: 'x'.repeat(size) };
      yield { kind: 'result', text: 'Done.' };
    };

  it('is cut at the ceiling of output, whole pieces up to it and none after, and the task says it was cut', async () => {
    world.agent.script = chatter(100, 2_000);
    const sink = await runFor();
    const kept = (sink.of('event') as { text: string }[]).reduce((total, event) => total + event.text.length, 0);
    expect(kept).toBeLessThanOrEqual(64 * 1024);
    expect(kept).toBeGreaterThan(60 * 1024);
    expect(sink.of('done')[0]).toMatchObject({ truncated: true });
  });

  it('is cut at less when the office asks for less, and never at more', async () => {
    world.agent.script = chatter(10, 500);
    const small = await runFor({ ...request, maxOutputBytes: 1_000 });
    expect((small.of('event') as { text: string }[]).reduce((total, event) => total + event.text.length, 0)).toBe(1_000);
    expect(small.of('done')[0]).toMatchObject({ truncated: true });
    const big = await runFor({ ...request, taskId: 't2', maxOutputBytes: 64 * 1024 });
    expect(big.of('done')[0]).toMatchObject({ truncated: false });
  });

  it('is sent in events of the size one event may be', async () => {
    world.agent.script = async function* () {
      yield { kind: 'text', text: 'y'.repeat(5_000) };
      yield { kind: 'result', text: 'Done.' };
    };
    const sink = await runFor();
    expect((sink.of('event') as { text: string }[]).map((event) => event.text.length)).toEqual([2_000, 2_000, 1_000]);
  });

  it('keeps the end of the coding agent’s answer within what an answer may be', async () => {
    world.agent.script = async function* () {
      yield { kind: 'result', text: 'z'.repeat(20_000) };
    };
    const done = (await runFor()).of('done')[0] as { text: string; truncated: boolean };
    expect(done.text).toHaveLength(8_000);
    expect(done.truncated).toBe(true);
  });
});

describe('one task at a time on the machine, across every process of the runner', () => {
  const rejection = (sink: RecordingSink) => sink.of('rejected')[0] as { reason: string; message: string };

  it('takes the lock for the whole of a task, from before the copy of the folder is made to before whoever asked is told how it ended', async () => {
    const seen: string[] = [];
    const prepare = world.isolation.prepare.bind(world.isolation);
    world.isolation.prepare = (folder, taskId, signal) => {
      seen.push(`held when the copy is made: ${world.lock.held}`);
      return prepare(folder, taskId, signal);
    };
    world.agent.script = async function* () {
      seen.push(`held while it works: ${world.lock.held}`);
      yield { kind: 'result', text: 'Done.' };
    };
    const sink = new RecordingSink();
    sink.done = () => void seen.push(`held when told it is done: ${world.lock.held}`);
    await world.service.runForOwner(request, sink, false);
    expect(seen).toEqual(['held when the copy is made: true', 'held while it works: true', 'held when told it is done: false']);
    expect(world.lock.acquired).toBe(1);
    expect(world.lock.released).toBe(1);
  });

  it('takes it for a folder that is worked in place too', async () => {
    world.policy.policy = { ...world.policy.policy, folders: [{ ...site, isolation: 'in-place' }] };
    world.lock.heldElsewhere = true;
    expect(rejection(await runFor())).toMatchObject({ reason: 'busy' });
    expect(world.agent.requests).toEqual([]);
  });

  it('refuses a task, with words and the reason busy, when another process of the runner holds it, and nothing is begun', async () => {
    world.lock.heldElsewhere = true;
    const sink = await runFor();
    expect(rejection(sink)).toEqual({ reason: 'busy', message: expect.stringContaining('Another runner process on this machine is running a task.') });
    expect(sink.kinds).toEqual(['rejected']);
    expect(world.isolation.made).toEqual([]);
    expect(world.agent.requests).toEqual([]);
    expect(world.service.runningTask).toBeUndefined();
    expect(world.store.entries).toEqual([]);
  });

  it('takes the next task once the other process lets go of it', async () => {
    world.lock.heldElsewhere = true;
    await runFor();
    world.lock.heldElsewhere = false;
    expect((await runFor()).kinds).toContain('done');
  });

  it('does not take it for what is refused before the machine would begin: a folder that is not shared, a pause, a coding agent that cannot be used', async () => {
    await runFor({ ...request, folder: 'nowhere' });
    world.service.setPausedByOffice(true);
    await runFor();
    world.service.setPausedByOffice(false);
    world.agent.detection = { ...world.agent.detection, loggedIn: false };
    await runFor();
    expect(world.lock.acquired).toBe(0);
  });

  it('refuses with words, and does not throw, when the lock cannot be asked', async () => {
    world.lock.failWith = new Error('EACCES: permission denied, open /Users/ana/secret/task.lock');
    const sink = await runFor();
    expect(rejection(sink)).toMatchObject({ reason: 'busy', message: expect.stringContaining('could not find out whether another runner process is running a task') });
    expect(JSON.stringify(sink.told)).not.toContain('/Users/ana');
    expect(world.agent.requests).toEqual([]);
    expect(world.service.runningTask).toBeUndefined();
  });

  describe('gives it up, whichever way the task ends', () => {
    const patient = async function* (_request: unknown, signal: AbortSignal): AsyncGenerator<AgentEvent> {
      yield { kind: 'text', text: 'Working' };
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    };

    it('when it is done', async () => {
      await runFor();
      expect(world.lock.held).toBe(false);
      expect(world.lock.released).toBe(1);
    });

    it('when the coding agent failed', async () => {
      world.agent.script = async function* () {
        yield { kind: 'error', message: 'It failed.' };
      };
      await runFor();
      expect(world.lock.held).toBe(false);
    });

    it('when the coding agent threw', async () => {
      world.agent.script = async function* () {
        await Promise.reject(new Error('crashed'));
        yield { kind: 'result', text: 'Not reached.' };
      };
      await runFor();
      expect(world.lock.held).toBe(false);
    });

    it('when it was cancelled, and when the machine was paused, and when it timed out', async () => {
      world.agent.script = patient;
      const first = world.service.runForOwner(request, new RecordingSink(), false);
      await flush();
      world.service.cancel('t1');
      await first;
      expect(world.lock.held).toBe(false);

      const second = world.service.runForOwner({ ...request, taskId: 't2' }, new RecordingSink(), false);
      await flush();
      world.service.setPausedByOffice(true);
      await second;
      world.service.setPausedByOffice(false);
      expect(world.lock.held).toBe(false);

      const third = world.service.runForOwner({ ...request, taskId: 't3' }, new RecordingSink(), false);
      await flush();
      await world.scheduler.advance(30 * 60_000);
      await third;
      expect(world.lock.held).toBe(false);
      expect(world.lock.acquired).toBe(3);
      expect(world.lock.released).toBe(3);
    });

    it('when the work could not be kept', async () => {
      world.isolation.finishFails = new Error('could not keep it');
      await runFor();
      expect(world.lock.held).toBe(false);
    });

    it('when the copy of the folder could not be made, by a refusal and by a mistake', async () => {
      world.isolation.refuseWith = new IsolationError('That folder holds no git repository.');
      expect(rejection(await runFor())).toMatchObject({ reason: 'cannot-isolate' });
      expect(world.lock.held).toBe(false);
      world.isolation.refuseWith = new Error('something else broke');
      expect(rejection(await runFor())).toMatchObject({ reason: 'cannot-isolate' });
      expect(world.lock.held).toBe(false);
      expect(world.lock.acquired).toBe(2);
    });

    it('when it was paused while it was being got ready', async () => {
      let pause: () => void = () => undefined;
      const prepare = world.isolation.prepare.bind(world.isolation);
      world.isolation.prepare = async (folder, taskId, signal) => {
        pause();
        return prepare(folder, taskId, signal);
      };
      pause = () => world.service.setPausedByOffice(true);
      const sink = await runFor();
      expect(rejection(sink)).toMatchObject({ reason: 'paused' });
      expect(world.lock.held).toBe(false);
    });

    it('when it was stopped because the runner was stopping', async () => {
      world.agent.script = patient;
      const running = world.service.runForOwner(request, new RecordingSink(), false);
      await flush();
      world.service.stopAll();
      await running;
      expect(world.lock.held).toBe(false);
    });

    it('when the sink itself fails, which is a mistake of the program that is thrown on', async () => {
      const sink = new RecordingSink();
      sink.accepted = () => {
        throw new Error('the sink broke');
      };
      await expect(world.service.runForOwner(request, sink, false)).rejects.toThrow('the sink broke');
      expect(world.lock.held).toBe(false);
      expect(world.service.runningTask).toBeUndefined();
    });
  });
});

describe('the machine when a task is over', () => {
  it('is free for the next task by the time whoever asked is told how this one ended, so that an answer is never that it is busy', async () => {
    const freeWhenToldDone: (string | undefined)[] = [];
    const sink = new RecordingSink();
    sink.done = () => void freeWhenToldDone.push(world.service.runningTask);
    await world.service.runForOwner(request, sink, false);

    world.agent.script = async function* () {
      yield { kind: 'error', message: 'It failed.' };
    };
    sink.failed = () => void freeWhenToldDone.push(world.service.runningTask);
    await world.service.runForOwner({ ...request, taskId: 't2' }, sink, false);

    world.isolation.finishFails = new Error('could not keep it');
    world.agent.script = async function* () {
      yield { kind: 'result', text: 'Done.' };
    };
    await world.service.runForOwner({ ...request, taskId: 't3' }, sink, false);
    expect(freeWhenToldDone).toEqual([undefined, undefined, undefined]);
  });

  it('has written down how the task ended before it is told, which is what a connection that dropped is told from', async () => {
    const wasWritten: boolean[] = [];
    await world.service.offer({ type: 'task.offer', taskId: 't1', folder: 'site', agent: null, instruction: 'x' }, (message) => {
      if (message.type === 'task.done') wasWritten.push(world.journal.entries().some((entry) => entry.state === 'done' && entry.taskId === 't1'));
    });
    expect(wasWritten).toEqual([true]);
  });
});

describe('a task that is stopped', () => {
  /** A coding agent that waits for the signal, as one that is doing a long job does, and ends when it comes. */
  const patient = async function* (_request: unknown, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    yield { kind: 'text', text: 'Working' };
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
  };

  it('is cancelled when the office asks, the work is given up and the coding agent is told to stop', async () => {
    world.agent.script = patient;
    const sink = new RecordingSink();
    const running = world.service.runForOwner(request, sink, false);
    await flush();
    expect(world.service.cancel('other-task')).toBe(false);
    expect(world.service.cancel('t1')).toBe(true);
    await running;
    expect(sink.of('failed')[0]).toMatchObject({ reason: 'cancelled' });
    expect(world.isolation.made[0]).toMatchObject({ discarded: true, finished: false });
    expect(world.service.runningTask).toBeUndefined();
  });

  it('is stopped when the office pauses the machine, and when its owner does', async () => {
    world.agent.script = patient;
    const first = new RecordingSink();
    const one = world.service.runForOwner(request, first, false);
    await flush();
    world.service.setPausedByOffice(true);
    await one;
    expect(first.of('failed')[0]).toMatchObject({ reason: 'paused' });

    world.service.setPausedByOffice(false);
    const second = new RecordingSink();
    const two = world.service.runForOwner({ ...request, taskId: 't2' }, second, false);
    await flush();
    world.service.localPauseChanged(true);
    await two;
    expect(second.of('failed')[0]).toMatchObject({ reason: 'paused' });
  });

  it('is stopped at its ceiling of time: the office’s when that is less, never more than the machine’s own', async () => {
    world.agent.script = patient;
    const sink = new RecordingSink();
    const running = world.service.runForOwner({ ...request, maxSeconds: 60 }, sink, false);
    await flush();
    await world.scheduler.advance(59_000);
    expect(sink.of('failed')).toEqual([]);
    await world.scheduler.advance(1_000);
    await running;
    expect(sink.of('failed')[0]).toMatchObject({ reason: 'timeout', durationMs: 60_000 });
  });

  it('is stopped by thirty minutes at the most', async () => {
    world.agent.script = patient;
    const sink = new RecordingSink();
    const running = world.service.runForOwner(request, sink, false);
    await flush();
    await world.scheduler.advance(30 * 60_000);
    await running;
    expect(sink.of('failed')[0]).toMatchObject({ reason: 'timeout' });
  });

  it('is given up on, with the machine free again, when the coding agent does not go once it was told to', async () => {
    world.agent.script = async function* () {
      yield { kind: 'text', text: 'Working' };
      await new Promise(() => undefined);
    };
    const sink = new RecordingSink();
    const running = world.service.runForOwner({ ...request, maxSeconds: 10 }, sink, false);
    await flush();
    await world.scheduler.advance(10_000);
    expect(sink.of('failed')).toEqual([]);
    await world.scheduler.advance(ABORT_GRACE_MS);
    await running;
    expect(sink.of('failed')[0]).toMatchObject({ reason: 'timeout' });
    expect(world.service.runningTask).toBeUndefined();
    expect(world.isolation.made[0]?.discarded).toBe(true);
  });

  it('is stopped with the runner: nothing is left running', async () => {
    world.agent.script = patient;
    const sink = new RecordingSink();
    const running = world.service.runForOwner(request, sink, false);
    await flush();
    world.service.stopAll();
    await running;
    expect(sink.of('failed')[0]).toMatchObject({ reason: 'interrupted' });
  });

  it('is not started when it was told to stop before the coding agent began', async () => {
    world.agent.script = patient;
    const sink = new RecordingSink();
    const running = world.service.runForOwner(request, sink, false);
    // Cancelled while the machine is still looking at the folder and the tool: nothing has been started yet.
    expect(world.service.cancel('t1')).toBe(true);
    await running;
    expect(world.agent.requests).toEqual([]);
    expect(sink.kinds).toEqual(['accepted', 'failed']);
    expect(sink.of('failed')[0]).toMatchObject({ reason: 'cancelled' });
  });

  it('is rejected, not begun, when the machine was paused while it was being got ready', async () => {
    const sink = new RecordingSink();
    const running = world.service.runForOwner(request, sink, false);
    world.service.setPausedByOffice(true);
    await running;
    expect(sink.kinds).toEqual(['rejected']);
    expect(world.agent.requests).toEqual([]);
  });
});

describe('making and keeping the copy of a folder', () => {
  const patient = async function* (_request: unknown, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    yield { kind: 'text', text: 'Working' };
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
  };
  const rejection = (sink: RecordingSink) => sink.of('rejected')[0] as { reason: string; message: string };

  describe('that goes on until it is told to stop', () => {
    beforeEach(() => void (world.isolation.prepareHangs = true));

    it('ends when the task is cancelled meanwhile, as a task that was cancelled before the coding agent began, and the machine is free at once', async () => {
      const sink = new RecordingSink();
      const running = world.service.runForOwner(request, sink, false);
      await flush();
      expect(world.service.runningTask).toBe('t1');
      expect(world.service.cancel('t1')).toBe(true);
      await running;
      expect(sink.kinds).toEqual(['accepted', 'failed']);
      expect(sink.of('failed')[0]).toMatchObject({ reason: 'cancelled' });
      expect(world.agent.requests).toEqual([]);
      expect(world.service.runningTask).toBeUndefined();
      expect(world.lock.held).toBe(false);
      expect(world.scheduler.pending).toBe(0);
    });

    it('is rejected as paused when the machine is paused meanwhile, and the machine is free', async () => {
      const sink = new RecordingSink();
      const running = world.service.runForOwner(request, sink, false);
      await flush();
      world.service.localPauseChanged(true);
      await running;
      expect(sink.kinds).toEqual(['rejected']);
      expect(rejection(sink)).toMatchObject({ reason: 'paused' });
      expect(world.lock.held).toBe(false);
      expect(world.scheduler.pending).toBe(0);
    });

    it('ends as interrupted when the runner stops meanwhile', async () => {
      const sink = new RecordingSink();
      const running = world.service.runForOwner(request, sink, false);
      await flush();
      world.service.stopAll();
      await running;
      expect(sink.of('failed')[0]).toMatchObject({ reason: 'interrupted' });
      expect(world.lock.held).toBe(false);
    });

    it('is refused, with words, when it takes too long, whatever the ceiling of the task is, and the machine is free', async () => {
      const sink = new RecordingSink();
      const running = world.service.runForOwner({ ...request, maxSeconds: 1 }, sink, false);
      await flush();
      await world.scheduler.advance(PREPARE_COPY_MS - 1);
      expect(sink.kinds).toEqual([]);
      await world.scheduler.advance(1);
      await running;
      expect(sink.kinds).toEqual(['rejected']);
      expect(rejection(sink)).toMatchObject({ reason: 'cannot-isolate', message: 'Making a copy of that folder took too long, so the task was not taken.' });
      expect(world.lock.held).toBe(false);
      expect(world.scheduler.pending).toBe(0);
    });

    it('is told to stop by a signal that aborts when the task is cancelled', async () => {
      const signals: AbortSignal[] = [];
      const prepare = world.isolation.prepare.bind(world.isolation);
      world.isolation.prepare = (folder, taskId, signal) => {
        signals.push(signal);
        return prepare(folder, taskId, signal);
      };
      const running = world.service.runForOwner(request, new RecordingSink(), false);
      await flush();
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(false);
      world.service.cancel('t1');
      await running;
      expect(signals[0]?.aborted).toBe(true);
    });
  });

  describe('keeping the work, which goes on until it is told to stop', () => {
    beforeEach(() => {
      world.isolation.finishHangs = true;
      world.agent.script = async function* () {
        yield { kind: 'result', text: 'Done.' };
      };
    });

    it('ends as cancelled when the task is cancelled meanwhile: the work is given up, and no timer of the task is left', async () => {
      const sink = new RecordingSink();
      const running = world.service.runForOwner(request, sink, false);
      await flush();
      expect(world.service.runningTask).toBe('t1');
      world.service.cancel('t1');
      await running;
      expect(sink.of('failed')[0]).toMatchObject({ reason: 'cancelled', message: 'The task was cancelled.' });
      expect(sink.of('done')).toEqual([]);
      expect(world.isolation.made[0]).toMatchObject({ finished: false, discarded: true });
      expect(world.service.runningTask).toBeUndefined();
      expect(world.lock.held).toBe(false);
      expect(world.scheduler.pending).toBe(0);
    });

    it('ends as paused when the machine is paused meanwhile', async () => {
      const sink = new RecordingSink();
      const running = world.service.runForOwner(request, sink, false);
      await flush();
      world.service.setPausedByOffice(true);
      await running;
      expect(sink.of('failed')[0]).toMatchObject({ reason: 'paused' });
      expect(world.isolation.made[0]?.discarded).toBe(true);
    });

    it('ends as timed out, in words that say it was keeping the work, when it takes too long, whatever the ceiling of the task is', async () => {
      const sink = new RecordingSink();
      const running = world.service.runForOwner({ ...request, maxSeconds: 10 }, sink, false);
      await flush();
      await world.scheduler.advance(10_000);
      expect(sink.kinds).toEqual(['accepted']);
      await world.scheduler.advance(KEEP_WORK_MS - 10_000);
      await running;
      expect(sink.of('failed')[0]).toMatchObject({ reason: 'timeout', message: 'Keeping the work took too long, so it was given up.' });
      expect(world.isolation.made[0]?.discarded).toBe(true);
      expect(world.lock.held).toBe(false);
      expect(world.scheduler.pending).toBe(0);
    });

    it('is a failure that says what the isolation said when it could not keep the work for another reason', async () => {
      world.isolation.finishHangs = false;
      world.isolation.finishFails = new IsolationError('The work could not be kept (a disk that is full).');
      const sink = await runFor();
      expect(sink.of('failed')[0]).toMatchObject({ reason: 'error', message: 'The work could not be kept (a disk that is full).' });
      expect(world.scheduler.pending).toBe(0);
    });
  });

  it('leaves no timer behind for a task that ends well, nor for one that is stopped while the coding agent works', async () => {
    await runFor();
    expect(world.scheduler.pending).toBe(0);
    world.agent.script = patient;
    const running = world.service.runForOwner({ ...request, taskId: 't2' }, new RecordingSink(), false);
    await flush();
    world.service.cancel('t2');
    await running;
    expect(world.scheduler.pending).toBe(0);
  });
});

describe('the tasks the office offers', () => {
  const offer: TaskOffer = { type: 'task.offer', taskId: 't9', folder: 'site', agent: 'claude-code', instruction: 'Fix the typo', maxSeconds: 120 };

  it('are written down as failed in the journal when the program breaks after they began, and the mistake goes on', async () => {
    world.agent.script = async function* () {
      yield { kind: 'result', text: 'Done.' };
    };
    await expect(
      world.service.offer(offer, (message) => {
        if (message.type === 'task.accept') throw new Error('a mistake of this program');
      }),
    ).rejects.toThrow('a mistake of this program');
    expect(world.journal.entries()).toEqual([expect.objectContaining({ state: 'failed', taskId: 't9', reason: 'error' })]);
    expect(world.isolation.made.every((made) => made.finished || made.discarded)).toBe(true);
  });

  it('are answered in the protocol: accept, the events in order from 0, and how it ended', async () => {
    world.agent.script = async function* () {
      yield { kind: 'text', text: 'one' };
      yield { kind: 'text', text: 'two' };
      yield { kind: 'result', text: 'Done.' };
    };
    const sent: unknown[] = [];
    await world.service.offer(offer, (message) => void sent.push(message));
    expect(sent).toEqual([
      { type: 'task.accept', taskId: 't9' },
      { type: 'task.event', taskId: 't9', seq: 0, event: { kind: 'text', text: 'one' } },
      { type: 'task.event', taskId: 't9', seq: 1, event: { kind: 'text', text: 'two' } },
      { type: 'task.done', taskId: 't9', text: 'Done.', branch: 'escritoriio/task', diffStat: ' README.md | 2 +-', durationMs: 0, truncated: false },
    ]);
  });

  it('are written in the journal as they begin and as they end, for the connection that may have dropped', async () => {
    let release: () => void = () => undefined;
    world.agent.script = async function* () {
      await new Promise<void>((resolve) => (release = resolve));
      yield { kind: 'result', text: 'Done.' };
    };
    const running = world.service.offer(offer, () => undefined);
    await flush();
    expect(world.journal.entries()).toEqual([{ state: 'running', taskId: 't9' }]);
    release();
    await running;
    expect(world.journal.entries()).toEqual([{ state: 'done', taskId: 't9', text: 'Done.', branch: 'escritoriio/task', diffStat: ' README.md | 2 +-', durationMs: 0, truncated: false }]);
    expect(world.store.entries).toHaveLength(1);
  });

  it('are not written in the journal when they were rejected, and a task the owner gives at the terminal never is', async () => {
    await world.service.offer({ ...offer, folder: 'nowhere' }, () => undefined);
    await runFor({ ...request, taskId: 't10' });
    expect(world.journal.entries()).toEqual([]);
  });

  it('are failed in the journal with the reason when the machine stops them', async () => {
    world.agent.script = async function* (_request, signal) {
      yield { kind: 'text', text: 'Working' };
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    };
    const running = world.service.offer(offer, () => undefined);
    await flush();
    world.service.cancel('t9');
    await running;
    expect(world.journal.entries()).toEqual([{ state: 'failed', taskId: 't9', reason: 'cancelled', message: 'The task was cancelled.', durationMs: 0 }]);
  });
});

describe('a task of a folder that asks before each task, when there is a place to ask its owner', () => {
  const offer: TaskOffer = { type: 'task.offer', taskId: 't7', folder: 'site', agent: null, instruction: 'Drop the table users' };
  let owner: FakeApprovals;
  let messages: RunnerToServer[];

  beforeEach(() => {
    owner = new FakeApprovals();
    world = setup(undefined, undefined, owner);
    world.policy.policy = { ...world.policy.policy, folders: [{ ...site, approval: 'ask' }] };
    messages = [];
  });

  const offered = (taskOffer: TaskOffer = offer) => world.service.offer(taskOffer, (message) => void messages.push(message));
  const kinds = () => messages.map((message) => message.type);
  const ended = () => messages.find((message) => message.type === 'task.failed' || message.type === 'task.done');

  it('is taken at once, and then says in fixed words that it waits for its owner, who is shown the exact text and the folder', async () => {
    const running = offered();
    await flush();
    expect(messages).toEqual([
      { type: 'task.accept', taskId: 't7' },
      { type: 'task.event', taskId: 't7', seq: 0, event: { kind: 'text', text: WAITING_FOR_APPROVAL } },
    ]);
    expect(owner.requests).toEqual([{ taskId: 't7', folder: 'site', access: 'edit', instruction: 'Drop the table users' }]);
    expect(world.agent.requests).toEqual([]);
    expect(world.isolation.made).toEqual([]);
    expect(world.journal.entries()).toEqual([{ state: 'running', taskId: 't7' }]);
    expect(world.lock.held).toBe(true);
    owner.answerWith('approved');
    await running;
    expect(kinds()).toEqual(['task.accept', 'task.event', 'task.done']);
    expect(world.agent.requests).toHaveLength(1);
    expect(world.lock.held).toBe(false);
  });

  it('is not told to the owner’s notes with what it asked', async () => {
    const running = offered();
    await flush();
    owner.answerWith('approved');
    await running;
    expect(world.notes).toContainEqual({ kind: 'waiting-for-approval', taskId: 't7' });
    expect(JSON.stringify(world.notes)).not.toContain('Drop the table');
    expect(JSON.stringify(messages.slice(0, 2))).not.toContain('Drop the table');
  });

  it('ends as failed, in fixed words and with nothing run, when its owner denies it', async () => {
    const running = offered();
    await flush();
    owner.answerWith('denied');
    await running;
    expect(ended()).toEqual({ type: 'task.failed', taskId: 't7', reason: 'cancelled', message: 'Its owner did not approve this task on their machine, so it was not run.', durationMs: 0 });
    expect(kinds()).not.toContain('task.reject');
    expect(world.agent.requests).toEqual([]);
    expect(world.isolation.made).toEqual([]);
    expect(world.journal.entries()).toEqual([expect.objectContaining({ state: 'failed', taskId: 't7', reason: 'cancelled' })]);
    expect(world.lock.held).toBe(false);
    expect(world.service.runningTask).toBeUndefined();
  });

  it('ends as failed when nobody answers in ten minutes, and takes the question away', async () => {
    const running = offered();
    await flush();
    await world.scheduler.advance(APPROVAL_WAIT_MS - 1);
    expect(owner.waiting).toBe(true);
    await world.scheduler.advance(1);
    await running;
    expect(ended()).toMatchObject({ type: 'task.failed', reason: 'cancelled', message: 'Its owner did not answer on their machine in time, so the task was not run.', durationMs: APPROVAL_WAIT_MS });
    expect(owner.taken).toBe(1);
    expect(world.agent.requests).toEqual([]);
  });

  it('does not wait longer than the time the office gave the task, and says it ran out of time', async () => {
    const running = offered({ ...offer, maxSeconds: 60 });
    await flush();
    await world.scheduler.advance(60_000);
    await running;
    expect(ended()).toMatchObject({ type: 'task.failed', reason: 'timeout', durationMs: 60_000 });
  });

  it('has only what is left of its time once it is approved, since the office counts from the moment it was taken', async () => {
    const running = offered({ ...offer, maxSeconds: 600 });
    await flush();
    await world.scheduler.advance(400_000);
    world.agent.script = async function* (_request, signal) {
      yield { kind: 'text', text: 'Working' };
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    };
    owner.answerWith('approved');
    await flush();
    await world.scheduler.advance(199_999);
    expect(world.service.runningTask).toBe('t7');
    await world.scheduler.advance(1);
    await running;
    expect(ended()).toMatchObject({ type: 'task.failed', reason: 'timeout' });
  });

  it.each([
    ['cancelled from the office', () => world.service.cancel('t7'), 'cancelled', 'The task was cancelled.'],
    ['paused from the office', () => world.service.setPausedByOffice(true), 'paused', 'The machine was paused, so the task was stopped.'],
    ['paused by its owner on the machine', () => world.service.localPauseChanged(true), 'paused', 'The machine was paused, so the task was stopped.'],
    ['stopped with the runner', () => world.service.stopAll(), 'interrupted', 'The runner stopped while the task was running.'],
  ] as const)('is ended, and the question taken away, when it is %s while its owner is asked', async (_how, stop, reason, message) => {
    const running = offered();
    await flush();
    stop();
    await running;
    expect(ended()).toMatchObject({ type: 'task.failed', reason, message });
    expect(owner.taken).toBe(1);
    expect(world.agent.requests).toEqual([]);
    expect(world.lock.held).toBe(false);
  });

  it('does not stay waiting for a place to ask that ignores the signal', async () => {
    world = setup(undefined, undefined, { ask: () => new Promise(() => undefined) });
    world.policy.policy = { ...world.policy.policy, folders: [{ ...site, approval: 'ask' }] };
    const running = offered();
    await flush();
    world.service.cancel('t7');
    await running;
    expect(ended()).toMatchObject({ type: 'task.failed', reason: 'cancelled' });
  });

  it('is refused as busy, before it is taken, when another process holds the machine’s task', async () => {
    world.lock.heldElsewhere = true;
    await offered();
    expect(messages).toEqual([{ type: 'task.reject', taskId: 't7', reason: 'busy', message: expect.any(String) }]);
    expect(owner.requests).toEqual([]);
  });

  it('is refused before it is taken, for what the rules refuse whatever its owner says', async () => {
    world.agent.detection = { ...detected, loggedIn: false };
    await offered();
    expect(kinds()).toEqual(['task.reject']);
    expect(owner.requests).toEqual([]);
  });

  it('ends as failed, and not as rejected, when the folder is not shared any more once its owner approves', async () => {
    const running = offered();
    await flush();
    world.policy.policy = { ...world.policy.policy, folders: [] };
    owner.answerWith('approved');
    await running;
    expect(kinds()).toEqual(['task.accept', 'task.event', 'task.failed']);
    expect(ended()).toMatchObject({ reason: 'error', message: 'That folder is not one this machine shares.' });
    expect(world.agent.requests).toEqual([]);
  });

  it('is not run in a folder that was changed while its owner was asked', async () => {
    const running = offered();
    await flush();
    world.policy.policy = { ...world.policy.policy, folders: [{ ...site, approval: 'ask', trusted: true }] };
    owner.answerWith('approved');
    await running;
    expect(ended()).toMatchObject({ type: 'task.failed', reason: 'error', message: expect.stringContaining('changed while the owner was asked') });
    expect(world.agent.requests).toEqual([]);
  });

  it('ends as paused, not as rejected, when the owner paused the machine meanwhile and approved all the same', async () => {
    const running = offered();
    await flush();
    world.policy.policy = { ...world.policy.policy, paused: true };
    owner.answerWith('approved');
    await running;
    expect(ended()).toMatchObject({ type: 'task.failed', reason: 'paused' });
  });

  it('is refused as before for a task its owner gives at the terminal that was not approved there, even with a place to ask', async () => {
    const sink = await runFor();
    expect(sink.of('rejected')[0]).toMatchObject({ reason: 'needs-approval' });
    expect(owner.requests).toEqual([]);
  });

  it('tells what watches the tasks that it began, that it waits and how it ended', async () => {
    const told: string[] = [];
    world = setup(undefined, undefined, owner);
    const watched = new TaskService({
      ...world.deps,
      observer: {
        began: ({ taskId, folder }) => void told.push(`began ${taskId} ${folder}`),
        said: (_taskId, event) => void told.push(`said ${event.kind}`),
        approval: (_taskId, waiting) => void told.push(`approval ${waiting}`),
        ended: (_taskId, ending) => void told.push(`ended ${'done' in ending ? 'done' : ending.failed.reason}`),
      },
    });
    world.policy.policy = { ...world.policy.policy, folders: [{ ...site, approval: 'ask' }] };
    const running = watched.offer(offer, () => undefined);
    await flush();
    owner.answerWith('denied');
    await running;
    expect(told).toEqual(['began t7 site', 'said text', 'approval true', 'approval false', 'ended cancelled']);
  });
});

describe('a task in a workspace', () => {
  const asked = (words: string): TaskRequest => ({ ...request, folder: 'build', instruction: words });
  let ops: FakeWorkspaceOps;
  let owner: FakeApprovals;
  let scan: FakeGitSettingsScan;
  let service: TaskService;

  beforeEach(() => {
    world = setup();
    world.policy.policy = { ...EMPTY_POLICY, folders: [site, build] };
    ops = new FakeWorkspaceOps();
    owner = new FakeApprovals();
    scan = new FakeGitSettingsScan();
    service = new TaskService({ ...world.deps, workspace: ops, settingsScan: scan, approvals: owner });
    world.agent.workspaceTools = true;
  });

  const run = async (taskRequest: TaskRequest = asked('Build the thing')) => {
    const sink = new RecordingSink();
    await service.runForOwner(taskRequest, sink, false);
    return sink;
  };

  it('works in place, and gives the agent the tools of the workspace, which are made for this task and this folder', async () => {
    await run();
    const [seen] = world.agent.requests;
    expect(seen?.folder).toBe(build.realPath);
    expect(seen?.access).toBe('edit');
    expect(world.isolation.made).toEqual([]);
    expect(seen?.workspace).toBeDefined();
    await seen?.workspace?.newFolder('hello');
    expect(ops.calls).toEqual(['new hello']);
  });

  it('gives a plain folder no such tools, even when there is a place to make them', async () => {
    await run({ ...request, instruction: 'Fix it' });
    expect(world.agent.requests[0]?.workspace).toBeUndefined();
  });

  it('says in words, and goes on without the tools, when the coding agent has none', async () => {
    world.agent.workspaceTools = false;
    const sink = await run();
    expect(world.agent.requests[0]?.workspace).toBeUndefined();
    expect(sink.of('event')).toContainEqual({ kind: 'text', text: expect.stringMatching(/cannot make folders or clone repositories by itself/) });
    expect(sink.kinds.at(-1)).toBe('done');
  });

  it('gives no tools where nothing can do what they ask, and says so in the same words', async () => {
    service = new TaskService({ ...world.deps, approvals: owner });
    const sink = await run();
    expect(world.agent.requests[0]?.workspace).toBeUndefined();
    expect(sink.of('event')).toContainEqual({ kind: 'text', text: expect.stringMatching(/cannot make folders or clone repositories by itself/) });
  });

  it.each([{ access: 'read-only' as const, isolation: 'in-place' as const }, { access: 'edit' as const, isolation: 'worktree' as const }])('is refused when the policy says the workspace is $access and $isolation', async (way) => {
    world.policy.policy = { ...EMPTY_POLICY, folders: [{ ...build, ...way }] };
    const sink = await run();
    expect(sink.of('rejected')[0]).toMatchObject({ reason: 'not-allowed', message: expect.stringMatching(/workspace is edited in place/) });
    expect(world.agent.requests).toEqual([]);
  });

  describe('when the agent asks to clone a repository', () => {
    const URL_OF_HELLO = 'https://github.com/octocat/Hello-World.git';

    it('tells the office, in fixed words, that it waits, shows the owner the exact address and the folder, and clones when they say yes', async () => {
      const notes: TaskNote[] = [];
      const seen: unknown[] = [];
      service = new TaskService({ ...world.deps, workspace: ops, settingsScan: scan, approvals: owner, report: (note) => void notes.push(note), observer: { began: () => undefined, said: (_id, event) => void seen.push(event), approval: (id, waiting) => void seen.push({ approval: id, waiting }), ended: () => undefined } });
      let cloned: { ok: boolean; words: string } | undefined;
      world.agent.script = async function* (agentRequest) {
        cloned = await agentRequest.workspace?.clone(URL_OF_HELLO);
        yield { kind: 'result', text: 'Cloned.' };
      };
      const sink = new RecordingSink();
      const running = service.runForOwner(asked('Clone it'), sink, false);
      await flush();
      expect(owner.cloneRequests).toEqual([{ kind: 'clone', taskId: 't1', workspace: 'build', url: URL_OF_HELLO, folder: 'Hello-World' }]);
      expect(sink.of('event')).toContainEqual({ kind: 'text', text: WAITING_FOR_CLONE_APPROVAL });
      expect(notes).toContainEqual({ kind: 'waiting-for-approval', taskId: 't1' });
      expect(seen).toContainEqual({ approval: 't1', waiting: true });
      owner.answerCloneWith('approved');
      await running;
      expect(cloned?.ok).toBe(true);
      expect(seen).toContainEqual({ approval: 't1', waiting: false });
      expect(ops.calls).toEqual([`address ${URL_OF_HELLO}`, `clone Hello-World ${URL_OF_HELLO}`]);
      expect(sink.kinds.at(-1)).toBe('done');
    });

    it('does not tell the office what was asked: only the fixed words, and the call as the agent made it, cleaned', async () => {
      world.agent.script = async function* (agentRequest) {
        void agentRequest.workspace?.clone(URL_OF_HELLO);
        await flush();
        yield { kind: 'result', text: 'x' };
      };
      const sink = new RecordingSink();
      const running = service.runForOwner(asked('Clone it'), sink, false);
      await flush();
      owner.answerCloneWith('denied');
      await running;
      expect(JSON.stringify(sink.of('event'))).not.toContain(URL_OF_HELLO);
    });

    it('takes the question away when the task is cancelled, paused, or reaches its ceiling, and waits no more than ten minutes', async () => {
      world.agent.script = async function* (agentRequest) {
        await agentRequest.workspace?.clone(URL_OF_HELLO);
        yield { kind: 'result', text: 'x' };
      };
      for (const stop of [() => service.cancel('t1'), () => service.setPausedByOffice(true), () => service.stopAll()]) {
        owner = new FakeApprovals();
        service = new TaskService({ ...world.deps, workspace: ops, settingsScan: scan, approvals: owner });
        const sink = new RecordingSink();
        const running = service.runForOwner(asked('Clone it'), sink, false);
        await flush();
        stop();
        await running;
        expect(owner.clonesTaken).toBe(1);
        expect(sink.kinds.at(-1)).toBe('failed');
        service.setPausedByOffice(false);
      }
      const sink = new RecordingSink();
      owner = new FakeApprovals();
      service = new TaskService({ ...world.deps, workspace: ops, settingsScan: scan, approvals: owner });
      const running = service.runForOwner(asked('Clone it'), sink, false);
      await flush();
      await world.scheduler.advance(APPROVAL_WAIT_MS);
      await flush();
      expect(owner.clonesTaken).toBe(1);
      await running;
      expect(sink.kinds.at(-1)).toBe('done');
      expect(ops.calls.filter((call) => call.startsWith('clone'))).toEqual([]);
    });

    it('counts the time spent waiting against the ceiling of the task', async () => {
      world.agent.script = async function* (agentRequest) {
        await agentRequest.workspace?.clone(URL_OF_HELLO);
        yield { kind: 'result', text: 'x' };
      };
      const sink = new RecordingSink();
      const running = service.runForOwner({ ...asked('Clone it'), maxSeconds: 30 }, sink, false);
      await flush();
      await world.scheduler.advance(30_000);
      await running;
      expect(sink.of('failed')[0]).toMatchObject({ reason: 'timeout' });
      expect(owner.clonesTaken).toBe(1);
    });
  });

  describe('what the task leaves in the repositories of the folder', () => {
    const finding = { repository: 'api', hooks: ['pre-commit'], settings: ['core.hooksPath'], restored: [], notes: [] };

    it('is looked at after the task, and what was taken away is told first in the final text, in plain words', async () => {
      scan.report = { findings: [finding], incomplete: [] };
      const sink = await run();
      expect(scan.scanned).toEqual([build.realPath]);
      const [done] = sink.of('done') as { text: string }[];
      expect(done?.text).toBe('The task changed git settings that run programs; they were removed: api (hooks pre-commit; settings core.hooksPath).\n\nDone.');
    });

    it('is looked at for a plain folder worked in place too, and not for one worked in a copy', async () => {
      world.policy.policy = { ...EMPTY_POLICY, folders: [{ ...site, isolation: 'in-place' }] };
      scan.report = { findings: [finding], incomplete: [] };
      await service.runForOwner(request, new RecordingSink(), false);
      expect(scan.scanned).toEqual([site.realPath]);
      scan.scanned.length = 0;
      world.policy.policy = { ...EMPTY_POLICY, folders: [site] };
      await service.runForOwner({ ...request, taskId: 't2' }, new RecordingSink(), false);
      expect(scan.scanned).toEqual([]);
    });

    it('is recorded before the agent begins, and what is taken away after is what that record says was not there', async () => {
      world.agent.script = async function* () {
        scan.order.push('agent');
        yield { kind: 'result', text: 'Done.' };
      };
      await run();
      expect(scan.order).toEqual(['snapshot', 'agent', 'scan']);
      expect(scan.recorded).toEqual([build.realPath]);
      expect(scan.baselines[0]).toBe(scan.baseline);
    });

    it('is checked with no record, which removes nothing and says so in the check, when the record could not be made', async () => {
      scan.baseline = undefined;
      await run();
      expect(scan.baselines).toEqual([undefined]);
    });

    it('is not recorded for a folder worked in a copy', async () => {
      world.policy.policy = { ...EMPTY_POLICY, folders: [site] };
      await service.runForOwner(request, new RecordingSink(), false);
      expect(scan.recorded).toEqual([]);
    });

    it('says in fixed words, first, that the check did not look at everything, though it found nothing', async () => {
      scan.report = { findings: [], incomplete: ['budget'] };
      const sink = await run();
      expect((sink.of('done')[0] as { text: string }).text).toBe('WARNING: The check of git repositories stopped before it looked at every folder, so some could not be checked.\n\nDone.');
    });

    it('says nothing when there was nothing to take away', async () => {
      const sink = await run();
      expect(scan.scanned).toHaveLength(1);
      expect(sink.of('done')[0]).toMatchObject({ text: 'Done.' });
    });

    it('is told with the failure too, and after a cancel, since the agent may have written it before it was stopped', async () => {
      scan.report = { findings: [finding], incomplete: [] };
      world.agent.script = async function* (_request, signal) {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        yield { kind: 'error', message: 'stopped' };
      };
      const sink = new RecordingSink();
      const running = service.runForOwner(asked('Build'), sink, false);
      await flush();
      service.cancel('t1');
      await running;
      expect(scan.scanned).toHaveLength(1);
      expect(sink.of('failed')[0]).toMatchObject({ reason: 'cancelled', message: expect.stringContaining('they were removed: api') });
    });

    it('is not stopped by the cancel that ended the task, and is given a time of its own', async () => {
      world.agent.script = async function* (_request, signal) {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        yield { kind: 'error', message: 'stopped' };
      };
      const running = service.runForOwner(asked('Build'), new RecordingSink(), false);
      await flush();
      service.cancel('t1');
      await running;
      expect(scan.signals[0]?.aborted).toBe(false);
      expect(world.scheduler.pending).toBe(0);
    });

    it('is not run for a task that was refused', async () => {
      await run({ ...asked('x'), folder: 'nowhere' });
      expect(scan.scanned).toEqual([]);
    });
  });
});

describe('what a task says of an address', () => {
  it('has no user name, password or token in it, in what the agent said or in the call it made', async () => {
    world.agent.script = async function* () {
      yield { kind: 'text', text: 'Cloning https://x-access-token:ghs_SECRET@github.com/a/b.git?token=SECRET now' };
      yield { kind: 'tool', name: 'mcp__escritoriio__workspace_clone', summary: 'https://user:SECRET@github.com/a/b.git', denied: false };
      yield { kind: 'result', text: 'Done with https://user:SECRET@github.com/a/b.git' };
    };
    const sink = await runFor();
    expect(JSON.stringify(sink.told)).not.toContain('SECRET');
    expect(JSON.stringify(sink.told)).toContain('https://github.com/a/b.git');
  });
});
