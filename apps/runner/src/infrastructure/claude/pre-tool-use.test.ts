import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import type { FolderAccess } from '../../domain/folder-policy.ts';
import { createPreToolUseHook, decideToolUse } from './pre-tool-use.ts';
import type { ToolUseContext } from './pre-tool-use.ts';

const FOLDER = '/Users/ana/work/site';

/** The file system, which says where a path really is: itself, unless a test says a link leads elsewhere. */
function context(overrides: Partial<ToolUseContext> & { readonly links?: Readonly<Record<string, string>> } = {}): ToolUseContext {
  const { links = {}, ...rest } = overrides;
  const resolveReal = (path: string): Promise<string> => {
    for (const [from, to] of Object.entries(links)) if (path === from || path.startsWith(`${from}/`)) return Promise.resolve(to + path.slice(from.length));
    return Promise.resolve(path);
  };
  return { folder: FOLDER, access: 'edit', windows: false, resolveReal, ...rest };
}

const decide = (name: string, input: unknown, overrides?: Parameters<typeof context>[0]) => decideToolUse({ name, input }, context(overrides));

describe('which calls of a tool are allowed', () => {
  describe('files of the folder', () => {
    it.each([
      ['Read', { file_path: `${FOLDER}/README.md` }],
      ['Read', { file_path: 'README.md' }],
      ['Read', { file_path: './src/../src/index.ts' }],
      ['Read', { file_path: FOLDER }],
      ['Glob', { pattern: '**/*.ts' }],
      ['Glob', { pattern: 'src/**/*.{ts,tsx}', path: `${FOLDER}/packages` }],
      ['Grep', { pattern: 'TODO' }],
      ['Grep', { pattern: '^/usr/bin', path: 'src', glob: '*.ts' }],
      ['Edit', { file_path: `${FOLDER}/src/index.ts`, old_string: 'a', new_string: 'b' }],
      ['Write', { file_path: 'docs/new-file.md', content: 'x' }],
    ])('allows %s %j', async (name, input) => {
      expect(await decide(name, input)).toEqual({ allowed: true });
    });

    it.each([
      ['Read', { file_path: '/etc/passwd' }],
      ['Read', { file_path: '/Users/ana/.ssh/id_ed25519' }],
      ['Read', { file_path: '../other/secrets.txt' }],
      ['Read', { file_path: 'src/../../other/secrets.txt' }],
      ['Read', { file_path: `${FOLDER}/../other/secrets.txt` }],
      ['Read', { file_path: '/Users/ana/work/site-two/a.txt' }],
      ['Glob', { pattern: '*', path: '/Users/ana' }],
      ['Grep', { pattern: 'password', path: '..' }],
      ['Edit', { file_path: '/Users/ana/.zshrc', old_string: 'a', new_string: 'b' }],
      ['Write', { file_path: '../escape.txt', content: 'x' }],
    ])('refuses %s %j, for a path outside the folder', async (name, input) => {
      expect(await decide(name, input)).toEqual({ allowed: false, reason: expect.stringContaining('outside the folder') });
    });

    it('refuses a path that is a link inside the folder leading out of it, whatever it is called', async () => {
      const links = { [`${FOLDER}/vendor`]: '/Users/ana/.ssh' };
      expect(await decide('Read', { file_path: 'vendor/id_ed25519' }, { links })).toMatchObject({ allowed: false });
      expect(await decide('Write', { file_path: `${FOLDER}/vendor/authorized_keys`, content: 'x' }, { links })).toMatchObject({ allowed: false });
      expect(await decide('Glob', { pattern: '*', path: 'vendor' }, { links })).toMatchObject({ allowed: false });
    });

    it('allows a link that stays inside the folder, and a folder that is itself reached through a link', async () => {
      expect(await decide('Read', { file_path: 'docs/guide.md' }, { links: { [`${FOLDER}/docs`]: `${FOLDER}/documentation` } })).toEqual({ allowed: true });
      const links = { '/var/work': '/private/var/work' };
      expect(await decideToolUse({ name: 'Read', input: { file_path: 'a.txt' } }, context({ folder: '/var/work/site', links }))).toEqual({ allowed: true });
    });

    it('does not judge what it cannot find out about, and leaves the failure to the hook, which refuses', async () => {
      const failing = context({ resolveReal: () => Promise.reject(new Error('EACCES')) });
      await expect(decideToolUse({ name: 'Read', input: { file_path: 'a.txt' } }, failing)).rejects.toThrow('EACCES');
    });
  });

  describe('paths that a tool might read differently from the way they are read here', () => {
    it.each(['~/.ssh/id_ed25519', '~', '~root/x', ' /etc/passwd', '/etc/passwd ', 'a.txt\n', 'a\x00b.txt', '', '   '])('refuses the path %j', async (file_path) => {
      expect(await decide('Read', { file_path })).toMatchObject({ allowed: false });
    });

    it.each([undefined, null, 3, ['a'], {}])('refuses a path that is %j', async (file_path) => {
      expect(await decide('Read', { file_path })).toMatchObject({ allowed: false });
    });

    it('refuses the path that is not given when the tool needs one, and allows the search that is not given one', async () => {
      expect(await decide('Edit', { old_string: 'a', new_string: 'b' })).toMatchObject({ allowed: false });
      expect(await decide('Grep', { pattern: 'x' })).toEqual({ allowed: true });
      expect(await decide('Glob', { pattern: '*', path: null })).toMatchObject({ allowed: false });
    });

    it('refuses a path of a drive that is not the folder, and one that is relative to a drive', async () => {
      const windows = { folder: 'C:\\Users\\ana\\work\\site', windows: true } as const;
      expect(await decide('Read', { file_path: 'D:\\secrets.txt' }, windows)).toMatchObject({ allowed: false });
      expect(await decide('Read', { file_path: 'C:secrets.txt' }, windows)).toMatchObject({ allowed: false });
      expect(await decide('Read', { file_path: '..\\other\\a.txt' }, windows)).toMatchObject({ allowed: false });
      expect(await decide('Read', { file_path: 'C:\\Users\\ana\\work\\site\\src\\a.ts' }, windows)).toEqual({ allowed: true });
      expect(await decide('Read', { file_path: 'src\\a.ts' }, windows)).toEqual({ allowed: true });
    });
  });

  describe('patterns', () => {
    it.each([
      ['Glob', { pattern: '/etc/*' }],
      ['Glob', { pattern: '../*' }],
      ['Glob', { pattern: '**/../../*' }],
      ['Glob', { pattern: '~/*' }],
      ['Glob', { pattern: '\\\\server\\share\\*' }],
      ['Glob', { pattern: '{src,/etc}/*' }],
      ['Glob', { pattern: 'c:/windows/*' }],
      ['Glob', { pattern: 3 }],
      ['Grep', { pattern: 'x', glob: '/etc/*' }],
      ['Grep', { pattern: 'x', glob: '../**' }],
    ])('refuses %s %j, which points beyond the place it is given', async (name, input) => {
      expect(await decide(name, input)).toMatchObject({ allowed: false });
    });

    it('does not mind what a search looks for, only where', async () => {
      expect(await decide('Grep', { pattern: '/etc/passwd|\\.\\./' })).toEqual({ allowed: true });
    });
  });

  describe('files that Git and Claude Code run by themselves', () => {
    it.each(['.git/config', '.git/hooks/pre-commit', '.git', 'sub/.git/config', '.GIT/config', '.gitmodules', '.claude/settings.json', '.claude/hooks/x.sh', '.mcp.json', `${FOLDER}/.git/HEAD`])('may not be written: %s', async (file_path) => {
      expect(await decide('Write', { file_path, content: 'x' })).toEqual({ allowed: false, reason: expect.stringContaining('Git and Claude Code') });
      expect(await decide('Edit', { file_path, old_string: 'a', new_string: 'b' })).toMatchObject({ allowed: false });
    });

    it('may be read, as any other file is', async () => {
      expect(await decide('Read', { file_path: '.git/config' })).toEqual({ allowed: true });
      expect(await decide('Grep', { pattern: 'url', path: '.git' })).toEqual({ allowed: true });
    });

    it('may not be written through a link inside the folder that leads to them', async () => {
      expect(await decide('Write', { file_path: 'docs/config', content: 'x' }, { links: { [`${FOLDER}/docs`]: `${FOLDER}/.git` } })).toMatchObject({ allowed: false });
    });

    it('are not confused with files whose names only start the same way', async () => {
      expect(await decide('Write', { file_path: '.github/workflows/ci.yml', content: 'x' })).toEqual({ allowed: true });
      expect(await decide('Write', { file_path: '.gitignore', content: 'x' })).toEqual({ allowed: true });
      expect(await decide('Write', { file_path: 'docs/claude.md', content: 'x' })).toEqual({ allowed: true });
    });

    it('may be where the folder itself is: it is what is under the folder that counts', async () => {
      expect(await decideToolUse({ name: 'Write', input: { file_path: 'a.txt', content: 'x' } }, context({ folder: '/Users/ana/.claude/projects/site' }))).toEqual({ allowed: true });
    });
  });

  describe('other ways Windows has of writing the name of a file', () => {
    const windows = { folder: 'C:\\Users\\ana\\work\\site', windows: true } as const;
    const written = (file_path: string, overrides: Parameters<typeof context>[0] = windows) => decide('Write', { file_path, content: 'x' }, overrides);

    it.each(['.git.', '.git...', '.claude.\\settings.json', '.claude \\settings.json', 'sub\\.GIT .\\config', '.mcp.json.', '.gitmodules.', 'C:\\Users\\ana\\work\\site\\.git.\\hooks\\pre-commit'])('does not take a name for another when it only ends in dots or spaces: %s', async (file_path) => {
      expect(await written(file_path)).toMatchObject({ allowed: false });
    });

    it('takes them as different names where the system does not ignore what ends a name', async () => {
      expect(await written('.git.', {})).toEqual({ allowed: true });
      expect(await written('.claude ./x', {})).toEqual({ allowed: true });
    });

    it.each(['GITMOD~1', 'CLAUDE~1\\settings.json', 'src\\PROGRA~1\\a.txt', 'notes~12.txt', 'GIT~1\\config'])('refuses the short form of a name, for reading as for writing: %s', async (file_path) => {
      expect(await written(file_path)).toEqual({ allowed: false, reason: expect.stringContaining('not a path') });
      expect(await decide('Read', { file_path }, windows)).toMatchObject({ allowed: false });
    });

    it('does not mind a tilde that is not the start of a short name', async () => {
      expect(await written('notes~final.txt')).toEqual({ allowed: true });
      expect(await written('$report~final.docx')).toEqual({ allowed: true });
    });

    it.each(['file.txt:stream', 'file.txt::$DATA', 'src\\.git:hidden', 'a.txt:'])('refuses a stream of a file, which is the file: %s', async (file_path) => {
      expect(await written(file_path)).toEqual({ allowed: false, reason: expect.stringContaining('not a path') });
      expect(await decide('Grep', { pattern: 'x', path: file_path }, windows)).toMatchObject({ allowed: false });
    });

    it('does not take the colon after the drive for one of those', async () => {
      expect(await written('C:\\Users\\ana\\work\\site\\src\\a.ts')).toEqual({ allowed: true });
    });

    it('leaves these alone where the system has none of them: a name is only the name it is', async () => {
      expect(await written('a~1.txt', {})).toEqual({ allowed: true });
      expect(await written('a:b.txt', {})).toEqual({ allowed: true });
    });
  });

  describe('commands', () => {
    it.each([
      { command: 'pnpm test' },
      { command: 'ls', run_in_background: false, dangerouslyDisableSandbox: false },
    ])('are allowed in a folder that is edited: %j', async (input) => {
      expect(await decide('Bash', input)).toEqual({ allowed: true });
    });

    it.each([{ dangerouslyDisableSandbox: true }, { dangerouslyDisableSandbox: 'true' }, { dangerouslyDisableSandbox: 1 }])('are not asked to run outside the sandbox: %j', async (extra) => {
      expect(await decide('Bash', { command: 'curl https://example.com', ...extra })).toEqual({ allowed: false, reason: expect.stringContaining('sandbox') });
    });

    it.each([{ run_in_background: true }, { run_in_background: 'yes' }])('are not left running when the task ends: %j', async (extra) => {
      expect(await decide('Bash', { command: 'pnpm dev', ...extra })).toEqual({ allowed: false, reason: expect.stringContaining('nothing may be left running') });
    });

    it.each([{}, { command: '' }, { command: '  ' }, { command: 3 }])('are refused when the call has no command in it: %j', async (input) => {
      expect(await decide('Bash', input)).toMatchObject({ allowed: false });
    });

    it('go along with the file tools in a folder that is edited, each judged by its own rules', async () => {
      expect(await decide('Bash', { command: 'ls' })).toEqual({ allowed: true });
      expect(await decide('Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' })).toEqual({ allowed: true });
      expect(await decide('Write', { file_path: 'a.ts', content: 'x' })).toEqual({ allowed: true });
      expect(await decide('Read', { file_path: 'README.md' })).toEqual({ allowed: true });
      expect(await decide('Read', { file_path: '/etc/passwd' })).toMatchObject({ allowed: false });
      expect(await decide('Write', { file_path: '.git/config', content: 'x' })).toEqual({ allowed: false, reason: expect.stringContaining('Git and Claude Code') });
    });

    it('are refused in a folder that is only read, whatever the call', async () => {
      expect(await decide('Bash', { command: 'ls' }, { access: 'read-only' })).toEqual({ allowed: false, reason: expect.stringContaining('read only') });
    });
  });

  describe('tools', () => {
    it.each(['WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill', 'AskUserQuestion', 'Monitor', 'mcp__server__tool', 'NotebookEdit', 'TodoWrite', ''])('refuses %j, which the task was not given', async (name) => {
      expect(await decide(name, { file_path: `${FOLDER}/a.txt`, url: 'https://example.com' })).toMatchObject({ allowed: false });
    });

    it.each(['Edit', 'Write', 'Bash', 'NotebookEdit'])('refuses %s in a folder shared to be read only, whatever the call', async (name) => {
      const decision = await decide(name, { file_path: `${FOLDER}/a.txt`, notebook_path: `${FOLDER}/a.ipynb`, command: 'ls', content: 'x' }, { access: 'read-only' satisfies FolderAccess });
      expect(decision).toEqual({ allowed: false, reason: expect.stringContaining('read only') });
    });

    it('allows reading in a folder shared to be read only', async () => {
      const readOnly = { access: 'read-only' } as const;
      expect(await decide('Read', { file_path: 'a.txt' }, readOnly)).toEqual({ allowed: true });
      expect(await decide('Glob', { pattern: '*' }, readOnly)).toEqual({ allowed: true });
      expect(await decide('Grep', { pattern: 'x' }, readOnly)).toEqual({ allowed: true });
    });

    it.each([null, undefined, 'Read', 3])('refuses a call whose input is %j', async (input) => {
      expect(await decide('Read', input)).toMatchObject({ allowed: false });
    });
  });
});

describe('the hook', () => {
  const callOf = (tool_name: string, tool_input: unknown, tool_use_id = 'toolu_1'): HookInput =>
    ({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id, session_id: 's', transcript_path: '', cwd: FOLDER }) as HookInput;
  const signal = { signal: new AbortController().signal };

  it('says nothing of a call that is allowed, so that Claude Code still makes its own checks', async () => {
    const denied = new Set<string>();
    const hook = createPreToolUseHook(context(), denied);
    expect(await hook(callOf('Read', { file_path: 'README.md' }), 'toolu_1', signal)).toEqual({});
    expect(denied.size).toBe(0);
  });

  it('refuses a call that is not, with the reason for the model, and remembers which call it was', async () => {
    const denied = new Set<string>();
    const hook = createPreToolUseHook(context(), denied);
    expect(await hook(callOf('Read', { file_path: '/etc/passwd' }, 'toolu_9'), 'toolu_9', signal)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('outside the folder') },
    });
    expect([...denied]).toEqual(['toolu_9']);
  });

  it('refuses a call it could not judge, which is every call when the file system does not answer', async () => {
    const denied = new Set<string>();
    const hook = createPreToolUseHook(context({ resolveReal: () => Promise.reject(new Error('EIO')) }), denied);
    expect(await hook(callOf('Write', { file_path: 'a.txt', content: 'x' }, 'toolu_3'), 'toolu_3', signal)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('could not be checked') } });
    expect(denied.has('toolu_3')).toBe(true);
  });

  it('leaves alone what is not a call of a tool', async () => {
    const hook = createPreToolUseHook(context(), new Set());
    expect(await hook({ hook_event_name: 'Stop' } as HookInput, undefined, signal)).toEqual({});
  });
});

describe('the tools of a workspace', () => {
  const NEW_FOLDER = 'mcp__escritoriio__workspace_new_folder';
  const CLONE = 'mcp__escritoriio__workspace_clone';

  it.each([
    [NEW_FOLDER, { name: 'hello' }],
    [CLONE, { url: 'https://github.com/octocat/Hello-World.git' }],
    [CLONE, { url: 'https://github.com/octocat/Hello-World.git', name: 'hello' }],
  ])('allows %s in a workspace', async (name, input) => {
    expect(await decide(name, input, { workspace: true })).toEqual({ allowed: true });
  });

  it.each([
    [NEW_FOLDER, { name: 'hello' }],
    [CLONE, { url: 'https://github.com/octocat/Hello-World.git' }],
  ])('refuses %s in any other task', async (name, input) => {
    for (const overrides of [{}, { workspace: false }, { access: 'read-only' as const }]) {
      expect(await decide(name, input, overrides)).toEqual({ allowed: false, reason: expect.stringContaining('not available') });
    }
  });

  it.each([
    ['mcp__escritoriio__workspace_delete'],
    ['mcp__escritoriio__workspace_clone '],
    ['mcp__escritoriio__workspace_clone2'],
    ['mcp__escritoriio__WORKSPACE_CLONE'],
    ['mcp__escritoriio__'],
    ['mcp__other__workspace_clone'],
    ['mcp__other__anything'],
    ['mcp__'],
    ['mcp__plugin_github_github__create_issue'],
    ['MCP__escritoriio__workspace_clone'],
    ['ListMcpResourcesTool'],
    ['ReadMcpResourceTool'],
  ])('refuses every other name, such as %j, even in a workspace', async (name) => {
    expect(await decide(name, {}, { workspace: true })).toEqual({ allowed: false, reason: expect.any(String) });
  });

  it.each([null, undefined, 'x', 3])('refuses a call of a tool of the workspace whose input is %j', async (input) => {
    expect(await decide(NEW_FOLDER, input, { workspace: true })).toMatchObject({ allowed: false });
  });

  it('is judged by the hook the same way, and a refused call is remembered as refused', async () => {
    const denied = new Set<string>();
    const hook = createPreToolUseHook(context({ workspace: true }), denied);
    const call = (tool_name: string, tool_use_id: string) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input: { name: 'x' }, tool_use_id, session_id: 's', transcript_path: '', cwd: FOLDER }) as HookInput;
    const signal = { signal: new AbortController().signal };
    expect(await hook(call(NEW_FOLDER, 't1'), 't1', signal)).toEqual({});
    expect(await hook(call('mcp__other__x', 't2'), 't2', signal)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect([...denied]).toEqual(['t2']);
  });
});
