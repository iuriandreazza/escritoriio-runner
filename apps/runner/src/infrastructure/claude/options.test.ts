import { describe, expect, it } from 'vitest';
import type { AgentRequest } from '../../application/task-ports.ts';
import { childEnvironment } from '../../domain/child-environment.ts';
import { claudeQueryOptions, MAX_TURNS } from './options.ts';
import { agentRequest } from './testing.ts';
import { REFUSED_TOOLS } from './tools.ts';

const abortController = new AbortController();
const preToolUse = () => Promise.resolve({});
const spawnProcess = () => {
  throw new Error('not started in a test of the options');
};
const optionsFor = (request: AgentRequest) => claudeQueryOptions(request, { abortController, preToolUse, spawnProcess });

const shell = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/ana',
  ANTHROPIC_API_KEY: 'sk-ant-in-the-shell',
  ANTHROPIC_AUTH_TOKEN: 'token',
  GITHUB_TOKEN: 'ghp_x',
  AWS_SECRET_ACCESS_KEY: 'aws',
  OPENAI_API_KEY: 'sk-openai',
};

describe('the options Claude Code is started with', () => {
  it('never skips, widens or hands over its permissions', () => {
    const options = optionsFor(agentRequest());
    expect(options.permissionMode).toBe('dontAsk');
    expect(JSON.stringify(options)).not.toMatch(/bypassPermissions|acceptEdits|"auto"/);
    for (const key of ['allowDangerouslySkipPermissions', 'permissionPrompts', 'permissionPromptToolName', 'canUseTool', 'onUserDialog', 'onElicitation', 'mcpServers', 'plugins', 'agents', 'settings', 'managedSettings', 'additionalDirectories', 'extraArgs']) {
      expect(options).not.toHaveProperty(key);
    }
  });

  it('reads no settings, MCP servers, commands or files of the folder or of the person', () => {
    const options = optionsFor(agentRequest());
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.verbatimPrompts).toBe(true);
    expect(options.persistSession).toBe(false);
  });

  it('runs the program of the person, where the runner says, ending after a number of turns', () => {
    const options = optionsFor(agentRequest({ executable: '/opt/tools/claude', folder: '/Users/ana/work/other' }));
    expect(options.pathToClaudeCodeExecutable).toBe('/opt/tools/claude');
    expect(options.cwd).toBe('/Users/ana/work/other');
    expect(options.maxTurns).toBe(MAX_TURNS);
  });

  it('is stopped through the controller it is given', () => {
    expect(optionsFor(agentRequest()).abortController).toBe(abortController);
  });

  it('is started by the function it is given, so that the runner can end it and what it left running', () => {
    expect(optionsFor(agentRequest()).spawnClaudeCodeProcess).toBe(spawnProcess);
  });

  it('starts it with exactly the environment the runner built, a copy of it, and no key, token or secret', () => {
    const environment = childEnvironment(shell, false);
    const options = optionsFor(agentRequest({ environment }));
    expect(options.env).toEqual(environment);
    expect(options.env).not.toBe(environment);
    expect(Object.keys(options.env ?? {}).join(' ')).not.toMatch(/KEY|TOKEN|SECRET|ANTHROPIC|OPENAI|GITHUB|AWS/);
  });

  it.each([
    { access: 'read-only' as const, tools: ['Read', 'Glob', 'Grep'] },
    { access: 'edit' as const, tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] },
  ])('gives a folder of $access access these tools and no others, as the base set and as what is approved', ({ access, tools }) => {
    const options = optionsFor(agentRequest({ access }));
    expect(options.tools).toEqual(tools);
    expect(options.allowedTools).toEqual(tools);
  });

  it('gives a folder that is only read no tool that writes, and no shell', () => {
    const options = optionsFor(agentRequest({ access: 'read-only' }));
    for (const tool of ['Bash', 'Edit', 'Write', 'NotebookEdit']) {
      expect(options.tools).not.toContain(tool);
      expect(options.allowedTools).not.toContain(tool);
    }
  });

  it('refuses the tools that reach the web, ask a person, start other agents or leave something running, and never one that is given', () => {
    for (const access of ['read-only', 'edit'] as const) {
      const options = optionsFor(agentRequest({ access }));
      for (const refused of ['WebFetch', 'WebSearch', 'AskUserQuestion', 'Agent', 'Task', 'Skill', 'Monitor', 'ScheduleWakeup', 'EnterWorktree']) {
        expect(options.disallowedTools).toContain(refused);
      }
      expect(options.disallowedTools).toEqual(REFUSED_TOOLS);
      expect(options.disallowedTools?.filter((name) => options.tools instanceof Array && options.tools.includes(name))).toEqual([]);
    }
  });

  it('is asked about every call of every tool, with no matcher that could leave one out', () => {
    const { PreToolUse } = optionsFor(agentRequest()).hooks ?? {};
    expect(PreToolUse).toHaveLength(1);
    expect(PreToolUse?.[0]).toEqual({ hooks: [preToolUse] });
  });

  describe('the sandbox of the shell commands', () => {
    const request = agentRequest({ access: 'edit' });
    const sandbox = optionsFor(request).sandbox;

    it('is on, and a system that cannot provide it is an error, not a run with none', () => {
      expect(sandbox?.enabled).toBe(true);
      expect(sandbox?.failIfUnavailable).toBe(true);
    });

    it('does not let a command ask to leave it, or run anything outside it', () => {
      expect(sandbox?.allowUnsandboxedCommands).toBe(false);
      expect(sandbox).not.toHaveProperty('excludedCommands');
      expect(sandbox).not.toHaveProperty('allowAppleEvents');
      expect(sandbox?.filesystem).not.toHaveProperty('disabled');
    });

    it('reaches no host: none is allowed, and one that is not named is refused rather than asked about', () => {
      expect(sandbox?.network).toEqual({ allowedDomains: [], strictAllowlist: true });
    });

    it('cannot read the places that hold the credentials of the person, nor the state of the runner, which holds its token, nor the copies of other tasks', () => {
      const unreadable = sandbox?.filesystem?.denyRead ?? [];
      for (const place of ['.ssh', '.aws', '.gnupg', '.config/gcloud', '.kube', '.docker', '.npmrc', '.netrc', '.git-credentials', '.claude/.credentials.json', '.claude.json']) {
        expect(unreadable).toContain(`/Users/ana/${place}`);
      }
      expect(unreadable).toContain('/Users/ana/Library/Application Support/escritoriio-runner');
      expect(unreadable).toContain('/Users/ana/Library/Caches/escritoriio-runner/worktrees');
    });

    it('can read the folder it works in, which lies inside a place it cannot read (the runner makes its copies there)', () => {
      const inCopies = agentRequest({ folder: '/Users/ana/Library/Caches/escritoriio-runner/worktrees/task-1' });
      expect(optionsFor(inCopies).sandbox?.filesystem?.allowRead).toEqual(['/Users/ana/Library/Caches/escritoriio-runner/worktrees/task-1']);
      expect(sandbox?.filesystem?.allowRead).toEqual([request.folder]);
    });

    it('also keeps the login out of reach where the person keeps the settings of Claude Code elsewhere', () => {
      const moved = agentRequest({ environment: { HOME: '/Users/ana', CLAUDE_CONFIG_DIR: '/Users/ana/.claude-work' } });
      expect(optionsFor(moved).sandbox?.filesystem?.denyRead).toContain('/Users/ana/.claude-work/.credentials.json');
    });

    it('does not double the slash of a home that ends in one', () => {
      const request = agentRequest({ surroundings: { home: '/Users/ana/', stateDirectory: '/state', worktreesDirectory: '/copies', windows: false } });
      expect(optionsFor(request).sandbox?.filesystem?.denyRead).toContain('/Users/ana/.ssh');
    });

    it('is left out where the system has none, which is a task that only runs in a folder its owner trusts', () => {
      const windows = optionsFor(agentRequest({ surroundings: { home: 'C:\\Users\\ana', stateDirectory: 'C:\\state', worktreesDirectory: 'C:\\copies', windows: true } }));
      expect(windows).not.toHaveProperty('sandbox');
      expect(windows.permissionMode).toBe('dontAsk');
      expect(windows.hooks?.PreToolUse).toHaveLength(1);
      expect(windows.tools).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']);
    });

    it('is an error at the start for a task that runs commands where the system cannot provide it, and no error for one that runs none', () => {
      expect(optionsFor(agentRequest({ access: 'edit' })).sandbox?.failIfUnavailable).toBe(true);
      const readOnly = optionsFor(agentRequest({ access: 'read-only' }));
      expect(readOnly.sandbox?.enabled).toBe(true);
      expect(readOnly.sandbox?.failIfUnavailable).toBe(false);
      expect(readOnly.tools).not.toContain('Bash');
    });
  });
});

describe('the options of a task in a workspace', () => {
  const server = { type: 'sdk', name: 'escritoriio', instance: {} } as never;
  const withServer = (request: AgentRequest) => claudeQueryOptions(request, { abortController, preToolUse, spawnProcess, workspaceServer: server });

  it('adds one MCP server, the runner’s own, under its name, and keeps every other out', () => {
    const options = withServer(agentRequest({ access: 'edit' }));
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['escritoriio']);
    expect(options.mcpServers?.escritoriio).toBe(server);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.settingSources).toEqual([]);
  });

  it('approves the two tools by their exact names, after the tools of Claude Code, and leaves the set of tools as it was', () => {
    const options = withServer(agentRequest({ access: 'edit' }));
    expect(options.allowedTools).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'mcp__escritoriio__workspace_new_folder', 'mcp__escritoriio__workspace_clone']);
    expect(options.tools).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']);
    expect(options.permissionMode).toBe('dontAsk');
  });

  it('leaves out every MCP server, and approves no MCP tool, in a task that has no workspace', () => {
    const options = optionsFor(agentRequest({ access: 'edit' }));
    expect(options).not.toHaveProperty('mcpServers');
    expect(options.allowedTools?.some((name) => name.startsWith('mcp__'))).toBe(false);
  });

  it('refuses, by both of the names Claude Code gives them, the tools that list or read what an MCP server holds', () => {
    expect(withServer(agentRequest()).disallowedTools).toEqual(expect.arrayContaining(['ListMcpResources', 'ReadMcpResource', 'ListMcpResourcesTool', 'ReadMcpResourceTool']));
  });
});
