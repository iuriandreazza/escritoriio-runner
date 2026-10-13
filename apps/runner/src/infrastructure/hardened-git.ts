import { toOneLine } from '@escritoriio/runner-protocol';
import { IsolationError } from '../application/task-ports.ts';
import { childEnvironment } from '../domain/child-environment.ts';
import type { Places } from '../domain/redact.ts';
import { redactPaths } from '../domain/redact.ts';
import { findProgram } from './find-program.ts';
import type { ProcessResult, RunProcess } from './run-process.ts';

/** What one git command may take, unless it is given less: the copy of a large repository is not quick. */
const GIT_TIMEOUT_MS = 5 * 60_000;

export const NO_GIT = 'Git is not installed on this machine, or the runner cannot find it, so the work cannot be done on a branch of its own.';
export const COULD_NOT_COPY = 'A copy of that folder for this task could not be made';

/**
 * What git is started with, whatever the repository holds. A repository controls programs that git runs for it: hooks (a Husky setup
 * points `core.hooksPath` at the project's own scripts), a file system monitor, filters, external diff programs, a pager. The copy a
 * coding agent worked in is the agent's to write, so all of it is untrusted, and none of those may run: they are switched off on the
 * command line, which wins over every file of settings. The filters, which have a name for each of them in the settings, are switched
 * off by name (see `filterGuards`).
 */
export function gitHardening(nullDevice: string, reach: 'local' | 'network' = 'local'): string[] {
  const network = reach === 'network';
  return [
    '--no-pager',
    '--literal-pathspecs',
    '-c', `core.hooksPath=${nullDevice}`,
    '-c', 'core.fsmonitor=false',
    // A redirect is not followed, so that the host that is contacted is the one that was approved (a repository that moved has to be asked for at its new address), and what is fetched is checked object by object.
    // Only what a clone from a hosted repository needs is let through. A command that reaches a remote says which protocols it may use, and everything not named is refused; `file` and `ext` are named again, since they are the two that read the machine or run a program.
    ...(network ? ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'protocol.file.allow=never', '-c', 'http.followRedirects=false', '-c', 'transfer.fsckObjects=true'] : []),
    '-c', 'protocol.ext.allow=never',
    '-c', 'core.sshCommand=false',
    // The owner's own credential helper is what a clone from a private repository needs: it is the one setting that is not switched off when git reaches a remote, which only the runner ever does and never for the agent.
    ...(network ? [] : ['-c', 'credential.helper=']),
    '-c', 'commit.gpgSign=false',
    '-c', 'tag.gpgSign=false',
    '-c', 'submodule.recurse=false',
    '-c', 'gc.auto=0',
    '-c', 'maintenance.auto=false',
    '-c', 'color.ui=never',
    // File names with control or direction characters are what the agent can make: git writes them escaped, and that is how they are kept.
    '-c', 'core.quotePath=true',
  ];
}

/** The identity of the commits the runner makes itself, so that the work never depends on what the person has set up for themselves, and the commit says who made it. */
export const COMMIT_IDENTITY = ['-c', 'user.name=escritoriio Runner', '-c', 'user.email=runner@escritoriio.invalid'];

/**
 * How git reaches a host over ssh when the runner clones for the owner: nobody is asked anything, and an unknown or changed host key is a
 * refusal, whatever `StrictHostKeyChecking` the owner's own settings of ssh say (the command line wins over them).
 */
export const OWNER_SSH_COMMAND = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes';

export interface Where {
  readonly cwd: string;
  /** Set for a copy that an agent has worked in: git is told where its own files are, and does not look for them where the agent could have pointed. */
  readonly gitDir?: string;
  readonly workTree?: string;
}

export interface HardenedGitOptions {
  /** How a program is run: the real one, or a test's. */
  readonly exec: RunProcess;
  /** What the runner was started with: only what a coding agent may have reaches git (see `childEnvironment`). */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly windows: boolean;
  /**
   * `local` (the default) reaches no remote and uses nothing of the owner's credentials. `network` is for the clone that the owner approved:
   * it may use the ssh agent and the credential helper of the owner, over https and ssh only, with the check of host keys on.
   */
  readonly reach?: 'local' | 'network';
}

/** What bounds the commands of a `HardenedGit`: both are optional, and the command is stopped by whichever comes first. */
export interface GitLimits {
  /** Every command is stopped, with what it started, when this aborts, and any that is asked for after it did is not started. */
  readonly signal?: AbortSignal | undefined;
  /** What one command may take. */
  readonly timeoutMs?: number | undefined;
}

export interface HardenedGit {
  /** Runs git. Throws `IsolationError` when git cannot be started at all; a command that fails is an answer. */
  run(where: Where, guards: readonly string[], args: readonly string[]): Promise<ProcessResult>;
  /**
   * Switches off every filter the settings name, whoever wrote them: a filter is a program that git runs on the files it reads and writes,
   * and what runs is named in the settings, not in the repository's attributes. Git LFS is one, and a repository that uses it gets the
   * plain files on the task's branch for this reason. Read again for each stage, so that nothing added since is left on.
   */
  filterGuards(where: Where): Promise<string[]>;
  /** The same git with limits of its own, instead of any it had: what must stop with a task, or what must not wait for long. */
  scoped(limits: GitLimits): HardenedGit;
}

/** The one way this runner starts git, for the copy of a task and for the clean-up of what a task left: the same hardening for both. */
export function createHardenedGit({ exec, environment, windows, reach = 'local' }: HardenedGitOptions): HardenedGit {
  const hardening = gitHardening(windows ? 'NUL' : '/dev/null', reach);
  const network = reach === 'network';
  const socket = environment.SSH_AUTH_SOCK;
  const env = {
    ...childEnvironment(environment, windows),
    // Nothing waits for a person, and the words git says are the ones that are looked for.
    GIT_TERMINAL_PROMPT: '0',
    // The settings of the system are where the credential helper of some installations is (Apple's git), and the owner's own clone is theirs to have it.
    ...(network ? {} : { GIT_CONFIG_NOSYSTEM: '1' }),
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
    // The agent of ssh keys is the owner's, and is handed to nothing but this process: the child of the coding agent is built from nothing.
    ...(network ? { GIT_ALLOW_PROTOCOL: 'https:ssh', GIT_SSH_COMMAND: OWNER_SSH_COMMAND, ...(socket ? { SSH_AUTH_SOCK: socket } : {}) } : {}),
  };
  // Git is started by the full path it has on the PATH, found once, and not by its name: Windows looks for a program of that name in the folder it is started from first.
  let program: string | undefined;
  // Only a git that was found is remembered: one that is installed while the runner runs is found by the next task.
  const git = async (): Promise<string | undefined> => (program ??= await findProgram('git', environment, windows));

  function bound(limits: GitLimits): HardenedGit {
    async function run(where: Where, guards: readonly string[], args: readonly string[]): Promise<ProcessResult> {
      const pinned = where.gitDir === undefined ? [] : [`--git-dir=${where.gitDir}`, `--work-tree=${where.workTree ?? where.cwd}`];
      const file = await git();
      if (file === undefined) throw new IsolationError(NO_GIT);
      try {
        return await exec(file, [...hardening, ...pinned, ...guards, ...args], { cwd: where.cwd, env, timeoutMs: limits.timeoutMs ?? GIT_TIMEOUT_MS, signal: limits.signal });
      } catch {
        throw new IsolationError(NO_GIT);
      }
    }

    async function filterGuards(where: Where): Promise<string[]> {
      const listed = await run(where, [], ['config', '--list', '-z']);
      if (listed.exitCode !== 0) throw new IsolationError(`${COULD_NOT_COPY}: its settings could not be read.`);
      const names = new Set<string>();
      for (const entry of listed.stdout.split('\0')) {
        const key = entry.split('\n', 1)[0] ?? '';
        const name = /^filter\.(.+)\.[^.]+$/i.exec(key)?.[1];
        if (name !== undefined) names.add(name);
      }
      // A name that has an equals sign cannot be written as `-c` takes it, and so cannot be switched off: it is not worked with.
      if ([...names].some((name) => name.includes('='))) throw new IsolationError(`${COULD_NOT_COPY}: one of its filters has a name that cannot be switched off.`);
      return [...names].flatMap((name) => [`filter.${name}.clean=`, `filter.${name}.smudge=`, `filter.${name}.process=`, `filter.${name}.required=false`]).flatMap((setting) => ['-c', setting]);
    }

    return { run, filterGuards, scoped: bound };
  }

  return bound({});
}

/** What git said, in one line and with no place of this machine in it: it ends up in what the office is told. */
export function describeGitFailure(result: ProcessResult, places: Places): string {
  if (result.stopped === 'timeout') return 'git took too long and was stopped';
  if (result.stopped === 'aborted') return 'git was stopped';
  if (result.stopped === 'too-much-output') return 'git said too much and was stopped';
  const lines = result.stderr.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const line = (lines.find((candidate) => /^(fatal|error):/.test(candidate)) ?? lines.at(-1) ?? `git ended with the code ${result.exitCode}`).replace(/^(fatal|error):\s*/, '');
  return redactPaths(toOneLine(line).slice(0, 200), places);
}
