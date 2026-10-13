import { describe, expect, it } from 'vitest';
import { detectClaudeCode, isAtLeast, MINIMUM_VERSION, parseVersion } from './detect.ts';
import type { DetectDeps } from './detect.ts';
import type { Exec, ExecResult } from './system.ts';

const HOME = '/Users/ana';
const LOGGED_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' });
const LOGGED_IN = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' });

/** The programs of a machine: what each prints when it is asked, keyed by the command line. */
class Machine {
  readonly asked: string[] = [];
  readonly answers = new Map<string, ExecResult>();
  readonly executables = new Set<string>();

  has(path: string, version = '2.1.250 (Claude Code)', status: ExecResult = { stdout: LOGGED_IN, exitCode: 0 }): this {
    this.executables.add(path);
    this.answers.set(`${path} --version`, { stdout: `${version}\n`, exitCode: 0 });
    this.answers.set(`${path} auth status`, status);
    return this;
  }

  prints(command: string, answer: ExecResult): this {
    this.answers.set(command, answer);
    return this;
  }

  exec: Exec = (file, args) => {
    const command = [file, ...args].join(' ');
    this.asked.push(command);
    return Promise.resolve(this.answers.get(command) ?? { stdout: '', exitCode: null });
  };

  deps(overrides: Partial<DetectDeps> = {}): DetectDeps {
    return { exec: this.exec, isExecutable: (path) => Promise.resolve(this.executables.has(path)), platform: 'darwin', home: HOME, shell: '/bin/zsh', searchPath: '/usr/local/bin:/usr/bin:/bin', ...overrides };
  }
}

const LOOKUP = '/bin/zsh -lc command -v claude';

describe('versions', () => {
  it('are read from what `claude --version` prints', () => {
    expect(parseVersion('2.1.250 (Claude Code)')).toEqual([2, 1, 250]);
    expect(parseVersion('Claude Code v3.0.1\n')).toEqual([3, 0, 1]);
    expect(parseVersion('no version here')).toBeUndefined();
    expect(parseVersion('')).toBeUndefined();
  });

  it('are compared as numbers, not as text', () => {
    const minimum = MINIMUM_VERSION;
    expect(isAtLeast([2, 1, 248], minimum)).toBe(true);
    expect(isAtLeast([2, 1, 250], minimum)).toBe(true);
    expect(isAtLeast([2, 1, 25], minimum)).toBe(false);
    expect(isAtLeast([2, 1, 247], minimum)).toBe(false);
    expect(isAtLeast([2, 2, 0], minimum)).toBe(true);
    expect(isAtLeast([10, 0, 0], minimum)).toBe(true);
    expect(isAtLeast([1, 99, 999], minimum)).toBe(false);
  });
});

describe('finding Claude Code on a machine', () => {
  it('finds it where the login shell of the person says, which a desktop program started from the Dock could not know', async () => {
    const machine = new Machine().has('/Users/ana/.nvm/versions/node/v22/bin/claude').prints(LOOKUP, { stdout: '/Users/ana/.nvm/versions/node/v22/bin/claude\n', exitCode: 0 });
    expect(await detectClaudeCode(undefined, machine.deps())).toEqual({
      installed: true,
      path: '/Users/ana/.nvm/versions/node/v22/bin/claude',
      version: '2.1.250',
      loggedIn: true,
      supported: true,
      problem: undefined,
      containment: 'sandbox',
    });
  });

  it('asks the shell as a login shell and not an interactive one, for a fixed command, with a short time', async () => {
    const asked: { file: string; args: readonly string[]; timeout: number }[] = [];
    const exec: Exec = (file, args, timeout) => {
      asked.push({ file, args, timeout });
      return Promise.resolve({ stdout: '', exitCode: null });
    };
    await detectClaudeCode(undefined, new Machine().deps({ exec, shell: '/bin/zsh' }));
    expect(asked[0]).toEqual({ file: '/bin/zsh', args: ['-lc', 'command -v claude'], timeout: expect.any(Number) });
    expect(asked[0]?.timeout).toBeLessThanOrEqual(10_000);
    expect(asked[0]?.args).not.toContain('-i');
  });

  it('takes the last path that the shell printed: what a profile says as it starts is not the answer', async () => {
    const machine = new Machine().has('/opt/homebrew/bin/claude').prints(LOOKUP, { stdout: 'Welcome back, Ana\n/some/path/that/is/noise\nalias claude=something\n/opt/homebrew/bin/claude\n', exitCode: 0 });
    expect((await detectClaudeCode(undefined, machine.deps())).path).toBe('/opt/homebrew/bin/claude');
  });

  it('asks /bin/sh when the person has no shell set', async () => {
    const machine = new Machine().has('/usr/local/bin/claude').prints('/bin/sh -lc command -v claude', { stdout: '/usr/local/bin/claude\n', exitCode: 0 });
    expect((await detectClaudeCode(undefined, machine.deps({ shell: undefined }))).path).toBe('/usr/local/bin/claude');
  });

  it.each(['/Users/ana/.local/bin/claude', '/Users/ana/.claude/local/claude', '/usr/local/bin/claude', '/opt/homebrew/bin/claude'])('looks in the usual place %s when the shell does not know it', async (path) => {
    const machine = new Machine().has(path);
    expect((await detectClaudeCode(undefined, machine.deps())).path).toBe(path);
  });

  it('goes on to the next when the first is not a program that says its version', async () => {
    const machine = new Machine().has('/usr/local/bin/claude').prints(LOOKUP, { stdout: '/Users/ana/old/claude\n', exitCode: 0 });
    machine.executables.add('/Users/ana/old/claude');
    expect((await detectClaudeCode(undefined, machine.deps())).path).toBe('/usr/local/bin/claude');
  });

  it('uses the program the owner chose, and no other', async () => {
    const machine = new Machine().has('/opt/tools/claude', '2.1.260 (Claude Code)').has('/Users/ana/.local/bin/claude');
    const found = await detectClaudeCode('/opt/tools/claude', machine.deps());
    expect(found).toMatchObject({ installed: true, path: '/opt/tools/claude', version: '2.1.260' });
    expect(machine.asked.some((command) => command.startsWith('/bin/zsh'))).toBe(false);
  });

  it('does not look elsewhere when what the owner chose is not a program that can be run', async () => {
    const machine = new Machine().has('/Users/ana/.local/bin/claude');
    expect(await detectClaudeCode('/opt/tools/missing', machine.deps())).toMatchObject({ installed: false, path: undefined, problem: expect.stringContaining('you chose') });
    machine.executables.add('/opt/tools/not-claude');
    expect(await detectClaudeCode('/opt/tools/not-claude', machine.deps())).toMatchObject({ installed: false });
  });

  it('says in words that it is not there, and what can be done', async () => {
    const found = await detectClaudeCode(undefined, new Machine().deps());
    expect(found).toEqual({ installed: false, path: undefined, version: undefined, loggedIn: null, supported: false, problem: expect.stringContaining('Install it, or choose where it is'), containment: 'sandbox' });
  });
});

describe('what Claude Code is, once it is found', () => {
  const found = (machine: Machine) => detectClaudeCode(undefined, machine.deps());

  it('is not supported when it is older than the first version that does what the runner asks, and says to update', async () => {
    const detected = await found(new Machine().has('/usr/local/bin/claude', '2.1.247 (Claude Code)'));
    expect(detected).toMatchObject({ installed: true, version: '2.1.247', supported: false });
    expect(detected.problem).toContain('Update it');
    expect(detected.problem).toContain('2.1.248');
  });

  it('is supported from that version on, and a newer one is too', async () => {
    expect(await found(new Machine().has('/usr/local/bin/claude', '2.1.248 (Claude Code)'))).toMatchObject({ supported: true, problem: undefined });
    expect(await found(new Machine().has('/usr/local/bin/claude', '2.2.0 (Claude Code)'))).toMatchObject({ supported: true });
  });

  it('is not logged in when it says so, though it ends with an error when it does', async () => {
    const machine = new Machine().has('/usr/local/bin/claude', '2.1.250 (Claude Code)', { stdout: LOGGED_OUT, exitCode: 1 });
    expect(await found(machine)).toMatchObject({ installed: true, loggedIn: false, supported: true });
  });

  it.each([
    ['nothing', { stdout: '', exitCode: null }],
    ['text', { stdout: 'Not logged in. Run claude to log in.', exitCode: 1 }],
    ['JSON of another shape', { stdout: '{"ok":true}', exitCode: 0 }],
    ['JSON that is not an object', { stdout: '"yes"', exitCode: 0 }],
    ['null', { stdout: 'null', exitCode: 0 }],
    ['a login that is not true or false', { stdout: '{"loggedIn":"yes"}', exitCode: 0 }],
  ])('does not know whether somebody is logged in when it says %s', async (_what, status) => {
    expect(await found(new Machine().has('/usr/local/bin/claude', '2.1.250 (Claude Code)', status))).toMatchObject({ installed: true, loggedIn: null });
  });

  describe('what contains it', () => {
    const contained = (machine: Machine, overrides: Partial<DetectDeps>) => detectClaudeCode(undefined, machine.deps(overrides));
    const installed = () => new Machine().has('/usr/local/bin/claude');

    it('is the sandbox of macOS, which needs nothing installed', async () => {
      expect(await contained(installed(), { platform: 'darwin' })).toMatchObject({ containment: 'sandbox', problem: undefined });
    });

    it('is the sandbox of Linux when the two programs it needs are on the PATH that Claude Code is given', async () => {
      const machine = installed();
      machine.executables.add('/usr/bin/bwrap').add('/usr/local/bin/socat');
      expect(await contained(machine, { platform: 'linux' })).toMatchObject({ containment: 'sandbox', problem: undefined });
    });

    it.each([
      ['bubblewrap', ['/usr/bin/socat']],
      ['socat', ['/usr/bin/bwrap']],
      ['bubblewrap and socat', []],
    ])('is none on Linux, and says what to install, when %s is missing', async (missing, present) => {
      const machine = installed();
      for (const path of present) machine.executables.add(path);
      const found = await contained(machine, { platform: 'linux' });
      expect(found).toMatchObject({ installed: true, supported: true, containment: 'none' });
      expect(found.problem).toContain(`${missing} could not be found`);
      expect(found.problem).toContain('not marked as trusted');
    });

    it('looks for those programs only where Claude Code is told to look, and not anywhere else on the machine', async () => {
      const machine = installed();
      machine.executables.add('/opt/bwrap-here/bwrap').add('/opt/bwrap-here/socat');
      expect(await contained(machine, { platform: 'linux', searchPath: '/usr/bin' })).toMatchObject({ containment: 'none' });
      expect(await contained(machine, { platform: 'linux', searchPath: '/usr/bin:/opt/bwrap-here' })).toMatchObject({ containment: 'sandbox' });
      expect(await contained(machine, { platform: 'linux', searchPath: undefined })).toMatchObject({ containment: 'none' });
    });

    it('is none on Windows, which has no sandbox, and says so', async () => {
      const windows = new Machine().has('C:\\Users\\ana\\.local\\bin\\claude.exe');
      const found = await contained(windows, { platform: 'win32', home: 'C:\\Users\\ana' });
      expect(found).toMatchObject({ installed: true, path: 'C:\\Users\\ana\\.local\\bin\\claude.exe', containment: 'none', problem: expect.stringContaining('no sandbox on Windows') });
    });

    it('says both, when the version is too old and there is no sandbox', async () => {
      const found = await contained(new Machine().has('/usr/local/bin/claude', '2.1.100 (Claude Code)'), { platform: 'linux' });
      expect(found.supported).toBe(false);
      expect(found.problem).toContain('Update it');
      expect(found.problem).toContain('could not be found');
    });

    it('is told even when Claude Code is not there, with no word of the sandbox in what is said', async () => {
      const found = await detectClaudeCode(undefined, new Machine().deps({ platform: 'linux' }));
      expect(found).toMatchObject({ installed: false, containment: 'none', problem: expect.stringContaining('Install it, or choose where it is') });
      expect(found.problem).not.toContain('sandbox');
    });
  });

  it('is looked for with `where` on Windows, and only a program is taken, not a script that starts it', async () => {
    const machine = new Machine().has('C:\\Tools\\claude.exe').prints('where claude', { stdout: 'C:\\npm\\claude.cmd\r\nC:\\Tools\\claude.exe\r\n', exitCode: 0 });
    expect((await detectClaudeCode(undefined, machine.deps({ platform: 'win32', home: 'C:\\Users\\ana' }))).path).toBe('C:\\Tools\\claude.exe');
    const onlyScript = new Machine().prints('where claude', { stdout: 'C:\\npm\\claude.cmd\r\n', exitCode: 0 });
    expect(await detectClaudeCode(undefined, onlyScript.deps({ platform: 'win32', home: 'C:\\Users\\ana' }))).toMatchObject({ installed: false, problem: expect.stringContaining('claude.exe') });
  });

  it('does not throw, whatever goes wrong: it is not installed, in words', async () => {
    const broken: Exec = () => Promise.reject(new Error('spawn exploded'));
    const detected = await detectClaudeCode(undefined, new Machine().deps({ exec: broken }));
    expect(detected).toMatchObject({ installed: false, supported: false, loggedIn: null });
    expect(detected.problem).toBeTruthy();
    const refusing = new Machine().deps({ isExecutable: () => Promise.reject(new Error('EACCES')) });
    expect(await detectClaudeCode('/x', refusing)).toMatchObject({ installed: false });
  });
});
