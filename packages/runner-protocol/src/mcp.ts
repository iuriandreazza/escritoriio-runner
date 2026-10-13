import { z } from 'zod';
import { RUNNER_LIMITS } from './protocol.ts';
import { oneLine } from './text.ts';

/**
 * The ceilings on what a machine and the office say of the MCP servers that run on the machine. The office keeps the same numbers for the
 * servers it reaches over the web (`MCP_*` in its shared package); they are written again here because this package is published and
 * imports nothing private, and a test of the office keeps the two alike.
 */
export const MCP_LIMITS = {
  requestId: 64,
  serverLabel: RUNNER_LIMITS.folderLabel,
  servers: 20,
  serverName: 100,
  tools: 200,
  toolName: 128,
  title: 200,
  description: 4_000,
  /** One schema, as the characters of its JSON. */
  schemaChars: 32_000,
  /** Every definition of a list together, as bytes of JSON: what the office keeps of a server's tools at most. */
  definitionsBytes: 80_000,
  argumentsChars: 8_000,
  resultChars: 64 * 1024,
  /** How long a request may take: the office may ask for less, never for more. */
  callMs: 30_000,
} as const;

/** What a message weighs on the wire: its bytes, which are more than its characters when it holds anything but plain ASCII. */
export const frameBytes = (message: unknown): number => new TextEncoder().encode(JSON.stringify(message)).length;

/**
 * Why a request to a local server came to nothing, as a code: the office writes the words, since the server's own words (and the
 * machine's) may carry what must not leave it.
 */
export const MCP_FAILURES = [
  /** The machine has no server by that label (any more). */
  'no-server',
  /** The tool is not one its owner approved on this machine, or it is no longer as it was approved there. */
  'not-approved',
  /** The machine is paused. */
  'paused',
  /** The machine is serving other requests already. */
  'busy',
  /** The program did not start, or ended before it answered. */
  'unreachable',
  'timeout',
  /** What the program said was not what an MCP server says. */
  'protocol',
  'too-large',
  /** The arguments do not fit what the tool was approved to take. */
  'bad-arguments',
  /** The answer is not the one the tool promised. */
  'bad-answer',
] as const;
export type McpFailure = (typeof MCP_FAILURES)[number];

/** What an id of a request is made of: the office makes it, and the machine only gives it back. */
const requestId = z.string().regex(new RegExp(`^[A-Za-z0-9_-]{1,${MCP_LIMITS.requestId}}$`));

/** The label of a local server: what the office calls it, never a command. */
export const mcpServerLabel = oneLine(MCP_LIMITS.serverLabel);

const toolName = z.string().min(1).max(MCP_LIMITS.toolName);

/** An object that is no larger, as JSON, than `max` characters: a schema or the arguments of a call. */
const smallObject = (max: number) => z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= max, 'too large');

/** What the office asks of a machine: to say which tools a local server has, or to call one. Nothing here says how a server is run: that is the machine's own. */
export const mcpListRequestSchema = z.object({ type: z.literal('mcp.list'), id: requestId, server: mcpServerLabel });
export const mcpCallRequestSchema = z.object({
  type: z.literal('mcp.call'),
  id: requestId,
  server: mcpServerLabel,
  tool: toolName,
  arguments: smallObject(MCP_LIMITS.argumentsChars),
  // Asking for more than the machine allows is asking for what it allows: the ceilings are the machine's, so the request is read, not refused.
  timeoutMs: z.number().int().min(1).transform((ms) => Math.min(ms, MCP_LIMITS.callMs)),
});

/** What a local server says of a tool, as it said it: untrusted text, which the office cleans and limits again as it does what any server says. */
const listedToolSchema = z.object({
  name: toolName,
  title: z.string().max(MCP_LIMITS.title).nullable(),
  description: z.string().max(MCP_LIMITS.description),
  inputSchema: smallObject(MCP_LIMITS.schemaChars),
  outputSchema: smallObject(MCP_LIMITS.schemaChars).nullable(),
  hints: z.object({ readOnly: z.boolean().optional(), destructive: z.boolean().optional(), idempotent: z.boolean().optional(), openWorld: z.boolean().optional() }),
});
export type McpListedToolMessage = z.infer<typeof listedToolSchema>;

const count = z.number().int().min(0).max(10_000);

export const mcpListedSchema = z.object({
  type: z.literal('mcp.listed'),
  id: requestId,
  server: z.object({ name: z.string().max(MCP_LIMITS.serverName) }),
  tools: z.array(listedToolSchema).max(MCP_LIMITS.tools),
  /** How many tools the server has that its owner has not approved on the machine, or that are not as they were approved there: they are not listed. */
  held: count,
  /** How many it has that were left out of the list for being too many or too large to send. */
  omitted: count,
});
export const mcpAnsweredSchema = z.object({ type: z.literal('mcp.answered'), id: requestId, text: z.string().max(MCP_LIMITS.resultChars), isError: z.boolean() });
export const mcpFailedSchema = z.object({ type: z.literal('mcp.failed'), id: requestId, failure: z.enum(MCP_FAILURES) });

export type McpAnsweredMessage = z.infer<typeof mcpAnsweredSchema>;
export type McpListedMessage = z.infer<typeof mcpListedSchema>;
export type McpFailedMessage = z.infer<typeof mcpFailedSchema>;
export type McpListRequest = z.infer<typeof mcpListRequestSchema>;
export type McpCallRequest = z.infer<typeof mcpCallRequestSchema>;
