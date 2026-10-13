import type { McpFailure } from '@escritoriio/runner-protocol';
import type { LocalMcpServer, LocalTool } from '../domain/mcp-server.ts';

/** The MCP servers its owner set up on this machine. Only the owner's own commands write them: nothing that comes from the office does. */
export interface McpServers {
  readonly servers: readonly LocalMcpServer[];
}

export const NO_MCP_SERVERS: McpServers = { servers: [] };

/** What a change of the servers comes to: the servers to keep, and whatever the one who changed them has to know of what it did. */
export interface McpServersEdit<T> {
  /** The servers to keep. The ones that were given, as they are, keep nothing and write nothing. */
  readonly servers: McpServers;
  readonly result: T;
}

/** Where the servers are kept. They are read again at every request, so that what the owner changes is what holds. */
export interface McpServerStore {
  load(): Promise<McpServers>;
  /** Changes the servers as one step, on what is kept when it is made and not on what was read before the owner was asked something. What `change` throws is thrown, and nothing is kept. */
  update<T>(change: (current: McpServers) => McpServersEdit<T>): Promise<T>;
}

/**
 * Why a local server could not be used: a code the office is told, and for the person at this machine alone a few words (`detail`) that never leave
 * it, since what a program says of itself may hold what it was given.
 */
export class LocalMcpError extends Error {
  readonly failure: McpFailure;
  readonly detail: string | undefined;

  constructor(failure: McpFailure, detail?: string) {
    super(detail ?? failure);
    this.name = 'LocalMcpError';
    this.failure = failure;
    this.detail = detail;
  }
}

/** What it takes to start a local server. */
export interface LocalLaunch {
  readonly command: string;
  readonly args: readonly string[];
  /** The whole of its environment: nothing else of the runner's is passed on. */
  readonly env: Readonly<Record<string, string>>;
  /** Where it runs; a folder of its own that is empty, and goes away with it, when there is none. */
  readonly cwd: string | undefined;
}

/** A call of a tool, with the definition its owner approved on this machine: the arguments are checked against the first, and the answer against the second. */
export interface LocalCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>> | null;
}

/** What a tool answered, as the words it sent and whether it says it failed. */
export interface LocalAnswer {
  readonly text: string;
  readonly isError: boolean;
}

/** One running local server, spoken to. Everything it returns is untrusted. Rejects with `LocalMcpError`. */
export interface LocalMcpSession {
  readonly serverName: string;
  listTools(signal: AbortSignal): Promise<LocalTool[]>;
  callTool(call: LocalCall, signal: AbortSignal): Promise<LocalAnswer>;
  /** Ends the server, and does not return before it is gone. */
  close(): Promise<void>;
}

/** Starts local servers and speaks MCP to them over their standard input and output. Rejects with `LocalMcpError`. */
export interface LocalMcpClient {
  open(launch: LocalLaunch, signal: AbortSignal): Promise<LocalMcpSession>;
}
