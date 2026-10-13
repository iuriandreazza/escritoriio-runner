import { z } from 'zod';
import { CODING_AGENT_KINDS, MAX_RUNNER_MESSAGE_BYTES, RUNNER_LIMITS, RUNNER_PROTOCOL_VERSION } from './protocol.ts';
import { mcpAnsweredSchema, mcpCallRequestSchema, mcpFailedSchema, mcpListedSchema, mcpListRequestSchema, mcpServerLabel, MCP_LIMITS } from './mcp.ts';
import { journalEntrySchema, taskCancelSchema, taskDoneSchema, taskEventSchema, taskFailedSchema, taskOfferSchema, TASK_LIMITS, TASK_REJECTIONS } from './tasks.ts';
import { oneLine, toOneLine } from './text.ts';

const agentFound = z.object({
  kind: z.enum(CODING_AGENT_KINDS),
  /** Null when it is installed and says no version. */
  version: z.string().max(RUNNER_LIMITS.agentVersion).transform(toOneLine).nullable(),
  /** Null when the tool cannot tell. */
  loggedIn: z.boolean().nullable(),
});
export type CodingAgentFound = z.infer<typeof agentFound>;

/** What a runner says to the server. Every field is capped: the code is public, so anybody may write a runner. */
export const runnerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    protocol: z.number().int(),
    runnerVersion: oneLine(RUNNER_LIMITS.runnerVersion),
    os: oneLine(RUNNER_LIMITS.os),
    /** The coding agents it found on the machine and which versions. */
    agents: z.array(agentFound).max(RUNNER_LIMITS.agents),
    /** The labels of the folders its owner chose to share: never a path. */
    folders: z.array(oneLine(RUNNER_LIMITS.folderLabel)).max(RUNNER_LIMITS.folders),
    /** Whether its owner paused it on the machine itself. */
    paused: z.boolean(),
    /** The labels of the MCP servers its owner runs on the machine: never a command. An older runner says none. */
    mcpServers: z.array(mcpServerLabel).max(MCP_LIMITS.servers).default([]),
    /** The tasks it is running or finished lately, so that the office can settle what a dropped connection left unsaid. */
    tasks: z.array(journalEntrySchema).max(TASK_LIMITS.journal).default([]),
  }),
  /** Still here. The server answers `pong`. */
  z.object({ type: z.literal('ping') }),
  /** Its owner paused or resumed it on the machine itself. */
  z.object({ type: z.literal('paused'), paused: z.boolean() }),
  /** It took the task it was offered. */
  z.object({ type: z.literal('task.accept'), taskId: taskDoneSchema.shape.taskId }),
  /** It did not take it, and why: the code for the office, the words for the person. */
  z.object({ type: z.literal('task.reject'), taskId: taskDoneSchema.shape.taskId, reason: z.enum(TASK_REJECTIONS), message: z.string().max(TASK_LIMITS.message) }),
  /** A piece of what the coding agent is doing, in order, and capped. */
  z.object({ type: z.literal('task.event'), taskId: taskDoneSchema.shape.taskId, seq: z.number().int().min(0), event: taskEventSchema }),
  z.object({ type: z.literal('task.done'), ...taskDoneSchema.shape }),
  z.object({ type: z.literal('task.failed'), ...taskFailedSchema.shape }),
  /** What a local MCP server it was asked about has: what its owner approved on the machine, as the server lists it. */
  mcpListedSchema,
  /** What a tool of a local MCP server answered. */
  mcpAnsweredSchema,
  /** Why a request of the office came to nothing. */
  mcpFailedSchema,
]);
export type RunnerToServer = z.infer<typeof runnerMessageSchema>;

/** What the server says to a runner. */
export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('welcome'),
    protocol: z.number().int(),
    device: z.object({ id: z.string().max(64), name: z.string().max(200) }),
    agent: z.object({ name: z.string().max(200) }),
    workspace: z.object({ name: z.string().max(200) }),
    /** Whether its owner paused it from the office. */
    paused: z.boolean(),
  }),
  z.object({ type: z.literal('pong') }),
  /** Its owner paused or resumed it from the office. */
  z.object({ type: z.literal('paused'), paused: z.boolean() }),
  z.object({ type: z.literal('error'), message: z.string().max(500) }),
  /** A task for the machine to do, in a folder its owner shares. Nothing runs before the machine has checked, on its own, that it may. */
  taskOfferSchema,
  taskCancelSchema,
  /** To list the tools of a local MCP server of the machine, or to call one. The machine runs only what its owner set up there. */
  mcpListRequestSchema,
  mcpCallRequestSchema,
]);
export type ServerToRunner = z.infer<typeof serverMessageSchema>;

export type Parsed<T> = { readonly ok: true; readonly message: T } | { readonly ok: false; readonly error: string; readonly unsupportedProtocol?: true };

function parseJson(raw: string): unknown {
  if (raw.length > MAX_RUNNER_MESSAGE_BYTES) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

const helloVersion = z.object({ type: z.literal('hello'), protocol: z.number().int() });

/**
 * A frame from a runner, or why it is not one. A `hello` of another protocol version is told apart before the rest of it is
 * read, since the rest is what the version changes: the server answers it with the way forward and not with a complaint about a field.
 */
export function parseRunnerMessage(raw: string): Parsed<RunnerToServer> {
  const json = parseJson(raw);
  if (json === undefined) return { ok: false, error: 'That is not a message' };
  const hello = helloVersion.safeParse(json);
  if (hello.success && hello.data.protocol !== RUNNER_PROTOCOL_VERSION) {
    return { ok: false, error: `This server speaks runner protocol ${RUNNER_PROTOCOL_VERSION}, not ${hello.data.protocol}. Update the runner.`, unsupportedProtocol: true };
  }
  const parsed = runnerMessageSchema.safeParse(json);
  return parsed.success ? { ok: true, message: parsed.data } : { ok: false, error: 'That message is not valid' };
}

/** A frame from the server, or why it is not one. */
export function parseServerMessage(raw: string): Parsed<ServerToRunner> {
  const json = parseJson(raw);
  if (json === undefined) return { ok: false, error: 'That is not a message' };
  const parsed = serverMessageSchema.safeParse(json);
  return parsed.success ? { ok: true, message: parsed.data } : { ok: false, error: 'That message is not valid' };
}
