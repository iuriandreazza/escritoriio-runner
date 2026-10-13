import type { LocalMcpServer, LocalTool } from '../domain/mcp-server.ts';
import { canonicalDefinition } from '../domain/mcp-server.ts';
import type { LocalAnswer, LocalCall, LocalLaunch, LocalMcpClient, LocalMcpSession, McpServers, McpServersEdit, McpServerStore } from './mcp-ports.ts';
import { LocalMcpError, NO_MCP_SERVERS } from './mcp-ports.ts';

/** The hash of a test is the text itself, so that what a test says was approved can be read in it. */
export const textHash = (text: string): string => text;

export const search: LocalTool = { name: 'search', title: null, description: 'Looks a word up.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, outputSchema: null, hints: { readOnly: true } };
export const remove: LocalTool = { name: 'remove', title: null, description: 'Removes a note.', inputSchema: { type: 'object' }, outputSchema: null, hints: {} };

export const approving = (...tools: readonly LocalTool[]): Record<string, string> => Object.fromEntries(tools.map((tool) => [tool.name, textHash(canonicalDefinition(tool))]));

export const notes: LocalMcpServer = { label: 'notes', command: 'notes-server', args: ['--stdio'], env: { NOTES_API_KEY: 'k-123456', REGION: 'eu' }, folder: null, approved: approving(search) };

export class FakeMcpStore implements McpServerStore {
  servers: McpServers;
  /** How many times a change kept something. */
  writes = 0;
  failToLoad: Error | undefined;

  constructor(servers: readonly LocalMcpServer[] = [notes]) {
    this.servers = { servers };
  }

  load(): Promise<McpServers> {
    return this.failToLoad ? Promise.reject(this.failToLoad) : Promise.resolve(this.servers);
  }

  update<T>(change: (current: McpServers) => McpServersEdit<T>): Promise<T> {
    try {
      const { servers, result } = change(this.servers);
      if (servers !== this.servers) this.writes += 1;
      this.servers = servers;
      return Promise.resolve(result);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

export { NO_MCP_SERVERS };

/** What a fake local server does when it is called: answers, fails, or never answers. */
export type FakeBehaviour = LocalAnswer | LocalMcpError | 'hang';

/** A local MCP server that a test scripts: what it lists, how each tool answers, and what it was asked. */
export class FakeLocalMcp implements LocalMcpClient {
  tools: LocalTool[] = [search, remove];
  serverName = 'Fake notes';
  readonly launches: LocalLaunch[] = [];
  readonly calls: LocalCall[] = [];
  /** How each tool answers; a tool with no entry says "ok". */
  readonly behaviour = new Map<string, FakeBehaviour>();
  openFails: Error | undefined;
  listFails: Error | undefined;
  /** Sessions opened and not closed. */
  open_ = 0;
  closed = 0;
  /** Every session waits until its signal aborts, as one whose program does not answer does. */
  hangOnOpen = false;

  open(launch: LocalLaunch, signal: AbortSignal): Promise<LocalMcpSession> {
    this.launches.push(launch);
    if (this.openFails) return Promise.reject(this.openFails);
    this.open_ += 1;
    const session: LocalMcpSession = {
      serverName: this.serverName,
      listTools: () => (this.listFails ? Promise.reject(this.listFails) : Promise.resolve(structuredClone(this.tools))),
      callTool: (call, callSignal) => {
        this.calls.push(call);
        const behaviour = this.behaviour.get(call.name) ?? { text: 'ok', isError: false };
        if (behaviour === 'hang') return untilAborted(callSignal);
        if (behaviour instanceof LocalMcpError) return Promise.reject(behaviour);
        return Promise.resolve(behaviour);
      },
      close: () => {
        this.closed += 1;
        this.open_ -= 1;
        return Promise.resolve();
      },
    };
    return this.hangOnOpen ? untilAborted(signal) : Promise.resolve(session);
  }
}

function untilAborted<T>(signal: AbortSignal): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    const stop = (): void => reject(new LocalMcpError('timeout'));
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
}
