import { describe, expect, it } from 'vitest';
import { parseCommandLine, USAGE } from './command-line.ts';

describe('the command line', () => {
  it.each([
    [['--help'], { name: 'help' }],
    [['-h'], { name: 'help' }],
    [[], { name: 'help' }],
    [['--version'], { name: 'version' }],
    [['-v'], { name: 'version' }],
    [['start'], { name: 'start' }],
    [['status'], { name: 'status' }],
    [['doctor'], { name: 'doctor' }],
  ])('reads %j', (argv, command) => {
    expect(parseCommandLine(argv)).toEqual({ ok: true, command });
  });

  it('reads pair with a server and a code', () => {
    expect(parseCommandLine(['pair', 'office.example.com', 'ABCD-EFGH'])).toEqual({ ok: true, command: { name: 'pair', input: ['office.example.com', 'ABCD-EFGH'], deviceName: undefined, yes: false } });
  });

  it('reads pair with a link, which has the characters a shell makes much of', () => {
    const link = 'escritoriio://pair?server=https%3A%2F%2Foffice.example.com&code=ABCDEFGH';
    expect(parseCommandLine(['pair', link])).toMatchObject({ ok: true, command: { name: 'pair', input: [link] } });
  });

  it('reads the options of pair wherever they are', () => {
    const expected = { ok: true, command: { name: 'pair', input: ['office.example.com', 'ABCDEFGH'], deviceName: 'Ana desktop', yes: true } };
    expect(parseCommandLine(['pair', 'office.example.com', 'ABCDEFGH', '--name', 'Ana desktop', '--yes'])).toEqual(expected);
    expect(parseCommandLine(['pair', '-y', '--name=Ana desktop', 'office.example.com', 'ABCDEFGH'])).toEqual(expected);
  });

  it.each([
    ['a command that is not one', ['dance']],
    ['an option that is not one', ['start', '--fast']],
    ['an option without its value', ['pair', 'office.example.com', 'ABCDEFGH', '--name']],
    ['options of pair for another command', ['start', '--yes']],
    ['more than start takes', ['start', 'now']],
    ['more than status takes', ['status', 'now']],
    ['more than doctor takes', ['doctor', 'now']],
  ])('refuses %s', (_name, argv) => {
    const parsed = parseCommandLine(argv);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.error).not.toBe('');
  });

  it('has a usage text that lists every command', () => {
    for (const command of ['pair', 'start', 'status', '--help', '--version', '--name', '--yes']) expect(USAGE).toContain(command);
  });
});

describe('sharing a folder from the command line', () => {
  const added = { name: 'folders-add', path: '/work/site', label: undefined, access: 'read-only', approval: 'auto', isolation: 'worktree', trusted: false, agent: null, yes: false };

  it('is read-only, in a copy, and without asking each time, unless it is said otherwise: the narrowest', () => {
    expect(parseCommandLine(['folders', 'add', '/work/site'])).toEqual({ ok: true, command: added });
  });

  it('may be given edit, which is a choice of its own', () => {
    expect(parseCommandLine(['folders', 'add', '/work/site', '--access', 'edit'])).toEqual({ ok: true, command: { ...added, access: 'edit' } });
  });

  it('says in its usage that edit gives a shell, and what contains it', () => {
    expect(USAGE).toMatch(/edit lets it read\s+and change files, and run commands in a shell, inside the sandbox of your operating system/);
  });
});

describe('making a workspace from the command line', () => {
  const made = { name: 'folders-new', parent: '/work', folderName: 'build', label: undefined, approval: 'auto', trusted: false, agent: null, yes: false };

  it('is the folder to make it in and the name of the new one, without asking each time unless it is said otherwise', () => {
    expect(parseCommandLine(['folders', 'new', '/work', 'build'])).toEqual({ ok: true, command: made });
  });

  it('may be labelled, trusted, given an agent and a way of approving, and may skip the question', () => {
    expect(parseCommandLine(['folders', 'new', '/work', 'build', '--label', 'Desk', '--approval', 'ask', '--trusted', '--agent', 'claude-code', '--yes'])).toEqual({
      ok: true,
      command: { ...made, label: 'Desk', approval: 'ask', trusted: true, agent: 'claude-code', yes: true },
    });
  });

  it.each([
    [['folders', 'new'], /needs the folder to make it in and the name/],
    [['folders', 'new', '/work'], /needs the folder to make it in and the name/],
    [['folders', 'new', '/work', 'build', 'extra'], /takes nothing more/],
    [['folders', 'new', '/work', 'build', '--access', 'edit'], /--access is an option of folders add, not of folders new/],
    [['folders', 'new', '/work', 'build', '--isolation', 'in-place'], /--isolation is an option of folders add, not of folders new/],
    [['folders', 'new', '/work', 'build', '--approval', 'sometimes'], /--approval is one of/],
    [['folders', 'new', '/work', 'build', '--agent', 'nobody'], /--agent is one of/],
  ])('refuses %j', (argv, error) => {
    const parsed = parseCommandLine(argv);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.error).toMatch(error);
  });

  it('says in its usage what a workspace is and what is asked of the person', () => {
    expect(USAGE).toMatch(/folders new <parent folder> <name>/);
    expect(USAGE).toMatch(/clone git repositories, each of which you approve on this machine/);
  });
});

describe('running a task from the command line', () => {
  const run = (...argv: string[]) => parseCommandLine(['run', ...argv]);
  const task = (folder: string, instruction: string, more: { agent?: string | null; approve?: boolean } = {}) => ({ ok: true, command: { name: 'run', folder, instruction, agent: more.agent ?? null, approve: more.approve ?? false } });

  it('is a folder and an instruction, said with quotes or without', () => {
    expect(run('site', 'Fix the typo')).toEqual(task('site', 'Fix the typo'));
    expect(run('site', 'Fix', 'the', 'typo')).toEqual(task('site', 'Fix the typo'));
  });

  it('has its options before the instruction, wherever before', () => {
    expect(run('--approve', 'site', 'fix', 'it')).toEqual(task('site', 'fix it', { approve: true }));
    expect(run('site', '--approve', '--agent', 'claude-code', 'fix', 'it')).toEqual(task('site', 'fix it', { approve: true, agent: 'claude-code' }));
    expect(run('--agent=claude-code', 'site', 'fix it')).toEqual(task('site', 'fix it', { agent: 'claude-code' }));
  });

  it.each([
    ['a flag that is the version', ['site', 'explain', 'the', '-v', 'flag'], 'explain the -v flag'],
    ['a flag that is the help', ['site', 'what', 'does', '-h', 'do'], 'what does -h do'],
    ['an option of run', ['site', 'fix', 'it', '--approve'], 'fix it --approve'],
    ['an option of run with a value', ['site', 'fix', '--agent', 'codex', 'now'], 'fix --agent codex now'],
    ['an option that is no option', ['site', 'remove', '--force', 'and', '-rf'], 'remove --force and -rf'],
    ['a long word that begins with two dashes, alone', ['site', 'run', '--', 'again'], 'run -- again'],
  ])('keeps %s, after the first word of the instruction, as part of it', (_what, words, instruction) => {
    expect(run(...words)).toEqual(task('site', instruction));
  });

  it('keeps them with the options that came before the instruction, which still count', () => {
    expect(run('--approve', 'site', 'explain', '-v')).toEqual(task('site', 'explain -v', { approve: true }));
    expect(run('--agent', 'claude-code', 'site', 'fix', '-h')).toEqual(task('site', 'fix -h', { agent: 'claude-code' }));
  });

  it('may begin with a word that has a dash when the options are ended with two', () => {
    expect(run('site', '--', '--weird', 'thing')).toEqual(task('site', '--weird thing'));
    expect(run('--', 'site', '-v', 'is', 'a', 'flag')).toEqual(task('site', '-v is a flag'));
    expect(run('--approve', 'site', '--', '-v')).toEqual(task('site', '-v', { approve: true }));
  });

  it('is the help or the version when they are asked for before the instruction', () => {
    expect(run('-h')).toEqual({ ok: true, command: { name: 'help' } });
    expect(run('site', '--help')).toEqual({ ok: true, command: { name: 'help' } });
    expect(run('-v', 'site')).toEqual({ ok: true, command: { name: 'version' } });
  });

  it('refuses an option that is not one, before the instruction, where it is a mistake', () => {
    expect(run('site', '--aprove', 'fix it')).toMatchObject({ ok: false });
    expect(run('--agent', 'gpt', 'site', 'fix it')).toMatchObject({ ok: false, error: expect.stringContaining('--agent is one of') });
  });

  it('needs a folder and an instruction', () => {
    expect(run('site')).toMatchObject({ ok: false });
    expect(run('site', '--approve')).toMatchObject({ ok: false });
    expect(run()).toMatchObject({ ok: false });
    expect(run('site', '   ')).toMatchObject({ ok: false });
  });

  it('says in its usage that the instruction is not read for options', () => {
    expect(USAGE).toContain('run site explain the -v flag');
    expect(USAGE).toContain('they go before the instruction');
  });
});

describe('setting up a local MCP server from the command line', () => {
  const add = (...argv: string[]) => parseCommandLine(['mcp', 'add', ...argv]);
  const server = (label: string, command: string, args: string[], more: { env?: string[]; folder?: string | null; yes?: boolean } = {}) => ({
    ok: true,
    command: { name: 'mcp-add', label, command, args, env: more.env ?? [], folder: more.folder ?? null, yes: more.yes ?? false },
  });

  it('is a label and what to run, after two dashes', () => {
    expect(add('notes', '--', 'npx', '-y', 'some-server', '--stdio')).toEqual(server('notes', 'npx', ['-y', 'some-server', '--stdio']));
    expect(add('notes', '--', 'notes-server')).toEqual(server('notes', 'notes-server', []));
  });

  it('keeps everything after the two dashes as the program and its arguments, the words that look like options of this one included', () => {
    expect(add('notes', '--', 'node', 'server.js', '--yes', '--env', 'A=b', '-h')).toEqual(server('notes', 'node', ['server.js', '--yes', '--env', 'A=b', '-h']));
  });

  it('has its options before the two dashes, wherever before', () => {
    expect(add('notes', '--env', 'API_KEY=k-1', '--env=REGION=eu', '--folder', 'site', '--yes', '--', 'node', 'server.js')).toEqual(server('notes', 'node', ['server.js'], { env: ['API_KEY=k-1', 'REGION=eu'], folder: 'site', yes: true }));
    expect(add('--yes', '--env', 'A=b', 'notes', '--', 'node')).toEqual(server('notes', 'node', [], { env: ['A=b'], yes: true }));
  });

  it.each([
    ['no two dashes, which is how an argument of the program is told from an option of this', ['notes', 'node', 'server.js']],
    ['no label', ['--', 'node']],
    ['no program', ['notes', '--']],
    ['an option that is not one', ['notes', '--fast', '--', 'node']],
    ['an environment without its value', ['notes', '--env', '--', 'node']],
    ['an option of another command', ['notes', '--agent', 'claude-code', '--', 'node']],
    ['more than a label before the two dashes', ['notes', 'more', '--', 'node']],
  ])('refuses %s', (_what, argv) => {
    expect(add(...argv)).toMatchObject({ ok: false });
  });
});

describe('looking after the local MCP servers from the command line', () => {
  const mcp = (...argv: string[]) => parseCommandLine(['mcp', ...argv]);

  it.each([
    [['list'], { name: 'mcp-list' }],
    [['tools', 'notes'], { name: 'mcp-tools', label: 'notes' }],
    [['approve', 'notes'], { name: 'mcp-approve', label: 'notes', tools: [], yes: false }],
    [['approve', 'notes', 'search', 'add', '--yes'], { name: 'mcp-approve', label: 'notes', tools: ['search', 'add'], yes: true }],
    [['deny', 'notes', 'search', 'add'], { name: 'mcp-deny', label: 'notes', tools: ['search', 'add'] }],
    [['remove', 'notes'], { name: 'mcp-remove', label: 'notes' }],
  ])('reads mcp %j', (argv, command) => {
    expect(mcp(...argv)).toEqual({ ok: true, command });
  });

  it.each([
    ['nothing to do', []],
    ['something it does not do', ['restart', 'notes']],
    ['a list that takes more', ['list', 'notes']],
    ['tools without a label', ['tools']],
    ['approve without a label', ['approve']],
    ['deny without a tool', ['deny', 'notes']],
    ['remove without a label', ['remove']],
    ['remove with more than a label', ['remove', 'notes', 'files']],
    ['options of add for another command', ['list', '--env', 'A=b']],
    ['--yes for a command that asks nothing', ['remove', 'notes', '--yes']],
  ])('refuses %s', (_what, argv) => {
    expect(mcp(...argv)).toMatchObject({ ok: false });
  });

  it('has a usage text that lists them, and says that the program, its arguments and its environment stay on the machine', () => {
    for (const words of ['mcp add', 'mcp list', 'mcp tools', 'mcp approve', 'mcp deny', 'mcp remove', '--env', '--folder']) expect(USAGE).toContain(words);
    expect(USAGE).toMatch(/never told to the office/);
  });
});
