import { readdir, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isSamePath } from '../domain/paths.ts';
import type { HardenedGit } from './hardened-git.ts';

/**
 * Makes the repository forget the copy of a task, and nothing else. Git keeps a small folder for each worktree of a repository, with a
 * pointer to where the worktree is. The pointer of this copy is found by reading them all, and only that folder goes: `git worktree prune`
 * would take away the entry of every worktree of the repository whose folder is not there at this moment, and a person's own worktree on a
 * disk that is not mounted, or on the other side of a move, is one of those.
 */
export async function forgetCopy(git: HardenedGit, repository: string, target: string, windows: boolean): Promise<void> {
  const asked = await git.run({ cwd: repository }, [], ['rev-parse', '--git-common-dir']).catch(() => undefined);
  const commonDirectory = asked?.exitCode === 0 ? asked.stdout.trim() : '';
  if (commonDirectory === '') return;
  const entries = join(resolve(repository, commonDirectory), 'worktrees');
  // Git writes the place of a copy as the file system names it, which is not always how it was reached (a temporary folder behind a link, say).
  const parent = await realpath(dirname(target)).catch(() => dirname(target));
  const wanted = [join(target, '.git'), join(parent, basename(target), '.git')];
  for (const name of await readdir(entries).catch(() => [])) {
    const pointer = (await readFile(join(entries, name, 'gitdir'), 'utf8').catch(() => '')).trim();
    if (pointer !== '' && wanted.some((place) => isSamePath(place, pointer, windows))) await rm(join(entries, name), { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Takes the copy of a task away: git forgets it, and the folder goes even when git cannot be asked, as when the agent damaged what git reads. */
export async function removeCopy(git: HardenedGit, repository: string, target: string, windows: boolean): Promise<void> {
  const guards = await git.filterGuards({ cwd: repository }).catch(() => []);
  await git.run({ cwd: repository }, guards, ['worktree', 'remove', '--force', target]).catch(() => undefined);
  await rm(target, { recursive: true, force: true }).catch(() => undefined);
  await forgetCopy(git, repository, target, windows).catch(() => undefined);
}
