import { MCP_LIMITS } from '@escritoriio/runner-protocol';
import type { LocalMcpServer, LocalTool } from './mcp-server.ts';
import { standingOf } from './mcp-server.ts';

/** A tool a local server lists, with the hash of its definition. */
export interface FoundTool {
  readonly tool: LocalTool;
  readonly hash: string;
}

export interface Offer {
  /** The tools to tell the office of. */
  readonly tools: readonly LocalTool[];
  /** How many the server has that were not approved on this machine, or are not as they were approved: they are not told of. */
  readonly held: number;
  /** How many were left out for being too many or too large to send. */
  readonly omitted: number;
}

const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
const cut = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max));

/**
 * What a machine tells the office of the tools of a local server: only the ones its owner approved here, and only as they were when approved
 * (a tool whose definition changed is held back, not shown with its new words). What the office is told is within what it takes, so that a
 * server with many or large tools cannot make the list too large for a message: a description is cut, and a tool whose schema is too large
 * or that would go past the budget of a list is left out.
 */
export function offerTools(server: Pick<LocalMcpServer, 'approved'>, found: readonly FoundTool[]): Offer {
  const tools: LocalTool[] = [];
  let held = 0;
  let omitted = 0;
  let weight = 0;
  for (const { tool, hash } of found) {
    if (standingOf(server, tool.name, hash) !== 'approved') {
      held += 1;
      continue;
    }
    const fits =
      tools.length < MCP_LIMITS.tools &&
      tool.name.length <= MCP_LIMITS.toolName &&
      JSON.stringify(tool.inputSchema).length <= MCP_LIMITS.schemaChars &&
      (tool.outputSchema === null || JSON.stringify(tool.outputSchema).length <= MCP_LIMITS.schemaChars);
    const offered: LocalTool = { ...tool, title: tool.title === null ? null : cut(tool.title, MCP_LIMITS.title), description: cut(tool.description, MCP_LIMITS.description) };
    // The budget is the one the office keeps for a server: what a list weighs as JSON, in bytes.
    const size = byteLength(offered) + 1;
    if (!fits || weight + size > MCP_LIMITS.definitionsBytes) {
      omitted += 1;
      continue;
    }
    weight += size;
    tools.push(offered);
  }
  return { tools, held, omitted };
}
