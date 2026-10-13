import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { MadeFolder, PlacedFolder, WorkspaceOps } from '../application/workspace-ports.ts';
import type { Surroundings } from '../domain/folder-policy.ts';
import { isSamePath } from '../domain/paths.ts';
import { placesOf } from '../domain/redact.ts';
import { redactUrls } from '../domain/redact-urls.ts';
import type { HardenedGit, Where } from './hardened-git.ts';
import { COMMIT_IDENTITY, createHardenedGit, describeGitFailure } from './hardened-git.ts';
import { ensurePrivateDirectory } from './private-directory.ts';
import type { ProcessResult, RunProcess } from './run-process.ts';

export const INITIAL_BRANCH = 'main';

/** A clone has this long: a large repository over a slow line is not quick, and the owner is waiting on what the agent does with it. */
export const CLONE_TIMEOUT_MS = 10 * 60_000;
export const CLONE_TOTAL_MS = 15 * 60_000;

/** Git has no limit on how much a clone may take, so the folder is measured while it grows. */
export const MAX_CLONE_BYTES = 2 * 1024 * 1024 * 1024;
const SIZE_POLL_MS = 2_000;
/** What a measurement looks at before it gives up counting: a clone of a million files is over any ceiling anyway. */
const MAX_ENTRIES_MEASURED = 500_000;

/** What a read of the settings of a clone looks at: a file that is larger is not one git wrote. */
const MAX_CONFIG_BYTES = 1024 * 1024;

const SSH_HOST_KEY = /host key verification failed|remote host identification has changed/i;

export interface WorkspaceFilesOptions {
  readonly surroundings: Surroundings;
  readonly exec: RunProcess;
  /** What the runner was started with: only what git needs of it reaches git. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly maxCloneBytes?: number;
  readonly sizePollMs?: number;
  readonly cloneTimeoutMs?: number;
  /** All the clone may take, the fetch and the writing of the files: it is more than one command of git has. */
  readonly cloneTotalMs?: number;
  /** What moves the built folder into the workspace: a test's, to make that cross a disk. */
  readonly move?: typeof rename;
}

const isExisting = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'EEXIST';

/** What a plain person reads of a git failure on the way to a remote, with the address cleaned of what could be a secret. */
function plainCloneFailure(result: ProcessResult, said: string): string {
  if (SSH_HOST_KEY.test(result.stderr)) return 'the host key of that server is not known on this machine, or it has changed: connect to it once with ssh yourself, and check it, before it is cloned from';
  if (/authentication failed|permission denied|could not read username|terminal prompts disabled/i.test(result.stderr)) return 'the machine of the owner has no credentials for that repository, or they were refused';
  if (/could not resolve host|unable to access|connection (?:refused|timed out)/i.test(result.stderr)) return `the server could not be reached (${redactUrls(said)})`;
  return redactUrls(said);
}

/** The size in bytes of everything under a folder, and how many entries that is, links counted as themselves and never followed; it stops counting when there is far more than any ceiling would let be. */
async function measure(root: string): Promise<{ readonly bytes: number; readonly entries: number }> {
  let bytes = 0;
  let seen = 0;
  const pending = [root];
  while (pending.length > 0 && seen < MAX_ENTRIES_MEASURED) {
    const directory = pending.pop() as string;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      seen += 1;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else bytes += (await lstat(path).catch(() => undefined))?.size ?? 0;
    }
  }
  return { bytes, entries: seen };
}

/**
 * The files and the git of a workspace, which an agent with a shell can change under the runner's feet. Nothing follows a link: a folder is
 * made with a `mkdir` that fails when anything is there (a link included, a dangling one too), after the workspace was found where it was; a
 * clone goes into a folder that was just made empty, never into a name that git would make itself. Git is the hardened git of the runner:
 * the commit of a new folder with none of what the owner has set up, and the clone with their credentials and nothing else of them.
 */
export function createWorkspaceOps(options: WorkspaceFilesOptions): WorkspaceOps {
  const { surroundings, exec, environment } = options;
  const { windows } = surroundings;
  const local = createHardenedGit({ exec, environment, windows });
  const remote = createHardenedGit({ exec, environment, windows, reach: 'network' });
  const maxCloneBytes = options.maxCloneBytes ?? MAX_CLONE_BYTES;
  const sizePollMs = options.sizePollMs ?? SIZE_POLL_MS;
  const cloneTimeoutMs = options.cloneTimeoutMs ?? CLONE_TIMEOUT_MS;
  const totalMs = options.cloneTotalMs ?? CLONE_TOTAL_MS;
  const move = options.move ?? rename;

  /** Whether the workspace is where it was when the owner shared it. */
  async function isWhereItWas(workspace: string): Promise<boolean> {
    const real = await realpath(workspace).catch(() => undefined);
    return real !== undefined && isSamePath(real, workspace, windows);
  }

  async function isRealDirectory(path: string): Promise<boolean> {
    const found = await lstat(path).catch(() => undefined);
    return found?.isDirectory() === true && !found.isSymbolicLink();
  }

  const words = (result: ProcessResult, target: string, workspace: string): string => describeGitFailure(result, placesOf(surroundings, environment, { workFolder: target, allowedFolder: workspace }));

  async function folderNames(workspace: string): Promise<readonly string[]> {
    const entries = await readdir(workspace, { withFileTypes: true }).catch(() => []);
    // A name the agent gives cannot begin with a dot: what does is the places where tools keep their own files (Claude Code leaves `.claude` at the top), and is not a folder of the workspace.
    return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name);
  }

  /** A clone is a folder whose own git directory names a remote. What a repository says in its settings is read as text and run by nothing. */
  async function isClone(workspace: string, name: string): Promise<boolean> {
    const gitDirectory = join(workspace, name, '.git');
    if (!(await isRealDirectory(gitDirectory))) return false;
    const config = await readFile(join(gitDirectory, 'config'), 'utf8').catch(() => '');
    return config.length <= MAX_CONFIG_BYTES && /^\s*\[remote\s+"[^"\n]+"\]/m.test(config);
  }

  async function countClones(workspace: string): Promise<number> {
    const names = await folderNames(workspace);
    return (await Promise.all(names.map((name) => isClone(workspace, name)))).filter(Boolean).length;
  }

  async function makeFolder(workspace: string, name: string): Promise<MadeFolder> {
    if (!(await isWhereItWas(workspace))) return 'moved';
    const target = join(workspace, name);
    try {
      // Not recursive: with it, `mkdir` succeeds on a folder that is there, and on a link that leads to one.
      await mkdir(target, { mode: 0o755 });
    } catch (error) {
      if (isExisting(error)) return 'exists';
      throw error;
    }
    // What was just made is a folder of its own and not something that took its place in the time between.
    if (!(await isRealDirectory(target)) || !(await isWhereItWas(workspace))) return 'exists';
    return 'made';
  }

  /** Words when a command of git ended any way but well. */
  async function clonesStep(hardened: HardenedGit, where: Where, guards: readonly string[], args: readonly string[], target: string, workspace: string): Promise<string | undefined> {
    const result = await hardened.run(where, guards, args);
    if (result.exitCode === 0) return undefined;
    if (result.stopped === 'aborted') return 'git was stopped';
    if (result.stopped === 'timeout') return 'git took too long and was stopped';
    return plainCloneFailure(result, words(result, target, workspace));
  }

  /** A folder of the runner's own that nothing else is in and nobody else can enter: where git is run for what is not in the workspace. */
  const neutralDirectory = (): Promise<string> => ensurePrivateDirectory(join(surroundings.stateDirectory, 'neutral'));

  async function addressProblem(url: string, signal: AbortSignal): Promise<string | undefined> {
    try {
      const asked = await remote.scoped({ signal, timeoutMs: 30_000 }).run({ cwd: await neutralDirectory() }, [], ['ls-remote', '--get-url', url]);
      if (asked.exitCode !== 0) return 'git could not say where that address would lead, so nothing was cloned.';
      return asked.stdout.trim() === url ? undefined : 'The git settings of the owner rewrite that address (url.*.insteadOf), so it would reach another host than the one shown: nothing was cloned.';
    } catch (error) {
      return error instanceof Error ? error.message : 'git could not be run';
    }
  }

  /**
   * Builds a folder apart, in a place of the runner's own that the agent cannot reach (its state folder is hidden from the sandbox), and puts it
   * in the workspace whole. The name is made first, as an empty folder, and the built one replaces it with one `rename`, which fails when what is
   * there is not an empty folder (a link put there meanwhile, a folder with something in it): nothing is written where the agent can swap the place.
   */
  async function placeBuilt(workspace: string, name: string, build: (repository: string) => Promise<string | undefined>): Promise<PlacedFolder> {
    if (!(await isWhereItWas(workspace))) return { outcome: 'moved' };
    const stage = await mkdtemp(join(await ensurePrivateDirectory(join(surroundings.stateDirectory, 'staging')), 'w-'));
    try {
      const repository = join(stage, 'repository');
      const failure = await build(repository);
      if (failure !== undefined) return { outcome: 'failed', words: failure };
      return await putInWorkspace(workspace, name, repository);
    } catch (error) {
      return { outcome: 'failed', words: error instanceof Error ? redactUrls(error.message) : 'the runner could not finish it' };
    } finally {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function putInWorkspace(workspace: string, name: string, built: string): Promise<PlacedFolder> {
    const target = join(workspace, name);
    try {
      // Not recursive: with it, `mkdir` succeeds on a folder that is there, and on a link that leads to one.
      await mkdir(target, { mode: 0o755 });
    } catch (error) {
      if (isExisting(error)) return { outcome: 'exists' };
      throw error;
    }
    const failed = (reason: string): PlacedFolder => ({ outcome: 'failed', words: reason });
    if (!(await isRealDirectory(target)) || (await readdir(target)).length > 0 || !(await isWhereItWas(workspace))) return { outcome: 'exists' };
    let note: string | undefined;
    try {
      await move(built, target);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : '';
      if (code !== 'EXDEV' && code !== 'EPERM') {
        await rmdir(target).catch(() => undefined);
        return failed('the folder could not be put in the workspace, which was changed while it was made');
      }
      // The runner's own folder is on another disk than the workspace: it is copied, links as they are, and what was copied is measured against what was built.
      await cp(built, target, { recursive: true, verbatimSymlinks: true, errorOnExist: false, force: false });
      const [was, is] = await Promise.all([measure(built), measure(target)]);
      if (was.bytes !== is.bytes || was.entries !== is.entries) {
        await rm(target, { recursive: true, force: true }).catch(() => undefined);
        return failed('the copy to the workspace, which is on another disk, did not come out as it was built');
      }
      note = 'It was copied across disks, from a folder of the runner’s own, and checked.';
    }
    const real = await realpath(target).catch(() => undefined);
    if (real === undefined || !isSamePath(real, target, windows) || !(await isRealDirectory(target))) return failed('the folder is not where it was put, so what is in it cannot be trusted');
    return note === undefined ? { outcome: 'made' } : { outcome: 'made', note };
  }

  function newRepository(workspace: string, name: string, signal: AbortSignal): Promise<PlacedFolder> {
    return placeBuilt(workspace, name, async (repository) => {
      await mkdir(repository);
      const hardened = local.scoped({ signal });
      // No template, so that no hook is copied into the folder: the repository holds nothing that runs.
      const init = await hardened.run({ cwd: repository }, [], ['init', '--quiet', `--initial-branch=${INITIAL_BRANCH}`, '--template=']);
      if (init.exitCode !== 0) return words(init, repository, workspace);
      const gitDir = join(repository, '.git');
      if (!(await isRealDirectory(gitDir))) return 'git did not make the repository where it was asked to';
      const commit = await hardened.run({ cwd: repository, gitDir, workTree: repository }, [], [...COMMIT_IDENTITY, 'commit', '--allow-empty', '--quiet', '--no-verify', '--no-gpg-sign', '-m', 'Initial commit (escritoriio Runner)']);
      return commit.exitCode === 0 ? undefined : words(commit, repository, workspace);
    });
  }

  function cloneRepository(workspace: string, name: string, url: string, signal: AbortSignal): Promise<PlacedFolder> {
    return placeBuilt(workspace, name, async (repository) => {
      // What a clone may take from the machine: how long it runs in all, and how big the folder gets, which nothing in git limits.
      const limited = new AbortController();
      let stopped: 'too-big' | 'too-long' | undefined;
      const stop = (why: 'too-big' | 'too-long'): void => {
        stopped ??= why;
        limited.abort();
      };
      const forward = (): void => limited.abort();
      if (signal.aborted) limited.abort();
      else signal.addEventListener('abort', forward, { once: true });
      const deadline = setTimeout(() => stop('too-long'), totalMs);
      let measuring = false;
      const watching = setInterval(() => {
        // One look at a time: a look at a large folder is slower than the time between two.
        if (measuring) return;
        measuring = true;
        void measure(repository)
          .then(({ bytes, entries }) => {
            if (bytes > maxCloneBytes || entries >= MAX_ENTRIES_MEASURED) stop('too-big');
          })
          .finally(() => (measuring = false));
      }, sizePollMs);
      watching.unref();
      deadline.unref();
      const ended = (): string | undefined => {
        if (stopped === 'too-big') return `the repository is larger than ${Math.round(maxCloneBytes / (1024 * 1024))} MB, so the clone was stopped`;
        if (stopped === 'too-long') return 'the clone took too long, so it was stopped';
        return undefined;
      };
      try {
        const limits = { signal: limited.signal, timeoutMs: cloneTimeoutMs };
        // The clone is the one process that carries the credentials of the owner, and it is not started where the agent has a shell: its folder could
        // hold a repository whose settings name a helper or an include. It is built in the runner's own folder, run from another, and named whole.
        // `--no-checkout` first: a repository can name a filter or an include that applies once its files are written, and the checkout would run
        // it before the guards were pinned to the folder. `--` ends the options, so that no address is read as one; `--template=` copies no hook.
        const cloned = await clonesStep(remote.scoped(limits), { cwd: await neutralDirectory() }, [], ['clone', '--no-checkout', '--no-recurse-submodules', '--template=', '--quiet', '--', url, repository], repository, workspace);
        if (ended()) return ended();
        if (cloned !== undefined) return cloned;

        // From here on nothing reaches a remote, and nothing carries the owner's credentials: the files are written by git with the hardening of every other copy.
        const hardened = local.scoped(limits);
        const gitDir = join(repository, '.git');
        if (!(await isRealDirectory(gitDir))) return 'git did not make the repository where it was asked to';
        const inFolder: Where = { cwd: repository, gitDir, workTree: repository };
        // A repository with nothing in it has nothing to check out.
        const head = await hardened.run(inFolder, [], ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
        if (head.exitCode !== 0 && !head.stopped) return undefined;
        // The settings of the new repository are known only now, and so are the filters they name: each is switched off by name, and the files are written.
        const guards = await hardened.filterGuards(inFolder);
        const checkedOut = await clonesStep(hardened, inFolder, guards, ['reset', '--hard', '--quiet'], repository, workspace);
        return ended() ?? checkedOut;
      } finally {
        clearInterval(watching);
        clearTimeout(deadline);
        signal.removeEventListener('abort', forward);
      }
    });
  }

  async function discardFolder(workspace: string, name: string): Promise<void> {
    const target = join(workspace, name);
    // Only what is a real folder: something that took its place, a link say, is not what was made and is not taken away.
    if (!(await isWhereItWas(workspace)) || !(await isRealDirectory(target))) return;
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
  }

  return { folderNames, countClones, makeFolder, discardFolder, addressProblem, newRepository, cloneRepository };
}
