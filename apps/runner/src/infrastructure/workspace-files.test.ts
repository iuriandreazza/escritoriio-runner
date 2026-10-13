import { access, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceOps } from '../application/workspace-ports.ts';
import type { Surroundings } from '../domain/folder-policy.ts';
import { createRepository, neverAborted, plainGit } from '../testing/git-fixtures.ts';
import { createHardenedGit } from './hardened-git.ts';
import type { ProcessOptions, ProcessResult, RunProcess } from './run-process.ts';
import { runProcess } from './run-process.ts';
import { createWorkspaceOps, INITIAL_BRANCH } from './workspace-files.ts';

let root: string;
let workspace: string;
let surroundings: Surroundings;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'escritoriio-runner-workspace-')));
  workspace = join(root, 'home', 'build');
  await mkdir(workspace, { recursive: true });
  surroundings = { home: join(root, 'home'), stateDirectory: join(root, 'state'), worktreesDirectory: join(root, 'copies'), windows: false };
  await mkdir(surroundings.stateDirectory);
});

afterEach(() => rm(root, { recursive: true, force: true }));

const environment = () => ({ PATH: process.env.PATH, HOME: join(root, 'home'), SSH_AUTH_SOCK: '/private/tmp/agent.sock', GITHUB_TOKEN: 'ghp_must_not_reach_git' });
const make = (exec: RunProcess = runProcess, extra: Partial<Parameters<typeof createWorkspaceOps>[0]> = {}): WorkspaceOps => createWorkspaceOps({ surroundings, exec, environment: environment(), ...extra });
const exists = (path: string) => access(path).then(() => true, () => false);

describe('making a folder in a workspace', () => {
  it('makes an empty folder', async () => {
    expect(await make().makeFolder(workspace, 'hello')).toBe('made');
    expect(await readdir(join(workspace, 'hello'))).toEqual([]);
  });

  it('does not make what is there already, a folder or a file', async () => {
    await mkdir(join(workspace, 'folder'));
    await writeFile(join(workspace, 'file'), 'x');
    expect(await make().makeFolder(workspace, 'folder')).toBe('exists');
    expect(await make().makeFolder(workspace, 'file')).toBe('exists');
  });

  it('does not follow a link planted at the name, one that leads out of the workspace or one that leads nowhere', async () => {
    await mkdir(join(root, 'outside'));
    await symlink(join(root, 'outside'), join(workspace, 'out'));
    await symlink(join(root, 'nowhere'), join(workspace, 'dangling'));
    expect(await make().makeFolder(workspace, 'out')).toBe('exists');
    expect(await make().makeFolder(workspace, 'dangling')).toBe('exists');
    expect(await readdir(join(root, 'outside'))).toEqual([]);
    expect(await exists(join(root, 'nowhere'))).toBe(false);
  });

  it('refuses when the workspace is not where it was: a link now stands in its place', async () => {
    await mkdir(join(root, 'elsewhere'));
    await rm(workspace, { recursive: true });
    await symlink(join(root, 'elsewhere'), workspace);
    expect(await make().makeFolder(workspace, 'hello')).toBe('moved');
    expect(await readdir(join(root, 'elsewhere'))).toEqual([]);
    await rm(workspace);
    expect(await make().makeFolder(workspace, 'hello')).toBe('moved');
  });
});

describe('looking at the folders of a workspace', () => {
  it('lists the real folders at its top, and not files or links, or the places where tools keep their own files', async () => {
    await mkdir(join(workspace, '.claude'));
    await mkdir(join(workspace, 'one'));
    await mkdir(join(workspace, 'two'));
    await writeFile(join(workspace, 'file.txt'), 'x');
    await symlink(join(root, 'home'), join(workspace, 'link'));
    expect([...(await make().folderNames(workspace))].sort()).toEqual(['one', 'two']);
  });

  it('counts the folders that are clones, by what their own settings say, and nothing else', async () => {
    await createRepository(join(workspace, 'cloned'), { 'a.txt': 'a' });
    await plainGit(join(workspace, 'cloned'), 'remote', 'add', 'origin', 'https://github.com/octocat/Hello-World.git');
    await createRepository(join(workspace, 'mine'), { 'b.txt': 'b' });
    await mkdir(join(workspace, 'plain'));
    // A `.git` that is a file, or a link to a repository that has a remote, is not a clone made here.
    await writeFile(join(workspace, 'plain', '.git'), `gitdir: ${join(workspace, 'cloned', '.git')}\n`);
    await mkdir(join(workspace, 'linked'));
    await symlink(join(workspace, 'cloned', '.git'), join(workspace, 'linked', '.git'));
    expect(await make().countClones(workspace)).toBe(1);
  });
});

const stagingOf = (root: string) => join(root, 'state', 'staging');
const leftInStaging = (root: string) => readdir(stagingOf(root)).catch(() => []);

describe('making a repository in a workspace', () => {
  it('leaves one empty commit on the branch main, by the runner, and no hook, put there whole', async () => {
    expect(await make().newRepository(workspace, 'hello', neverAborted())).toEqual({ outcome: 'made' });
    const folder = join(workspace, 'hello');
    expect((await plainGit(folder, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe(INITIAL_BRANCH);
    expect((await plainGit(folder, 'log', '--format=%an <%ae>|%s')).trim()).toBe('escritoriio Runner <runner@escritoriio.invalid>|Initial commit (escritoriio Runner)');
    expect((await plainGit(folder, 'rev-list', '--count', 'HEAD')).trim()).toBe('1');
    expect(await readdir(join(folder, '.git', 'hooks')).catch(() => [])).toEqual([]);
  });

  it('is built where the agent cannot reach, and leaves nothing there', async () => {
    const seen: string[] = [];
    await make((file, args, options) => (seen.push(options.cwd), runProcess(file, args, options))).newRepository(workspace, 'hello', neverAborted());
    expect(seen.length).toBeGreaterThan(0);
    for (const cwd of seen) expect(cwd.startsWith(stagingOf(root))).toBe(true);
    expect(await leftInStaging(root)).toEqual([]);
  });

  it('does not put it over what is there: a folder, a file, a link that leads out or nowhere', async () => {
    await mkdir(join(workspace, 'folder'));
    await writeFile(join(workspace, 'folder', 'mine.txt'), 'mine');
    await writeFile(join(workspace, 'file'), 'x');
    await mkdir(join(root, 'outside'));
    await symlink(join(root, 'outside'), join(workspace, 'out'));
    await symlink(join(root, 'nowhere'), join(workspace, 'dangling'));
    for (const name of ['folder', 'file', 'out', 'dangling']) expect(await make().newRepository(workspace, name, neverAborted())).toEqual({ outcome: 'exists' });
    expect(await readFile(join(workspace, 'folder', 'mine.txt'), 'utf8')).toBe('mine');
    expect(await readdir(join(root, 'outside'))).toEqual([]);
    expect(await exists(join(root, 'nowhere'))).toBe(false);
    expect(await leftInStaging(root)).toEqual([]);
  });

  it('is not put in a workspace that is not where it was', async () => {
    await mkdir(join(root, 'elsewhere'));
    await rm(workspace, { recursive: true });
    await symlink(join(root, 'elsewhere'), workspace);
    expect(await make().newRepository(workspace, 'hello', neverAborted())).toEqual({ outcome: 'moved' });
    expect(await readdir(join(root, 'elsewhere'))).toEqual([]);
  });

  it('fails when the empty folder that was made for it is swapped for a link before it is put there, and writes nothing through it', async () => {
    await mkdir(join(root, 'elsewhere'));
    const move: typeof rename = async (from, to) => {
      await rm(to, { recursive: true });
      await symlink(join(root, 'elsewhere'), to);
      return rename(from, to);
    };
    const placed = await make(runProcess, { move }).newRepository(workspace, 'hello', neverAborted());
    expect(placed.outcome).toBe('failed');
    expect(await readdir(join(root, 'elsewhere'))).toEqual([]);
  });

  it('copies it, and says so, when the runner’s folder is on another disk than the workspace', async () => {
    const move: typeof rename = () => Promise.reject(Object.assign(new Error('cross-device'), { code: 'EXDEV' }));
    const placed = await make(runProcess, { move }).newRepository(workspace, 'hello', neverAborted());
    expect(placed).toEqual({ outcome: 'made', note: expect.stringMatching(/copied across disks/) });
    expect((await plainGit(join(workspace, 'hello'), 'rev-list', '--count', 'HEAD')).trim()).toBe('1');
    expect(await leftInStaging(root)).toEqual([]);
  });

  it('gives the words of what went wrong, with no path of the machine, when git cannot be run, and leaves nothing', async () => {
    const ops = createWorkspaceOps({ surroundings, exec: runProcess, environment: { PATH: '', HOME: join(root, 'home') } });
    const placed = await ops.newRepository(workspace, 'hello', neverAborted());
    expect(placed).toEqual({ outcome: 'failed', words: expect.stringMatching(/Git is not installed/) });
    expect(JSON.stringify(placed)).not.toContain(root);
    expect(await exists(join(workspace, 'hello'))).toBe(false);
    expect(await leftInStaging(root)).toEqual([]);
  });

  it('does not start when the task was stopped', async () => {
    expect(await make().newRepository(workspace, 'hello', AbortSignal.abort())).toEqual({ outcome: 'failed', words: expect.stringMatching(/stopped/) });
    expect(await exists(join(workspace, 'hello'))).toBe(false);
  });
});

describe('taking away a folder that was made', () => {
  it('removes it with what is in it', async () => {
    const ops = make();
    await ops.makeFolder(workspace, 'hello');
    await writeFile(join(workspace, 'hello', 'x.txt'), 'x');
    await ops.discardFolder(workspace, 'hello');
    expect(await exists(join(workspace, 'hello'))).toBe(false);
  });

  it('does not remove what took its place: a link, and what it leads to', async () => {
    await mkdir(join(root, 'precious'));
    await writeFile(join(root, 'precious', 'keep.txt'), 'keep');
    await symlink(join(root, 'precious'), join(workspace, 'hello'));
    await make().discardFolder(workspace, 'hello');
    expect(await readFile(join(root, 'precious', 'keep.txt'), 'utf8')).toBe('keep');
    expect(await exists(join(workspace, 'hello'))).toBe(true);
  });

  it('does nothing, and does not throw, for a folder that is not there', async () => {
    await expect(make().discardFolder(workspace, 'nothing')).resolves.toBeUndefined();
  });
});

interface Call {
  readonly args: readonly string[];
  readonly options: ProcessOptions;
}

/** What a clone does is left to the test: it is given the folder, and says how the command ended. */
function cloneWith(behave: (call: Call, signal: AbortSignal | undefined) => Promise<ProcessResult> | undefined, afterCheckout?: (call: Call) => Promise<void>, always?: ProcessResult) {
  const calls: Call[] = [];
  const exec: RunProcess = async (file, args, options) => {
    const call = { args, options };
    calls.push(call);
    if (always) return always;
    const done = args.includes('clone') ? behave(call, options.signal) : undefined;
    const result = await (done ?? runProcess(file, args, options));
    if (args.includes('reset')) await afterCheckout?.(call);
    return result;
  };
  return { calls, exec };
}

const ok: ProcessResult = { exitCode: 0, stdout: '', stderr: '', stopped: undefined };
const refused = (stderr: string): ProcessResult => ({ exitCode: 128, stdout: '', stderr, stopped: undefined });
const URL_OF_HELLO = 'https://github.com/octocat/Hello-World.git';

/** What a clone said, as words when it did not end well and nothing when it did. */
async function cloning(ops: WorkspaceOps, workspace: string, name: string, signal: AbortSignal = neverAborted()): Promise<string | undefined> {
  const placed = await ops.cloneRepository(workspace, name, URL_OF_HELLO, signal);
  return placed.outcome === 'failed' ? placed.words : placed.outcome === 'made' ? undefined : placed.outcome;
}

describe('cloning a repository', () => {
  /** The server's side, in a folder: a repository the clone gives, since a local address is exactly what the clone refuses. */
  async function serve(target: string, config: readonly (readonly [string, string])[] = []): Promise<ProcessResult> {
    await createRepository(target, { 'README.md': 'hello\n', 'src/index.js': 'x\n', '.gitattributes': '* filter=evil\n' });
    for (const [key, value] of config) await plainGit(target, 'config', key, value);
    return ok;
  }

  it('is asked for as git must be to be safe: no checkout yet, no submodules, no template, the address after two dashes, and only the owner’s own reach', async () => {
    const { calls, exec } = cloneWith((call) => serve(call.args.at(-1) as string));
    const ops = make(exec);
    expect(await cloning(ops, workspace, 'Hello-World', neverAborted())).toBeUndefined();
    const first = calls.find((call) => call.args.includes('clone'));
    const verb = first?.args.indexOf('clone') ?? -1;
    // Built in a folder of the runner's own, where the agent cannot reach, and put in the workspace afterwards.
    expect(first?.args.slice(verb, -1)).toEqual(['clone', '--no-checkout', '--no-recurse-submodules', '--template=', '--quiet', '--', URL_OF_HELLO]);
    expect(first?.args.at(-1)?.startsWith(stagingOf(root))).toBe(true);
    expect(first?.args).toEqual(expect.arrayContaining(['http.followRedirects=false', 'transfer.fsckObjects=true']));
    expect(first?.options.env.SSH_AUTH_SOCK).toBe('/private/tmp/agent.sock');
    expect(first?.options.env.GIT_ALLOW_PROTOCOL).toBe('https:ssh');
    expect(Object.keys(first?.options.env ?? {}).join(' ')).not.toMatch(/GITHUB|TOKEN/);
    // Not in the workspace, where the agent has a shell: its settings may name a helper that would run with the owner's credentials.
    expect(first?.options.cwd).toBe(join(root, 'state', 'neutral'));
    expect(first?.args).toContain('protocol.allow=never');
    expect(first?.args).not.toContain('credential.helper=');
  });

  it('reaches the remote with the owner’s reach and nothing after it: the files are written by git that has none of it', async () => {
    const { calls, exec } = cloneWith((call) => serve(call.args.at(-1) as string));
    const ops = make(exec);
    await cloning(ops, workspace, 'Hello-World', neverAborted());
    const [fetch, ...writing] = calls.filter((call) => !call.args.includes('ls-remote'));
    expect(fetch?.options.env.SSH_AUTH_SOCK).toBe('/private/tmp/agent.sock');
    expect(writing.length).toBeGreaterThan(0);
    for (const call of writing) {
      expect(call.options.env).not.toHaveProperty('SSH_AUTH_SOCK');
      expect(call.options.env).not.toHaveProperty('GIT_SSH_COMMAND');
      expect(call.args).toContain('credential.helper=');
    }
  });

  it('checks the files out only after the guards are pinned to the new folder, and never runs a filter the repository names', async () => {
    const marker = join(root, 'filter-ran');
    const { calls, exec } = cloneWith((call) => serve(call.args.at(-1) as string, [['filter.evil.smudge', `touch ${marker}; cat`], ['filter.evil.required', 'true']]));
    const ops = make(exec);
    expect(await cloning(ops, workspace, 'Hello-World', neverAborted())).toBeUndefined();
    expect(await readFile(join(workspace, 'Hello-World', 'README.md'), 'utf8')).toBe('hello\n');
    expect(await exists(marker)).toBe(false);
    const checkout = calls.find((call) => call.args.includes('reset'));
    expect(checkout?.args).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^--git-dir=${stagingOf(root)}`)), 'filter.evil.smudge=', 'filter.evil.required=false']));
    expect((await plainGit(join(workspace, 'Hello-World'), 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('main');
  });

  it('is not checked out when the repository has no commit', async () => {
    const { calls, exec } = cloneWith(async (call) => {
      await plainGit(join(call.args.at(-1) as string, '..'), 'init', '--quiet', call.args.at(-1) as string);
      return ok;
    });
    const ops = make(exec);
    expect(await cloning(ops, workspace, 'empty', neverAborted())).toBeUndefined();
    expect(calls.some((call) => call.args.includes('reset'))).toBe(false);
  });

  it.each([
    ['fatal: repository \'https://x-access-token:ghs_SECRET@github.com/a/b.git/\' not found', /not found/],
    ['remote: Invalid username or password.\nfatal: Authentication failed for \'https://github.com/a/b.git/\'', /no credentials/],
    ['fatal: could not read Username for \'https://github.com\': terminal prompts disabled', /no credentials/],
    ['Host key verification failed.\nfatal: Could not read from remote repository.', /host key/],
    ['fatal: unable to access \'https://github.com/a/b.git/\': Could not resolve host: github.com', /could not be reached/],
  ])('says in plain words, with no secret and no path, what git said (%#)', async (stderr, words) => {
    const { exec } = cloneWith(() => Promise.resolve(refused(stderr)));
    const ops = make(exec);
    const said = await cloning(ops, workspace, 'x', neverAborted());
    expect(said).toMatch(words);
    expect(said).not.toContain('SECRET');
    expect(said).not.toContain(root);
  });

  it('does not put the clone over a folder that appeared while it was cloned, and leaves nothing of it in the workspace', async () => {
    const { exec } = cloneWith(
      (call) => serve(call.args.at(-1) as string),
      async () => {
        await mkdir(join(workspace, 'x'));
        await writeFile(join(workspace, 'x', 'mine.txt'), 'mine');
      },
    );
    expect(await cloning(make(exec), workspace, 'x')).toBe('exists');
    expect(await readdir(join(workspace, 'x'))).toEqual(['mine.txt']);
    expect(await leftInStaging(root)).toEqual([]);
  });

  it('is stopped as a whole when it takes longer than all of a clone may, though no one command did', async () => {
    const { exec } = cloneWith((_call, signal) => new Promise((resolve) => signal?.addEventListener('abort', () => resolve({ exitCode: null, stdout: '', stderr: '', stopped: 'aborted' }), { once: true })));
    expect(await cloning(make(exec, { cloneTotalMs: 30 }), workspace, 'x')).toMatch(/took too long, so it was stopped/);
  });

  it('is stopped with the signal of the task, and says so', async () => {
    const controller = new AbortController();
    const { exec } = cloneWith(
      (_call, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener('abort', () => resolve({ exitCode: null, stdout: '', stderr: '', stopped: 'aborted' }), { once: true });
          controller.abort();
        }),
    );
    const ops = make(exec);
    expect(await cloning(ops, workspace, 'x', controller.signal)).toBe('git was stopped');
  });

  it('is given a time of its own, and says when it was used up', async () => {
    const { calls, exec } = cloneWith(() => Promise.resolve({ exitCode: null, stdout: '', stderr: '', stopped: 'timeout' }));
    const ops = make(exec, { cloneTimeoutMs: 1234 });
    expect(await cloning(ops, workspace, 'x', neverAborted())).toMatch(/took too long/);
    expect(calls[0]?.options.timeoutMs).toBe(1234);
  });

  it('is stopped when the folder grows past what a clone may take', async () => {
    const { exec } = cloneWith(
      async (call, signal) => {
        await mkdir(call.args.at(-1) as string);
        await writeFile(join(call.args.at(-1) as string, 'pack.tmp'), Buffer.alloc(5_000));
        return new Promise((resolve) => signal?.addEventListener('abort', () => resolve({ exitCode: null, stdout: '', stderr: '', stopped: 'aborted' }), { once: true }));
      },
    );
    const ops = make(exec, { maxCloneBytes: 1_000, sizePollMs: 10 });
    expect(await cloning(ops, workspace, 'big', neverAborted())).toMatch(/larger than/);
  });

  it('is refused by the real git, with the arguments the runner gives it, for what reads the machine or runs a program', async () => {
    await createRepository(join(root, 'secret-repo'), { 'private.txt': 'secret\n' });
    const git = createHardenedGit({ exec: runProcess, environment: { PATH: process.env.PATH, HOME: join(root, 'home') }, windows: false, reach: 'network' });
    for (const url of [`file://${join(root, 'secret-repo')}`, join(root, 'secret-repo'), 'ext::sh -c touch% /tmp/pwned', 'git://github.com/octocat/Hello-World.git']) {
      const target = join(workspace, `refused-${await readdir(workspace).then((names) => names.length)}`);
      await mkdir(target);
      const result = await git.run({ cwd: workspace }, [], ['clone', '--no-checkout', '--no-recurse-submodules', '--template=', '--quiet', '--', url, target]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/not allowed|disallowed|protocol/i);
      expect(await readdir(target)).toEqual([]);
    }
    expect(await exists('/tmp/pwned')).toBe(false);
  });
});

describe('the address that is cloned from', () => {
  const asking = (stdout: string, exitCode = 0) => cloneWith(() => undefined, undefined, { exitCode, stdout, stderr: '', stopped: undefined });

  it('is asked what it would lead to, from a folder of the runner’s own, and is as written when nothing rewrites it', async () => {
    const { calls, exec } = asking(`${URL_OF_HELLO}\n`);
    expect(await make(exec).addressProblem(URL_OF_HELLO, neverAborted())).toBeUndefined();
    expect(calls[0]?.args.slice(-3)).toEqual(['ls-remote', '--get-url', URL_OF_HELLO]);
    expect(calls[0]?.options.cwd).toBe(join(root, 'state', 'neutral'));
  });

  it('is refused, with words, when the owner’s settings send it to another host', async () => {
    const { exec } = asking('https://mirror.example.org/octocat/Hello-World.git\n');
    expect(await make(exec).addressProblem(URL_OF_HELLO, neverAborted())).toMatch(/rewrite that address/);
  });

  it('is refused, with words, when git cannot say', async () => {
    const { exec } = asking('', 128);
    expect(await make(exec).addressProblem(URL_OF_HELLO, neverAborted())).toMatch(/could not say/);
  });

  it('is rewritten by the real git when a setting says so, which is what is caught', async () => {
    await mkdir(join(root, 'home'), { recursive: true });
    await writeFile(join(root, 'home', '.gitconfig'), '[url "https://mirror.example.org/"]\n\tinsteadOf = https://github.com/\n');
    expect(await make().addressProblem(URL_OF_HELLO, neverAborted())).toMatch(/rewrite that address/);
  });
});
