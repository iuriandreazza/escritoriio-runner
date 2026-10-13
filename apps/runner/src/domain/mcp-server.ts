import type { McpListedToolMessage } from '@escritoriio/runner-protocol';

/** A tool as a local MCP server lists it. */
export type LocalTool = McpListedToolMessage;

/**
 * A local MCP server its owner set up on this machine. How it is run (the program, its arguments, its environment) is typed here and is
 * never sent anywhere: the office knows it by its label and asks for it by that label alone.
 */
export interface LocalMcpServer {
  /** What the office calls it: a name its owner chose, never a command. */
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Typed on this machine. Whatever the server writes of them is taken out before it leaves. */
  readonly env: Readonly<Record<string, string>>;
  /** The label of a shared folder to run in; null for a folder of its own that is empty and goes away when the server does. */
  readonly folder: string | null;
  /** The tools its owner approved on this machine: each by name, with the hash of the definition they saw. A tool is called only while it is still that. */
  readonly approved: Readonly<Record<string, string>>;
}

const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, sorted(item)]));
  }
  return value;
};

/**
 * The text that a tool's approval on this machine is the hash of: what its owner is shown of it (name, title, description) and what is
 * checked against (both schemas). Its keys are put in order, so that a server that lists them in another one is not taken for having changed
 * the tool. What the server hints at is not in it: it is shown and never trusted, and a server flipping a hint must not undo an approval.
 */
export function canonicalDefinition(tool: LocalTool): string {
  return JSON.stringify(sorted({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema }));
}

/**
 * Where a tool stands against what its owner approved: `new` was never approved on this machine, `approved` is as it was when approved, and
 * `changed` was approved and is not any more what the server lists: it is not called until its owner has looked at it again and approved it.
 */
export type ToolStanding = 'approved' | 'new' | 'changed';

export function standingOf(server: Pick<LocalMcpServer, 'approved'>, name: string, hash: string): ToolStanding {
  const approved = Object.hasOwn(server.approved, name) ? server.approved[name] : undefined;
  if (approved === undefined) return 'new';
  return approved === hash ? 'approved' : 'changed';
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ENV_VALUE_MAX = 4_096;

export type EnvAssignment = { readonly ok: true; readonly name: string; readonly value: string } | { readonly ok: false; readonly error: string };

/** `NAME=value` as a person types it for the environment of a server. The value is everything after the first `=`, which may be empty. */
export function parseEnvAssignment(text: string): EnvAssignment {
  const at = text.indexOf('=');
  if (at < 0) return { ok: false, error: `"${text.slice(0, 40)}" is not NAME=value` };
  const name = text.slice(0, at);
  const value = text.slice(at + 1);
  if (name === '__proto__' || !ENV_NAME.test(name)) return { ok: false, error: `"${name.slice(0, 40)}" is not the name of an environment variable: letters, digits and underscores, not beginning with a digit` };
  if (value.includes('\u0000')) return { ok: false, error: `The value of ${name} has a NUL in it` };
  if (value.length > ENV_VALUE_MAX) return { ok: false, error: `The value of ${name} is longer than ${ENV_VALUE_MAX} characters` };
  return { ok: true, name, value };
}

const COMMAND_MAX = 1_024;
const ARGUMENT_MAX = 4_096;
const ARGUMENTS_MAX = 100;

/** What is wrong with what a person asked to run, in words; nothing when it can be run. */
export function problemWithLaunch(command: string, args: readonly string[]): string | undefined {
  if (command.trim() === '') return 'Say what to run, after --: the program and its arguments.';
  if (command.includes('\u0000') || args.some((argument) => argument.includes('\u0000'))) return 'A command line cannot have a NUL in it.';
  if (command.length > COMMAND_MAX) return `The program is named in more than ${COMMAND_MAX} characters.`;
  if (args.length > ARGUMENTS_MAX) return `A server takes at most ${ARGUMENTS_MAX} arguments.`;
  if (args.some((argument) => argument.length > ARGUMENT_MAX)) return `An argument is longer than ${ARGUMENT_MAX} characters.`;
  return undefined;
}
