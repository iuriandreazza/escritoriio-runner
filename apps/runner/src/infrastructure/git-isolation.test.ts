import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { TASK_LIMITS } from '@escritoriio/runner-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IsolationError } from '../application/task-ports.ts';
import type { AllowedFolder } from '../domain/folder-policy.ts';
import { createRepository, neverAborted, plainGit, writeInto } from '../testing/git-fixtures.ts';
import { findProgram } from './find-program.ts';
import { createGitIsolation, taskBranch } from './git-isolation.ts';
import { gitHardening } from './hardened-git.ts';
import type { RunProcess } from './run-process.ts';
import { runProcess } from './run-process.ts';

const onWindows = process.platform === 'win32';
const NULL_DEVICE = onWindows ? 'NUL' : '/dev/null';
// Real git, and a machine that may be busy.
const SLOW = 60_000;

let root: string;
let home: string;
let state: string;
let copies: string;
let repository: string;

beforeEach(async () => {
  // The system's own name for the folder: on some of them the temporary folder is reached through a link, and git answers with the real one.
  root = await realpath(await mkdtemp(join(tmpdir(), 'escritoriio-runner-git-')));
  home = join(root, 'home');
  state = join(root, 'state');
  copies = join(root, 'copies');
  repository = join(root, 'repository');
  await mkdir(home);
});

afterEach(() => rm(root, { recursive: true, force: true }));

const folderOf = (path: string): AllowedFolder => ({ label: 'site', path, realPath: path, access: 'edit', approval: 'auto', isolation: 'worktree', trusted: false, agent: null });

const isolationWith = (exec: RunProcess = runProcess, environment: Record<string, string> = {}) =>
  createGitIsolation({ surroundings: { home, stateDirectory: state, worktreesDirectory: copies, windows: onWindows }, exec, environment: { PATH: process.env.PATH, HOME: home, ...environment } });

const names = async (path: string): Promise<string[]> => (await readdir(path).catch(() => [])).sort();
const branches = async (): Promise<string[]> => (await plainGit(repository, 'branch', '--format=%(refname:short)')).split('\n').filter((line) => line !== '').sort();
const gitHead = async (): Promise<string> => (await plainGit(repository, 'rev-parse', 'HEAD')).trim();
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

/** What the person would notice of the folder they work in: its files, their state, where HEAD is, the index and the branches. */
async function snapshot(): Promise<unknown> {
  // Looking at the status refreshes the index, which is the person's doing and not the runner's: the index is looked at after it.
  const status = await plainGit(repository, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
  return {
    status,
    index: createHash('sha256').update(await readFile(join(repository, '.git', 'index'))).digest('hex'),
    head: await gitHead(),
    branches: (await branches()).filter((branch) => !branch.startsWith('escritoriio/')),
    worktrees: await plainGit(repository, 'worktree', 'list', '--porcelain'),
  };
}

describe('the branch of a task', () => {
  it.each(['t1', 'task_2-b', 'a'.repeat(64), '3f2b8c1e-7d3a-4f5e-9a1b-0c2d3e4f5a6b'])('is named for the id %s', (id) => {
    expect(taskBranch(id)).toBe(`escritoriio/${id}`);
  });

  it.each(['', '../x', 'a/b', 'a b', 'a.b', 'a'.repeat(65), 'tâche', 'a\nb', 'a:b', 'a~1'])('is not made for the id %j, which cannot be used to name a branch', async (id) => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    await expect(isolationWith().prepare(folderOf(repository), id, neverAborted())).rejects.toThrow(/id that cannot be used to name a branch/);
    expect(await names(copies)).toEqual([]);
    expect(await branches()).toEqual(['main']);
  });
});

describe('making the place for a task', () => {
  it('is a worktree of the folder on a branch of its own, from the last commit', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n', 'src/b.ts': 'export {};\n' });
    await writeInto(repository, { 'a.txt': 'not committed\n', 'untracked.txt': 'not committed either\n' });
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());

    expect(isolated.folder).toBe(join(copies, 't1'));
    expect(await names(isolated.folder)).toEqual(['.git', 'a.txt', 'src']);
    expect(await readFile(join(isolated.folder, 'a.txt'), 'utf8')).toBe('hello\n');
    expect(await branches()).toEqual(['escritoriio/t1', 'main']);
    expect((await plainGit(isolated.folder, 'rev-parse', 'HEAD')).trim()).toBe(await gitHead());
    await isolated.discard();
  }, SLOW);

  it.skipIf(onWindows)('keeps what holds the person’s code private to the person', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    expect((await stat(copies)).mode & 0o777).toBe(0o700);
    await isolated.discard();
  }, SLOW);

  it('is the same folder in the copy when the folder is a part of the repository', async () => {
    await createRepository(repository, { 'docs/a.md': 'docs\n', 'src/b.ts': 'code\n' });
    const isolated = await isolationWith().prepare(folderOf(join(repository, 'docs')), 't1', neverAborted());
    expect(isolated.folder).toBe(join(copies, 't1', 'docs'));
    expect(await names(isolated.folder)).toEqual(['a.md']);
    await isolated.discard();
  }, SLOW);

  it('says when the folder is not in the last commit, and leaves nothing', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    await mkdir(join(repository, 'new-folder'));
    await writeInto(repository, { 'new-folder/c.txt': 'not committed\n' });
    await expect(isolationWith().prepare(folderOf(join(repository, 'new-folder')), 't1', neverAborted())).rejects.toThrow(/not part of the last commit/);
    expect(await names(copies)).toEqual([]);
    expect(await branches()).toEqual(['main']);
    expect(await plainGit(repository, 'worktree', 'list')).not.toMatch(/t1/);
  }, SLOW);

  it('says when the folder holds no git repository, without saying where the folder is', async () => {
    await mkdir(repository);
    const failure = isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    await expect(failure).rejects.toBeInstanceOf(IsolationError);
    await expect(failure).rejects.toThrow(/^That folder holds no git repository: /);
    await expect(failure).rejects.not.toThrow(repository);
  }, SLOW);

  it('says when the repository has no commit yet', async () => {
    await mkdir(repository);
    await plainGit(repository, 'init', '--quiet');
    await expect(isolationWith().prepare(folderOf(repository), 't1', neverAborted())).rejects.toThrow(/no commit yet/);
  }, SLOW);

  it('does not copy a repository that is around the person’s home', async () => {
    await createRepository(home, { 'work/site/a.txt': 'hello\n' });
    await expect(isolationWith().prepare(folderOf(join(home, 'work', 'site')), 't1', neverAborted())).rejects.toThrow(/home folder, a whole disk/);
    expect(await names(copies)).toEqual([]);
  }, SLOW);

  it('says when git is not there', async () => {
    const missing: RunProcess = () => Promise.reject(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }));
    await expect(isolationWith(missing).prepare(folderOf(repository), 't1', neverAborted())).rejects.toThrow(/Git is not installed/);
  });

  it('does not take a task id twice: the branch that is there is left as it is', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const first = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    await writeInto(first.folder, { 'new.txt': 'work\n' });
    expect((await first.finish(neverAborted())).branch).toBe('escritoriio/t1');
    const tip = (await plainGit(repository, 'rev-parse', 'escritoriio/t1')).trim();

    await expect(isolationWith().prepare(folderOf(repository), 't1', neverAborted())).rejects.toThrow(/exists already/);
    expect((await plainGit(repository, 'rev-parse', 'escritoriio/t1')).trim()).toBe(tip);
  }, SLOW);
});

describe('ending a task that did something', () => {
  it('commits it to the branch with an identity of its own, removes the copy and keeps the branch', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n', 'gone.txt': 'bye\n', 'src/b.ts': 'code\n' });
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    await writeInto(isolated.folder, { 'a.txt': 'hello, world\n', 'new/c.txt': 'new\n' });
    await rm(join(isolated.folder, 'gone.txt'));

    const kept = await isolated.finish(neverAborted());

    expect(kept.branch).toBe('escritoriio/t1');
    expect(kept.diffStat).toMatch(/a\.txt/);
    expect(kept.diffStat).toMatch(/new\/c\.txt/);
    expect(kept.diffStat).toMatch(/gone\.txt/);
    expect(kept.diffStat).toMatch(/3 files changed/);
    expect(await exists(isolated.folder)).toBe(false);
    expect(await names(copies)).toEqual([]);
    expect(await branches()).toEqual(['escritoriio/t1', 'main']);
    expect(await plainGit(repository, 'worktree', 'list')).not.toMatch(/t1/);
    expect(await plainGit(repository, 'show', 'escritoriio/t1:a.txt')).toBe('hello, world\n');
    expect(await plainGit(repository, 'show', 'escritoriio/t1:new/c.txt')).toBe('new\n');
    expect(await plainGit(repository, 'ls-tree', '--name-only', 'escritoriio/t1')).not.toMatch(/gone\.txt/);
    expect((await plainGit(repository, 'log', '--format=%an|%ae|%cn|%ce', '-1', 'escritoriio/t1')).trim()).toBe('escritoriio Runner|runner@escritoriio.invalid|escritoriio Runner|runner@escritoriio.invalid');
    expect(await plainGit(repository, 'rev-list', '--count', 'main..escritoriio/t1')).toBe('1\n');
  }, SLOW);

  it('leaves the folder of the person exactly as it was, dirty files included, and pushes and moves nothing', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n', 'b.txt': 'b\n' });
    await plainGit(repository, 'branch', 'other');
    await writeInto(repository, { 'a.txt': 'edited by the person\n', 'untracked.txt': 'also theirs\n' });
    await plainGit(repository, 'add', 'b.txt');
    const before = await snapshot();
    const exec = recording();

    const isolated = await isolationWith(exec.run).prepare(folderOf(repository), 't1', neverAborted());
    await writeInto(isolated.folder, { 'a.txt': 'edited by the agent\n', 'new.txt': 'new\n' });
    await isolated.finish(neverAborted());

    expect(await snapshot()).toEqual(before);
    expect(await readFile(join(repository, 'a.txt'), 'utf8')).toBe('edited by the person\n');
    expect(await branches()).toEqual(['escritoriio/t1', 'main', 'other']);
    expect(exec.calls.flatMap((call) => call.args).filter((argument) => ['push', 'pull', 'fetch', 'remote', 'checkout', 'switch', 'clean'].includes(argument))).toEqual([]);
    // The files of the copy are written with a reset, and it is the copy that is reset, by where git keeps its files: never the person's folder.
    const resets = exec.calls.filter((call) => call.args.includes('reset'));
    expect(resets).toHaveLength(1);
    expect(resets[0]?.cwd).toBe(isolated.folder);
    expect(resets[0]?.args.some((argument) => argument.startsWith('--git-dir=') && argument.includes(join('.git', 'worktrees')))).toBe(true);
  }, SLOW);

  it('keeps what the agent committed itself, without making a commit of nothing', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    await writeInto(isolated.folder, { 'mine.txt': 'committed by the agent\n' });
    await plainGit(isolated.folder, 'add', '-A');
    await plainGit(isolated.folder, 'commit', '--quiet', '-m', 'the agent’s own commit');

    const kept = await isolated.finish(neverAborted());

    expect(kept.branch).toBe('escritoriio/t1');
    expect(kept.diffStat).toMatch(/mine\.txt/);
    expect(await plainGit(repository, 'rev-list', '--count', 'main..escritoriio/t1')).toBe('1\n');
  }, SLOW);

  it('keeps the work on its own branch when the agent moved the copy to another, and commits to none of them', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    await plainGit(isolated.folder, 'checkout', '--quiet', '-b', 'the-agents-branch');
    await writeInto(isolated.folder, { 'work.txt': 'work\n' });

    const kept = await isolated.finish(neverAborted());

    expect(kept.branch).toBe('escritoriio/t1');
    expect(await plainGit(repository, 'show', 'escritoriio/t1:work.txt')).toBe('work\n');
    expect((await plainGit(repository, 'rev-parse', 'the-agents-branch')).trim()).toBe(await gitHead());
  }, SLOW);

  it('keeps the work when the agent left the copy on no branch at all', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    await plainGit(isolated.folder, 'checkout', '--quiet', '--detach');
    await writeInto(isolated.folder, { 'work.txt': 'work\n' });
    expect((await isolated.finish(neverAborted())).branch).toBe('escritoriio/t1');
    expect(await plainGit(repository, 'show', 'escritoriio/t1:work.txt')).toBe('work\n');
  }, SLOW);

  it('keeps only the folder that was allowed when that is a part of the repository', async () => {
    await createRepository(repository, { 'docs/a.md': 'docs\n', 'src/b.ts': 'code\n' });
    const isolated = await isolationWith().prepare(folderOf(join(repository, 'docs')), 't1', neverAborted());
    await writeInto(join(isolated.folder, '..'), { 'src/outside.ts': 'written beyond the folder\n' });
    await writeInto(isolated.folder, { 'inside.md': 'inside\n' });

    await isolated.finish(neverAborted());

    const files = (await plainGit(repository, 'ls-tree', '-r', '--name-only', 'escritoriio/t1')).split('\n');
    expect(files).toContain('docs/inside.md');
    expect(files).not.toContain('src/outside.ts');
  }, SLOW);

  it('says the names of files that hide or reverse text as git escapes them, and keeps the stat to its limit', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    const hidden = { 'evil\u202Etxt.md': 'x\n', 'two\nlines.md': 'x\n', 'bell\u0007.md': 'x\n' };
    await writeInto(isolated.folder, hidden);
    for (let file = 0; file < 150; file++) await writeFile(join(isolated.folder, `generated-${file}.txt`), 'x\n');

    const { diffStat } = await isolated.finish(neverAborted());

    expect(diffStat?.length).toBeLessThanOrEqual(TASK_LIMITS.diffStat);
    expect(diffStat).toMatch(/\n\.\.\.\n| \.\.\.\n/);
    expect(diffStat).toMatch(/153 files changed/);
    for (const line of diffStat?.split('\n') ?? []) expect(line).not.toMatch(/[\p{Cc}\u202E\u2066-\u2069]/u);
  }, SLOW);

  it('is not made to commit with what the person has set up for themselves: not their identity, not a signature that needs them', async () => {
    await writeFile(join(home, '.gitconfig'), '[user]\n\tname = Somebody Else\n\temail = else@example.com\n[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n[core]\n\teditor = false\n');
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    await writeInto(isolated.folder, { 'work.txt': 'work\n' });
    await isolated.finish(neverAborted());
    expect((await plainGit(repository, 'log', '--format=%an <%ae>', '-1', 'escritoriio/t1')).trim()).toBe('escritoriio Runner <runner@escritoriio.invalid>');
    expect(await plainGit(repository, 'cat-file', '-p', 'escritoriio/t1')).not.toMatch(/gpgsig/);
  }, SLOW);
});

describe('ending a task that did nothing', () => {
  it.each([
    ['touched nothing', async () => undefined],
    ['changed a file and changed it back', async (folder: string) => {
      await writeInto(folder, { 'a.txt': 'something else\n' });
      await writeInto(folder, { 'a.txt': 'hello\n' });
    }],
    ['made only what git ignores', async (folder: string) => writeInto(folder, { 'ignored.log': 'noise\n' })],
  ])('leaves nothing of it when it %s', async (_what, act) => {
    await createRepository(repository, { 'a.txt': 'hello\n', '.gitignore': '*.log\n' });
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    await act(isolated.folder);

    expect(await isolated.finish(neverAborted())).toEqual({ branch: null, diffStat: null });

    expect(await exists(isolated.folder)).toBe(false);
    expect(await branches()).toEqual(['main']);
    expect(await plainGit(repository, 'worktree', 'list')).not.toMatch(/t1/);
  }, SLOW);

  it('leaves nothing of it when the agent committed something and undid it', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    await writeInto(isolated.folder, { 'x.txt': 'x\n' });
    await plainGit(isolated.folder, 'add', '-A');
    await plainGit(isolated.folder, 'commit', '--quiet', '-m', 'add');
    await plainGit(isolated.folder, 'reset', '--quiet', '--hard', 'HEAD~1');
    expect(await isolated.finish(neverAborted())).toEqual({ branch: null, diffStat: null });
    expect(await branches()).toEqual(['main']);
  }, SLOW);

  it('says the same thing again when it is asked to end twice', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    await writeInto(isolated.folder, { 'x.txt': 'x\n' });
    const first = await isolated.finish(neverAborted());
    expect(await isolated.finish(neverAborted())).toEqual(first);
  }, SLOW);
});

describe('giving a task up', () => {
  it('takes the copy and the branch away, as if nothing had been begun, and may be told twice', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const before = await snapshot();
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    await writeInto(isolated.folder, { 'x.txt': 'x\n' });

    await isolated.discard();
    await isolated.discard();

    expect(await exists(isolated.folder)).toBe(false);
    expect(await branches()).toEqual(['main']);
    expect(await snapshot()).toEqual(before);
  }, SLOW);

  it('does not fail when the copy was taken away by somebody else', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    await rm(isolated.folder, { recursive: true, force: true });
    await expect(isolated.discard()).resolves.toBeUndefined();
    expect(await branches()).toEqual(['main']);
  }, SLOW);

  it('does not fail when there is no git to ask', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const exec = recording();
    const isolated = await isolationWith(exec.run).prepare(folderOf(repository), 't1', neverAborted());
    exec.failFrom = 'now';
    await expect(isolated.discard()).resolves.toBeUndefined();
    expect(await exists(isolated.folder)).toBe(false);
  }, SLOW);

  it('does not take away what was finished, when a mistake further on gives the task up after all', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    await writeInto(isolated.folder, { 'x.txt': 'x\n' });
    await isolated.finish(neverAborted());
    await isolated.discard();
    expect(await branches()).toEqual(['escritoriio/t1', 'main']);
    expect(await plainGit(repository, 'show', 'escritoriio/t1:x.txt')).toBe('x\n');
  }, SLOW);

  it('is what is done with the copy of a task that could not be kept', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    await writeInto(isolated.folder, { 'x.txt': 'x\n' });
    // Something the agent did to the files git needs: the index is not one.
    const gitDir = (await plainGit(isolated.folder, 'rev-parse', '--absolute-git-dir')).trim();
    await writeFile(join(gitDir, 'index'), 'not an index');
    await expect(isolated.finish(neverAborted())).rejects.toBeInstanceOf(IsolationError);
    await isolated.discard();
    expect(await exists(isolated.folder)).toBe(false);
    expect(await branches()).toEqual(['main']);
  }, SLOW);
});

interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

/** The real thing, with what it was asked written down. */
function recording() {
  const calls: Call[] = [];
  const state = { failFrom: undefined as 'now' | undefined };
  const run: RunProcess = (file, args, options) => {
    if (state.failFrom) return Promise.reject(new Error('git cannot be started'));
    calls.push({ file, args, env: options.env, cwd: options.cwd });
    return runProcess(file, args, options);
  };
  return {
    calls,
    run,
    set failFrom(value: 'now') {
      state.failFrom = value;
    },
  };
}

describe('what is written down about a copy, beside it', () => {
  const record = (taskId = 't1') => join(copies, `${taskId}.json`);
  const readRecord = async (taskId = 't1') => JSON.parse(await readFile(record(taskId), 'utf8')) as { version: number; repository: string; branch: string; base: string };

  it('is the repository, the branch and the commit the copy began from, kept while the task goes on and private to the person', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    expect(await readRecord()).toEqual({ version: 1, repository, branch: 'escritoriio/t1', base: await gitHead() });
    if (!onWindows) expect((await stat(record())).mode & 0o777).toBe(0o600);
    await isolated.discard();
  }, SLOW);

  it('is there before the copy is made, so that a runner killed while making it leaves nothing that a clean-up cannot account for', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const seen: boolean[] = [];
    const watching: RunProcess = async (file, args, options) => {
      if (args.includes('worktree') && args.includes('add')) seen.push(await exists(record()));
      return runProcess(file, args, options);
    };
    const isolated = await isolationWith(watching).prepare(folderOf(repository), 't1', neverAborted());
    expect(seen).toEqual([true]);
    await isolated.discard();
  }, SLOW);

  it.each([
    ['the work is kept on its branch', async (isolated: { folder: string; finish(signal: AbortSignal): Promise<unknown> }) => {
      await writeInto(isolated.folder, { 'x.txt': 'x\n' });
      await isolated.finish(neverAborted());
    }],
    ['there was nothing to keep', async (isolated: { folder: string; finish(signal: AbortSignal): Promise<unknown> }) => void (await isolated.finish(neverAborted()))],
  ])('is gone when %s', async (_what, finish) => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    await finish(isolated);
    expect(await names(copies)).toEqual([]);
  }, SLOW);

  it('is gone when the task is given up, and when the copy could not be made', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    await isolated.discard();
    expect(await names(copies)).toEqual([]);

    await plainGit(repository, 'branch', 'escritoriio/t2');
    await expect(isolationWith().prepare(folderOf(repository), 't2', neverAborted())).rejects.toThrow(/exists already/);
    expect(await names(copies)).toEqual([]);
    expect(await branches()).toEqual(['escritoriio/t2', 'main']);

    await mkdir(join(repository, 'new-folder'));
    await writeInto(repository, { 'new-folder/c.txt': 'not committed\n' });
    await expect(isolationWith().prepare(folderOf(join(repository, 'new-folder')), 't3', neverAborted())).rejects.toThrow(/not part of the last commit/);
    expect(await names(copies)).toEqual([]);
  }, SLOW);

  it('is not written over by a task with the id of one that was left behind: it is what the clean-up goes by', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    await mkdir(copies);
    await writeFile(record(), 'what an earlier run wrote');
    await expect(isolationWith().prepare(folderOf(repository), 't1', neverAborted())).rejects.toThrow(/exists already/);
    expect(await readFile(record(), 'utf8')).toBe('what an earlier run wrote');
    expect(await branches()).toEqual(['main']);
  }, SLOW);
});

describe('how git is started', () => {
  it('always has the repository’s programs switched off and nothing to wait for', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n', '.gitattributes': '*.txt filter=lfs\n' });
    await plainGit(repository, 'config', 'filter.lfs.clean', 'git-lfs clean -- %f');
    await plainGit(repository, 'config', 'filter.lfs.smudge', 'git-lfs smudge -- %f');
    await plainGit(repository, 'config', 'filter.lfs.process', 'git-lfs filter-process');
    await plainGit(repository, 'config', 'filter.with.dots.in.its.name.clean', 'cat');
    const exec = recording();
    const isolated = await isolationWith(exec.run, { ANTHROPIC_API_KEY: 'sk-ant-secret', GITHUB_TOKEN: 'ghp_secret', GIT_DIR: '/elsewhere', GIT_EXTERNAL_DIFF: 'evil' }).prepare(folderOf(repository), 't1', neverAborted());
    await writeInto(isolated.folder, { 'x.txt': 'x\n' });
    await isolated.finish(neverAborted());

    expect(exec.calls.length).toBeGreaterThan(8);
    for (const call of exec.calls) {
      // By the full path that was found on the PATH, and not by a name that the folder it is run in could answer to.
      expect(isAbsolute(call.file)).toBe(true);
      expect(basename(call.file)).toMatch(/^git(\.exe)?$/);
      expect(call.args.slice(0, gitHardening(NULL_DEVICE).length)).toEqual(gitHardening(NULL_DEVICE));
      expect(call.args).toEqual(expect.arrayContaining(['--no-pager', `core.hooksPath=${NULL_DEVICE}`, 'core.fsmonitor=false', 'protocol.ext.allow=never', 'core.sshCommand=false']));
      expect(call.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' });
      expect(Object.keys(call.env)).not.toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY']));
      expect(JSON.stringify(call.env)).not.toMatch(/secret|elsewhere|evil/);
    }
    const changing = exec.calls.filter((call) => call.args.some((argument) => ['worktree', 'add', 'commit', 'diff'].includes(argument)));
    for (const call of changing) {
      expect(call.args).toEqual(expect.arrayContaining(['filter.lfs.clean=', 'filter.lfs.smudge=', 'filter.lfs.process=', 'filter.lfs.required=false', 'filter.with.dots.in.its.name.clean=']));
    }
  }, SLOW);

  it('has every command after the copy was made name where git keeps the copy’s files, and not look for them in the copy', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const exec = recording();
    const isolated = await isolationWith(exec.run).prepare(folderOf(repository), 't1', neverAborted());
    const madeBefore = exec.calls.length;
    await writeInto(isolated.folder, { 'x.txt': 'x\n' });
    await isolated.finish(neverAborted());
    const inTheCopy = exec.calls.slice(madeBefore).filter((call) => call.args.some((argument) => ['add', 'commit', 'diff', 'symbolic-ref'].includes(argument)));
    expect(inTheCopy.length).toBeGreaterThan(3);
    for (const call of inTheCopy) {
      expect(call.args.some((argument) => argument.startsWith('--git-dir=') && argument.includes(join('.git', 'worktrees')))).toBe(true);
      expect(call.args.some((argument) => argument.startsWith('--work-tree='))).toBe(true);
    }
  }, SLOW);
});

describe('what a repository would have git run', () => {
  /** Programs that write a mark when git runs them, the ways a repository has git run one: hooks of a Husky setup, a monitor of the file system, filters, programs for diffs. */
  async function hostileRepository(directory: string, marks: string, withProcessFilter = false): Promise<void> {
    await mkdir(marks, { recursive: true });
    const scripts = join(directory, '..', `scripts-of-${directory.split(/[\\/]/).at(-1)}`);
    await mkdir(scripts, { recursive: true });
    const script = async (path: string, mark: string, body = ''): Promise<string> => {
      await writeFile(path, `#!/bin/sh\ntouch "${join(marks, mark)}"\n${body}`);
      await chmod(path, 0o755);
      return path;
    };
    // The hooks are in the repository, as a Husky setup keeps them, so the copy has them too.
    const hooks = ['pre-commit', 'commit-msg', 'post-commit', 'post-checkout', 'post-merge', 'reference-transaction'];
    await createRepository(directory, { 'a.txt': 'hello\n', '.gitattributes': '*.txt filter=evil diff=evil\n', 'dir/b.txt': 'b\n', ...Object.fromEntries(hooks.map((hook) => [`.husky/${hook}`, ''])) });
    for (const hook of hooks) await script(join(directory, '.husky', hook), `hook-${hook}`);
    await plainGit(directory, 'add', '-A');
    await plainGit(directory, 'commit', '--quiet', '-m', 'Hooks that can be run');
    await plainGit(directory, 'config', 'core.hooksPath', '.husky');
    await plainGit(directory, 'config', 'filter.evil.clean', await script(join(scripts, 'clean.sh'), 'filter-clean', 'cat\n'));
    await plainGit(directory, 'config', 'filter.evil.smudge', await script(join(scripts, 'smudge.sh'), 'filter-smudge', 'cat\n'));
    // One that does not speak the protocol git expects: with it set, git run plainly cannot read or write a file at all.
    if (withProcessFilter) await plainGit(directory, 'config', 'filter.evil.process', await script(join(scripts, 'process.sh'), 'filter-process'));
    await plainGit(directory, 'config', 'core.fsmonitor', await script(join(scripts, 'fsmonitor.sh'), 'fsmonitor', "printf '\\0'\n"));
    await plainGit(directory, 'config', 'diff.external', await script(join(scripts, 'diff.sh'), 'diff-external'));
    await plainGit(directory, 'config', 'diff.evil.textconv', await script(join(scripts, 'textconv.sh'), 'textconv', 'cat "$1"\n'));
    await plainGit(directory, 'config', 'core.sshCommand', await script(join(scripts, 'ssh.sh'), 'ssh'));
    await plainGit(directory, 'config', 'core.pager', await script(join(scripts, 'pager.sh'), 'pager', 'cat\n'));
    await plainGit(directory, 'config', 'credential.helper', await script(join(scripts, 'credential.sh'), 'credential'));
  }

  const edit = async (folder: string): Promise<void> => {
    await writeInto(folder, { 'a.txt': 'changed\n', 'new.txt': 'new\n', 'dir/c.txt': 'c\n' });
  };

  // So that the tests below mean something: the same repository, with git run plainly, runs these.
  it.skipIf(onWindows)('runs them when git is run plainly, which is what the tests below keep from happening', async () => {
    const marks = join(root, 'marks-control');
    const control = join(root, 'control');
    await hostileRepository(control, marks);
    await rm(marks, { recursive: true });
    await mkdir(marks);
    const copy = join(root, 'control-copy');
    await plainGit(control, 'worktree', 'add', '--quiet', '-b', 'control', copy);
    await edit(copy);
    await plainGit(copy, 'add', '-A');
    await plainGit(copy, 'commit', '--quiet', '-m', 'work');
    await plainGit(copy, 'diff', 'HEAD~1', 'HEAD');
    expect(await names(marks)).toEqual(expect.arrayContaining(['hook-pre-commit', 'hook-post-commit', 'hook-post-checkout', 'filter-clean', 'filter-smudge', 'fsmonitor']));
  }, SLOW);

  it.skipIf(onWindows)('runs none of them, whatever it is asked: not when the copy is made, nor when what was done is kept, nor when it is given up', async () => {
    const marks = join(root, 'marks');
    await hostileRepository(repository, marks);
    const before = await snapshot();
    await rm(marks, { recursive: true });
    await mkdir(marks);
    await plainGit(repository, 'config', 'filter.evil.process', join(root, 'scripts-of-repository', 'process.sh'));
    await writeFile(join(root, 'scripts-of-repository', 'process.sh'), `#!/bin/sh\ntouch "${join(marks, 'filter-process')}"\n`, { mode: 0o755 });

    const isolation = isolationWith();
    const kept = await isolation.prepare(folderOf(repository), 't1', neverAborted());
    await edit(kept.folder);
    const result = await kept.finish(neverAborted());
    const given = await isolation.prepare(folderOf(repository), 't2', neverAborted());
    await edit(given.folder);
    await given.discard();

    expect(await names(marks)).toEqual([]);
    expect(result.branch).toBe('escritoriio/t1');
    expect(await plainGit(repository, 'show', 'escritoriio/t1:new.txt')).toBe('new\n');
    expect(await plainGit(repository, 'show', 'escritoriio/t1:a.txt')).toBe('changed\n');
    expect(await branches()).toEqual(['escritoriio/t1', 'main']);
    // Git run plainly cannot read a file with that filter set, so it is taken off to look at what is left.
    await plainGit(repository, 'config', '--unset', 'filter.evil.process');
    expect(await snapshot()).toEqual(before);
  }, SLOW);

  it.skipIf(onWindows)('runs none of the ones the person’s own settings name either', async () => {
    const marks = join(root, 'marks');
    await mkdir(marks);
    const hooks = join(home, 'global-hooks');
    await mkdir(hooks);
    for (const hook of ['pre-commit', 'post-checkout', 'post-commit']) {
      await writeFile(join(hooks, hook), `#!/bin/sh\ntouch "${join(marks, `global-${hook}`)}"\n`);
      await chmod(join(hooks, hook), 0o755);
    }
    await writeFile(join(home, '.gitconfig'), `[core]\n\thooksPath = ${hooks}\n`);
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    await writeInto(isolated.folder, { 'x.txt': 'x\n' });
    await isolated.finish(neverAborted());
    expect(await names(marks)).toEqual([]);
  }, SLOW);

  it.skipIf(onWindows)('runs none of the programs in a copy the agent pointed somewhere else, or filled with a repository of its own', async () => {
    const marks = join(root, 'marks');
    await hostileRepository(repository, marks);
    await rm(marks, { recursive: true });
    await mkdir(marks);
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    await edit(isolated.folder);

    // The agent writes in its folder, and so in what tells git where the copy's files are: this one says they are in a repository it made.
    const decoy = join(root, 'decoy');
    await plainGit(root, 'init', '--quiet', '--bare', decoy);
    const scriptPath = join(root, 'decoy-script.sh');
    await writeFile(scriptPath, `#!/bin/sh\ntouch "${join(marks, 'decoy')}"\nprintf '\\0'\n`);
    await chmod(scriptPath, 0o755);
    await plainGit(decoy, 'config', 'core.fsmonitor', scriptPath);
    await plainGit(decoy, 'config', 'core.hooksPath', join(repository, '.husky'));
    await plainGit(decoy, 'config', 'filter.decoy.clean', scriptPath);
    await writeFile(join(isolated.folder, '.git'), `gitdir: ${decoy}\n`);
    // And repositories of its own inside the copy, with a filter of its own, one with a commit and one without.
    for (const [name, committed] of [['nested', true], ['nested-empty', false]] as const) {
      const nested = join(isolated.folder, name);
      await mkdir(nested);
      await plainGit(nested, 'init', '--quiet');
      await writeInto(nested, { '.gitattributes': '*.txt filter=decoy\n', 'n.txt': 'n\n' });
      if (committed) {
        await plainGit(nested, 'add', '-A');
        await plainGit(nested, 'commit', '--quiet', '-m', 'nested');
      }
      await plainGit(nested, 'config', 'filter.decoy.clean', scriptPath);
      await plainGit(nested, 'config', 'core.fsmonitor', scriptPath);
    }

    const kept = await isolated.finish(neverAborted());

    expect(await names(marks)).toEqual([]);
    expect(kept.branch).toBe('escritoriio/t1');
    expect(await plainGit(repository, 'show', 'escritoriio/t1:new.txt')).toBe('new\n');
    expect(await plainGit(decoy, 'rev-list', '--all', '--count')).toBe('0\n');
    expect(await exists(isolated.folder)).toBe(false);
  }, SLOW);

  it.skipIf(onWindows)('takes away a copy that the agent linked to somewhere else, not what the link leads to', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'precious.txt'), 'keep me\n');
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    await symlink(outside, join(isolated.folder, 'link'));
    await isolated.discard();
    expect(await readFile(join(outside, 'precious.txt'), 'utf8')).toBe('keep me\n');
    expect(await exists(isolated.folder)).toBe(false);
  }, SLOW);
});

describe('what the settings of a repository name only for the branch of the task', () => {
  async function branchOnlyFilter(): Promise<{ readonly marks: string }> {
    const marks = join(root, 'marks');
    await mkdir(marks);
    const smudge = join(root, 'smudge.sh');
    await writeFile(smudge, `#!/bin/sh\ntouch "${join(marks, 'smudge-on-the-task-branch')}"\ncat\n`);
    await chmod(smudge, 0o755);
    await createRepository(repository, { 'a.txt': 'hello\n', '.gitattributes': '*.txt filter=branchonly\n' });
    // Read when the branch that is checked out is one of the tasks, and not before: what is read of the repository on `main` does not have it.
    await writeFile(join(repository, '.git', 'task-branch.config'), `[filter "branchonly"]\n\tsmudge = ${smudge}\n\trequired = true\n`);
    await plainGit(repository, 'config', 'includeIf.onbranch:escritoriio/**.path', 'task-branch.config');
    return { marks };
  }

  it.skipIf(onWindows)('are not run when the files are written into the copy, though the repository does not name them until the branch is checked out', async () => {
    const { marks } = await branchOnlyFilter();
    expect(await plainGit(repository, 'config', '--list')).not.toMatch(/branchonly/);

    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());

    expect(await names(marks)).toEqual([]);
    expect(await readFile(join(isolated.folder, 'a.txt'), 'utf8')).toBe('hello\n');
    await writeInto(isolated.folder, { 'a.txt': 'changed\n' });
    expect((await isolated.finish(neverAborted())).branch).toBe('escritoriio/t1');
    expect(await names(marks)).toEqual([]);
  }, SLOW);

  // So that the test above means something: git run plainly does run it.
  it.skipIf(onWindows)('are run by git run plainly, which is what the test above keeps from happening', async () => {
    const { marks } = await branchOnlyFilter();
    await plainGit(repository, 'worktree', 'add', '--quiet', '-b', 'escritoriio/control', join(root, 'control-copy'));
    expect(await names(marks)).toEqual(['smudge-on-the-task-branch']);
  }, SLOW);
});

describe('the worktrees of the person, which are theirs', () => {
  const entries = () => names(join(repository, '.git', 'worktrees'));

  /** A worktree of the person's own whose folder is not there for the moment: on a disk that is not mounted, or on the other side of a move. */
  async function worktreeAway(): Promise<() => Promise<void>> {
    const own = join(root, 'own-worktree');
    await plainGit(repository, 'worktree', 'add', '--quiet', '-b', 'own-branch', own);
    const away = join(root, 'own-worktree-away');
    await rename(own, away);
    return () => rename(away, own);
  }

  const stillListed = async (): Promise<boolean> => (await plainGit(repository, 'worktree', 'list', '--porcelain')).includes(join(root, 'own-worktree'));

  it('are not forgotten when a copy is given up', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const back = await worktreeAway();
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    await isolated.discard();
    await back();
    expect(await entries()).toEqual(['own-worktree']);
    expect(await stillListed()).toBe(true);
  }, SLOW);

  it('are not forgotten when the work is kept and a copy is taken away', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const back = await worktreeAway();
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    await writeInto(isolated.folder, { 'new.txt': 'new\n' });
    await isolated.finish(neverAborted());
    await back();
    expect(await entries()).toEqual(['own-worktree']);
    expect(await stillListed()).toBe(true);
  }, SLOW);

  it('are left alone when the copy that is taken away was already gone, which the person or the agent may have done', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const back = await worktreeAway();
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    expect(await entries()).toEqual(['own-worktree', 't1']);
    await rm(isolated.folder, { recursive: true, force: true });
    await isolated.discard();
    expect(await entries()).toEqual(['own-worktree']);
    await back();
    expect(await stillListed()).toBe(true);
    expect(await branches()).toEqual(['main', 'own-branch']);
  }, SLOW);

  it('are left alone when the copy has the name of another entry, and git numbered it', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    // An entry named as the next copy would be, which git works around by adding a number to the name of the new one.
    const other = join(root, 'elsewhere', 't1');
    await mkdir(join(root, 'elsewhere'));
    await plainGit(repository, 'worktree', 'add', '--quiet', '-b', 'person-branch', other);
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    expect(await entries()).toEqual(['t1', 't11']);
    await isolated.discard();
    expect(await entries()).toEqual(['t1']);
    expect(await plainGit(repository, 'worktree', 'list', '--porcelain')).toContain(other);
  }, SLOW);
});

describe('whether a folder can be copied', () => {
  it('is yes for a folder of a repository that has a commit, and nothing is made to find it out', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n', 'docs/a.md': 'docs\n' });
    expect(await isolationWith().check(folderOf(repository))).toBeUndefined();
    expect(await isolationWith().check(folderOf(join(repository, 'docs')))).toBeUndefined();
    expect(await names(copies)).toEqual([]);
    expect(await branches()).toEqual(['main']);
  }, SLOW);

  it.each([
    ['a folder that holds no repository', async () => void (await mkdir(repository)), () => repository, /^That folder holds no git repository: /],
    ['a repository with no commit yet', async () => {
      await mkdir(repository);
      await plainGit(repository, 'init', '--quiet');
    }, () => repository, /no commit yet/],
    ['a folder that is not in the last commit', async () => {
      await createRepository(repository, { 'a.txt': 'hello\n' });
      await mkdir(join(repository, 'new-folder'));
      await writeInto(repository, { 'new-folder/c.txt': 'not committed\n' });
    }, () => join(repository, 'new-folder'), /not part of the last commit/],
    ['a repository around the home folder', async () => {
      await createRepository(home, { 'work/site/a.txt': 'hello\n' });
    }, () => join(home, 'work', 'site'), /home folder, a whole disk/],
    ['a repository that holds a place where credentials are kept, with the credentials committed in it', async () => {
      await createRepository(join(home, '.config'), { 'gh/hosts.yml': 'oauth_token: not-for-a-copy\n', 'nvim/init.lua': '-- settings\n' });
    }, () => join(home, '.config', 'nvim'), /place where credentials are kept/],
  ])('is no for %s, in the words that a task would be refused with', async (_what, arrange, folder, words) => {
    await arrange();
    expect(await isolationWith().check(folderOf(folder()))).toMatch(words);
    expect(await names(copies)).toEqual([]);
  }, SLOW);

  it('says when git is not there', async () => {
    expect(await isolationWith(runProcess, { PATH: '' }).check(folderOf(repository))).toMatch(/Git is not installed/);
  });
});

describe('git, as a program that is found', () => {
  it('is looked for on the PATH of the runner, and a machine that has none is told so, with nothing run', async () => {
    const calls: string[] = [];
    const exec: RunProcess = (file) => {
      calls.push(file);
      return Promise.reject(new Error('must not be run'));
    };
    await expect(isolationWith(exec, { PATH: '' }).prepare(folderOf(repository), 't1', neverAborted())).rejects.toThrow(/Git is not installed/);
    expect(calls).toEqual([]);
  });

  it.skipIf(onWindows)('is looked for again when it was not found: a git installed while the runner runs is used by the next task', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const bin = join(root, 'bin');
    await mkdir(bin);
    const isolation = isolationWith(runProcess, { PATH: bin });
    expect(await isolation.check(folderOf(repository))).toMatch(/Git is not installed/);
    const real = (await findProgram('git', { PATH: process.env.PATH }, false)) ?? '';
    await symlink(real, join(bin, 'git'));
    expect(await isolation.check(folderOf(repository))).toBeUndefined();
  });

  it.skipIf(onWindows)('is the one of the PATH and not one that is in the folder it is run from', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const mark = join(root, 'planted-ran');
    await writeFile(join(repository, 'git'), `#!/bin/sh\ntouch "${mark}"\n`);
    await chmod(join(repository, 'git'), 0o755);
    // An empty entry and a dot are the folder the program is run from, which is where the agent could have put one.
    const isolated = await isolationWith(runProcess, { PATH: `:.:${process.env.PATH}` }).prepare(folderOf(repository), 't1', neverAborted());
    await isolated.finish(neverAborted());
    expect(await exists(mark)).toBe(false);
  }, SLOW);
});

describe('being told to stop in the middle of git', () => {
  /** The environment of a machine whose `git` sleeps for the commands whose words match, and is the real one for the others: what a git that does not end looks like. */
  async function withSlowGit(slowOn: string): Promise<Record<string, string>> {
    const real = await findProgram('git', process.env, false);
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'git'), `#!/bin/sh\ncase " $* " in\n  *"${slowOn}"*) sleep 60 ;;\nesac\nexec "${real}" "$@"\n`);
    await chmod(join(bin, 'git'), 0o755);
    return { PATH: `${bin}:${process.env.PATH}` };
  }

  /** Aborts in a moment, and gives what the run came to and how long it was before it did. */
  async function stoppedSoon(run: (signal: AbortSignal) => Promise<unknown>): Promise<{ readonly failure: unknown; readonly ms: number }> {
    const controller = new AbortController();
    const started = Date.now();
    const running = run(controller.signal).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    setTimeout(() => controller.abort(), 500);
    const failure = await running;
    return { failure, ms: Date.now() - started };
  }

  it.skipIf(onWindows)('leaves nothing of a copy that was being made, and is quick about it', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const environment = await withSlowGit('worktree add');
    const { failure, ms } = await stoppedSoon((signal) => isolationWith(runProcess, environment).prepare(folderOf(repository), 't1', signal));
    expect(failure).toBeInstanceOf(IsolationError);
    expect(ms).toBeLessThan(20_000);
    expect(await names(copies)).toEqual([]);
    expect(await branches()).toEqual(['main']);
    expect(await names(join(repository, '.git', 'worktrees'))).toEqual([]);

    // And the id is free again.
    const again = await isolationWith().prepare(folderOf(repository), 't1', neverAborted());
    await again.discard();
  }, SLOW);

  it.skipIf(onWindows)('leaves nothing of a copy that was being written, and nothing of the other worktrees of the person is taken with it', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const own = join(root, 'own-worktree');
    await plainGit(repository, 'worktree', 'add', '--quiet', '-b', 'own-branch', own);
    const away = join(root, 'own-worktree-away');
    await rename(own, away);
    const environment = await withSlowGit('reset --hard');

    const { failure } = await stoppedSoon((signal) => isolationWith(runProcess, environment).prepare(folderOf(repository), 't1', signal));

    expect(failure).toBeInstanceOf(IsolationError);
    expect(await names(copies)).toEqual([]);
    expect(await branches()).toEqual(['main', 'own-branch']);
    expect(await names(join(repository, '.git', 'worktrees'))).toEqual(['own-worktree']);
    await rename(away, own);
  }, SLOW);

  it.skipIf(onWindows)('does not start git at all when it was told to stop already', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const calls: string[] = [];
    const exec: RunProcess = (file, args, options) => {
      calls.push(args.join(' '));
      return runProcess(file, args, options);
    };
    await expect(isolationWith(exec).prepare(folderOf(repository), 't1', AbortSignal.abort())).rejects.toBeInstanceOf(IsolationError);
    expect(await names(copies)).toEqual([]);
    expect(calls.join('\n')).not.toMatch(/worktree add/);
  }, SLOW);

  it.skipIf(onWindows)('lets the work be given up afterwards when keeping it was stopped, and is quick about it', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const isolated = await isolationWith(runProcess, await withSlowGit(' commit ')).prepare(folderOf(repository), 't1', neverAborted());
    await writeInto(isolated.folder, { 'new.txt': 'new\n' });

    const { failure, ms } = await stoppedSoon((signal) => isolated.finish(signal));

    expect(failure).toBeInstanceOf(IsolationError);
    expect(ms).toBeLessThan(20_000);
    await isolated.discard();
    expect(await names(copies)).toEqual([]);
    expect(await branches()).toEqual(['main']);
  }, SLOW);

  it('takes a copy away whatever became of the signal it was made under: giving up is what a task that was stopped needs', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const stopped = new AbortController();
    const isolated = await isolationWith().prepare(folderOf(repository), 't1', stopped.signal);
    stopped.abort();
    await isolated.discard();
    expect(await exists(isolated.folder)).toBe(false);
    expect(await branches()).toEqual(['main']);
  }, SLOW);
});
