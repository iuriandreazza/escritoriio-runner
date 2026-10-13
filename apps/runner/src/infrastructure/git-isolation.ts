import { mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { TASK_ID_PATTERN, TASK_LIMITS } from '@escritoriio/runner-protocol';
import type { IsolatedFolder, Isolation } from '../application/task-ports.ts';
import { IsolationError } from '../application/task-ports.ts';
import { capLines } from '../domain/cap-lines.ts';
import type { AllowedFolder, Surroundings } from '../domain/folder-policy.ts';
import { problemWithNewFolder } from '../domain/folder-policy.ts';
import { placesOf } from '../domain/redact.ts';
import type { HardenedGit, Where } from './hardened-git.ts';
import { COMMIT_IDENTITY, COULD_NOT_COPY, createHardenedGit, describeGitFailure } from './hardened-git.ts';
import { sweepWorktrees } from './git-sweep.ts';
import type { ProcessResult, RunProcess } from './run-process.ts';
import { removeCopy } from './worktree-copies.ts';
import { hasWorktreeRecord, removeWorktreeRecord, taskBranch, writeWorktreeRecord } from './worktree-records.ts';

export { taskBranch } from './worktree-records.ts';

export interface GitIsolationOptions {
  /** The places of this machine: the copies are made in `worktreesDirectory`, and no repository around the home folder, or around these places, is copied. */
  readonly surroundings: Surroundings;
  /** How a program is run: the real one, or a test's. */
  readonly exec: RunProcess;
  /** What the runner was started with: only what a coding agent may have reaches git (see `childEnvironment`), and git is looked for on its PATH. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

const DIFF_STAT = '--stat=100,60,25';

/** What a command may take when nobody waits on it for long: looking at a folder before it is shared, and taking away what a task left. */
const QUICK_GIT_MS = 30_000;

const NO_REPOSITORY = 'That folder holds no git repository: put it under git (git init, then a first commit), or change the folder to work in place.';
const NO_COMMIT = 'That repository has no commit yet: make a first commit, so that there is something to copy.';
const TOO_WIDE = 'The git repository around that folder is your home folder, a whole disk, the runner’s own folders or a place where credentials are kept, and a copy of that cannot be made. Give the folder a repository of its own, or change it to work in place.';
const NOT_COMMITTED = 'That folder is not part of the last commit of its repository, so there is nothing of it to copy. Commit it, or change the folder to work in place.';
const NOT_TRUSTED = 'Git does not trust that repository because it belongs to another user. Its safe.directory setting is how the owner of this machine allows it.';
const TASK_EXISTS = 'A copy or a branch for this task exists already in that repository.';
const BAD_TASK_ID = 'This task has an id that cannot be used to name a branch.';

/** Where a failure is told: not with a place of this machine in it. */
interface FailurePlaces {
  readonly repository: string;
  readonly folder: AllowedFolder;
}

/** Where a folder is in its repository. */
interface Located {
  readonly repository: string;
  /** Where the folder is in the repository, with a slash at the end, or nothing for the top. */
  readonly prefix: string;
  /** The last commit, which is what a copy is made from. */
  readonly base: string;
  readonly places: FailurePlaces;
}

interface Made {
  readonly taskId: string;
  readonly repository: string;
  readonly target: string;
  readonly workFolder: string;
  readonly gitDir: string;
  readonly branch: string;
  readonly base: string;
  readonly prefix: string;
}

/**
 * The place for a task as a git worktree of the folder's repository, made from its last commit on a branch of its own. The folder the
 * person works in is never touched: no file, no index, no branch other than the new one, and nothing is pushed. What the agent did is
 * committed to the branch when the task ends, and the copy is removed, the branch kept.
 */
export function createGitIsolation(options: GitIsolationOptions): Isolation {
  const { surroundings } = options;
  const { windows } = surroundings;
  const environment = options.environment ?? process.env;
  const worktrees = resolve(surroundings.worktreesDirectory);
  const git = createHardenedGit({ exec: options.exec, environment, windows });
  // Taking away what is left of a task is done after it was told to stop, so it is not stopped by that, and it is not waited on for long.
  const quick = git.scoped({ timeoutMs: QUICK_GIT_MS });

  const describe = (result: ProcessResult, { repository, folder }: FailurePlaces): string =>
    describeGitFailure(result, placesOf(surroundings, environment, { workFolder: repository, allowedFolder: folder.realPath }));

  async function exists(path: string): Promise<boolean> {
    return stat(path).then(() => true, () => false);
  }

  /** What git answered, unless it was stopped before it could answer: a command that did not finish says nothing about the folder. */
  function answered(result: ProcessResult, places: FailurePlaces): ProcessResult {
    if (result.stopped) throw new IsolationError(`${COULD_NOT_COPY} (${describe(result, places)}).`);
    return result;
  }

  /** Where a folder is in its repository and what a copy of it would be made from, or why there is no copy to make. */
  async function locate(folder: AllowedFolder, hardened: HardenedGit): Promise<Located> {
    const first: FailurePlaces = { repository: folder.realPath, folder };
    const located = answered(await hardened.run({ cwd: folder.realPath }, [], ['rev-parse', '--show-toplevel', '--show-prefix']), first);
    const [repository = '', prefix = ''] = located.stdout.split('\n').map((line) => line.replace(/\r$/, ''));
    const places = { repository: repository || folder.realPath, folder };
    if (located.exitCode !== 0 || repository === '') {
      if (/dubious ownership/.test(located.stderr)) throw new IsolationError(NOT_TRUSTED);
      throw new IsolationError(/not a git repository|must be run in a work tree/.test(located.stderr) ? NO_REPOSITORY : `${COULD_NOT_COPY} (${describe(located, places)}).`);
    }
    // A repository around the person's home (dotfiles are kept that way) would put all of it in the copy.
    if (problemWithNewFolder(repository, surroundings)) throw new IsolationError(TOO_WIDE);

    const head = answered(await hardened.run({ cwd: repository }, [], ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']), places);
    const base = head.stdout.trim();
    if (head.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(base)) throw new IsolationError(NO_COMMIT);

    if (prefix !== '') {
      // A folder the last commit does not hold (a new one, or one that is only there as files nobody committed) has nothing to be copied.
      const kind = answered(await hardened.run({ cwd: repository }, [], ['cat-file', '-t', `${base}:${prefix.replace(/\/$/, '')}`]), places);
      if (kind.exitCode !== 0 || kind.stdout.trim() !== 'tree') throw new IsolationError(NOT_COMMITTED);
    }
    return { repository, prefix, base, places };
  }

  async function check(folder: AllowedFolder): Promise<string | undefined> {
    try {
      await locate(folder, quick);
      return undefined;
    } catch (error) {
      if (error instanceof IsolationError) return error.message;
      throw error;
    }
  }

  async function deleteBranch(repository: string, branch: string): Promise<void> {
    await quick.run({ cwd: repository }, [], ['branch', '-D', branch]).catch(() => undefined);
  }

  async function prepare(folder: AllowedFolder, taskId: string, signal: AbortSignal): Promise<IsolatedFolder> {
    if (!TASK_ID_PATTERN.test(taskId)) throw new IsolationError(BAD_TASK_ID);
    const hardened = git.scoped({ signal });
    const branch = taskBranch(taskId);
    const target = join(worktrees, taskId);

    const { repository, prefix, base, places } = await locate(folder, hardened);
    // Something under this id is there already: what a task that was stopped abruptly left, or the work of one that was kept. Neither is written over,
    // and what is there after a stop of this one, which began with nothing there, is this one's to take away.
    const taken = answered(await hardened.run({ cwd: repository }, [], ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]), places);
    if (taken.exitCode === 0 || (await exists(target)) || (await hasWorktreeRecord(worktrees, taskId))) throw new IsolationError(TASK_EXISTS);
    // The copies hold the person's code: only the person may enter the folder they are in.
    await mkdir(worktrees, { recursive: true, mode: 0o700 });
    const guards = await hardened.filterGuards({ cwd: repository });
    // Written down before the copy is made, so that a runner killed while making it leaves nothing that a clean-up cannot account for.
    await writeWorktreeRecord(worktrees, taskId, { repository, branch, base });
    // From the commit that was read, and not from `HEAD`, which may move while this is going on. Nothing is written into the copy yet:
    // the files are checked out below, once git can be asked which filters the copy's own settings name.
    const added = await hardened.run({ cwd: repository }, guards, ['worktree', 'add', '--quiet', '--no-checkout', '-b', branch, target, base]);
    if (added.exitCode !== 0 && !added.stopped) {
      await removeWorktreeRecord(worktrees, taskId);
      throw new IsolationError(/already exists|already checked out/.test(added.stderr) ? TASK_EXISTS : `${COULD_NOT_COPY} (${describe(added, places)}).`);
    }

    let made: Made;
    try {
      answered(added, places);
      // Asked before the agent has touched the copy: where git keeps the copy's files is not asked of a place the agent can write.
      const asked = await hardened.run({ cwd: target }, guards, ['rev-parse', '--absolute-git-dir']);
      const gitDir = asked.stdout.trim();
      if (asked.exitCode !== 0 || gitDir === '') throw new IsolationError(`${COULD_NOT_COPY}.`);
      made = { taskId, repository, target, workFolder: join(target, ...prefix.split('/').filter((part) => part !== '')), gitDir, branch, base, prefix };
      // The settings of the repository can depend on the branch that is checked out (an `includeIf` on the branch), so which filters there are is only known here.
      const inCopy: Where = { cwd: target, gitDir, workTree: target };
      const checkedOut = await hardened.run(inCopy, await hardened.filterGuards(inCopy), ['reset', '--hard', '--quiet']);
      if (checkedOut.exitCode !== 0) throw new IsolationError(`${COULD_NOT_COPY} (${describe(checkedOut, places)}).`);
    } catch (error) {
      await removeCopy(quick, repository, target, windows);
      await deleteBranch(repository, branch);
      await removeWorktreeRecord(worktrees, taskId);
      throw error;
    }
    return keeping(made, places);
  }

  function keeping(made: Made, places: FailurePlaces): IsolatedFolder {
    let outcome: { readonly branch: string | null; readonly diffStat: string | null } | undefined;
    let discarded = false;
    const inCopy: Where = { cwd: made.target, gitDir: made.gitDir, workTree: made.target };

    async function must(hardened: HardenedGit, guards: readonly string[], args: readonly string[], failure: string): Promise<ProcessResult> {
      const result = await hardened.run(inCopy, guards, args);
      if (result.exitCode !== 0) throw new IsolationError(`${failure} (${describe(result, places)}).`);
      return result;
    }

    async function commitWhatWasDone(hardened: HardenedGit): Promise<{ readonly branch: string | null; readonly diffStat: string | null }> {
      const guards = await hardened.filterGuards(inCopy);
      // The agent may have moved the copy to another branch, or off any. The work is the files that are there, so it goes on the task's branch whatever HEAD says, and no other branch is committed to.
      const current = await hardened.run(inCopy, guards, ['symbolic-ref', '--quiet', 'HEAD']);
      if (current.stdout.trim() !== `refs/heads/${made.branch}`) await must(hardened, guards, ['symbolic-ref', 'HEAD', `refs/heads/${made.branch}`], 'The work could not be kept');
      // Only the folder that was allowed is kept, not the rest of the repository the agent may have written in. A repository the agent
      // started inside it, with no commit, cannot be added at all: it is left out and the rest is kept, which is what a code of 1 says.
      const added = await hardened.run(inCopy, guards, ['add', '-A', '--ignore-errors', ...(made.prefix === '' ? [] : ['--', made.prefix])]);
      if (added.exitCode !== 0 && added.exitCode !== 1) throw new IsolationError(`The work could not be kept (${describe(added, places)}).`);
      const staged = await hardened.run(inCopy, guards, ['diff', '--cached', '--quiet', '--no-ext-diff']);
      if (staged.exitCode === 1) {
        await must(hardened, guards, [...COMMIT_IDENTITY, 'commit', '--quiet', '--no-verify', '--no-gpg-sign', '-m', `Work of the task ${made.taskId} (escritoriio Runner)`], 'The work could not be kept');
      } else if (staged.exitCode !== 0) {
        throw new IsolationError(`The work could not be kept (${describe(staged, places)}).`);
      }
      // Whether anything was done is asked of the commits against where the copy began, since the agent may have committed its own.
      const changed = await hardened.run(inCopy, guards, ['diff', '--quiet', '--no-ext-diff', '--no-textconv', made.base, 'HEAD']);
      if (changed.exitCode === 0) return { branch: null, diffStat: null };
      if (changed.exitCode !== 1) throw new IsolationError(`The work could not be kept (${describe(changed, places)}).`);
      const stat = await must(hardened, guards, ['diff', DIFF_STAT, '--no-ext-diff', '--no-textconv', '--no-color', made.base, 'HEAD'], 'The work could not be described');
      return { branch: made.branch, diffStat: capLines(stat.stdout.trimEnd(), TASK_LIMITS.diffStat) };
    }

    return {
      folder: made.workFolder,
      async finish(signal) {
        if (outcome) return outcome;
        const kept = await commitWhatWasDone(git.scoped({ signal }));
        // The work is kept from here: what follows is taking the copy away, which is not stopped half way.
        await removeCopy(quick, made.repository, made.target, windows);
        if (kept.branch === null) await deleteBranch(made.repository, made.branch);
        // Last: until the branch is decided, what was written down is what a clean-up would go by if the runner were killed now.
        await removeWorktreeRecord(worktrees, made.taskId);
        outcome = kept;
        return kept;
      },
      async discard() {
        // What was finished is the person's to look at, and giving a task up afterwards, as a mistake further on may, does not take it away.
        if (outcome || discarded) return;
        discarded = true;
        await removeCopy(quick, made.repository, made.target, windows);
        await deleteBranch(made.repository, made.branch);
        await removeWorktreeRecord(worktrees, made.taskId);
      },
    };
  }

  return { check, prepare, sweep: () => sweepWorktrees({ worktrees, git: quick, windows }) };
}
