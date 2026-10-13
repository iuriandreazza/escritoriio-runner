import type { FolderAccess } from '../../domain/folder-policy.ts';

const READING_TOOLS = ['Read', 'Glob', 'Grep'] as const;
const FILE_WRITING_TOOLS = ['Edit', 'Write'] as const;
const SHELL_TOOLS = ['Bash'] as const;
const WRITING_TOOLS = [...FILE_WRITING_TOOLS, ...SHELL_TOOLS] as const;

/**
 * The only tools a task is given. A folder that is only read gets the tools that look. One that may be edited gets those, the file tools
 * and the shell.
 *
 * The file tools and the shell together leave one gap that the hook cannot close. The hook checks a path when a call is made, and the tool
 * uses it a moment later: a command that swaps a link inside the folder in between can make a file tool write or read outside the folder.
 * It was measured against the real Claude Code 2.1.250 with a link flipped from another process: 18 of 180 writes and 7 of 180 reads went
 * outside. The owner of a folder that is edited accepts that. The sandbox confines what a command itself writes, and not what the file
 * tools do, since they run in the coding agent's own process.
 */
export function toolsFor(access: FolderAccess): readonly string[] {
  return access === 'read-only' ? READING_TOOLS : [...READING_TOOLS, ...FILE_WRITING_TOOLS, ...SHELL_TOOLS];
}

/** The name an in-process MCP server gives itself: Claude Code writes the names of its tools as `mcp__<server>__<tool>`. */
export const WORKSPACE_SERVER_NAME = 'escritoriio';

/**
 * The only tools that do not belong to Claude Code, given to the task of a workspace and to no other. Exact names, compared whole: a name
 * that begins like one of them, or differs in case or by a space, is another tool.
 */
export const WORKSPACE_NEW_FOLDER_TOOL = `mcp__${WORKSPACE_SERVER_NAME}__workspace_new_folder`;
export const WORKSPACE_CLONE_TOOL = `mcp__${WORKSPACE_SERVER_NAME}__workspace_clone`;
export const WORKSPACE_TOOL_NAMES: readonly string[] = [WORKSPACE_NEW_FOLDER_TOOL, WORKSPACE_CLONE_TOOL];

export const isWorkspaceTool = (name: string): boolean => WORKSPACE_TOOL_NAMES.includes(name);

/** Whether the tool can change anything: files, or whatever a command reaches. */
export const isWritingTool = (name: string): boolean => (WRITING_TOOLS as readonly string[]).includes(name) || name === 'NotebookEdit';

/**
 * Tools that are never given. `tools` already leaves them out, so this is a second lock on the same door: each of them either runs outside
 * the sandbox of the shell commands, asks a person who is not there, leaves something behind that outlives the task, or moves the
 * work somewhere other than the folder the owner allowed.
 */
export const REFUSED_TOOLS: readonly string[] = [
  'WebFetch',
  'WebSearch',
  'AskUserQuestion',
  'Agent',
  'Task',
  'Skill',
  'NotebookEdit',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'Monitor',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'RemoteTrigger',
  'Workflow',
  'SendMessage',
  'PushNotification',
  'TaskOutput',
  'TaskStop',
  'ListMcpResources',
  'ReadMcpResource',
  // The names Claude Code 2.1.250 gives them: it told a call by the other names that there was no such tool, which is not a refusal anything can rely on.
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
];
