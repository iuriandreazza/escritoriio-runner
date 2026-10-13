import { mkdir, mkdtemp, readdir, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepository, plainGit } from '../testing/git-fixtures.ts';
import { createHardenedGit } from './hardened-git.ts';
import { runProcess } from './run-process.ts';
import { forgetCopy, removeCopy } from './worktree-copies.ts';

const SLOW = 60_000;
let root: string;
let repository: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'escritoriio-runner-copies-')));
  repository = join(root, 'repository');
  await createRepository(repository, { 'a.txt': 'hello\n' });
});

afterEach(() => rm(root, { recursive: true, force: true }));

const git = () => createHardenedGit({ exec: runProcess, environment: { PATH: process.env.PATH, HOME: root }, windows: false });
const entries = async (): Promise<string[]> => (await readdir(join(repository, '.git', 'worktrees')).catch(() => [])).sort();
const addCopy = async (name: string): Promise<string> => {
  const path = join(root, 'copies', name);
  await mkdir(join(root, 'copies'), { recursive: true });
  await plainGit(repository, 'worktree', 'add', '--quiet', '-b', `escritoriio/${name}`, path);
  return path;
};

describe('making the repository forget a copy', () => {
  it('takes away the entry of that copy, and of no other, whether its folder is there or not', async () => {
    const mine = await addCopy('mine');
    await addCopy('another-task');
    const away = join(root, 'person-worktree');
    await plainGit(repository, 'worktree', 'add', '--quiet', '-b', 'person', away);
    await rename(away, `${away}-unmounted`);
    await rm(mine, { recursive: true });

    await forgetCopy(git(), repository, mine, false);

    expect(await entries()).toEqual(['another-task', 'person-worktree']);
  }, SLOW);

  it('does nothing when there is nothing to forget, or no repository to ask', async () => {
    await forgetCopy(git(), repository, join(root, 'copies', 'never-made'), false);
    await forgetCopy(git(), join(root, 'not-a-repository'), join(root, 'copies', 'x'), false);
    expect(await entries()).toEqual([]);
  }, SLOW);
});

describe('taking a copy away', () => {
  it('removes the folder and the entry, and leaves the branch for the caller to decide', async () => {
    const copy = await addCopy('t1');
    await removeCopy(git(), repository, copy, false);
    expect(await readdir(join(root, 'copies'))).toEqual([]);
    expect(await entries()).toEqual([]);
    expect(await plainGit(repository, 'branch', '--format=%(refname:short)')).toContain('escritoriio/t1');
  }, SLOW);

  it('removes the folder even when git cannot be asked', async () => {
    const copy = await addCopy('t1');
    const nowhere = createHardenedGit({ exec: runProcess, environment: { PATH: '' }, windows: false });
    await removeCopy(nowhere, repository, copy, false);
    expect(await readdir(join(root, 'copies'))).toEqual([]);
  }, SLOW);
});
