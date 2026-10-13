import { CODING_AGENT_KINDS, MCP_LIMITS, RUNNER_LIMITS, TASK_LIMITS } from '@escritoriio/runner-protocol';
import { z } from 'zod';

// The one list of what the window may ask of the main process. The main process checks every call against it, the preload only lets through the names
// in it, and the renderer is given its types and nothing else (no schema, no code). A request lists the fields it takes and no others, so a field
// that is not meant to cross (a path for a folder, a command to run) is refused and not ignored. Whatever the office said (the words of a task, the
// names of an AI member and of a machine) is data: it is cut to a length when it is shown, and never refused for being long.

/** The ceiling of what the window is told about one thing, which is what the window can show; the runner has cut to its own limits already. */
const CAPS = { name: 128, line: 400, words: 1_000, path: 4_096, url: 2_048, tailLines: 100, tasks: 50, items: 200 } as const;

/** A text from the office or from the machine, on its way to the window: shortened, never refused. */
const capped = (max: number) => z.string().transform((text) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`));

const noRequest = z.strictObject({});
const label = z.string().min(1).max(RUNNER_LIMITS.folderLabel);
const agentKind = z.enum(CODING_AGENT_KINDS);
const folderAccess = z.enum(['read-only', 'edit']);
const folderApproval = z.enum(['auto', 'ask']);
const folderIsolation = z.enum(['worktree', 'in-place']);

// --- what the window is told ------------------------------------------------------------------------------------

const deviceView = z.object({ host: capped(CAPS.name), deviceName: capped(RUNNER_LIMITS.deviceName), agentName: capped(CAPS.name), workspaceName: capped(CAPS.name) });

const connectionView = z.object({
  state: z.enum(['not-paired', 'offline', 'connecting', 'connected', 'reconnecting']),
  device: deviceView.nullable(),
  paused: z.boolean(),
  pausedByOffice: z.boolean(),
  pausedHere: z.boolean(),
  retryInMs: z.number().nullable(),
  slowRetry: z.boolean(),
  lastError: capped(CAPS.words).nullable(),
});

const tasksView = z.object({
  running: z
    .array(
      z.object({
        taskId: capped(TASK_LIMITS.taskId),
        folder: capped(RUNNER_LIMITS.folderLabel),
        startedAt: z.number(),
        waitingForApproval: z.boolean(),
        tail: z.array(capped(CAPS.line)).transform((lines) => lines.slice(-CAPS.tailLines)),
      }),
    )
    .transform((tasks) => tasks.slice(0, CAPS.tasks)),
  recent: z
    .array(
      z.object({
        taskId: capped(TASK_LIMITS.taskId),
        outcome: capped(32),
        durationMs: z.number(),
        branch: capped(TASK_LIMITS.branch).nullable(),
        summary: capped(CAPS.line),
      }),
    )
    .transform((tasks) => tasks.slice(0, CAPS.tasks)),
});

const allowedFolder = z.object({
  label: capped(RUNNER_LIMITS.folderLabel),
  path: capped(CAPS.path),
  realPath: capped(CAPS.path),
  access: folderAccess,
  approval: folderApproval,
  isolation: folderIsolation,
  trusted: z.boolean(),
  agent: agentKind.nullable(),
  /** Absent means a plain folder: a workspace is one the owner made empty for the agent to build in. */
  kind: z.enum(['plain', 'workspace']).optional(),
});

const folderView = z.object({ folder: allowedFolder, problem: capped(CAPS.words).optional() });

const agentDetection = z.object({
  installed: z.boolean(),
  path: capped(CAPS.path).optional(),
  version: capped(RUNNER_LIMITS.agentVersion).optional(),
  loggedIn: z.boolean().nullable(),
  supported: z.boolean(),
  problem: capped(CAPS.words).optional(),
  containment: z.enum(['sandbox', 'none']),
});

const agentView = z.object({ kind: agentKind, drivable: z.boolean(), detection: agentDetection.optional(), pickedPath: capped(CAPS.path).optional() });

const mcpServerView = z.object({
  label: capped(MCP_LIMITS.serverLabel),
  commandLine: capped(CAPS.line),
  folder: capped(RUNNER_LIMITS.folderLabel).nullable(),
  envNames: z.array(capped(CAPS.name)).transform((names) => names.slice(0, CAPS.items)),
  approvedTools: z.array(capped(MCP_LIMITS.toolName)).transform((names) => names.slice(0, MCP_LIMITS.tools)),
});

const mcpToolView = z.object({ name: capped(MCP_LIMITS.toolName), standing: z.enum(['approved', 'new', 'changed']), summary: capped(CAPS.line), readOnly: z.boolean() });

const doctorReport = z.object({
  checks: z
    .array(z.object({ id: capped(64), status: z.enum(['ok', 'warn', 'fail']), title: capped(CAPS.name), message: capped(CAPS.words) }))
    .transform((checks) => checks.slice(0, CAPS.items)),
  healthy: z.boolean(),
});

/** A task of a folder that asks first, waiting for its owner: the words are the office's, shown whole, never cut (the owner approves exactly these). */
const pendingTask = z.object({
  kind: z.literal('task').default('task'),
  askId: z.string().min(1).max(64),
  taskId: capped(TASK_LIMITS.taskId),
  folder: capped(RUNNER_LIMITS.folderLabel),
  access: folderAccess,
  instruction: z.string().max(TASK_LIMITS.instruction),
});

/** The agent of a workspace asking to clone a repository: the address is shown whole (the runner has refused every address that holds more than a host and a path), never cut, since it is what the owner approves. */
const pendingClone = z.object({
  kind: z.literal('clone'),
  askId: z.string().min(1).max(64),
  taskId: capped(TASK_LIMITS.taskId),
  workspace: capped(RUNNER_LIMITS.folderLabel),
  url: z.string().min(1).max(CAPS.url),
  folder: z.string().min(1).max(CAPS.name),
});

const pendingApproval = z.union([pendingClone, pendingTask]);

const pairLink = z.object({ linkId: capped(64), host: capped(CAPS.name) });

const updateState = z.object({
  state: z.enum(['idle', 'checking', 'none', 'available', 'downloading', 'downloaded', 'unavailable', 'error']),
  version: capped(32).optional(),
  message: capped(CAPS.words).optional(),
});

const appInfo = z.object({
  appVersion: capped(32),
  runnerVersion: capped(32),
  platform: capped(16),
  launchAtLogin: z.boolean(),
  launchAtLoginSupported: z.boolean(),
  updatesSupported: z.boolean(),
  stateDirectory: capped(CAPS.path),
});

/** What an action says it did: the shape is kept, so that a screen knows each field by its type. */
const outcome = <Shape extends z.ZodRawShape>(fields: Shape) => z.object(fields);

// --- the channels -----------------------------------------------------------------------------------------------

export const CHANNELS = {
  'connection:get': { request: noRequest, reply: connectionView },
  /** Connects, and stays connected, until the office says to stop. Gives at once; how it goes is told by the connection events. */
  'connection:start': { request: noRequest, reply: outcome({ started: z.boolean(), message: capped(CAPS.words).optional() }) },

  'tasks:get': { request: noRequest, reply: tasksView },
  'tasks:cancel': { request: z.strictObject({ taskId: z.string().min(1).max(TASK_LIMITS.taskId) }), reply: outcome({ cancelled: z.boolean() }) },

  'folders:list': { request: noRequest, reply: z.array(folderView).transform((views) => views.slice(0, RUNNER_LIMITS.folders)) },
  // The folder is chosen in the system's own picker, opened by the main process: the window says how it is to be shared, and never where.
  'folders:add': {
    request: z.strictObject({ label: label.optional(), access: folderAccess, approval: folderApproval, isolation: folderIsolation, trusted: z.boolean(), agent: agentKind.nullable() }),
    reply: outcome({ added: z.boolean(), label: capped(RUNNER_LIMITS.folderLabel).optional(), message: capped(CAPS.words).optional() }),
  },
  // Like adding, but the folder is made: the main process opens the system's picker for the folder it is to be made in, and the window says its name and how it is shared.
  // A workspace is always edited in place, so there is no access and no isolation to give, and no path.
  'folders:new-workspace': {
    request: z.strictObject({ name: z.string().min(1).max(256), label: label.optional(), approval: folderApproval, trusted: z.boolean(), agent: agentKind.nullable() }),
    reply: outcome({ added: z.boolean(), label: capped(RUNNER_LIMITS.folderLabel).optional(), message: capped(CAPS.words).optional() }),
  },
  'folders:update': {
    request: z.strictObject({
      label,
      changes: z.strictObject({ access: folderAccess.optional(), approval: folderApproval.optional(), isolation: folderIsolation.optional(), trusted: z.boolean().optional(), agent: agentKind.nullable().optional() }),
    }),
    reply: outcome({ updated: z.boolean() }),
  },
  'folders:remove': { request: z.strictObject({ label }), reply: outcome({ label: capped(RUNNER_LIMITS.folderLabel) }) },

  'agents:inspect': { request: noRequest, reply: z.array(agentView) },
  // Where a coding agent is, when it is not found by itself, is picked in a native file dialog of the main process.
  'agents:set-path': { request: z.strictObject({ kind: agentKind }), reply: outcome({ picked: z.boolean(), detection: agentDetection.optional() }) },
  'agents:clear-path': { request: z.strictObject({ kind: agentKind }), reply: outcome({ cleared: z.boolean() }) },

  'pause:set': { request: z.strictObject({ paused: z.boolean() }), reply: outcome({ changed: z.boolean() }) },

  'mcp:list': { request: noRequest, reply: z.array(mcpServerView).transform((servers) => servers.slice(0, MCP_LIMITS.servers)) },
  // What the server is and how it is run is shown in a native dialog, in the words of the command itself, before anything is kept.
  'mcp:add': {
    request: z.strictObject({
      label: z.string().min(1).max(MCP_LIMITS.serverLabel),
      command: z.string().min(1).max(1_000),
      args: z.array(z.string().max(1_000)).max(50),
      env: z.array(z.string().max(2_000)).max(50),
      folder: z.string().min(1).max(RUNNER_LIMITS.folderLabel).nullable(),
    }),
    reply: outcome({ added: z.boolean(), label: capped(MCP_LIMITS.serverLabel).optional() }),
  },
  'mcp:remove': { request: z.strictObject({ label }), reply: outcome({ label: capped(MCP_LIMITS.serverLabel) }) },
  'mcp:tools': { request: z.strictObject({ label }), reply: outcome({ label: capped(MCP_LIMITS.serverLabel), tools: z.array(mcpToolView).transform((tools) => tools.slice(0, MCP_LIMITS.tools)) }) },
  'mcp:approve': {
    request: z.strictObject({ label, tools: z.array(z.string().min(1).max(MCP_LIMITS.toolName)).max(MCP_LIMITS.tools) }),
    reply: outcome({ approved: z.array(capped(MCP_LIMITS.toolName)), waiting: z.number() }),
  },
  'mcp:deny': { request: z.strictObject({ label, tools: z.array(z.string().min(1).max(MCP_LIMITS.toolName)).max(MCP_LIMITS.tools) }), reply: outcome({ denied: z.array(capped(MCP_LIMITS.toolName)) }) },

  'pairing:current': { request: noRequest, reply: deviceView.nullable() },
  /** The link that was opened and is waiting to be reviewed, if one is. The code in it stays in the main process. */
  'pairing:pending-link': { request: noRequest, reply: pairLink.nullable() },
  // Either the link that was opened (by its id) or what the owner typed. The office's own words are then shown in a native dialog before the code is used.
  'pairing:pair': {
    request: z.union([
      z.strictObject({ linkId: z.string().min(1).max(64) }),
      z.strictObject({ server: z.string().min(1).max(2_048), code: z.string().min(1).max(32), deviceName: z.string().max(RUNNER_LIMITS.deviceName).optional() }),
    ]),
    reply: outcome({ paired: z.boolean(), deviceName: capped(RUNNER_LIMITS.deviceName).optional(), agentName: capped(CAPS.name).optional(), workspaceName: capped(CAPS.name).optional(), host: capped(CAPS.name).optional() }),
  },

  'doctor:run': { request: noRequest, reply: doctorReport },

  'approvals:list': { request: noRequest, reply: z.array(pendingApproval) },
  'approvals:answer': { request: z.strictObject({ taskId: z.string().min(1).max(TASK_LIMITS.taskId), askId: z.string().min(1).max(64), answer: z.enum(['approved', 'denied']) }), reply: outcome({ answered: z.boolean() }) },

  'app:info': { request: noRequest, reply: appInfo },
  'app:set-launch-at-login': { request: z.strictObject({ enabled: z.boolean() }), reply: outcome({ launchAtLogin: z.boolean() }) },
  'app:check-update': { request: noRequest, reply: updateState },
  /** Asks the owner in a native dialog, and only a yes downloads the update. */
  'app:accept-update': { request: noRequest, reply: updateState },
} as const;

export type ChannelName = keyof typeof CHANNELS;
export const CHANNEL_NAMES = Object.keys(CHANNELS) as readonly ChannelName[];

/** Whether a value names a channel: the table's own keys, and not what an object inherits. */
export const isChannelName = (value: unknown): value is ChannelName => typeof value === 'string' && Object.hasOwn(CHANNELS, value);

export type Request<C extends ChannelName> = z.input<(typeof CHANNELS)[C]['request']>;
export type Reply<C extends ChannelName> = z.output<(typeof CHANNELS)[C]['reply']>;

// --- what the main process tells the window, over one channel -----------------------------------------------------

export const eventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('connection'), view: connectionView }),
  z.object({ kind: z.literal('tasks'), view: tasksView }),
  z.object({ kind: z.literal('approvals'), pending: z.array(pendingApproval) }),
  /** Something the runner did for the owner that they may like to know. */
  z.object({ kind: z.literal('notice'), message: capped(CAPS.words) }),
  /** Something went wrong that is not the end of a task. */
  z.object({ kind: z.literal('problem'), message: capped(CAPS.words) }),
  /** A pairing link was opened: the window shows it for review and asks for nothing by itself. */
  z.object({ kind: z.literal('pair-link'), ...pairLink.shape }),
  z.object({ kind: z.literal('update'), update: updateState }),
]);
export type RunnerEvent = z.output<typeof eventSchema>;

// --- what the window is given to call, and what the wire carries ---------------------------------------------------

/** The names of the two wires of Electron: one for a call and its answer, one for what the main process pushes. */
export const WIRE = { call: 'runner:call', event: 'runner:event' } as const;

/** What a call is wrapped in: an answer, or a refusal with words, never a thrown error (Electron adds its own text to those). */
export type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** The words of every refusal of a call that is not one the window may make, so that it learns nothing of why. */
export const REFUSED = 'The app refused that request.';

/** What the window may call: the same list of names, with the types of what each takes and gives. */
export interface RunnerApi {
  call<C extends ChannelName>(channel: C, request: Request<C>): Promise<Reply<C>>;
  /** Listens to what the main process pushes. Gives what stops the listening. */
  onEvent(listener: (event: RunnerEvent) => void): () => void;
}

/** The name the preload gives the API in the window. */
export const API_NAME = 'escritoriioRunner';
