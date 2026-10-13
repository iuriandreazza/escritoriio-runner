import { beforeEach, describe, expect, it } from 'vitest';
import { WORKSPACE_LIMITS } from '../domain/workspace-limits.ts';
import type { ApprovalAnswer, ApprovalPort, CloneApprovalRequest } from './approvals.ts';
import { APPROVAL_WAIT_MS } from './approvals.ts';
import { FakeScheduler, flush } from './testing.ts';
import type { WorkspaceTools } from './workspace-ports.ts';
import { createWorkspaceTools, WAITING_FOR_CLONE_APPROVAL } from './workspace-session.ts';
import { FakeWorkspaceOps } from './workspace-testing.ts';

const URL_OF_HELLO = 'https://github.com/octocat/Hello-World.git';

/** The owner, played by a test: answers a clone when told to, and notices when the question is taken away. */
class FakeOwner implements ApprovalPort {
  readonly requests: CloneApprovalRequest[] = [];
  private settle: ((answer: ApprovalAnswer) => void) | undefined;
  taken = 0;
  ask(): Promise<ApprovalAnswer> {
    throw new Error('A workspace never asks the owner to approve a task');
  }
  askToClone(request: CloneApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer> {
    this.requests.push(request);
    return new Promise((resolve) => {
      this.settle = resolve;
      signal.addEventListener('abort', () => {
        this.taken += 1;
        resolve('denied');
      }, { once: true });
    });
  }
  answerWith(answer: ApprovalAnswer): void {
    this.settle?.(answer);
  }
}

let ops: FakeWorkspaceOps;
let owner: FakeOwner;
let scheduler: FakeScheduler;
let controller: AbortController;
let said: string[];
let waits: boolean[];
let tools: WorkspaceTools;

function build(approvals: ApprovalPort | null = owner): WorkspaceTools {
  return createWorkspaceTools({ workspace: '/Users/ana/work/build', label: 'build', taskId: 't1', ops, approvals: approvals ?? undefined, scheduler, signal: controller.signal, say: (words) => void said.push(words), waiting: (waiting) => void waits.push(waiting) });
}

beforeEach(() => {
  ops = new FakeWorkspaceOps();
  owner = new FakeOwner();
  scheduler = new FakeScheduler();
  controller = new AbortController();
  said = [];
  waits = [];
  tools = build();
});

describe('making a folder in a workspace', () => {
  it('makes it, makes it a git repository, and says so', async () => {
    const reply = await tools.newFolder('hello');
    expect(reply.ok).toBe(true);
    expect(reply.words).toContain('"hello"');
    expect(reply.words).toMatch(/git repository/);
    expect(reply.words).toContain('./hello');
    expect(ops.calls).toEqual(['new hello']);
  });

  it.each([['../etc'], ['a/b'], ['.git'], [''], ['CON'], ['bad\u{202E}name']])('refuses %j with the words of the rule, and touches nothing', async (name) => {
    const reply = await tools.newFolder(name);
    expect(reply.ok).toBe(false);
    expect(reply.words).toMatch(/^A folder name /);
    expect(ops.calls).toEqual([]);
  });

  it('refuses a name that is taken, by a folder or by anything else, without touching it', async () => {
    ops.made = 'exists';
    const reply = await tools.newFolder('hello');
    expect(reply).toEqual({ ok: false, words: expect.stringContaining('already') });
    expect(ops.calls).toEqual(['new hello']);
  });

  it('refuses when the workspace is not where it was, with words that name no path', async () => {
    ops.made = 'moved';
    const reply = await tools.newFolder('hello');
    expect(reply.ok).toBe(false);
    expect(reply.words).not.toContain('/');
  });

  it('says what went wrong when it could not be made a repository, and counts nothing', async () => {
    ops.startFails = 'git could not be started';
    const reply = await tools.newFolder('hello');
    expect(reply).toEqual({ ok: false, words: expect.stringContaining('git could not be started') });
    expect(ops.folders).toEqual([]);
  });

  it('says how the folder was put there when that is something to know', async () => {
    ops.note = 'It was copied across disks and checked.';
    expect((await tools.newFolder('hello')).words).toContain('It was copied across disks and checked.');
  });

  it('keeps its ceilings when the agent asks for several folders at once', async () => {
    const replies = await Promise.all(Array.from({ length: 12 }, (_, index) => tools.newFolder(`f${index}`)));
    expect(replies.filter((reply) => reply.ok)).toHaveLength(WORKSPACE_LIMITS.foldersPerTask);
    expect(ops.folders).toHaveLength(WORKSPACE_LIMITS.foldersPerTask);
  });

  it('keeps the room of the workspace when the agent asks for several folders at once', async () => {
    ops.folders = Array.from({ length: WORKSPACE_LIMITS.foldersPerWorkspace - 2 }, (_, index) => `d${index}`);
    const replies = await Promise.all(['a', 'b', 'c', 'd'].map((name) => tools.newFolder(name)));
    expect(replies.filter((reply) => reply.ok)).toHaveLength(2);
  });

  it(`makes at most ${WORKSPACE_LIMITS.foldersPerTask} in one task`, async () => {
    for (let index = 0; index < WORKSPACE_LIMITS.foldersPerTask; index++) expect((await tools.newFolder(`f${index}`)).ok).toBe(true);
    const reply = await tools.newFolder('one-more');
    expect(reply.ok).toBe(false);
    expect(reply.words).toContain(String(WORKSPACE_LIMITS.foldersPerTask));
    expect(ops.folders).not.toContain('one-more');
  });

  it(`makes none when the workspace holds ${WORKSPACE_LIMITS.foldersPerWorkspace} already`, async () => {
    ops.folders = Array.from({ length: WORKSPACE_LIMITS.foldersPerWorkspace }, (_, index) => `d${index}`);
    const reply = await tools.newFolder('one-more');
    expect(reply.ok).toBe(false);
    expect(reply.words).toContain(String(WORKSPACE_LIMITS.foldersPerWorkspace));
    expect(ops.calls).toEqual([]);
  });

  it('does nothing for a task that was stopped', async () => {
    controller.abort();
    const reply = await tools.newFolder('hello');
    expect(reply.ok).toBe(false);
    expect(ops.calls).toEqual([]);
  });

  it('does not count a folder that was refused against the task', async () => {
    for (let index = 0; index < 10; index++) await tools.newFolder('../bad');
    expect((await tools.newFolder('good')).ok).toBe(true);
  });
});

describe('asking to clone a repository', () => {
  const ask = (url = URL_OF_HELLO, name?: string): Promise<{ ok: boolean; words: string }> => tools.clone(url, name);

  it('shows the owner the exact address, the folder and the workspace, tells the office it waits, and clones on a yes', async () => {
    const replied = ask();
    await flush();
    expect(owner.requests).toEqual([{ kind: 'clone', taskId: 't1', workspace: 'build', url: URL_OF_HELLO, folder: 'Hello-World' }]);
    expect(said).toEqual([WAITING_FOR_CLONE_APPROVAL]);
    expect(waits).toEqual([true]);
    expect(ops.calls.filter((call) => !call.startsWith('address'))).toEqual([]);
    owner.answerWith('approved');
    const reply = await replied;
    expect(reply.ok).toBe(true);
    expect(reply.words).toContain('"Hello-World"');
    expect(reply.words).toContain('./Hello-World');
    expect(ops.calls).toEqual([`address ${URL_OF_HELLO}`, `clone Hello-World ${URL_OF_HELLO}`]);
    expect(waits).toEqual([true, false]);
  });

  it('puts it in the folder the agent named, when it named one', async () => {
    const replied = ask(URL_OF_HELLO, 'hello-copy');
    await flush();
    expect(owner.requests[0]?.folder).toBe('hello-copy');
    owner.answerWith('approved');
    await replied;
    expect(ops.calls).toEqual([`address ${URL_OF_HELLO}`, `clone hello-copy ${URL_OF_HELLO}`]);
  });

  it.each([
    ['file:///Users/ana/secret', undefined, /^A repository address /],
    ['https://user:pw@github.com/a/b.git', undefined, /^A repository address /],
    ['--upload-pack=x', undefined, /^A repository address /],
    [URL_OF_HELLO, '../x', /^A folder name /],
    [URL_OF_HELLO, '.git', /^A folder name /],
    ['https://github.com/octocat/.git', undefined, /^A folder name /],
  ])('refuses %j (%j) before the owner is asked, with the words of the rule', async (url, name, words) => {
    const reply = await ask(url, name);
    expect(reply.ok).toBe(false);
    expect(reply.words).toMatch(words);
    expect(owner.requests).toEqual([]);
    expect(ops.calls.filter((call) => !call.startsWith('address'))).toEqual([]);
    expect(said).toEqual([]);
  });

  it('refuses a folder that is there already, whatever the case, before the owner is asked', async () => {
    ops.folders = ['hello-world'];
    const reply = await ask();
    expect(reply.ok).toBe(false);
    expect(reply.words).toContain('already');
    expect(owner.requests).toEqual([]);
  });

  it(`refuses when the workspace holds ${WORKSPACE_LIMITS.foldersPerWorkspace} folders, or ${WORKSPACE_LIMITS.clonesPerWorkspace} clones, before the owner is asked`, async () => {
    ops.folders = Array.from({ length: WORKSPACE_LIMITS.foldersPerWorkspace }, (_, index) => `d${index}`);
    expect((await ask()).ok).toBe(false);
    ops.folders = [];
    ops.clones = WORKSPACE_LIMITS.clonesPerWorkspace;
    expect((await ask()).ok).toBe(false);
    expect(owner.requests).toEqual([]);
  });

  it('does not clone, and says why, when the owner says no', async () => {
    const replied = ask();
    await flush();
    owner.answerWith('denied');
    const reply = await replied;
    expect(reply).toEqual({ ok: false, words: expect.stringMatching(/did not approve/) });
    expect(ops.calls.filter((call) => !call.startsWith('address'))).toEqual([]);
    expect(waits).toEqual([true, false]);
  });

  it('does not clone, and says so, when the owner did not answer in time', async () => {
    const replied = ask();
    await flush();
    await scheduler.advance(APPROVAL_WAIT_MS);
    const reply = await replied;
    expect(reply).toEqual({ ok: false, words: expect.stringMatching(/did not answer in time/) });
    expect(ops.calls.filter((call) => !call.startsWith('address'))).toEqual([]);
    expect(owner.taken).toBe(1);
  });

  it('takes the question away, and clones nothing, when the task is stopped while the owner is asked', async () => {
    const replied = ask();
    await flush();
    controller.abort();
    const reply = await replied;
    expect(reply.ok).toBe(false);
    expect(owner.taken).toBe(1);
    expect(ops.calls.filter((call) => !call.startsWith('address'))).toEqual([]);
  });

  it('does not take a yes that comes after the task was stopped for an approval', async () => {
    const replied = ask();
    await flush();
    controller.abort();
    owner.answerWith('approved');
    expect((await replied).ok).toBe(false);
    expect(ops.calls.filter((call) => !call.startsWith('address'))).toEqual([]);
  });

  it('is refused, with words, where nobody can be asked about a clone', async () => {
    for (const approvals of [null, { ask: owner.ask } as ApprovalPort]) {
      const reply = await build(approvals).clone(URL_OF_HELLO);
      expect(reply).toEqual({ ok: false, words: expect.stringMatching(/no place to approve/) });
    }
    expect(ops.calls.filter((call) => !call.startsWith('address'))).toEqual([]);
  });

  it('refuses, before the owner is asked, an address that the owner’s own settings would send somewhere else', async () => {
    ops.addressFails = 'Your git settings rewrite that address, so it would reach another host than the one shown.';
    const reply = await ask();
    expect(reply).toEqual({ ok: false, words: expect.stringMatching(/rewrite that address/) });
    expect(owner.requests).toEqual([]);
    expect(said).toEqual([]);
    expect(ops.calls).toEqual([`address ${URL_OF_HELLO}`]);
  });

  it('says what happened when the clone failed', async () => {
    ops.cloneFails = 'the repository was not found';
    const replied = ask();
    await flush();
    owner.answerWith('approved');
    const reply = await replied;
    expect(reply).toEqual({ ok: false, words: expect.stringContaining('the repository was not found') });
    expect(ops.calls).toEqual([`address ${URL_OF_HELLO}`, `clone Hello-World ${URL_OF_HELLO}`]);
  });

  it('does not clone into a folder that appeared while the owner was asked', async () => {
    const replied = ask();
    await flush();
    ops.made = 'exists';
    owner.answerWith('approved');
    const reply = await replied;
    expect(reply.ok).toBe(false);
    expect(ops.calls).toEqual([`address ${URL_OF_HELLO}`, `clone Hello-World ${URL_OF_HELLO}`]);
  });

  it('gives git the signal of the task, so that a cancel ends the clone, and takes the folder away', async () => {
    ops.cloneHangs = true;
    const replied = ask();
    await flush();
    owner.answerWith('approved');
    await flush();
    controller.abort();
    const reply = await replied;
    expect(reply.ok).toBe(false);
    expect(ops.signals[0]?.aborted).toBe(true);
  });

  it(`asks at most ${WORKSPACE_LIMITS.clonesPerTask} times in one task, an answer of no included`, async () => {
    for (let index = 0; index < WORKSPACE_LIMITS.clonesPerTask; index++) {
      const replied = ask(`https://github.com/octocat/repo-${index}.git`);
      await flush();
      owner.answerWith('denied');
      await replied;
    }
    const reply = await ask('https://github.com/octocat/one-more.git');
    expect(reply.ok).toBe(false);
    expect(reply.words).toContain(String(WORKSPACE_LIMITS.clonesPerTask));
    expect(owner.requests).toHaveLength(WORKSPACE_LIMITS.clonesPerTask);
  });
});
