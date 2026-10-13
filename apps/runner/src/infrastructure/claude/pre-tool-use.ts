import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { FolderAccess } from '../../domain/folder-policy.ts';
import { isInside, resolveAgainst } from '../../domain/paths.ts';
import { isWorkspaceTool, isWritingTool, toolsFor } from './tools.ts';

export interface ToolUseContext {
  /** Where the task works: nothing outside it may be touched. */
  readonly folder: string;
  readonly access: FolderAccess;
  readonly windows: boolean;
  /** The task is in a workspace, and has the two tools of it. Absent means it has none. */
  readonly workspace?: boolean;
  /** Where a path really is once its links are followed, as far as the file system can say. Rejects when it cannot tell, and then the call is refused. */
  readonly resolveReal: (path: string) => Promise<string>;
}

export type ToolDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

const OUTSIDE = 'That path is outside the folder this task works in.';
const ODD_PATH = 'That is not a path this task may use.';
const MALFORMED = 'That call is not in a form this task accepts.';
const PROTECTED = 'The files that Git and Claude Code run by themselves may not be changed.';
const NOT_THIS_TASK = 'That tool is not available in this task.';
const READ_ONLY = 'This folder is shared to be read only, so nothing may be changed.';
const CANNOT_CHECK = 'This call could not be checked, so it was not allowed.';

/** What a call to each tool names as a place, and which of them must be given. The tools of the task are the only ones there are. */
const PATH_INPUTS: Readonly<Record<string, readonly { readonly field: string; readonly required: boolean }[]>> = {
  Read: [{ field: 'file_path', required: true }],
  Edit: [{ field: 'file_path', required: true }],
  Write: [{ field: 'file_path', required: true }],
  Glob: [{ field: 'path', required: false }],
  Grep: [{ field: 'path', required: false }],
};

/** What a search is given to match files against, as a path under the search's place: it may not point at another place. */
const PATTERN_INPUTS: Readonly<Record<string, string>> = { Glob: 'pattern', Grep: 'glob' };

// Files that Git and Claude Code act on by themselves: a changed `.git` file may point at a settings file that runs commands the next time
// Git is used in the folder, and a changed `.claude` folder is a hook. Compared without regard to case, since some systems have none.
const SELF_RUNNING = new Set(['.git', '.gitmodules', '.claude', '.mcp.json']);

/** What a name is compared as. Windows ignores the dots and spaces that end a name (`.git.` is `.git`), and the other systems do not. */
const nameAsCompared = (name: string, windows: boolean): string => (windows ? name.replace(/[. ]+$/, '') : name).toLowerCase();

/**
 * Another way to write the name of a file that Windows knows and a comparison of names does not: the short form it keeps for old
 * programs (`PROGRA~1`, `GITMOD~1`), and a stream of a file (`file.txt:stream`), which is the file for what the name is compared to.
 */
const isAlternateName = (name: string): boolean => name.includes(':') || /~\d/.test(name);

/**
 * A path that a program might read differently from the way it is read here: one that starts with `~` (tools take it as the home folder),
 * that has spaces around it (tools trim them, and then it may be absolute), or that is a Windows path relative to a drive.
 */
function isUnclear(path: string, windows: boolean): boolean {
  return path === '' || path.startsWith('~') || path !== path.trim() || /\p{Cc}/u.test(path) || (windows && /^[a-z]:(?![\\/])/i.test(path));
}

/** A pattern that begins somewhere other than the place it is given, or climbs out of it, also in one of the alternatives of a `{a,b}`. */
function leavesItsPlace(pattern: string): boolean {
  return /(^|[{,])\s*[\\/~]/.test(pattern) || /^[a-z]:/i.test(pattern) || pattern.includes('..');
}

/** The names under `root` that lead to `path`, which must lie inside it. */
function namesBelow(root: string, path: string, windows: boolean): string[] {
  const start = resolveAgainst(root, root, windows);
  const here = resolveAgainst(root, path, windows);
  if (start === undefined || here === undefined) return [];
  return here
    .slice(start.length)
    .split(/[\\/]+/)
    .filter((name) => name !== '');
}

const touchesSelfRunningFile = (names: readonly string[], windows: boolean): boolean => names.some((name) => SELF_RUNNING.has(nameAsCompared(name, windows)));

/** Why a path may not be used by this call, or undefined when it may. `writing` also keeps it off the files that run by themselves. */
async function problemWithPath(given: unknown, context: ToolUseContext, writing: boolean): Promise<string | undefined> {
  const { folder, windows, resolveReal } = context;
  if (typeof given !== 'string' || isUnclear(given, windows)) return ODD_PATH;
  const here = resolveAgainst(folder, given, windows);
  if (here === undefined || !isInside(folder, here, windows)) return OUTSIDE;
  // A link inside the folder may lead out of it: what counts is where the path really is, compared with where the folder really is.
  const [realFolder, realHere] = await Promise.all([resolveReal(folder), resolveReal(here)]);
  if (!isInside(realFolder, realHere, windows)) return OUTSIDE;
  const named = namesBelow(folder, here, windows);
  if (windows && named.some(isAlternateName)) return ODD_PATH;
  if (writing && (touchesSelfRunningFile(named, windows) || touchesSelfRunningFile(namesBelow(realFolder, realHere, windows), windows))) return PROTECTED;
  return undefined;
}

function problemWithCommand(input: Readonly<Record<string, unknown>>): string | undefined {
  if (typeof input.command !== 'string' || input.command.trim() === '') return MALFORMED;
  // The sandbox is what contains a command: one that asks to run outside it is not run.
  if (input.dangerouslyDisableSandbox !== undefined && input.dangerouslyDisableSandbox !== false) return 'Commands run only inside the sandbox.';
  // Something left running would outlive the task, which ends with nothing of it left.
  if (input.run_in_background !== undefined && input.run_in_background !== false) return 'A command must finish within the task: nothing may be left running.';
  return undefined;
}

/**
 * Whether one call of a tool is allowed. It is asked for every call, since the tools that are approved beforehand reach no other check: the
 * runner, and not the coding agent, is the authority over what the machine lets a task touch. Whatever is not known to be fine is refused.
 */
export async function decideToolUse(use: { readonly name: string; readonly input: unknown }, context: ToolUseContext): Promise<ToolDecision> {
  const { name, input } = use;
  // Any tool that is not Claude Code's own is a tool of an MCP server: the only ones there are, in a workspace, are the runner's two, whatever any server says it has.
  if (name.startsWith('mcp__')) {
    if (!context.workspace || !isWorkspaceTool(name)) return { allowed: false, reason: NOT_THIS_TASK };
    return typeof input === 'object' && input !== null ? { allowed: true } : { allowed: false, reason: MALFORMED };
  }
  if (!toolsFor(context.access).includes(name)) return { allowed: false, reason: isWritingTool(name) && context.access === 'read-only' ? READ_ONLY : NOT_THIS_TASK };
  if (typeof input !== 'object' || input === null) return { allowed: false, reason: MALFORMED };
  const fields = input as Readonly<Record<string, unknown>>;

  if (name === 'Bash') {
    const problem = problemWithCommand(fields);
    return problem === undefined ? { allowed: true } : { allowed: false, reason: problem };
  }

  const writing = isWritingTool(name);
  for (const { field, required } of PATH_INPUTS[name] ?? []) {
    if (fields[field] === undefined && !required) continue;
    const problem = await problemWithPath(fields[field], context, writing);
    if (problem !== undefined) return { allowed: false, reason: problem };
  }
  const patternField = PATTERN_INPUTS[name];
  const pattern = patternField === undefined ? undefined : fields[patternField];
  if (pattern !== undefined && (typeof pattern !== 'string' || leavesItsPlace(pattern))) {
    return { allowed: false, reason: OUTSIDE };
  }
  return { allowed: true };
}

/**
 * The hook Claude Code calls before every use of a tool. A call that is allowed gets no answer of its own: it goes on to the checks of
 * Claude Code itself, which still refuse what they would have refused. A call that is not allowed, or could not be judged, is refused, and
 * remembered in `denied` so that what the task tells of it can say it was.
 */
export function createPreToolUseHook(context: ToolUseContext, denied: Set<string>): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const decision = await decideToolUse({ name: input.tool_name, input: input.tool_input }, context).catch((): ToolDecision => ({ allowed: false, reason: CANNOT_CHECK }));
    if (decision.allowed) return {};
    denied.add(input.tool_use_id);
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.reason } };
  };
}
