import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AllowedFolder } from '../domain/folder-policy.ts';
import { createRepository, neverAborted, plainGit, writeInto } from '../testing/git-fixtures.ts';
import { createGitIsolation } from './git-isolation.ts';
import type { RunProcess } from './run-process.ts';
import { runProcess } from './run-process.ts';

const onWindows = process.platform === 'win32';
// Real git, and a machine that may be busy.
const SLOW = 60_000;

let root: string;
let home: string;
let copies: string;
let repository: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'escritoriio-runner-sweep-')));
  home = join(root, 'home');
  copies = join(root, 'copies');
  repository = join(root, 'repository');
  await mkdir(home);
});

afterEach(() => rm(root, { recursive: true, force: true }));

const folder: () => AllowedFolder = () => ({ label: 'site', path: repository, realPath: repository, access: 'edit', approval: 'auto', isolation: 'worktree', trusted: false, agent: null });
const isolationWith = (exec: RunProcess = runProcess) =>
  createGitIsolation({ surroundings: { home, stateDirectory: join(root, 'state'), worktreesDirectory: copies, windows: onWindows }, exec, environment: { PATH: process.env.PATH, HOME: home } });

const names = async (path: string): Promise<string[]> => (await readdir(path).catch(() => [])).sort();
const branches = async (): Promise<string[]> => (await plainGit(repository, 'branch', '--format=%(refname:short)')).split('\n').filter((line) => line !== '').sort();
const worktreeList = async (): Promise<string[]> => (await plainGit(repository, 'worktree', 'list', '--porcelain')).split('\n').filter((line) => line.startsWith('worktree '));
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

/** A task that began and was never ended: the runner was killed, so nothing finished it or gave it up. */
async function leftBehind(taskId = 't1') {
  return isolationWith().prepare(folder(), taskId, neverAborted());
}

describe('cleaning up after a runner that was killed in the middle of a task', () => {
  it('takes away the copy, what was written down about it, and the branch that has nothing on it', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const orphan = await leftBehind();
    expect(await branches()).toEqual(['escritoriio/t1', 'main']);

    expect(await isolationWith().sweep()).toEqual({ copies: 1, branches: 1 });

    expect(await exists(orphan.folder)).toBe(false);
    expect(await names(copies)).toEqual([]);
    expect(await branches()).toEqual(['main']);
    expect(await worktreeList()).toEqual([`worktree ${repository}`]);
  }, SLOW);

  it('takes the branch away too when the agent only changed files and committed nothing', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const orphan = await leftBehind();
    await writeInto(orphan.folder, { 'a.txt': 'changed\n', 'new.txt': 'new\n' });
    expect(await isolationWith().sweep()).toEqual({ copies: 1, branches: 1 });
    expect(await branches()).toEqual(['main']);
    expect(await names(copies)).toEqual([]);
  }, SLOW);

  it('keeps the branch, and takes away the copy, when there is a commit on it', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const orphan = await leftBehind();
    await writeInto(orphan.folder, { 'work.txt': 'the work\n' });
    await plainGit(orphan.folder, 'add', '-A');
    await plainGit(orphan.folder, 'commit', '--quiet', '-m', 'work that was done');
    const tip = (await plainGit(repository, 'rev-parse', 'escritoriio/t1')).trim();

    expect(await isolationWith().sweep()).toEqual({ copies: 1, branches: 0 });

    expect(await exists(orphan.folder)).toBe(false);
    expect(await names(copies)).toEqual([]);
    expect(await branches()).toEqual(['escritoriio/t1', 'main']);
    expect((await plainGit(repository, 'rev-parse', 'escritoriio/t1')).trim()).toBe(tip);
    expect(await plainGit(repository, 'show', 'escritoriio/t1:work.txt')).toBe('the work\n');
    expect(await worktreeList()).toEqual([`worktree ${repository}`]);
  }, SLOW);

  it('does not touch the work of a task that ended well, which is on a branch with a commit and has no copy any more', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const finished = await leftBehind('done-1');
    await writeInto(finished.folder, { 'x.txt': 'x\n' });
    await finished.finish(neverAborted());
    const orphan = await leftBehind('t2');
    const tip = (await plainGit(repository, 'rev-parse', 'escritoriio/done-1')).trim();

    expect(await isolationWith().sweep()).toEqual({ copies: 1, branches: 1 });

    expect(await branches()).toEqual(['escritoriio/done-1', 'main']);
    expect((await plainGit(repository, 'rev-parse', 'escritoriio/done-1')).trim()).toBe(tip);
    expect(await exists(orphan.folder)).toBe(false);
  }, SLOW);

  it('does nothing when there is nothing to do, even when the folder of copies is not there', async () => {
    expect(await isolationWith().sweep()).toEqual({ copies: 0, branches: 0 });
    await mkdir(copies);
    expect(await isolationWith().sweep()).toEqual({ copies: 0, branches: 0 });
  });

  it('takes care of every copy there is, and of each branch by itself: only the one with a commit on it stays', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    await leftBehind('t1');
    const second = await leftBehind('t2');
    await writeInto(second.folder, { 'w.txt': 'w\n' });
    await plainGit(second.folder, 'add', '-A');
    await plainGit(second.folder, 'commit', '--quiet', '-m', 'w');
    await leftBehind('t3');
    expect(await isolationWith().sweep()).toEqual({ copies: 3, branches: 2 });
    expect(await branches()).toEqual(['escritoriio/t2', 'main']);
  }, SLOW);

  it('does a clean-up of a record whose copy is already gone: the branch goes if nothing is on it, and stays if there is', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const empty = await leftBehind('t1');
    const worked = await leftBehind('t2');
    await writeInto(worked.folder, { 'w.txt': 'w\n' });
    await plainGit(worked.folder, 'add', '-A');
    await plainGit(worked.folder, 'commit', '--quiet', '-m', 'w');
    await rm(empty.folder, { recursive: true });
    await rm(worked.folder, { recursive: true });

    expect(await isolationWith().sweep()).toEqual({ copies: 2, branches: 1 });

    expect(await branches()).toEqual(['escritoriio/t2', 'main']);
    expect(await names(copies)).toEqual([]);
    expect(await worktreeList()).toEqual([`worktree ${repository}`]);
  }, SLOW);

  it('leaves the worktrees of the person alone, one whose folder is not there for the moment included', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const own = join(root, 'own-worktree');
    await plainGit(repository, 'worktree', 'add', '--quiet', '-b', 'own-branch', own);
    const away = join(root, 'own-worktree-away');
    await rename(own, away);
    await leftBehind();

    expect(await isolationWith().sweep()).toEqual({ copies: 1, branches: 1 });

    await rename(away, own);
    expect(await names(join(repository, '.git', 'worktrees'))).toEqual(['own-worktree']);
    expect(await worktreeList()).toEqual([`worktree ${repository}`, `worktree ${own}`]);
    expect(await branches()).toEqual(['main', 'own-branch']);
  }, SLOW);

  it('removes a copy that has no record, and goes no further: it knows nothing of its repository', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    await plainGit(repository, 'branch', 'escritoriio/orphan');
    await mkdir(join(copies, 'orphan'), { recursive: true });
    await writeFile(join(copies, 'orphan', 'file.txt'), 'x');
    expect(await isolationWith().sweep()).toEqual({ copies: 1, branches: 0 });
    expect(await names(copies)).toEqual([]);
    expect(await branches()).toEqual(['escritoriio/orphan', 'main']);
  }, SLOW);

  it('leaves alone what is not named as this runner names a copy, and a file with the name of one', async () => {
    await mkdir(join(copies, 'not an id'), { recursive: true });
    await mkdir(join(copies, 'a.b'));
    await writeFile(join(copies, '.DS_Store'), 'x');
    await writeFile(join(copies, 'notes.txt'), 'x');
    await writeFile(join(copies, 'some-file'), 'x');
    await writeFile(join(copies, 'x.json.123.4.tmp'), 'x');
    expect(await isolationWith().sweep()).toEqual({ copies: 0, branches: 0 });
    expect(await names(copies)).toEqual(['.DS_Store', 'a.b', 'not an id', 'notes.txt', 'some-file', 'x.json.123.4.tmp']);
  });

  it('is not made to go where a record says by a record that is not what this runner writes: the copy goes, and nothing else does', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const head = (await plainGit(repository, 'rev-parse', 'HEAD')).trim();
    await plainGit(repository, 'branch', 'escritoriio/other');
    await plainGit(repository, 'branch', 'precious');
    for (const [id, content] of [
      ['t1', '{ not json'],
      ['t2', JSON.stringify({ version: 1, repository, branch: 'escritoriio/other', base: head })],
      ['t3', JSON.stringify({ version: 1, repository, branch: 'precious', base: head })],
      ['t4', JSON.stringify({ version: 1, repository, branch: 'escritoriio/t4', base: 'not-a-commit' })],
      ['t5', JSON.stringify({ version: 2, repository, branch: 'escritoriio/t5', base: head })],
    ] as const) {
      await mkdir(join(copies, id), { recursive: true });
      await writeFile(join(copies, `${id}.json`), content);
    }
    expect(await isolationWith().sweep()).toEqual({ copies: 5, branches: 0 });
    expect(await branches()).toEqual(['escritoriio/other', 'main', 'precious']);
    expect(await names(copies)).toEqual([]);
  }, SLOW);

  it('goes on when the repository is gone: the copy and the record are taken away, and nothing fails', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const orphan = await leftBehind();
    await rm(repository, { recursive: true, force: true });
    expect(await isolationWith().sweep()).toEqual({ copies: 1, branches: 0 });
    expect(await exists(orphan.folder)).toBe(false);
    expect(await names(copies)).toEqual([]);
  }, SLOW);

  it('keeps the branch when the commit the copy began from cannot be found any more, since it cannot tell that nothing is on it', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    await leftBehind();
    const record = JSON.parse(await readFile(join(copies, 't1.json'), 'utf8')) as Record<string, unknown>;
    await writeFile(join(copies, 't1.json'), JSON.stringify({ ...record, base: '0'.repeat(40) }));
    expect(await isolationWith().sweep()).toEqual({ copies: 1, branches: 0 });
    expect(await branches()).toEqual(['escritoriio/t1', 'main']);
  }, SLOW);

  it.skipIf(onWindows)('does not follow a link in a copy that was left behind, and takes the link away', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'precious.txt'), 'keep me\n');
    const orphan = await leftBehind();
    await symlink(outside, join(orphan.folder, 'link'));
    await isolationWith().sweep();
    expect(await readFile(join(outside, 'precious.txt'), 'utf8')).toBe('keep me\n');
    expect(await exists(orphan.folder)).toBe(false);
  }, SLOW);

  it('does not read what is in a copy that was left behind to know where it belongs: the agent may have written anything there', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const decoy = join(root, 'decoy');
    await createRepository(decoy, { 'd.txt': 'decoy\n' });
    await plainGit(decoy, 'branch', 'escritoriio/t1');
    const orphan = await leftBehind();
    await writeFile(join(orphan.folder, '.git'), `gitdir: ${join(decoy, '.git')}\n`);
    await isolationWith().sweep();
    expect(await branches()).toEqual(['main']);
    expect((await plainGit(decoy, 'branch', '--format=%(refname:short)')).split('\n').filter(Boolean).sort()).toEqual(['escritoriio/t1', 'main']);
  }, SLOW);

  it('runs git as it is always run, with the programs of the repository switched off, and cannot be made to fail by there being no git', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n' });
    const orphan = await leftBehind();
    const calls: (readonly string[])[] = [];
    const watching: RunProcess = (file, args, options) => {
      calls.push(args);
      return runProcess(file, args, options);
    };
    await isolationWith(watching).sweep();
    expect(calls.length).toBeGreaterThan(3);
    for (const args of calls) expect(args).toEqual(expect.arrayContaining(['--no-pager', `core.hooksPath=${onWindows ? 'NUL' : '/dev/null'}`, 'core.fsmonitor=false']));

    const second = await leftBehind('t2');
    const noGit: RunProcess = () => Promise.reject(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }));
    expect(await isolationWith(noGit).sweep()).toEqual({ copies: 1, branches: 0 });
    expect(await exists(second.folder)).toBe(false);
    expect(await exists(orphan.folder)).toBe(false);
  }, SLOW);

  it.skipIf(onWindows)('runs none of what the repository has git run when it deletes a branch or forgets a copy', async () => {
    await createRepository(repository, { 'a.txt': 'hello\n', '.husky/reference-transaction': '', '.husky/post-checkout': '' });
    const marks = join(root, 'marks');
    await mkdir(marks);
    for (const hook of ['reference-transaction', 'post-checkout']) {
      await writeFile(join(repository, '.husky', hook), `#!/bin/sh\ntouch "${join(marks, hook)}"\n`);
      await chmod(join(repository, '.husky', hook), 0o755);
    }
    await plainGit(repository, 'add', '-A');
    await plainGit(repository, 'commit', '--quiet', '-m', 'Hooks that can be run');
    await leftBehind();
    await plainGit(repository, 'config', 'core.hooksPath', '.husky');
    // So that this means something: git run plainly does run the hook when it deletes a branch.
    await plainGit(repository, 'branch', 'control');
    await plainGit(repository, 'branch', '-D', 'control');
    expect(await names(marks)).toContain('reference-transaction');
    await rm(marks, { recursive: true });
    await mkdir(marks);

    expect(await isolationWith().sweep()).toEqual({ copies: 1, branches: 1 });
    expect(await names(marks)).toEqual([]);
  }, SLOW);
});
