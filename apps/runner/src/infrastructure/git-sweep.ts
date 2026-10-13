import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { TASK_ID_PATTERN } from '@escritoriio/runner-protocol';
import type { SweepReport } from '../application/task-ports.ts';
import type { HardenedGit } from './hardened-git.ts';
import { forgetCopy } from './worktree-copies.ts';
import { readWorktreeRecord, removeWorktreeRecord } from './worktree-records.ts';
import type { WorktreeRecord } from './worktree-records.ts';

export interface SweepDeps {
  readonly worktrees: string;
  readonly git: HardenedGit;
  readonly windows: boolean;
}

const RECORD_NAME = /^([A-Za-z0-9_-]{1,64})\.json$/;

async function isDirectory(path: string): Promise<boolean> {
  return lstat(path).then((entry) => entry.isDirectory(), () => false);
}

/**
 * Whether the branch of a leftover task holds nothing that was not there when the task began. Anything that cannot be told, the commit
 * it began from gone, the repository moved, a branch that is not there, keeps the branch: only a count of nothing deletes one.
 */
async function holdsNothingNew(git: HardenedGit, record: WorktreeRecord, guards: readonly string[]): Promise<boolean> {
  const where = { cwd: record.repository };
  const tip = await git.run(where, guards, ['rev-parse', '--verify', '--quiet', `refs/heads/${record.branch}^{commit}`]);
  if (tip.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(tip.stdout.trim())) return false;
  const ahead = await git.run(where, guards, ['rev-list', '--count', `${record.base}..${tip.stdout.trim()}`]);
  return ahead.exitCode === 0 && ahead.stdout.trim() === '0';
}

/** Takes what one leftover task owns away. Says whether a branch went. Nothing it meets stops it: it goes as far as it can. */
async function sweepOne(deps: SweepDeps, taskId: string): Promise<boolean> {
  const { worktrees, git, windows } = deps;
  const target = join(worktrees, taskId);
  // The copy goes first and whatever is in it is not read: a coding agent could have written anything there. A link in it is removed as a link.
  await rm(target, { recursive: true, force: true }).catch(() => undefined);
  const record = await readWorktreeRecord(worktrees, taskId);
  let branchDeleted = false;
  if (record) {
    try {
      await forgetCopy(git, record.repository, target, windows);
      const guards = await git.filterGuards({ cwd: record.repository });
      if (await holdsNothingNew(git, record, guards)) {
        const deleted = await git.run({ cwd: record.repository }, guards, ['branch', '-D', record.branch]);
        branchDeleted = deleted.exitCode === 0;
      }
    } catch {
      // The repository is gone or cannot be asked: its list of copies is left as it is, and the branch is not touched.
    }
  }
  await removeWorktreeRecord(worktrees, taskId);
  return branchDeleted;
}

/**
 * Cleans up after a runner that was stopped abruptly in the middle of a task. The folder of copies is the runner's own, and a task
 * writes down what it is about to make before it makes it, so for each name there: the copy goes, the repository is asked to forget it,
 * and the branch goes only if nothing was committed on it since the copy began. The work of a task that finished is on a branch with a
 * commit and is never touched, and a name that is not an id of this runner's is left alone.
 *
 * Only to be run while no task runs, since every copy is taken to be one that nothing owns.
 */
export async function sweepWorktrees(deps: SweepDeps): Promise<SweepReport> {
  const ids = new Set<string>();
  for (const name of await readdir(deps.worktrees).catch(() => [])) {
    const record = RECORD_NAME.exec(name)?.[1];
    if (record) ids.add(record);
    else if (TASK_ID_PATTERN.test(name) && (await isDirectory(join(deps.worktrees, name)))) ids.add(name);
  }
  let branches = 0;
  for (const id of ids) {
    if (await sweepOne(deps, id).catch(() => false)) branches += 1;
  }
  return { copies: ids.size, branches };
}
