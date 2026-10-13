import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pairingLink, RUNNER_CLOSE, RUNNER_PAIR_PATHS } from '@escritoriio/runner-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { version } from '../package.json';
import { FakeAgent, FakeIsolation } from './application/task-testing.ts';
import { USAGE } from './infrastructure/command-line.ts';
import { STATE_DIRECTORY_VARIABLE } from './infrastructure/file-device-store.ts';
import { runCli } from './main.ts';
import { eventually, FakeOffice, FAKE_TOKEN } from './testing/fake-office.ts';
import { createRepository, neverAborted, plainGit } from './testing/git-fixtures.ts';
import { FakeTerminal } from './testing/fake-terminal.ts';

let office: FakeOffice;
let home: string;
let terminal: FakeTerminal;
let agent: FakeAgent;
let isolation: FakeIsolation;

beforeEach(async () => {
  office = await FakeOffice.start();
  home = await mkdtemp(join(tmpdir(), 'escritoriio-runner-cli-'));
  terminal = new FakeTerminal();
  agent = new FakeAgent();
  isolation = new FakeIsolation();
});

afterEach(async () => {
  await office.stop();
  await rm(home, { recursive: true, force: true });
  // Where the copies of folders are made, beside the state and not in it, as it is when the state is named with ESCRITORIIO_RUNNER_HOME.
  await rm(`${home}-worktrees`, { recursive: true, force: true });
});

// The coding agents and git are the ones a test sets up: what is installed on the machine that runs the tests is not what they are about.
const run = (...argv: string[]) => runCli(argv, { terminal, env: { [STATE_DIRECTORY_VARIABLE]: home }, agents: { 'claude-code': agent }, isolation });
const host = () => new URL(office.origin).host;

describe('the commands that only say something', () => {
  it('says the version', async () => {
    expect(await run('--version')).toBe(0);
    expect(terminal.stdout).toEqual([version]);
  });

  it.each([[['--help']], [[]]])('shows how to use it, for %j', async (argv) => {
    expect(await run(...argv)).toBe(0);
    expect(terminal.stdout).toEqual([USAGE]);
  });

  it('refuses what it does not understand, and shows how to use it', async () => {
    expect(await run('dance')).toBe(2);
    expect(terminal.stderr.join('\n')).toContain('"dance" is not a command');
    expect(terminal.stderr.join('\n')).toContain(USAGE);
  });

  it('says it is not paired before it is', async () => {
    expect(await run('status')).toBe(0);
    expect(terminal.stdout.join('\n')).toMatch(/not paired/);
  });
});

describe('pair', () => {
  it('asks whom it pairs with before it uses the code, and pairs on a yes', async () => {
    terminal.answers = ['y'];
    expect(await run('pair', office.origin, 'abcd-efgh', '--name', 'Test laptop')).toBe(0);
    expect(terminal.questions).toEqual([`Pair this machine with the office at ${host()}? It will work for the AI member "Robo" of the workspace "Acme", and be called "Test laptop". [y/N] `]);
    expect(office.pairingCalls.map((call) => call.path)).toEqual([RUNNER_PAIR_PATHS.preview, RUNNER_PAIR_PATHS.pair]);
    expect(office.pairingCalls[1]?.body).toMatchObject({ code: 'ABCDEFGH', deviceName: 'Test laptop', os: process.platform, runnerVersion: version });
    expect(terminal.stdout.join('\n')).toContain(`Paired with Robo of Acme at ${host()}. This machine is called "Test laptop".`);
  });

  it('does not use the code, and keeps nothing, on anything but a yes', async () => {
    for (const answer of ['', 'n', 'no', 'maybe']) {
      terminal = new FakeTerminal();
      terminal.answers = [answer];
      expect(await run('pair', office.origin, 'ABCDEFGH')).toBe(1);
      expect(terminal.stderr).toEqual(['Not paired.']);
    }
    expect(office.pairingCalls.map((call) => call.path)).toEqual(Array(4).fill(RUNNER_PAIR_PATHS.preview));
    terminal = new FakeTerminal();
    await run('status');
    expect(terminal.stdout.join('\n')).toMatch(/not paired/);
  });

  it('does not ask with --yes, but still says whom it pairs with', async () => {
    expect(await run('pair', office.origin, 'ABCDEFGH', '--yes', '--name', 'Test laptop')).toBe(0);
    expect(terminal.questions).toEqual([]);
    expect(terminal.stdout[0]).toBe(`Pairing this machine with the office at ${host()}. It will work for the AI member "Robo" of the workspace "Acme", and be called "Test laptop".`);
  });

  it('says what the machine will be called when it was not told, with the name of the machine', async () => {
    terminal.answers = ['n'];
    await run('pair', office.origin, 'ABCDEFGH');
    expect(terminal.questions[0]).toMatch(/and be called "[^"]+"\. \[y\/N\] $/);
  });

  it('does not let the names of the office close the quotes they are shown in', async () => {
    office.pairingReply = (path) =>
      path === RUNNER_PAIR_PATHS.preview ? { status: 200, body: JSON.stringify({ agentName: 'Robo" of the workspace "Other', workspaceName: 'Acme' }) } : { status: 400, body: '{"error":"no"}' };
    terminal.answers = ['n'];
    await run('pair', office.origin, 'ABCDEFGH', '--name', 'Laptop');
    expect(terminal.questions[0]).toContain(`the AI member "Robo' of the workspace 'Other" of the workspace "Acme"`);
  });

  it('fails before the code is used, and before the office is asked anything, when the pairing could not be kept here', async () => {
    const blocked = join(home, 'a-file');
    await writeFile(blocked, 'in the way');
    terminal.answers = ['y'];
    expect(await runCli(['pair', office.origin, 'ABCDEFGH'], { terminal, env: { [STATE_DIRECTORY_VARIABLE]: join(blocked, 'state') } })).toBe(1);
    expect(office.pairingCalls).toEqual([]);
    expect(terminal.questions).toEqual([]);
    expect(terminal.stderr).toHaveLength(1);
  });

  it('says plainly, without the token, that the code was used and the machine has to be removed in the office, when it could not be kept after all', async () => {
    // The folder takes files but the pairing cannot replace what is there: the failure comes after the office made the machine.
    await mkdir(join(home, 'device.json'));
    expect(await run('pair', office.origin, 'ABCDEFGH', '--yes', '--name', 'Test laptop')).toBe(1);
    expect(office.pairingCalls.map((call) => call.path)).toEqual([RUNNER_PAIR_PATHS.preview, RUNNER_PAIR_PATHS.pair]);
    expect(terminal.stderr.join('\n')).toMatch(/code was used up.*"Test laptop".*Remove it in My machines.*pair again/);
    expect(terminal.shown).not.toContain(FAKE_TOKEN);
    expect(await readdir(home)).toEqual(['device.json']);
  });

  it('reads the link the office shows', async () => {
    expect(await run('pair', pairingLink(office.origin, 'ABCDEFGH'), '--yes')).toBe(0);
    expect(office.pairingCalls[0]?.body).toEqual({ code: 'ABCDEFGH' });
  });

  it('shows the token to nobody: not as it pairs, not in `status`, and the file is the only place it is kept', async () => {
    expect(await run('pair', office.origin, 'ABCDEFGH', '--yes')).toBe(0);
    expect(await run('status')).toBe(0);
    expect(terminal.shown).not.toContain(FAKE_TOKEN);
    expect(await readFile(join(home, 'device.json'), 'utf8')).toContain(FAKE_TOKEN);
  });

  it('says what the office says when it refuses, and keeps nothing', async () => {
    office.pairingReply = () => ({ status: 400, body: JSON.stringify({ error: 'That code is not valid or has expired' }) });
    expect(await run('pair', office.origin, 'ABCDEFGH', '--yes')).toBe(1);
    expect(terminal.stderr).toEqual(['That code is not valid or has expired']);
    await expect(readFile(join(home, 'device.json'))).rejects.toThrow(/ENOENT/);
  });

  it('says what is wrong with what it was given, before it asks the office anything', async () => {
    expect(await run('pair', office.origin)).toBe(1);
    expect(terminal.stderr.join('\n')).toMatch(/pairing link/);
    expect(office.pairingCalls).toEqual([]);
  });
});

describe('status', () => {
  it('says whom the machine is paired with, and not the token', async () => {
    await run('pair', office.origin, 'ABCDEFGH', '--yes', '--name', 'Test laptop');
    terminal = new FakeTerminal();
    expect(await run('status')).toBe(0);
    expect(terminal.stdout.slice(0, 4)).toEqual([`server:    ${host()}`, 'AI member: Robo', 'workspace: Acme', 'device:    Test laptop']);
    expect(terminal.stdout.slice(4)).toEqual(['paused:    no', 'folders:   none shared yet: escritoriio-runner folders add <path>', 'agents:    claude-code 2.1.250, logged in', 'mcp:       none set up yet: escritoriio-runner mcp add <label> -- <program> [arguments]']);
  });
});

describe('start', () => {
  const pair = () => run('pair', office.origin, 'ABCDEFGH', '--yes', '--name', 'Test laptop');

  it('says it is not paired, when it is not', async () => {
    expect(await run('start')).toBe(1);
    expect(terminal.stderr.join('\n')).toMatch(/not paired/);
    expect(office.sockets).toEqual([]);
  });

  it('connects with the token that pairing gave, says so, and ends with 0 on Ctrl-C', async () => {
    await pair();
    terminal = new FakeTerminal();
    const running = run('start');
    await eventually(() => expect(terminal.stdout.join('\n')).toContain(`connected to ${host()} as "Test laptop", working for Robo of Acme`));
    expect(office.sockets[0]?.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    terminal.pressCtrlC();
    expect(await running).toBe(0);
    expect(terminal.stdout.at(-1)).toBe('stopped');
    expect(terminal.stderr).toEqual([]);
    expect(terminal.shown).not.toContain(FAKE_TOKEN);
  });

  it('ends with 1, saying so, when the office removed the device', async () => {
    await pair();
    terminal = new FakeTerminal();
    const running = run('start');
    await eventually(() => expect(office.sockets).toHaveLength(1));
    office.sockets[0]?.close(RUNNER_CLOSE.revoked, 'This machine was removed in the office');
    expect(await running).toBe(1);
    expect(terminal.stderr.join('\n')).toMatch(/removed in the office.*escritoriio-runner pair/);
    expect(terminal.shown).not.toContain(FAKE_TOKEN);
  });

  it('ends with 1, saying so, when the office does not know the token', async () => {
    await pair();
    terminal = new FakeTerminal();
    office.refuseSocketsWith = 401;
    expect(await run('start')).toBe(1);
    expect(terminal.stderr.join('\n')).toMatch(/does not know this device/);
  });

  it('ends with 1, saying so, when another process of the device took its place', async () => {
    await pair();
    terminal = new FakeTerminal();
    const running = run('start');
    await eventually(() => expect(office.sockets).toHaveLength(1));
    office.sockets[0]?.close(RUNNER_CLOSE.replaced, 'Another connection of this machine took its place');
    expect(await running).toBe(1);
    expect(terminal.stderr.join('\n')).toMatch(/another process/i);
  });

  it('ends with 1, saying so, when the office speaks another protocol', async () => {
    await pair();
    terminal = new FakeTerminal();
    const running = run('start');
    await eventually(() => expect(office.sockets).toHaveLength(1));
    office.sockets[0]?.close(RUNNER_CLOSE.unsupportedProtocol, 'Update the runner');
    expect(await running).toBe(1);
    expect(terminal.stderr.join('\n')).toMatch(/update the runner/i);
  });

  it('says that it is waiting to try again when the connection is cut, and ends with 0 on Ctrl-C', async () => {
    await pair();
    terminal = new FakeTerminal();
    const running = run('start');
    await eventually(() => expect(office.sockets).toHaveLength(1));
    office.sockets[0]?.drop();
    await eventually(() => expect(terminal.stdout.join('\n')).toMatch(/reconnecting in \d+s: the connection was lost/));
    terminal.pressCtrlC();
    expect(await running).toBe(0);
  });

  it('waits, saying so in its own words and not the office\'s, when the office closes it as not allowed for now', async () => {
    await pair();
    terminal = new FakeTerminal();
    const running = run('start');
    await eventually(() => expect(office.sockets).toHaveLength(1));
    office.sockets[0]?.close(RUNNER_CLOSE.notAllowed, 'WORDS-OF-THE-OFFICE\u001b[2J');
    await eventually(() => expect(terminal.stdout.join('\n')).toMatch(/waiting in 5 min: this machine is not allowed to work for now/));
    expect(terminal.shown).not.toContain('WORDS-OF-THE-OFFICE');
    terminal.pressCtrlC();
    expect(await running).toBe(0);
  });

  it('says the pairing it finds is damaged, instead of connecting', async () => {
    await pair();
    await writeFile(join(home, 'device.json'), 'not json');
    terminal = new FakeTerminal();
    expect(await run('start')).toBe(1);
    expect(terminal.stderr.join('\n')).toMatch(/damaged/);
    expect(office.sockets).toEqual([]);
  });
});

const types = (messages: readonly { readonly type: string }[]): string[] => messages.map((message) => message.type);

/** A place for the folders a test shares, apart from where the runner keeps its own state, with the names the file system gives. */
function withWorkspace() {
  const place = { path: '' };
  beforeEach(async () => {
    place.path = await realpath(await mkdtemp(join(tmpdir(), 'escritoriio-runner-work-')));
    await mkdir(join(place.path, 'site'));
  });
  afterEach(() => rm(place.path, { recursive: true, force: true }));
  return place;
}

const policyFile = async (): Promise<{ folders: { label: string; access: string; approval: string; isolation: string; trusted: boolean; agent: string | null; realPath: string }[]; agentPaths: Record<string, string>; paused: boolean }> =>
  JSON.parse(await readFile(join(home, 'policy.json'), 'utf8'));

describe('folders', () => {
  const workspace = withWorkspace();
  const site = () => join(workspace.path, 'site');
  const share = (...options: string[]) => run('folders', 'add', site(), ...options);

  it('says that none is shared yet', async () => {
    expect(await run('folders', 'list')).toBe(0);
    expect(terminal.stdout).toEqual(['No folder is shared yet. Share one with: escritoriio-runner folders add <path>']);
  });

  it('shares a folder only after saying what it means and asking, and the narrowest is what it keeps when nothing else was chosen', async () => {
    terminal.answers = ['y'];
    expect(await share()).toBe(0);
    expect(terminal.questions).toEqual(['Share this folder? [y/N] ']);
    expect(terminal.stdout.join('\n')).toContain(`Requests from you to your AI member will have a coding agent read the files in ${site()} without asking each time`);
    expect(terminal.stdout.at(-1)).toMatch(/^Shared as "site"\./);
    expect((await policyFile()).folders).toEqual([{ label: 'site', path: site(), realPath: site(), access: 'read-only', approval: 'auto', isolation: 'worktree', trusted: false, agent: null }]);
  });

  it('says in the words that were promised what editing without asking means, shell included, and does not ask with --yes', async () => {
    expect(await share('--access', 'edit', '--yes')).toBe(0);
    expect(terminal.questions).toEqual([]);
    const text = terminal.stdout.join('\n');
    expect(text).toContain(`Requests from you to your AI member will have a coding agent read and change the files in ${site()} without asking each time, in a copy of the files on a branch of its own, so the files you have in the folder are not touched, for at most 30 minutes each. It is given file tools and a shell, so it can run commands as well.`);
    expect(text).toContain('The shell runs inside the sandbox of your operating system where it has one (macOS, and Linux with bubblewrap and socat): it writes only in the work folder and in a temporary folder of its own, has no network and cannot read the places where credentials are kept (such as ~/.ssh), but it can read the rest of this machine. Windows has no such sandbox: nothing contains the commands there, and a folder is edited only if you trusted it.');
    expect(text).toContain('The file tools are not inside that sandbox.');
    expect(text).toContain('Nothing is pushed');
    expect(text).toContain('this machine cannot tell who wrote it');
    expect((await policyFile()).folders[0]).toMatchObject({ access: 'edit', approval: 'auto', isolation: 'worktree', trusted: false });
  });

  describe('a workspace', () => {
    const made = (name = 'build') => join(workspace.path, name);
    const makeOne = (...options: string[]) => run('folders', 'new', workspace.path, 'build', ...options);

    it('is made empty, and shared as a workspace, only after saying what it means and asking', async () => {
      terminal.answers = ['y'];
      expect(await makeOne()).toBe(0);
      expect(terminal.questions).toEqual(['Share this folder? [y/N] ']);
      const text = terminal.stdout.join('\n');
      expect(text).toContain(`Workspace "build": ${made()}`);
      expect(text).toContain('the agent works IN PLACE');
      expect(text).toContain('create folders inside the workspace without asking you');
      expect(text).toContain('you approve each clone one by one');
      expect(terminal.stdout.at(-1)).toMatch(/^Made the workspace "build" and shared it\./);
      expect(await readdir(made())).toEqual([]);
      expect((await policyFile()).folders).toEqual([{ label: 'build', path: made(), realPath: made(), access: 'edit', approval: 'auto', isolation: 'in-place', trusted: false, agent: null, kind: 'workspace' }]);
    });

    it('is not made, and nothing is kept, when the person does not say yes', async () => {
      expect(await makeOne()).toBe(1);
      expect(terminal.stderr).toEqual(['Not made.']);
      await expect(stat(made())).rejects.toThrow(/ENOENT/);
      await expect(readFile(join(home, 'policy.json'))).rejects.toThrow(/ENOENT/);
    });

    it('can be made many times, blank each time, and is listed as a workspace', async () => {
      expect(await makeOne('--yes')).toBe(0);
      expect(await run('folders', 'new', workspace.path, 'second', '--label', 'Second', '--yes')).toBe(0);
      terminal = new FakeTerminal();
      await run('folders', 'list');
      expect(terminal.stdout.join('\n')).toContain(`build: ${made()} (workspace)`);
      expect(terminal.stdout.join('\n')).toContain(`Second: ${made('second')} (workspace)`);
      expect(await readdir(made('second'))).toEqual([]);
    });

    it('is refused, with words, where it would be a folder that is not shared at all, and nothing is made', async () => {
      const keys = join(home, '..', 'nowhere');
      expect(await run('folders', 'new', keys, 'build', '--yes')).toBe(1);
      expect(terminal.stderr.join('\n')).toMatch(/no folder at that path/);
      terminal = new FakeTerminal();
      expect(await run('folders', 'new', workspace.path, '../x', '--yes')).toBe(1);
      expect(terminal.stderr.join('\n')).toMatch(/one name and not a path/);
      terminal = new FakeTerminal();
      expect(await run('folders', 'new', workspace.path, 'site', '--yes')).toBe(1);
      expect(terminal.stderr.join('\n')).toMatch(/already/);
    });

    it('is not a way to share a folder as a workspace that was not made empty: folders add never makes one', async () => {
      expect(await share('--access', 'edit', '--isolation', 'in-place', '--yes')).toBe(0);
      expect((await policyFile()).folders[0]).not.toHaveProperty('kind');
    });
  });

  it.each(['codex', 'kimi-code'])('refuses the coding agent %s, which this runner cannot drive yet, naming the one it can', async (kind) => {
    expect(await share('--agent', kind, '--yes')).toBe(1);
    expect(terminal.stderr.join('\n')).toContain(`This runner cannot drive ${kind} yet. It can drive: claude-code.`);
    await expect(readFile(join(home, 'policy.json'))).rejects.toThrow(/ENOENT/);
  });

  it('refuses, with the words a task would be refused with, a folder that cannot be copied, unless it is shared to be worked in place', async () => {
    isolation.checkResult = 'That folder holds no git repository: put it under git (git init, then a first commit), or change the folder to work in place.';
    expect(await share('--yes')).toBe(1);
    expect(terminal.stderr.join('\n')).toContain('That folder holds no git repository: put it under git (git init, then a first commit), or change the folder to work in place. To share it anyway, work on the folder itself: --isolation in-place.');
    expect(terminal.questions).toEqual([]);
    terminal = new FakeTerminal();
    expect(await share('--isolation', 'in-place', '--yes')).toBe(0);
  });

  it('refuses a folder that is where the coding agent keeps its login, and is not under home', async () => {
    const claudeConfig = join(workspace.path, 'claude-config');
    await mkdir(claudeConfig);
    expect(await runCli(['folders', 'add', claudeConfig, '--yes'], { terminal, env: { [STATE_DIRECTORY_VARIABLE]: home, CLAUDE_CONFIG_DIR: claudeConfig }, agents: { 'claude-code': agent }, isolation })).toBe(1);
    expect(terminal.stderr.join('\n')).toMatch(/where credentials are kept/);
    expect(terminal.questions).toEqual([]);
  });

  it('does not undo a pause that was set in another terminal while the person was asked, nor a folder shared there', async () => {
    terminal.ask = async () => {
      await runCli(['pause'], { terminal: new FakeTerminal(), env: { [STATE_DIRECTORY_VARIABLE]: home }, agents: { 'claude-code': agent }, isolation });
      return 'y';
    };
    expect(await share()).toBe(0);
    const kept = await policyFile();
    expect(kept.paused).toBe(true);
    expect(kept.folders.map((folder) => folder.label)).toEqual(['site']);
  });

  it('says what working in place and trusting a folder mean', async () => {
    expect(await share('--access', 'edit', '--isolation', 'in-place', '--trusted', '--approval', 'ask', '--agent', 'claude-code', '--label', 'Docs', '--yes')).toBe(0);
    const text = terminal.stdout.join('\n');
    expect(text).toContain('only after you approve each one on this machine');
    expect(text).toContain('on the files in the folder themselves, with no copy and no branch');
    expect(text).toContain('It is trusted');
    expect((await policyFile()).folders[0]).toMatchObject({ label: 'Docs', access: 'edit', approval: 'ask', isolation: 'in-place', trusted: true, agent: 'claude-code' });
  });

  it('names the AI member the machine is paired with', async () => {
    await run('pair', office.origin, 'ABCDEFGH', '--yes');
    terminal = new FakeTerminal();
    await share('--yes');
    expect(terminal.stdout.join('\n')).toContain('Requests from you to Robo will have');
  });

  it.each([[''], ['n'], ['maybe']])('keeps nothing on an answer of %j, and ends with 1', async (answer) => {
    terminal.answers = [answer];
    expect(await share()).toBe(1);
    expect(terminal.stderr).toEqual(['Not shared.']);
    await expect(readFile(join(home, 'policy.json'))).rejects.toThrow(/ENOENT/);
  });

  it('takes a path that is not a full one as relative to the folder the command runs in', async () => {
    expect(await runCli(['folders', 'add', 'site', '--yes'], { terminal, env: { [STATE_DIRECTORY_VARIABLE]: home }, cwd: workspace.path, agents: { 'claude-code': agent }, isolation })).toBe(0);
    expect((await policyFile()).folders[0]?.realPath).toBe(site());
  });

  it('shares what a link leads to, under the name of the folder it leads to, and keeps the path that was given', async () => {
    await symlink(site(), join(workspace.path, 'link'));
    expect(await run('folders', 'add', join(workspace.path, 'link'), '--yes')).toBe(0);
    expect((await policyFile()).folders[0]).toMatchObject({ label: 'site', path: join(workspace.path, 'link'), realPath: site() });
  });

  it.each([
    ['a folder that is not there', () => join(workspace.path, 'nowhere'), /There is no folder at that path/],
    ['home itself', () => homedir(), /Your home folder holds everything of yours/],
    ['the settings of the runner', () => home, /settings and token/],
    ['a link to home', () => join(workspace.path, 'link-home'), /Your home folder holds everything/],
  ])('refuses %s, with words, and ends with 1', async (_what, path, message) => {
    await symlink(homedir(), join(workspace.path, 'link-home'));
    expect(await run('folders', 'add', path(), '--yes')).toBe(1);
    expect(terminal.stderr.join('\n')).toMatch(message);
    expect(terminal.questions).toEqual([]);
  });

  it('refuses a folder that is shared already, and a label that is taken or is not one', async () => {
    await share('--yes');
    terminal = new FakeTerminal();
    expect(await share('--yes', '--label', 'again')).toBe(1);
    expect(terminal.stderr.join('\n')).toMatch(/already shared as "site"/);
    await mkdir(join(workspace.path, 'other'));
    terminal = new FakeTerminal();
    expect(await run('folders', 'add', join(workspace.path, 'other'), '--yes', '--label', 'SITE')).toBe(1);
    expect(terminal.stderr.join('\n')).toMatch(/folder called "SITE" already/);
    terminal = new FakeTerminal();
    expect(await run('folders', 'add', join(workspace.path, 'other'), '--yes', '--label', 'a/b')).toBe(1);
    expect(terminal.stderr.join('\n')).toMatch(/not a path/);
  });

  it('gives a second folder of the same name a number', async () => {
    await share('--yes');
    await mkdir(join(workspace.path, 'deeper', 'site'), { recursive: true });
    expect(await run('folders', 'add', join(workspace.path, 'deeper', 'site'), '--yes')).toBe(0);
    expect((await policyFile()).folders.map((folder) => folder.label)).toEqual(['site', 'site-2']);
  });

  it('is listed with how it is shared, and with whether it is still where it was', async () => {
    await share('--access', 'edit', '--yes');
    terminal = new FakeTerminal();
    expect(await run('folders', 'list')).toBe(0);
    expect(terminal.stdout).toEqual([`site: ${site()}`, '  access: edit, approval: auto, isolation: worktree, trusted: no, agent: any', '  It is where it was when it was shared.']);
    await rm(site(), { recursive: true });
    terminal = new FakeTerminal();
    await run('folders', 'list');
    expect(terminal.stdout.at(-1)).toBe('  The folder is not there any more.');
  });

  it('shows in `status` how many are shared and which', async () => {
    await share('--yes');
    terminal = new FakeTerminal();
    await run('status');
    expect(terminal.stdout).toContain('folders:   1 shared: site');
  });

  it('is not shared any more after `folders remove`, which says what that does not do', async () => {
    await share('--yes');
    terminal = new FakeTerminal();
    expect(await run('folders', 'remove', 'site')).toBe(0);
    expect(terminal.stdout.join('\n')).toMatch(/Stopped sharing "site"\. A task that is running in it is not stopped/);
    expect((await policyFile()).folders).toEqual([]);
    terminal = new FakeTerminal();
    expect(await run('folders', 'remove', 'site')).toBe(1);
    expect(terminal.stderr.join('\n')).toMatch(/No folder is shared as "site"\. None is shared yet/);
  });

  it.skipIf(process.platform === 'win32')('are kept in a file that only its owner reads', async () => {
    await share('--yes');
    expect((await stat(join(home, 'policy.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
  });

  it('are not touched when the file cannot be read: every command says so, and none writes over it', async () => {
    await writeFile(join(home, 'policy.json'), '{"folders": [');
    for (const argv of [['folders', 'list'], ['folders', 'add', site(), '--yes'], ['folders', 'remove', 'site'], ['agents'], ['pause'], ['status']]) {
      terminal = new FakeTerminal();
      expect(await run(...argv)).toBe(1);
      expect(terminal.stderr.join('\n')).toMatch(/cannot be read.*damaged/);
    }
    expect(await readFile(join(home, 'policy.json'), 'utf8')).toBe('{"folders": [');
  });

  it.each([
    [['folders'], /folders takes add, new, list or remove/],
    [['folders', 'dance'], /folders takes add, new, list or remove/],
    [['folders', 'add'], /needs the path/],
    [['folders', 'add', '/x', '--access', 'root'], /--access is one of: read-only, edit/],
    [['folders', 'add', '/x', '--approval', 'never'], /--approval is one of: auto, ask/],
    [['folders', 'add', '/x', '--isolation', 'none'], /--isolation is one of: worktree, in-place/],
    [['folders', 'add', '/x', '--agent', 'gpt'], /--agent is one of: claude-code, codex, kimi-code/],
    [['folders', 'remove'], /needs the label/],
    [['folders', 'list', 'now'], /takes nothing more/],
    [['status', '--access', 'edit'], /--access is an option of folders add, not of status/],
  ])('is a mistake of the command line, with exit code 2 and how to use it, for %j', async (argv, message) => {
    expect(await run(...argv)).toBe(2);
    expect(terminal.stderr.join('\n')).toMatch(message);
    expect(terminal.stderr.join('\n')).toContain(USAGE);
  });
});

describe('settings that are a folder', () => {
  it('are said to be one, with the file and what to do, by every command, and not as the system says it', async () => {
    await mkdir(join(home, 'policy.json'), { recursive: true });
    for (const argv of [['status'], ['folders', 'list'], ['agents'], ['pause'], ['run', 'site', 'Fix it']]) {
      terminal = new FakeTerminal();
      expect(await run(...argv)).toBe(1);
      expect(terminal.stderr.join('\n')).toContain(`The settings kept in ${join(await realpath(home), 'policy.json')} cannot be used: it is a folder, and the settings are a file. Move it away, or mend it, and try again.`);
      expect(terminal.stderr.join('\n')).not.toContain('EISDIR');
    }
  });
});

describe('the coding agents', () => {
  it('are said, in `status`, to be none that can be used when the one that is installed is a version this runner cannot drive, and `agents` says why', async () => {
    agent.detection = { ...agent.detection, supported: false, problem: 'This version is too old: 1.0.0.' };
    expect(await run('status')).toBe(0);
    expect(terminal.stdout.join('\n')).toContain('agents:    none that can be used: escritoriio-runner agents says why');
    terminal = new FakeTerminal();
    expect(await run('agents')).toBe(0);
    expect(terminal.stdout.join('\n')).toContain('supported:    no: this runner cannot drive this version');
    expect(terminal.stdout.join('\n')).toContain('problem:      This version is too old: 1.0.0.');
  });

  it('are listed with what each is on this machine', async () => {
    expect(await run('agents')).toBe(0);
    expect(terminal.stdout.slice(0, 6)).toEqual(['claude-code', '  found:        yes, at /usr/local/bin/claude', '  version:      2.1.250', '  logged in:    yes', '  supported:    yes', '  containment:  it has a sandbox of its own on this system']);
    expect(terminal.stdout).toContain('  this runner cannot drive it yet');
  });

  it('have a path that the person picks, which is kept and looked for from then on, and which they can take back', async () => {
    expect(await run('agents', 'set-path', 'claude-code', '/opt/claude/bin/claude')).toBe(0);
    expect(terminal.stdout[0]).toBe('claude-code will be looked for at /opt/claude/bin/claude.');
    expect(agent.detects).toEqual(['/opt/claude/bin/claude']);
    expect((await policyFile()).agentPaths).toEqual({ 'claude-code': '/opt/claude/bin/claude' });

    terminal = new FakeTerminal();
    await run('agents');
    expect(agent.detects.at(-1)).toBe('/opt/claude/bin/claude');
    expect(terminal.stdout[1]).toContain('(the path you picked)');

    terminal = new FakeTerminal();
    expect(await run('agents', 'clear-path', 'claude-code')).toBe(0);
    expect(terminal.stdout).toEqual(['claude-code will be found by itself again.']);
    expect((await policyFile()).agentPaths).toEqual({});
    terminal = new FakeTerminal();
    await run('agents', 'clear-path', 'claude-code');
    expect(terminal.stdout).toEqual(['There was no path kept for claude-code.']);
  });

  it('say that nobody is logged in when the path was set to a tool that is not', async () => {
    agent.detection = { ...agent.detection, loggedIn: false };
    await run('agents', 'set-path', 'claude-code', '/opt/claude');
    expect(terminal.stdout[0]).toMatch(/Nobody is logged in to it yet/);
  });

  it('refuse a path that is not a full one, one where nothing runs, and a tool this runner cannot drive, and keep nothing', async () => {
    expect(await run('agents', 'set-path', 'claude-code', 'bin/claude')).toBe(1);
    expect(terminal.stderr.join('\n')).toMatch(/full path/);
    agent.detection = { ...agent.detection, installed: false, problem: 'That is not Claude Code.' };
    terminal = new FakeTerminal();
    expect(await run('agents', 'set-path', 'claude-code', '/opt/other')).toBe(1);
    expect(terminal.stderr.join('\n')).toContain('Nothing that can be run as claude-code was found at that path. That is not Claude Code.');
    agent.detection = { ...agent.detection, installed: true, supported: false, problem: 'This version is too old: 1.0.0.' };
    terminal = new FakeTerminal();
    expect(await run('agents', 'set-path', 'claude-code', '/opt/old')).toBe(1);
    expect(terminal.stderr.join('\n')).toContain('claude-code is at that path, but this runner cannot drive that version of it. This version is too old: 1.0.0.');
    terminal = new FakeTerminal();
    expect(await run('agents', 'set-path', 'codex', '/opt/codex')).toBe(1);
    expect(terminal.stderr.join('\n')).toMatch(/cannot drive codex yet/);
    await expect(readFile(join(home, 'policy.json'))).rejects.toThrow(/ENOENT/);
  });

  it.each([
    [['agents', 'set-path'], /needs the coding agent/],
    [['agents', 'set-path', 'gpt', '/x'], /takes one of: claude-code, codex, kimi-code/],
    [['agents', 'set-path', 'claude-code'], /needs the full path/],
    [['agents', 'clear-path'], /needs the coding agent/],
    [['agents', 'dance'], /agents takes nothing, or set-path or clear-path/],
  ])('are a mistake of the command line, with exit code 2, for %j', async (argv, message) => {
    expect(await run(...argv)).toBe(2);
    expect(terminal.stderr.join('\n')).toMatch(message);
  });
});

describe('pausing on the machine', () => {
  it('is kept, shown by `status`, and lifted by `resume`, and says what each means', async () => {
    expect(await run('pause')).toBe(0);
    expect(terminal.stdout.join('\n')).toMatch(/^Paused\..*takes no task.*within a second/s);
    expect((await policyFile()).paused).toBe(true);
    terminal = new FakeTerminal();
    await run('status');
    expect(terminal.stdout).toContain('paused:    yes, on this machine: escritoriio-runner resume lifts it');

    terminal = new FakeTerminal();
    expect(await run('resume')).toBe(0);
    expect(terminal.stdout.join('\n')).toMatch(/^Resumed\..*the office paused this machine as well/s);
    expect((await policyFile()).paused).toBe(false);
  });

  it('does not change what was already so, and says that it was', async () => {
    await run('resume');
    expect(terminal.stdout[0]).toBe('It was not paused.');
    terminal = new FakeTerminal();
    await run('pause');
    terminal = new FakeTerminal();
    await run('pause');
    expect(terminal.stdout[0]).toBe('It was paused already.');
  });
});

describe('run', () => {
  const workspace = withWorkspace();
  const shareSite = (...options: string[]) => run('folders', 'add', join(workspace.path, 'site'), '--access', 'edit', '--yes', ...options);

  it('runs a task by hand with no office at all, on a machine that is not paired, and ends with 0', async () => {
    await shareSite();
    terminal = new FakeTerminal();
    agent.script = async function* () {
      yield { kind: 'text', text: 'On it.' };
      yield { kind: 'result', text: 'Fixed.' };
    };
    expect(await run('run', 'site', 'Fix the typo in the README')).toBe(0);
    expect(office.sockets).toEqual([]);
    expect(office.pairingCalls).toEqual([]);
    expect(terminal.stdout).toEqual(expect.arrayContaining(['Working. Press Ctrl-C to stop it.', 'On it.', 'Done in 1s.', '\nFixed.']));
    expect(terminal.stdout.join('\n')).toContain('The work is on the branch escritoriio/task');
    expect(agent.requests[0]).toMatchObject({ instruction: 'Fix the typo in the README', access: 'edit' });
    expect(isolation.made).toHaveLength(1);
    expect(isolation.made[0]?.taskId).toMatch(/^local-[0-9a-f-]{36}$/);
  });

  it('puts the words of an instruction that was not quoted back together, and takes what comes after -- as it is', async () => {
    await shareSite();
    await run('run', 'site', 'Fix', 'the', 'typo');
    expect(agent.requests[0]?.instruction).toBe('Fix the typo');
    await run('run', 'site', '--', '--fix', 'the', 'typo');
    expect(agent.requests[1]?.instruction).toBe('--fix the typo');
  });

  it('is told the tool to use when the person says which', async () => {
    await shareSite();
    terminal = new FakeTerminal();
    expect(await run('run', '--agent', 'codex', 'site', 'Fix it')).toBe(1);
    expect(terminal.stderr.join('\n')).toMatch(/cannot drive that coding agent/);
    expect(await run('run', 'site', '--agent', 'claude-code', 'Fix it')).toBe(0);
  });

  it('takes an instruction as it was typed from its first word on, even a word that looks like an option, and does not print the version for it', async () => {
    await shareSite();
    terminal = new FakeTerminal();
    expect(await run('run', 'site', 'explain', 'the', '-v', 'flag')).toBe(0);
    expect(agent.requests[0]?.instruction).toBe('explain the -v flag');
    expect(terminal.stdout).not.toContain(version);
    expect(await run('run', 'site', 'what', 'does', '-h', 'do')).toBe(0);
    expect(agent.requests[1]?.instruction).toBe('what does -h do');
    expect(terminal.stdout).not.toContain(USAGE);
    expect(await run('run', 'site', 'fix', 'it', '--approve')).toBe(0);
    expect(agent.requests[2]?.instruction).toBe('fix it --approve');
  });

  it('finds the folder by its label in whatever case the person types it', async () => {
    await shareSite();
    terminal = new FakeTerminal();
    expect(await run('run', 'SITE', 'Fix it')).toBe(0);
    expect(isolation.made[0]?.folder.label).toBe('site');
  });

  it('is refused for a folder that is not shared, as the machine says it, and ends with 1', async () => {
    expect(await run('run', 'nowhere', 'Fix it')).toBe(1);
    expect(terminal.stderr).toEqual(['The task was not run: That folder is not one this machine shares.', 'See the folders that are shared with: escritoriio-runner folders list']);
    expect(agent.requests).toEqual([]);
  });

  it('is refused while the machine is paused on the machine itself', async () => {
    await shareSite();
    await run('pause');
    terminal = new FakeTerminal();
    expect(await run('run', 'site', 'Fix it')).toBe(1);
    expect(terminal.stderr).toEqual(['The task was not run: This machine is paused.']);
  });

  it('is refused for an instruction with nothing in it', async () => {
    await shareSite();
    expect(await run('run', 'site')).toBe(2);
    expect(await run('run', 'site', '   ')).toBe(2);
    expect(await run('run')).toBe(2);
  });

  it('asks the person to approve a folder that asks, with the exact text, unless they approve it in advance', async () => {
    await shareSite('--approval', 'ask');
    terminal = new FakeTerminal();
    terminal.answers = ['y'];
    expect(await run('run', 'site', 'Delete every test')).toBe(0);
    expect(terminal.stdout.join('\n')).toContain('The folder "site" asks you to approve each task. This is the exact text the coding agent would be given:\n\nDelete every test\n');
    expect(terminal.questions).toEqual(['Approve it and run it? [y/N] ']);

    terminal = new FakeTerminal();
    expect(await run('run', 'site', 'Delete every test')).toBe(1);
    expect(terminal.stderr).toEqual(['Not approved. Nothing was run.']);

    terminal = new FakeTerminal();
    expect(await run('run', '--approve', 'site', 'Delete every test')).toBe(0);
    expect(terminal.questions).toEqual([]);
    expect(agent.requests).toHaveLength(2);
  });

  it('ends with 130 when it is stopped with Ctrl-C, and gives the work up', async () => {
    await shareSite();
    terminal = new FakeTerminal();
    agent.script = async function* (_request, signal) {
      yield { kind: 'text', text: 'Working' };
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    };
    const running = run('run', 'site', 'Do something long');
    await eventually(() => expect(terminal.stdout).toContain('Working'));
    terminal.pressCtrlC();
    expect(await running).toBe(130);
    expect(terminal.stderr).toEqual(['The task was cancelled.']);
    expect(isolation.made[0]).toMatchObject({ discarded: true, finished: false });
  });

  it('ends with 143 when the program is asked to end, as a shell says it, and with 130 for Ctrl-C', async () => {
    await shareSite();
    terminal = new FakeTerminal();
    agent.script = async function* (_request, signal) {
      yield { kind: 'text', text: 'Working' };
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    };
    const running = run('run', 'site', 'Do something long');
    await eventually(() => expect(terminal.stdout).toContain('Working'));
    terminal.pressCtrlC('SIGTERM');
    expect(await running).toBe(143);
  });

  it('is stopped within a second by a pause that its owner sets in another terminal, and says that it was paused', async () => {
    await shareSite();
    terminal = new FakeTerminal();
    agent.script = async function* (_request, signal) {
      yield { kind: 'text', text: 'Working' };
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    };
    const running = run('run', 'site', 'Do something long');
    await eventually(() => expect(terminal.stdout).toContain('Working'));

    const other = new FakeTerminal();
    expect(await runCli(['pause'], { terminal: other, env: { [STATE_DIRECTORY_VARIABLE]: home }, agents: { 'claude-code': agent }, isolation })).toBe(0);

    // The pause is looked for once a second, which is as long as it may take.
    expect(await running).toBe(1);
    expect(terminal.stderr.join('\n')).toMatch(/The task failed \(paused\) after \d+s: The machine was paused, so the task was stopped\./);
    expect(isolation.made[0]).toMatchObject({ discarded: true, finished: false });
  }, 30_000);

  it('says what the coding agent could not do, with exit code 1', async () => {
    await shareSite();
    terminal = new FakeTerminal();
    agent.detection = { ...agent.detection, loggedIn: false };
    expect(await run('run', 'site', 'Fix it')).toBe(1);
    expect(terminal.stderr[0]).toMatch(/nobody is logged in to it on this machine/);
  });

  describe('with a real git repository and a coding agent that edits files', () => {
    const git = (cwd: string, ...args: string[]) => plainGit(cwd, ...args);
    const real = () => ({ terminal, env: { [STATE_DIRECTORY_VARIABLE]: home, PATH: process.env.PATH ?? '' }, agents: { 'claude-code': agent } });

    it('leaves the work on a branch of its own with a commit, and nothing in the folder changed', async () => {
      const repository = join(workspace.path, 'site');
      await createRepository(repository, { 'README.md': 'Hello\n', 'src/index.ts': 'export {};\n' });
      await writeFile(join(repository, 'notes.txt'), 'the person’s own, not committed\n');
      expect(await runCli(['folders', 'add', repository, '--access', 'edit', '--yes'], real())).toBe(0);
      const before = { status: await git(repository, 'status', '--porcelain=v1'), head: await git(repository, 'rev-parse', 'HEAD') };
      agent.script = async function* (request) {
        // The place a task works in is not in the folder that holds the token, nor under it.
        expect(request.folder.startsWith(`${await realpath(home)}-worktrees${sep}`)).toBe(true);
        expect(request.folder.startsWith(`${await realpath(home)}${sep}`)).toBe(false);
        await writeFile(join(request.folder, 'README.md'), 'Hello, world\n');
        await writeFile(join(request.folder, 'NEW.md'), 'new\n');
        yield { kind: 'result', text: 'Edited the README.' };
      };
      terminal = new FakeTerminal();

      expect(await runCli(['run', 'site', 'Edit the README'], real())).toBe(0);

      const branch = (await git(repository, 'branch', '--list', 'escritoriio/*', '--format=%(refname:short)')).trim();
      expect(branch).toMatch(/^escritoriio\/local-[0-9a-f-]{36}$/);
      expect(await git(repository, 'show', `${branch}:README.md`)).toBe('Hello, world\n');
      expect(await git(repository, 'show', `${branch}:NEW.md`)).toBe('new\n');
      expect(await git(repository, 'show', `${branch}:src/index.ts`)).toBe('export {};\n');
      expect(await git(repository, 'rev-list', '--count', `main..${branch}`)).toBe('1\n');
      expect(await readFile(join(repository, 'README.md'), 'utf8')).toBe('Hello\n');
      await expect(stat(join(repository, 'NEW.md'))).rejects.toThrow(/ENOENT/);
      expect(await git(repository, 'status', '--porcelain=v1')).toBe(before.status);
      expect(await git(repository, 'rev-parse', 'HEAD')).toBe(before.head);
      expect(await readdir(`${home}-worktrees`)).toEqual([]);
      expect(await readdir(home)).not.toContain('worktrees');
      expect(terminal.stdout.join('\n')).toContain(`The work is on the branch ${branch}`);
      expect(terminal.stdout.join('\n')).toMatch(/README\.md \| 2 \+-/);
      expect(terminal.shown).not.toContain(home);
    }, 60_000);

    it('refuses to share a folder that holds no repository, with the words a task would be refused with, and keeps nothing', async () => {
      expect(await runCli(['folders', 'add', join(workspace.path, 'site'), '--access', 'edit', '--yes'], real())).toBe(1);
      expect(terminal.stderr.join('\n')).toContain('That folder holds no git repository: put it under git (git init, then a first commit), or change the folder to work in place. To share it anyway, work on the folder itself: --isolation in-place.');
      expect(terminal.stdout.join('\n')).not.toContain('Share this folder?');
      await expect(readFile(join(home, 'policy.json'))).rejects.toThrow(/ENOENT/);
    }, 60_000);

    it('shares a folder that holds no repository when it is worked in place', async () => {
      expect(await runCli(['folders', 'add', join(workspace.path, 'site'), '--access', 'edit', '--isolation', 'in-place', '--yes'], real())).toBe(0);
    }, 60_000);

    it('says why in words, and leaves nothing behind, when a folder that was shared stopped being in a repository', async () => {
      const repository = join(workspace.path, 'site');
      await createRepository(repository, { 'README.md': 'Hello\n' });
      expect(await runCli(['folders', 'add', repository, '--access', 'edit', '--yes'], real())).toBe(0);
      await rm(join(repository, '.git'), { recursive: true });
      terminal = new FakeTerminal();
      expect(await runCli(['run', 'site', 'Edit the README'], real())).toBe(1);
      expect(terminal.stderr.join('\n')).toMatch(/That folder holds no git repository/);
      expect(agent.requests).toEqual([]);
    }, 60_000);
  });
});

describe('start, with tasks', () => {
  const workspace = withWorkspace();
  const pairIt = () => run('pair', office.origin, 'ABCDEFGH', '--yes', '--name', 'Test laptop');

  /** Starts the runner as a program of its own and waits until the office has heard from it. */
  async function started() {
    await pairIt();
    expect(await run('folders', 'add', join(workspace.path, 'site'), '--access', 'edit', '--yes')).toBe(0);
    terminal = new FakeTerminal();
    const running = run('start');
    await eventually(() => expect(office.sockets[0]?.messages.map((message) => message.type)).toContain('hello'));
    return { running, socket: office.sockets[0] as NonNullable<(typeof office.sockets)[number]> };
  }

  it('tells the office what it shares and finds, and runs the task the office offers, answering it as it goes', async () => {
    const { running, socket } = await started();
    expect(socket.messages[0]).toEqual({ type: 'hello', protocol: 1, runnerVersion: version, os: process.platform, agents: [{ kind: 'claude-code', version: '2.1.250', loggedIn: true }], folders: ['site'], mcpServers: [], paused: false, tasks: [] });
    agent.script = async function* () {
      yield { kind: 'text', text: 'Looking' };
      yield { kind: 'result', text: 'Done.' };
    };

    socket.send({ type: 'task.offer', taskId: 'task-1', folder: 'site', agent: null, instruction: 'Fix the typo' });
    await eventually(() => expect(types(socket.messages)).toContain('task.done'));

    expect(types(socket.messages).slice(1)).toEqual(['task.accept', 'task.event', 'task.done']);
    expect(socket.messages.at(-1)).toMatchObject({ type: 'task.done', taskId: 'task-1', text: 'Done.', branch: 'escritoriio/task' });
    expect(terminal.stdout).toEqual(expect.arrayContaining(['task task-1 taken', expect.stringMatching(/^task task-1 done in \d+s$/)]));
    expect(terminal.shown).not.toContain('Fix the typo');
    terminal.pressCtrlC();
    expect(await running).toBe(0);
  });

  it('refuses what is offered for a folder that is not shared, whatever the office says', async () => {
    const { running, socket } = await started();
    socket.send({ type: 'task.offer', taskId: 'task-1', folder: 'not-shared', agent: null, instruction: 'Fix the typo' });
    await eventually(() => expect(types(socket.messages)).toContain('task.reject'));
    expect(socket.messages.at(-1)).toMatchObject({ type: 'task.reject', taskId: 'task-1', reason: 'not-allowed' });
    expect(agent.requests).toEqual([]);
    terminal.pressCtrlC();
    await running;
  });

  it('takes up a pause that its owner sets from another terminal, tells the office, stops what runs, and refuses what is offered, until it is resumed', async () => {
    const { running, socket } = await started();
    agent.script = async function* (_request, signal) {
      yield { kind: 'text', text: 'Working' };
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    };
    socket.send({ type: 'task.offer', taskId: 'task-1', folder: 'site', agent: null, instruction: 'Take a while' });
    await eventually(() => expect(types(socket.messages)).toContain('task.event'));

    const elsewhere = new FakeTerminal();
    expect(await runCli(['pause'], { terminal: elsewhere, env: { [STATE_DIRECTORY_VARIABLE]: home }, agents: { 'claude-code': agent }, isolation })).toBe(0);
    await vi.waitFor(() => expect(socket.messages).toContainEqual({ type: 'paused', paused: true }), { timeout: 8_000, interval: 25 });
    await eventually(() => expect(socket.messages).toContainEqual(expect.objectContaining({ type: 'task.failed', taskId: 'task-1', reason: 'paused' })));
    expect(terminal.stdout).toContain('paused on this machine: no task is taken, and the one that runs is stopped');

    socket.send({ type: 'task.offer', taskId: 'task-2', folder: 'site', agent: null, instruction: 'Again' });
    await eventually(() => expect(socket.messages).toContainEqual(expect.objectContaining({ type: 'task.reject', taskId: 'task-2', reason: 'paused' })));

    await runCli(['resume'], { terminal: new FakeTerminal(), env: { [STATE_DIRECTORY_VARIABLE]: home }, agents: { 'claude-code': agent }, isolation });
    await vi.waitFor(() => expect(socket.messages).toContainEqual({ type: 'paused', paused: false }), { timeout: 8_000, interval: 25 });
    terminal.pressCtrlC();
    expect(await running).toBe(0);
  }, 30_000);

  it('says it is paused on the machine when it starts paused, in hello', async () => {
    await pairIt();
    await run('pause');
    terminal = new FakeTerminal();
    const running = run('start');
    await eventually(() => expect(office.sockets[0]?.messages[0]).toMatchObject({ type: 'hello', paused: true }));
    terminal.pressCtrlC();
    await running;
  });

  it('goes on with a task when the connection drops, and tells the next hello how it ended', async () => {
    const { running, socket } = await started();
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    agent.script = async function* () {
      yield { kind: 'text', text: 'Working' };
      await released;
      yield { kind: 'result', text: 'Finished while the link was down.' };
    };
    socket.send({ type: 'task.offer', taskId: 'task-1', folder: 'site', agent: null, instruction: 'Take a while' });
    await eventually(() => expect(types(socket.messages)).toContain('task.event'));

    socket.drop();
    await eventually(() => expect(office.sockets).toHaveLength(2));
    await eventually(() => expect(office.sockets[1]?.messages[0]).toMatchObject({ type: 'hello', tasks: [{ state: 'running', taskId: 'task-1' }] }));
    release();
    await eventually(() => expect(types(office.sockets[1]?.messages ?? [])).toContain('task.done'));
    expect(types(socket.messages)).not.toContain('task.done');

    office.sockets[1]?.drop();
    await eventually(() => expect(office.sockets).toHaveLength(3));
    await eventually(() => expect(office.sockets[2]?.messages[0]).toMatchObject({ type: 'hello', tasks: [{ state: 'done', taskId: 'task-1', text: 'Finished while the link was down.' }] }));
    terminal.pressCtrlC();
    expect(await running).toBe(0);
  }, 30_000);

  it('stops the task that runs when it is stopped, leaves how it ended in its journal, and ends with 0', async () => {
    const { running, socket } = await started();
    agent.script = async function* (_request, signal) {
      yield { kind: 'text', text: 'Working' };
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    };
    socket.send({ type: 'task.offer', taskId: 'task-1', folder: 'site', agent: null, instruction: 'Take a while' });
    await eventually(() => expect(types(socket.messages)).toContain('task.event'));
    terminal.pressCtrlC();
    expect(await running).toBe(0);
    expect(terminal.stdout).toContain('stopping: the task that runs is being stopped first');
    expect(terminal.stdout.at(-1)).toBe('stopped');
    expect(isolation.made[0]).toMatchObject({ discarded: true });
    const journal = JSON.parse(await readFile(join(home, 'journal.json'), 'utf8')) as { records: { entry: { state: string; taskId: string; reason?: string } }[] };
    expect(journal.records.map((record) => record.entry)).toEqual([expect.objectContaining({ state: 'failed', taskId: 'task-1', reason: 'interrupted' })]);
  });

  it('does not start, and says why, when the settings cannot be read', async () => {
    await pairIt();
    await writeFile(join(home, 'policy.json'), 'damaged');
    terminal = new FakeTerminal();
    expect(await run('start')).toBe(1);
    expect(terminal.stderr.join('\n')).toMatch(/cannot be read.*damaged/);
    expect(office.sockets).toEqual([]);
  });
});

describe('the folders of the runner itself', () => {
  it('is said, with words and exit code 1, when they cannot be set up because a link leads nowhere, and not as a crash', async () => {
    const dangling = join(tmpdir(), `escritoriio-runner-dangling-${process.pid}`);
    await rm(dangling, { force: true });
    await symlink(join(home, 'nowhere'), dangling);
    try {
      expect(await runCli(['status'], { terminal, env: { [STATE_DIRECTORY_VARIABLE]: dangling } })).toBe(1);
    } finally {
      await rm(dangling, { force: true });
    }
    expect(terminal.stderr).toEqual(['The runner’s own folders cannot be set up: A link that leads nowhere.']);
    expect(terminal.stdout).toEqual([]);
  });

  it('are not needed to say the version or to show how to use it', async () => {
    const dangling = join(tmpdir(), `escritoriio-runner-dangling-version-${process.pid}`);
    await rm(dangling, { force: true });
    await symlink(join(home, 'nowhere'), dangling);
    try {
      expect(await runCli(['--version'], { terminal, env: { [STATE_DIRECTORY_VARIABLE]: dangling } })).toBe(0);
    } finally {
      await rm(dangling, { force: true });
    }
  });
});

describe('one task at a time across processes, and the clean-up of what a killed run left', () => {
  const workspace = withWorkspace();
  const shareSite = () => run('folders', 'add', join(workspace.path, 'site'), '--access', 'edit', '--yes');
  const lockFile = () => join(home, 'task.lock');
  const holdLock = async (pid: number) => writeFile(lockFile(), JSON.stringify({ pid, startedAt: 1, token: 'another process' }));

  it('refuses a task given by hand while another process of the runner runs one, and says so', async () => {
    await shareSite();
    await holdLock(process.ppid);
    terminal = new FakeTerminal();
    expect(await run('run', 'site', 'Fix it')).toBe(1);
    expect(terminal.stderr).toEqual([expect.stringContaining('The task was not run: Another runner process on this machine is running a task.')]);
    expect(agent.requests).toEqual([]);
    expect(isolation.sweeps).toBe(0);
    expect(JSON.parse(await readFile(lockFile(), 'utf8')).pid).toBe(process.ppid);
  });

  it('runs a task by hand when the lock was left by a process that is gone, and leaves no lock behind', async () => {
    await shareSite();
    await holdLock(2_147_483_646);
    terminal = new FakeTerminal();
    expect(await run('run', 'site', 'Fix it')).toBe(0);
    await expect(stat(lockFile())).rejects.toThrow(/ENOENT/);
    expect((await readdir(home)).sort()).toEqual(['policy.json']);
  });

  it('holds the lock while it runs, so that a second run in another terminal is refused', async () => {
    await shareSite();
    terminal = new FakeTerminal();
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    agent.script = async function* () {
      yield { kind: 'text', text: 'Working' };
      await released;
      yield { kind: 'result', text: 'Done.' };
    };
    const first = run('run', 'site', 'The first');
    await eventually(() => expect(terminal.stdout).toContain('Working'));
    expect(JSON.parse(await readFile(lockFile(), 'utf8')).pid).toBe(process.pid);

    const other = new FakeTerminal();
    expect(await runCli(['run', 'site', 'The second'], { terminal: other, env: { [STATE_DIRECTORY_VARIABLE]: home }, agents: { 'claude-code': agent }, isolation })).toBe(1);
    expect(other.stderr).toEqual([expect.stringContaining('The task was not run: Another runner process on this machine is running a task.')]);

    release();
    expect(await first).toBe(0);
    await expect(stat(lockFile())).rejects.toThrow(/ENOENT/);
  });

  it('refuses what the office offers while a task given by hand runs in another process, and takes the next one after', async () => {
    await pairMachineAndShare();
    terminal = new FakeTerminal();
    const running = run('start');
    await eventually(() => expect(office.sockets[0]?.messages.map((message) => message.type)).toContain('hello'));
    const socket = office.sockets[0]!;
    await holdLock(process.ppid);
    socket.send({ type: 'task.offer', taskId: 'task-1', folder: 'site', agent: null, instruction: 'Fix it' });
    await eventually(() => expect(socket.messages).toContainEqual({ type: 'task.reject', taskId: 'task-1', reason: 'busy', message: expect.stringContaining('Another runner process on this machine is running a task.') }));
    await rm(lockFile());
    socket.send({ type: 'task.offer', taskId: 'task-2', folder: 'site', agent: null, instruction: 'Fix it' });
    await eventually(() => expect(types(socket.messages)).toContain('task.done'));
    terminal.pressCtrlC();
    expect(await running).toBe(0);
  });

  async function pairMachineAndShare() {
    await run('pair', office.origin, 'ABCDEFGH', '--yes', '--name', 'Test laptop');
    await shareSite();
  }

  it('cleans up before a task given by hand, and says what it did', async () => {
    await shareSite();
    isolation.sweepResult = { copies: 1, branches: 1 };
    terminal = new FakeTerminal();
    expect(await run('run', 'site', 'Fix it')).toBe(0);
    expect(isolation.sweeps).toBe(1);
    expect(terminal.stdout[0]).toBe('Cleaned up what an earlier run left behind when it was stopped abruptly: one copy of a folder, and one branch with nothing on it.');
  });

  it('says nothing of a clean-up that found nothing to do, and goes on when it fails', async () => {
    await shareSite();
    terminal = new FakeTerminal();
    await run('run', 'site', 'Fix it');
    expect(terminal.stdout.join('\n')).not.toContain('Cleaned up');

    isolation.sweep = () => Promise.reject(new Error('the disk is full'));
    terminal = new FakeTerminal();
    expect(await run('run', 'site', 'Fix it')).toBe(0);
    expect(terminal.stderr).toEqual(['Cleaning up what an earlier run left behind failed: the disk is full']);
  });

  it('cleans up when it starts, before it connects', async () => {
    await pairMachineAndShare();
    isolation.sweepResult = { copies: 2, branches: 0 };
    terminal = new FakeTerminal();
    const running = run('start');
    await eventually(() => expect(office.sockets).toHaveLength(1));
    expect(terminal.stdout).toContain('Cleaned up what an earlier run left behind when it was stopped abruptly: 2 copies of folders.');
    expect(terminal.stdout.indexOf('Cleaned up what an earlier run left behind when it was stopped abruptly: 2 copies of folders.')).toBeLessThan(terminal.stdout.findIndex((line) => line.startsWith('connecting to')));
    terminal.pressCtrlC();
    await running;
  });

  it('takes away, with real git, the copy and the empty branch of a task that was killed, and leaves the work of one that was not', async () => {
    const repository = join(workspace.path, 'site');
    await createRepository(repository, { 'README.md': 'Hello\n' });
    const env = { [STATE_DIRECTORY_VARIABLE]: home, PATH: process.env.PATH ?? '' };
    expect(await runCli(['folders', 'add', repository, '--access', 'edit', '--yes'], { terminal, env, agents: { 'claude-code': agent } })).toBe(0);

    // A runner that was killed in the middle of two tasks: one that did nothing, and one that committed something.
    const realHome = await realpath(home);
    const { createGitIsolation } = await import('./infrastructure/git-isolation.ts');
    const { runProcess } = await import('./infrastructure/run-process.ts');
    const killed = createGitIsolation({
      surroundings: { home: await realpath(homedir()), stateDirectory: realHome, worktreesDirectory: `${realHome}-worktrees`, windows: false },
      exec: runProcess,
      environment: env,
    });
    const folder = { label: 'site', path: repository, realPath: await realpath(repository), access: 'edit', approval: 'auto', isolation: 'worktree', trusted: false, agent: null } as const;
    await killed.prepare(folder, 'killed-empty', neverAborted());
    const worked = await killed.prepare(folder, 'killed-worked', neverAborted());
    await writeFile(join(worked.folder, 'work.txt'), 'the work\n');
    await plainGit(worked.folder, 'add', '-A');
    await plainGit(worked.folder, 'commit', '--quiet', '-m', 'work');
    expect((await readdir(`${home}-worktrees`)).sort()).toEqual(['killed-empty', 'killed-empty.json', 'killed-worked', 'killed-worked.json']);

    terminal = new FakeTerminal();
    expect(await runCli(['run', 'site', 'Edit the README'], { terminal, env, agents: { 'claude-code': agent } })).toBe(0);

    expect(terminal.stdout[0]).toBe('Cleaned up what an earlier run left behind when it was stopped abruptly: 2 copies of folders, and one branch with nothing on it.');
    const branches = (await plainGit(repository, 'branch', '--list', 'escritoriio/*', '--format=%(refname:short)')).split('\n').filter(Boolean);
    expect(branches.some((branch) => branch === 'escritoriio/killed-worked')).toBe(true);
    expect(branches.some((branch) => branch === 'escritoriio/killed-empty')).toBe(false);
    expect(await plainGit(repository, 'show', 'escritoriio/killed-worked:work.txt')).toBe('the work\n');
    expect(await readdir(`${home}-worktrees`)).toEqual([]);
  }, 60_000);
});

describe('doctor', () => {
  const pair = () => run('pair', office.origin, 'ABCDEFGH', '--yes', '--name', 'Test laptop');

  it('looks at the machine, in words, and ends with 0 when nothing fails', async () => {
    await pair();
    terminal = new FakeTerminal();
    expect(await run('doctor')).toBe(0);
    const shown = terminal.stdout.join('\n');
    expect(shown).toContain('[ok  ] Runner:');
    expect(shown).toContain('[ok  ] Coding agents: Ready: claude-code.');
    expect(shown).toContain(`[ok  ] Connection: ${host()} answered.`);
    expect(shown).toContain('[ok  ] Clock:');
    expect(shown).toContain('[warn] Folders: No folder is shared yet');
    expect(terminal.stdout.at(-1)).toBe('Nothing is failing.');
    expect(terminal.stderr).toEqual([]);
    expect(terminal.shown).not.toContain(FAKE_TOKEN);
  });

  it('ends with 1 when something fails, and says which, without opening the socket of the device', async () => {
    await pair();
    office.minRunnerVersion = '99.0.0';
    terminal = new FakeTerminal();
    expect(await run('doctor')).toBe(1);
    expect(terminal.stdout.join('\n')).toMatch(/\[FAIL\] Version: This runner is .* and the office needs 99\.0\.0 or newer/);
    expect(terminal.stdout.at(-1)).toBe('Something is failing: see the lines marked FAIL.');
    expect(office.sockets).toEqual([]);
  });

  it('says that the machine is not paired, and ends with 0, since nothing is failing', async () => {
    expect(await run('doctor')).toBe(0);
    expect(terminal.stdout.join('\n')).toContain('[warn] Connection: This machine is not paired');
  });

  it('takes out of what it says what looks like a key', async () => {
    agent.detection = { ...agent.detection, installed: false, problem: 'Failed with ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv' };
    expect(await run('doctor')).toBe(1);
    expect(terminal.shown).not.toContain('sk-ant-api03');
    expect(terminal.stdout.join('\n')).toContain('[secret removed]');
  });
});

describe('start, with another runner of the same device on this machine', () => {
  const pair = () => run('pair', office.origin, 'ABCDEFGH', '--yes', '--name', 'Test laptop');

  it('refuses to connect a second time, says so, and leaves the first one connected', async () => {
    await pair();
    terminal = new FakeTerminal();
    const first = terminal;
    const running = run('start');
    await eventually(() => expect(first.stdout.join('\n')).toContain('connected to'));

    terminal = new FakeTerminal();
    expect(await run('start')).toBe(1);
    expect(terminal.stderr).toEqual([expect.stringMatching(/Another runner of this machine is connected to the office already \(the app, or the command line\)\. Only one connects at a time: stop that one first\./)]);
    expect(office.sockets).toHaveLength(1);
    expect(first.stderr).toEqual([]);

    first.pressCtrlC();
    expect(await running).toBe(0);
  });
});

describe('start, stopped while it is still getting ready', () => {
  it('ends with 0 on Ctrl-C while it cleans up, and never connects', async () => {
    await run('pair', office.origin, 'ABCDEFGH', '--yes', '--name', 'Test laptop');
    terminal = new FakeTerminal();
    let sweeping = false;
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    isolation.sweep = async () => {
      sweeping = true;
      await gate;
      return { copies: 0, branches: 0 };
    };
    const running = run('start');
    await eventually(() => expect(sweeping).toBe(true));
    terminal.pressCtrlC();
    finish();
    expect(await running).toBe(0);
    expect(terminal.stdout.at(-1)).toBe('stopped');
    expect(office.sockets).toEqual([]);
  });
});

describe('start, with a folder that asks before each task', () => {
  const workspace = withWorkspace();
  const setUp = async () => {
    await run('pair', office.origin, 'ABCDEFGH', '--yes', '--name', 'Test laptop');
    await run('folders', 'add', join(workspace.path, 'site'), '--access', 'edit', '--approval', 'ask', '--yes');
    terminal = new FakeTerminal();
  };
  const connect = async () => {
    const running = run('start');
    await eventually(() => expect(office.sockets).toHaveLength(1));
    await eventually(() => expect(terminal.stdout.join('\n')).toContain('connected to'));
    return { running, socket: office.sockets[0]! };
  };
  const types = (messages: readonly { type: string }[]) => messages.map((message) => message.type);

  it('takes the task, tells the office it waits, shows the exact text at the terminal and runs it on a yes', async () => {
    await setUp();
    terminal.answers = ['y'];
    const { running, socket } = await connect();
    socket.send({ type: 'task.offer', taskId: 'task-1', folder: 'site', agent: null, instruction: 'Delete every test' });
    await eventually(() => expect(types(socket.messages)).toContain('task.done'));
    expect(types(socket.messages).slice(1)).toEqual(['task.accept', 'task.event', 'task.done']);
    expect(socket.messages[2]).toMatchObject({ type: 'task.event', event: { kind: 'text', text: 'Waiting for its owner to approve this task on their machine.' } });
    expect(terminal.stdout.join('\n')).toContain('The folder "site" (edit) asks you to approve each task. The office asks for this one. This is the exact text the coding agent would be given:\n\nDelete every test\n');
    expect(terminal.questions).toEqual(['Approve it and run it? [y/N] ']);
    expect(agent.requests).toHaveLength(1);
    terminal.pressCtrlC();
    expect(await running).toBe(0);
  });

  it('ends the task as failed, and runs nothing, on anything but a yes', async () => {
    await setUp();
    terminal.answers = ['n'];
    const { running, socket } = await connect();
    socket.send({ type: 'task.offer', taskId: 'task-1', folder: 'site', agent: null, instruction: 'Delete every test' });
    await eventually(() => expect(types(socket.messages)).toContain('task.failed'));
    expect(socket.messages.at(-1)).toMatchObject({ type: 'task.failed', reason: 'cancelled', message: 'Its owner did not approve this task on their machine, so it was not run.' });
    expect(agent.requests).toEqual([]);
    terminal.pressCtrlC();
    expect(await running).toBe(0);
  });

  it('takes the question away, and ends the task, when the runner is stopped while the person is asked', async () => {
    await setUp();
    terminal.holding = true;
    const { running, socket } = await connect();
    socket.send({ type: 'task.offer', taskId: 'task-1', folder: 'site', agent: null, instruction: 'Delete every test' });
    await eventually(() => expect(terminal.questions).toHaveLength(1));
    terminal.pressCtrlC();
    expect(await running).toBe(0);
    expect(terminal.stdout.join('\n')).toContain('stopping: the task that runs is being stopped first');
    expect(terminal.stdout.join('\n')).toContain('The question is no longer needed');
    expect(agent.requests).toEqual([]);
  });
});
