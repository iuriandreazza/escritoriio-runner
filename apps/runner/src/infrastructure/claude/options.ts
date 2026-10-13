import type { HookCallback, McpSdkServerConfigWithInstance, Options, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRequest } from '../../application/task-ports.ts';
import { credentialPaths } from '../../domain/credential-places.ts';
import { REFUSED_TOOLS, toolsFor, WORKSPACE_SERVER_NAME, WORKSPACE_TOOL_NAMES } from './tools.ts';

/** The most turns of the model one task may take. A task that needs more is one that went astray, and the time ceiling is not the only thing that ends it. */
export const MAX_TURNS = 40;

export interface QueryWiring {
  /** Ends the query: its process is stopped. */
  readonly abortController: AbortController;
  /** Called before every use of a tool, whatever the tool: what it says is the last word. */
  readonly preToolUse: HookCallback;
  /** Starts the program, so that the runner can end it, and what it started, when the task is over. */
  readonly spawnProcess: (options: SpawnOptions) => SpawnedProcess;
  /** The runner's own server of the tools of a workspace, which runs in this process. Only a task of a workspace has one. */
  readonly workspaceServer?: McpSdkServerConfigWithInstance | undefined;
}

function unreadablePlaces(request: AgentRequest): string[] {
  const { home, stateDirectory, worktreesDirectory } = request.surroundings;
  // The runner's own token is in its state directory, and what other tasks left is in its worktrees.
  return [...credentialPaths(home, request.environment.CLAUDE_CONFIG_DIR), stateDirectory, worktreesDirectory];
}

/**
 * What the shell commands of a task are kept inside. They write only in the folder of the task, they read all of the machine but the
 * places that hold secrets, and they reach no host on the network: a command that was talked into sending files somewhere has nowhere
 * to send them. `allowRead` puts the folder of the task back where it lies inside a place that is not to be read, since the work may be
 * done in a copy that the runner made in its own folder for copies. There is no sandbox where the system has none (Windows), and a task
 * only runs there in a folder its owner vouches for. Where it is asked for and the system cannot provide it (Linux without the programs it
 * needs), a task that runs commands does not start, whatever the folder: the runner never decides, by itself, to run commands with no sandbox.
 */
function sandboxFor(request: AgentRequest): Options['sandbox'] {
  return {
    enabled: true,
    // Without it a system that cannot sandbox would quietly run every command with no sandbox at all. A task that runs no command loses
    // nothing when the system has none, and is not to fail for want of it.
    failIfUnavailable: request.access === 'edit',
    // Without it a command that fails in the sandbox may be run again outside it.
    allowUnsandboxedCommands: false,
    // A host that is not named is refused, whatever the permission mode says, and nothing is named.
    network: { allowedDomains: [], strictAllowlist: true },
    filesystem: { denyRead: unreadablePlaces(request), allowRead: [request.folder] },
  };
}

/**
 * The options Claude Code is started with, for one task. Everything that decides what it may do is set here, and nothing is left to the
 * defaults of the program or to the settings it finds on the machine:
 *
 * - `env` replaces the environment of the process: it is exactly what the runner built, never what the runner itself was started with.
 * - `settingSources` is empty, so the hooks, MCP servers and instructions that a folder carries in its own files do not run.
 * - `permissionMode` is `dontAsk`: what is not approved beforehand is refused, and nobody is ever asked.
 * - `verbatimPrompts` makes the instruction text only text: no `@file` is pulled in and no `/command` is run because of it.
 * - `tools` is the whole set of tools there is (see `toolsFor`); the other lists only repeat it as a lock on the same door.
 * - The hook is asked about every call, and keeps each file tool inside the folder: a tool that is approved beforehand is not put to any
 *   other callback, and the sandbox covers only shell commands, so Read, Glob and Grep reach the whole machine without it.
 * - The one MCP server there is, in a workspace, is the runner's own, in this process, with two tools that are approved by name (`dontAsk` refuses what is not): `strictMcpConfig` leaves out every other.
 * - `spawnClaudeCodeProcess` starts the program in the way that lets the runner end it, and what it started (see `createTaskProcesses`).
 */
export function claudeQueryOptions(request: AgentRequest, wiring: QueryWiring): Options {
  const tools = [...toolsFor(request.access)];
  return {
    abortController: wiring.abortController,
    cwd: request.folder,
    pathToClaudeCodeExecutable: request.executable,
    env: { ...request.environment },
    settingSources: [],
    strictMcpConfig: true,
    permissionMode: 'dontAsk',
    verbatimPrompts: true,
    persistSession: false,
    maxTurns: MAX_TURNS,
    tools,
    allowedTools: [...tools, ...(wiring.workspaceServer ? WORKSPACE_TOOL_NAMES : [])],
    disallowedTools: [...REFUSED_TOOLS],
    spawnClaudeCodeProcess: wiring.spawnProcess,
    ...(request.surroundings.windows ? {} : { sandbox: sandboxFor(request) }),
    ...(wiring.workspaceServer ? { mcpServers: { [WORKSPACE_SERVER_NAME]: wiring.workspaceServer } } : {}),
    hooks: { PreToolUse: [{ hooks: [wiring.preToolUse] }] },
  };
}
