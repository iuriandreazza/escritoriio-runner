import { MCP_LIMITS } from '@escritoriio/runner-protocol';
import { cleanText, hasHiddenCharacters } from '../domain/clean-text.ts';
import { DESCRIBE_LABEL_PROBLEM, findByLabel, problemWithLabel, sameLabel } from '../domain/folder-label.ts';
import type { LocalMcpServer, LocalTool, ToolStanding } from '../domain/mcp-server.ts';
import { canonicalDefinition, parseEnvAssignment, problemWithLaunch, standingOf } from '../domain/mcp-server.ts';
import { plainText } from '../domain/plain-text.ts';
import type { LaunchDeps } from './mcp-launch.ts';
import { launchOf } from './mcp-launch.ts';
import type { LocalMcpClient, LocalMcpSession, McpServerStore } from './mcp-ports.ts';
import { LocalMcpError } from './mcp-ports.ts';
import { OwnerError } from './owner-error.ts';

export interface McpServersDeps extends LaunchDeps {
  readonly store: McpServerStore;
  readonly client: LocalMcpClient;
  /** The hash that a definition is approved by. */
  readonly hash: (text: string) => string;
}

/** What the person is shown before they are asked, and what they are asked. */
export interface Question {
  readonly lines: readonly string[];
  readonly prompt: string;
}

export interface NewMcpServer {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Each as typed: NAME=value. */
  readonly env: readonly string[];
  /** The label of a shared folder to run in. */
  readonly folder: string | null;
}

export type AddMcpServerOutcome = { readonly added: false } | { readonly added: true; readonly server: LocalMcpServer };

const DESCRIBE_FAILURE: Readonly<Record<string, string>> = {
  unreachable: 'It did not start, or it ended before it answered.',
  timeout: 'It took too long to answer.',
  protocol: 'What it said is not what an MCP server says.',
  busy: 'This machine is serving other requests.',
  'bad-arguments': 'The arguments did not fit what the tool takes.',
  'bad-answer': 'The answer was not the one the tool promised.',
};

/** Words for the person at the machine about a program that did not do what was asked: its own, when the adapter had some, and never the office's. */
function whyNot(error: unknown): Error {
  if (error instanceof LocalMcpError) {
    // What the program said of itself is for a terminal; a window is given only the fixed words of why.
    const fixed = DESCRIBE_FAILURE[error.failure] ?? 'The program could not be used.';
    return new OwnerError(error.detail ?? fixed, { cause: error, windowWords: fixed });
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** What is shown whole before a server is set up has a limit: a command line that cannot be read whole is not one to say yes to. */
const COMMAND_LINE_SHOWN_MAX = 2_000;

/** Loaded or run by the program itself before its own code: whoever sets these decides what runs. */
const CHANGES_WHAT_RUNS = /^(NODE_OPTIONS|NODE_PATH|PATH|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|RUBYOPT|PERL5OPT|BASH_ENV|LD_.*|DYLD_.*)$/i;
const LOOKS_LIKE_A_SECRET = /KEY|TOKEN|SECRET/i;

/** What is wrong with a command line that a person is to be shown whole and asked about: in words, nothing when it can be. */
function problemWithShowing(command: string, args: readonly string[]): string | undefined {
  if (hasHiddenCharacters(command) || args.some(hasHiddenCharacters)) return 'The program and its arguments hold characters that cannot be seen, so they could not be shown as they are.';
  const total = [command, ...args].reduce((sum, part) => sum + part.length, 0);
  if (total > COMMAND_LINE_SHOWN_MAX) return `The program and its arguments are more than ${COMMAND_LINE_SHOWN_MAX} characters in all, which is too much to be read whole before saying yes.`;
  return undefined;
}

/** Each part exactly as the program gets it, in quotes so that a space at an end, an empty argument or a line break shows. */
const argumentLines = (server: Pick<LocalMcpServer, 'command' | 'args'>): readonly string[] => [
  `    program:    ${JSON.stringify(server.command)}`,
  ...server.args.map((argument, index) => `    ${`argument ${index + 1}:`.padEnd(11)} ${JSON.stringify(argument)}`),
];

/** Words for the names among an environment that deserve a second look: what changes what the program loads or runs, and what looks like a secret. */
function warningsAbout(names: readonly string[]): readonly string[] {
  const changes = names.filter((name) => CHANGES_WHAT_RUNS.test(name));
  const secrets = names.filter((name) => LOOKS_LIKE_A_SECRET.test(name) && !changes.includes(name));
  return [
    ...(changes.length > 0 ? [`  Careful: ${changes.join(', ')} can change what the program loads or runs, so what it runs may not be what is written above.`] : []),
    ...(secrets.length > 0 ? [`  Note: ${secrets.join(', ')} look like secrets: the program can read them, and send them anywhere it can reach.`] : []),
  ];
}

const commandLine = (server: Pick<LocalMcpServer, 'command' | 'args'>): string => plainText([server.command, ...server.args].join(' '), 300);
const names = (items: readonly string[]): string => plainText(items.join(', '), 300);

/** The server a person means by a label they typed: the one with exactly that label, or else the one that differs only in case. */
function locate(servers: readonly LocalMcpServer[], label: string): LocalMcpServer {
  const found = findByLabel(servers, label);
  if (!found) throw new OwnerError(`There is no MCP server called "${plainText(label, 64)}". escritoriio-runner mcp list says which there are.`);
  return found;
}

// --- setting a server up ------------------------------------------------------------------------------------

function whereItRuns(folder: { readonly label: string; readonly realPath: string } | undefined): string {
  return folder ? `the shared folder "${folder.label}" (${folder.realPath})` : 'a folder of its own, empty, that goes away with it';
}

/** What a choice of how to run a server means, in plain words, since the person who makes it may never have thought about what it lets happen. */
function describeServerChoice(server: LocalMcpServer, folder: { readonly label: string; readonly realPath: string } | undefined): readonly string[] {
  const env = Object.keys(server.env);
  return [
    `MCP server "${server.label}":`,
    '  runs, with each part on its own line, as the program gets it:',
    ...argumentLines(server),
    `  in:           ${whereItRuns(folder)}`,
    `  environment:  ${env.length === 0 ? 'nothing beyond what a program needs to find its files' : `${env.join(', ')} (the values stay on this machine)`}`,
    ...warningsAbout(env),
    '',
    'What this means:',
    '- Each time your AI member uses one of its tools for you (or you try one from the office), this machine starts that program, asks it for its tools or calls one, and ends it.',
    '- It is the program you chose, run as your user. This machine does not contain it: it can do what your user can, and the folder above is only where it starts.',
    '- The office is told its label and the tools you approve for it. The program, its arguments and its environment stay here, and the values of the environment are taken out of everything it says before it is sent.',
    `- No tool is available to the office until you approve it: escritoriio-runner mcp approve ${server.label}`,
    `- You can stop using it at any time: escritoriio-runner mcp remove ${server.label}, or pause this machine.`,
  ];
}

/** The question the person answers, after what the choice means. */
export const SET_UP_MCP_PROMPT = 'Set this server up? [y/N] ';

/**
 * Puts a server among those this machine has. What is typed is checked first and refused with words: the label (a name and not a path), what to run, the
 * environment (NAME=value, once for each name) and the folder (one the machine shares). The person is asked, with what their choice means, before
 * anything is kept, and it is kept on the servers as they are then, not as they were when the question began.
 */
export async function addMcpServer(deps: McpServersDeps, request: NewMcpServer, confirm: (question: Question) => Promise<boolean>): Promise<AddMcpServerOutcome> {
  const labelProblem = problemWithLabel(request.label);
  if (labelProblem) throw new OwnerError(DESCRIBE_LABEL_PROBLEM[labelProblem]);
  const launchProblem = problemWithLaunch(request.command, request.args);
  if (launchProblem) throw new OwnerError(launchProblem);
  const showingProblem = problemWithShowing(request.command, request.args);
  if (showingProblem) throw new OwnerError(showingProblem);
  const env: Record<string, string> = {};
  for (const assignment of request.env) {
    const parsed = parseEnvAssignment(assignment);
    if (!parsed.ok) throw new OwnerError(parsed.error);
    if (Object.hasOwn(env, parsed.name)) throw new OwnerError(`${parsed.name} is given twice.`);
    env[parsed.name] = parsed.value;
  }
  let folder: { readonly label: string; readonly realPath: string } | undefined;
  if (request.folder !== null) {
    const shared = findByLabel((await deps.policy.load()).folders, request.folder);
    if (!shared) throw new OwnerError(`There is no shared folder called "${plainText(request.folder, 64)}". escritoriio-runner folders list says which there are.`);
    folder = shared;
  }
  const server: LocalMcpServer = { label: request.label, command: request.command, args: [...request.args], env, folder: folder?.label ?? null, approved: {} };
  if (!(await confirm({ lines: describeServerChoice(server, folder), prompt: SET_UP_MCP_PROMPT }))) return { added: false };
  await deps.store.update((current) => {
    const clash = current.servers.find((candidate) => sameLabel(candidate.label, server.label));
    if (clash) throw new OwnerError(`There is a server called "${clash.label}" already. Choose another label, or take that one away first: escritoriio-runner mcp remove ${clash.label}.`);
    if (current.servers.length >= MCP_LIMITS.servers) throw new OwnerError(`A machine has at most ${MCP_LIMITS.servers} MCP servers.`);
    return { servers: { servers: [...current.servers, server] }, result: undefined };
  });
  return { added: true, server };
}

export async function removeMcpServer(deps: Pick<McpServersDeps, 'store'>, label: string): Promise<LocalMcpServer> {
  return deps.store.update((current) => {
    const removed = locate(current.servers, label);
    return { servers: { servers: current.servers.filter((server) => server !== removed) }, result: removed };
  });
}

// --- what the servers are -----------------------------------------------------------------------------------

/** An MCP server of this machine as a screen shows it: what it is called and how it runs, in words that are safe to print, and which of its tools the owner approved. */
export interface McpServerView {
  readonly label: string;
  readonly commandLine: string;
  /** The label of the shared folder it runs in; null for a folder of its own. */
  readonly folder: string | null;
  /** The names of its environment, never the values. */
  readonly envNames: readonly string[];
  readonly approvedTools: readonly string[];
}

export async function inspectMcpServers(deps: Pick<McpServersDeps, 'store'>): Promise<readonly McpServerView[]> {
  const { servers } = await deps.store.load();
  return servers.map((server) => ({
    label: plainText(server.label, 64),
    commandLine: commandLine(server),
    folder: server.folder === null ? null : plainText(server.folder, 64),
    envNames: Object.keys(server.env).map((name) => plainText(name, 128)),
    approvedTools: Object.keys(server.approved).map((name) => plainText(name, 64)),
  }));
}

export async function describeMcpServers(deps: Pick<McpServersDeps, 'store'>): Promise<readonly string[]> {
  const servers = await inspectMcpServers(deps);
  if (servers.length === 0) return ['No MCP servers are set up. Set one up with: escritoriio-runner mcp add <label> -- <program> [arguments]'];
  return servers.flatMap((server) => [
    `${server.label}: ${server.commandLine}`,
    `  runs in:      ${server.folder === null ? 'a folder of its own' : `the shared folder "${server.folder}"`}`,
    `  environment:  ${server.envNames.length === 0 ? 'none' : names(server.envNames)}`,
    `  tools:        ${server.approvedTools.length === 0 ? `none approved yet: escritoriio-runner mcp approve ${server.label}` : `${server.approvedTools.length} approved: ${names(server.approvedTools)}`}`,
  ]);
}

// --- looking at the tools -----------------------------------------------------------------------------------

/** Starts the server for a person at the machine and gives what it lists, ending it after. Throws with words for them when it cannot. */
async function withTools<T>(deps: McpServersDeps, server: LocalMcpServer, signal: AbortSignal, use: (tools: readonly LocalTool[], session: LocalMcpSession) => Promise<T>): Promise<T> {
  const launch = await launchOf(deps, server);
  if (!launch) throw new OwnerError(`The folder "${plainText(server.folder ?? '', 64)}" is not shared any more, or is not where it was. Share it again, or set the server up without it.`);
  let session: LocalMcpSession | undefined;
  try {
    session = await deps.client.open(launch, signal);
    return await use(await session.listTools(signal), session);
  } catch (error) {
    throw whyNot(error);
  } finally {
    await session?.close().catch(() => undefined);
  }
}

const hashOf = (deps: McpServersDeps, tool: LocalTool): string => deps.hash(canonicalDefinition(tool));

/** A name the office and the file of approvals can hold: a server may list others, and they are not approved. */
const approvable = (tool: LocalTool): boolean => tool.name.length >= 1 && tool.name.length <= MCP_LIMITS.toolName && tool.name !== '__proto__';

const STANDING_SAID = { new: 'not approved yet', changed: 'it has changed since you approved it', approved: 'approved already' } as const;
const STANDING_WORDS = { approved: 'approved', new: 'not approved', changed: 'changed since you approved it: not approved' } as const;

/** A tool a server lists, as its owner is shown it, and where it stands against what they approved. */
export interface McpToolView {
  readonly name: string;
  readonly standing: ToolStanding;
  /** The first line of what it says it does, cleaned of what makes a terminal do things. */
  readonly summary: string;
  readonly readOnly: boolean;
}

/** Starts the server and asks it for its tools, ending it after: what a screen that lets the owner approve them is made from. */
export async function inspectMcpTools(deps: McpServersDeps, label: string, signal: AbortSignal): Promise<{ readonly label: string; readonly tools: readonly McpToolView[] }> {
  const server = locate((await deps.store.load()).servers, label);
  return withTools(deps, server, signal, (tools) =>
    Promise.resolve({
      label: server.label,
      tools: tools.map((tool) => ({
        name: plainText(tool.name, 64),
        standing: standingOf(server, tool.name, hashOf(deps, tool)),
        summary: plainText((cleanText(tool.description).split('\n')[0] ?? ''), 80),
        readOnly: tool.hints.readOnly === true,
      })),
    }),
  );
}

/** The tools a server lists, and which of them this machine's owner approved: what the office can be given depends on it. */
export async function listMcpTools(deps: McpServersDeps, label: string, signal: AbortSignal): Promise<readonly string[]> {
  const { label: server, tools } = await inspectMcpTools(deps, label, signal);
  if (tools.length === 0) return [`"${server}" lists no tools.`];
  const lines = tools.map((tool) => `  ${tool.name.padEnd(24)} ${STANDING_WORDS[tool.standing].padEnd(44)} ${tool.summary}`);
  const waiting = tools.some((tool) => tool.standing !== 'approved');
  return [`"${server}" lists ${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}:`, ...lines, ...(waiting ? ['', `Approve what the office may use: escritoriio-runner mcp approve ${server}`] : [])];
}

// --- approving ----------------------------------------------------------------------------------------------

const DESCRIPTION_SHOWN = 4_000;
const SCHEMA_SHOWN = 1_500;

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}… (cut here: all of it is what you approve)`);

/** The properties a schema names at its top level: what a person reads to tell what a tool takes. */
function takes(schema: Readonly<Record<string, unknown>>): string {
  const properties = schema.properties;
  const found = properties !== null && typeof properties === 'object' ? Object.keys(properties) : [];
  return found.length === 0 ? 'nothing' : names(found);
}

/** What a person is shown of a tool to approve it: all that its definition says, cleaned of what makes a terminal do things. */
function describeToolToApprove(server: LocalMcpServer, tool: LocalTool, standing: ToolStanding): Question {
  const schema = cut(JSON.stringify(tool.inputSchema, null, 2), SCHEMA_SHOWN);
  return {
    lines: [
      `Tool "${plainText(tool.name, 64)}" of "${server.label}" (${STANDING_SAID[standing]})${tool.hints.readOnly === true ? ', says it only reads' : ''}:`,
      ...(tool.title === null ? [] : [`  title:       ${plainText(tool.title, 200)}`]),
      '  description:',
      ...cleanText(cut(tool.description, DESCRIPTION_SHOWN)).split('\n').map((line) => `    ${line}`),
      `  takes:       ${takes(tool.inputSchema)}`,
      ...cleanText(schema).split('\n').map((line) => `    ${line}`),
      'The office, and your AI member, will be able to use it as described here, for as long as it is not changed.',
    ],
    prompt: `Let the office use "${plainText(tool.name, 64)}"? [y/N] `,
  };
}

export interface ApproveOutcome {
  readonly approved: readonly string[];
  /** How many tools were waiting for approval. */
  readonly waiting: number;
}

/**
 * Lets the person approve tools of a server on this machine: each is shown as the server lists it now, and what is kept is the hash of what they
 * were shown, so a server that changes a tool after it was looked at is not approved. Those named are asked about, approved or not; with none named,
 * those that are new or have changed. Nothing is approved for the person, whatever the office says.
 */
export async function approveMcpTools(deps: McpServersDeps, label: string, named: readonly string[], signal: AbortSignal, confirm: (question: Question) => Promise<boolean>): Promise<ApproveOutcome> {
  const server = locate((await deps.store.load()).servers, label);
  const chosen: { readonly name: string; readonly hash: string }[] = [];
  const waiting = await withTools(deps, server, signal, async (tools) => {
    const by = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of named) {
      if (!by.has(name) || !approvable(by.get(name)!)) throw new OwnerError(`"${server.label}" does not list a tool called "${plainText(name, 64)}". escritoriio-runner mcp tools ${server.label} says which it lists.`);
    }
    const candidates = named.length > 0 ? named.map((name) => by.get(name)!) : tools.filter((tool) => approvable(tool) && standingOf(server, tool.name, hashOf(deps, tool)) !== 'approved');
    for (const tool of candidates) {
      const hash = hashOf(deps, tool);
      const standing = standingOf(server, tool.name, hash);
      if (await confirm(describeToolToApprove(server, tool, standing))) chosen.push({ name: tool.name, hash });
    }
    return candidates.length;
  });
  if (chosen.length > 0) {
    await deps.store.update((current) => {
      const present = findByLabel(current.servers, server.label);
      if (!present) throw new OwnerError(`"${server.label}" was taken away while you were looking at its tools: nothing was approved.`);
      const approved = { ...present.approved, ...Object.fromEntries(chosen.map(({ name, hash }) => [name, hash])) };
      return { servers: { servers: current.servers.map((candidate) => (candidate === present ? { ...present, approved } : candidate)) }, result: undefined };
    });
  }
  return { approved: chosen.map(({ name }) => name), waiting };
}

/** Takes the approval of tools back: the office cannot use them again until they are approved again. */
export function denyMcpTools(deps: Pick<McpServersDeps, 'store'>, label: string, tools: readonly string[]): Promise<readonly string[]> {
  return deps.store.update((current) => {
    const server = locate(current.servers, label);
    const missing = tools.find((name) => !Object.hasOwn(server.approved, name));
    if (missing !== undefined) throw new OwnerError(`"${plainText(missing, 64)}" is not approved for "${server.label}".`);
    const approved = Object.fromEntries(Object.entries(server.approved).filter(([name]) => !tools.includes(name)));
    return { servers: { servers: current.servers.map((candidate) => (candidate === server ? { ...server, approved } : candidate)) }, result: tools };
  });
}
