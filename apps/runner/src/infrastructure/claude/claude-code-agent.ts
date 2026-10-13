import type { createSdkMcpServer, Options, SDKMessage, tool } from '@anthropic-ai/claude-agent-sdk';
import { homedir } from 'node:os';
import type { AgentDetection, AgentEvent, AgentRequest, CodingAgent } from '../../application/task-ports.ts';
import { childEnvironment } from '../../domain/child-environment.ts';
import { isInside, isSamePath } from '../../domain/paths.ts';
import { detectClaudeCode } from './detect.ts';
import type { DetectDeps } from './detect.ts';
import { CLAUDE_CODE_GAVE_NO_ANSWER, createMessageTranslator } from './messages.ts';
import { claudeQueryOptions } from './options.ts';
import { createPreToolUseHook } from './pre-tool-use.ts';
import { realPathOfNearest } from '../real-path-resolver.ts';
import { createSystemExec, isExecutableFile } from './system.ts';
import { createWorkspaceServer } from './workspace-server.ts';
import { createSystemProcessControl, createTaskProcesses } from './task-processes.ts';
import type { TaskProcesses, TaskScope } from './task-processes.ts';
import { toolsFor, WORKSPACE_TOOL_NAMES } from './tools.ts';

/** A run of Claude Code: what it says as it goes, and the way to end it. */
export interface ClaudeQuery extends AsyncIterable<SDKMessage> {
  close(): void;
}

/** The part of the Agent SDK that the adapter uses. */
export interface ClaudeSdk {
  query(request: { readonly prompt: string; readonly options: Options }): ClaudeQuery;
  /** What makes the runner's own MCP server for a workspace. Both come with the SDK; a stand-in that has no use for them may leave them out, and a task of a workspace then cannot start. */
  createSdkMcpServer?: typeof createSdkMcpServer;
  tool?: typeof tool;
}

export interface ClaudeCodeDeps extends Partial<DetectDeps> {
  /** Where the SDK comes from. It is loaded when a task begins and not before, so that the runner's other commands never read it. */
  readonly loadSdk?: () => Promise<ClaudeSdk>;
  readonly resolveReal?: (path: string) => Promise<string>;
  /** What starts the program of a task and ends what it left. */
  readonly startProcesses?: (scope: TaskScope) => TaskProcesses;
}

const COULD_NOT_START = 'The runner could not load what it needs to drive Claude Code.';
const STOPPED = 'Claude Code stopped before it finished.';

// The SDK is Anthropic's, under its own terms, and is not part of the runner's bundle: it is read from where it is installed, when it is needed.
const loadInstalledSdk = (): Promise<ClaudeSdk> => import('@anthropic-ai/claude-agent-sdk');

const isTerminal = (event: AgentEvent): boolean => event.kind === 'result' || event.kind === 'error';

/**
 * Where a task works, when the runner made that folder for it alone: no process has a reason to work there once the task is over, so any
 * orphan that does is something the task left. A folder that is somebody's own may have processes of theirs in it, and is not searched.
 */
async function ownFolderOf(request: AgentRequest, resolveReal: (path: string) => Promise<string>): Promise<string | undefined> {
  const { worktreesDirectory, windows } = request.surroundings;
  if (!isInside(worktreesDirectory, request.folder, windows) || isSamePath(worktreesDirectory, request.folder, windows)) return undefined;
  return resolveReal(request.folder).catch(() => undefined);
}

/**
 * Claude Code as a coding agent. It is the program the member already has and is logged in to (`request.executable`), driven through the
 * Agent SDK and started with the narrowest options there are for the folder (see `claudeQueryOptions`); every call of a tool is judged by the
 * runner's own hook first. It ends when Claude Code does, or at once when `signal` aborts, and then its process, and everything that it
 * started and left running, is ended (see `createTaskProcesses`) before the last thing is told, since whoever hears it goes on to take what
 * was done, and a process still running could change it.
 */
export function createClaudeCodeAgent(deps: ClaudeCodeDeps = {}): CodingAgent {
  const platform = deps.platform ?? process.platform;
  const detection: DetectDeps = {
    exec: deps.exec ?? createSystemExec(),
    isExecutable: deps.isExecutable ?? isExecutableFile,
    platform,
    home: deps.home ?? homedir(),
    shell: 'shell' in deps ? deps.shell : process.env.SHELL,
    searchPath: 'searchPath' in deps ? deps.searchPath : childEnvironment(process.env, platform === 'win32').PATH,
  };
  const loadSdk = deps.loadSdk ?? loadInstalledSdk;
  const resolveReal = deps.resolveReal ?? realPathOfNearest;
  const startProcesses = deps.startProcesses ?? ((scope: TaskScope) => createTaskProcesses(createSystemProcessControl(detection.platform), scope));

  async function* run(request: AgentRequest, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    if (signal.aborted) return;
    const controller = new AbortController();
    let query: ClaudeQuery | undefined;
    let processes: TaskProcesses | undefined;
    let stopping: Promise<void> | undefined;
    // A generator that waits for the next message does not hear that its consumer is done until the message comes, and one that is not asked
    // again never gets to clean up after itself, so the end of the process is not left to the consumer: the abort itself stops it.
    const stop = (): Promise<void> =>
      (stopping ??= (async () => {
        controller.abort();
        try {
          query?.close();
        } catch {
          // Something that is being closed has nothing more to say.
        }
        await processes?.cleanUp();
      })());
    const onAbort = (): void => void stop();
    const release = (): Promise<void> => {
      signal.removeEventListener('abort', onAbort);
      return stop();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const scope = { commands: request.access === 'edit', ownFolder: await ownFolderOf(request, resolveReal) };
      let sdk: ClaudeSdk;
      try {
        sdk = await loadSdk();
      } catch {
        yield { kind: 'error', message: COULD_NOT_START };
        return;
      }
      if (signal.aborted) return;

      // A task of a workspace is given the runner's two tools, from this process: a stand-in of the SDK that cannot make them cannot run it.
      const { workspace } = request;
      let workspaceServer: ReturnType<typeof createWorkspaceServer> | undefined;
      if (workspace) {
        if (!sdk.createSdkMcpServer || !sdk.tool) {
          yield { kind: 'error', message: COULD_NOT_START };
          return;
        }
        workspaceServer = createWorkspaceServer({ createSdkMcpServer: sdk.createSdkMcpServer, tool: sdk.tool }, workspace);
      }

      const denied = new Set<string>();
      const translator = createMessageTranslator(denied, [...toolsFor(request.access), ...(workspace ? WORKSPACE_TOOL_NAMES : [])]);
      const hook = createPreToolUseHook({ folder: request.folder, access: request.access, windows: request.surroundings.windows, workspace: workspace !== undefined, resolveReal }, denied);
      processes = startProcesses(scope);
      query = sdk.query({ prompt: request.instruction, options: claudeQueryOptions(request, { abortController: controller, preToolUse: hook, spawnProcess: processes.spawn, workspaceServer }) });

      let ended = false;
      try {
        for await (const message of query) {
          const events = translator.translate(message);
          ended = events.some(isTerminal);
          if (ended) await release();
          yield* events;
          if (ended) return;
        }
      } catch {
        if (signal.aborted || ended) return;
        await release();
        yield { kind: 'error', message: STOPPED };
        return;
      }
      if (!signal.aborted) {
        await release();
        yield { kind: 'error', message: CLAUDE_CODE_GAVE_NO_ANSWER };
      }
    } finally {
      await release();
    }
  }

  return {
    kind: 'claude-code',
    workspaceTools: true,
    detect: (executable): Promise<AgentDetection> => detectClaudeCode(executable, detection),
    run,
  };
}
