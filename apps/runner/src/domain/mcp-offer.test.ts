import { MCP_LIMITS } from '@escritoriio/runner-protocol';
import { describe, expect, it } from 'vitest';
import type { LocalMcpServer, LocalTool } from './mcp-server.ts';
import { offerTools } from './mcp-offer.ts';

const tool = (name: string, changes: Partial<LocalTool> = {}): LocalTool => ({ name, title: null, description: `Does ${name}.`, inputSchema: { type: 'object' }, outputSchema: null, hints: {}, ...changes });
const found = (tools: readonly LocalTool[]) => tools.map((one) => ({ tool: one, hash: `h-${one.name}` }));
const server = (approved: Record<string, string>): LocalMcpServer => ({ label: 'notes', command: 'notes-server', args: [], env: {}, folder: null, approved });

describe('what a machine offers of the tools a local server has', () => {
  it('offers the tools its owner approved, as the server lists them now, and says how many it holds back', () => {
    const offer = offerTools(server({ search: 'h-search', delete: 'h-old' }), found([tool('search'), tool('delete'), tool('add')]));
    expect(offer.tools.map((one) => one.name)).toEqual(['search']);
    // One was approved and has changed, one was never approved: neither is offered, and the person is told that there are two.
    expect(offer).toMatchObject({ held: 2, omitted: 0 });
  });

  it('offers nothing of a server whose tools nobody approved here', () => {
    expect(offerTools(server({}), found([tool('search'), tool('add')]))).toEqual({ tools: [], held: 2, omitted: 0 });
  });

  it('cuts a description and a title to what the office takes, and leaves the rest of the tool', () => {
    const long = tool('search', { description: 'x'.repeat(MCP_LIMITS.description + 50), title: 'T'.repeat(MCP_LIMITS.title + 50) });
    const [offered] = offerTools(server({ search: 'h-search' }), found([long])).tools;
    expect(offered?.description).toHaveLength(MCP_LIMITS.description);
    expect(offered?.title).toHaveLength(MCP_LIMITS.title);
    expect(offered?.name).toBe('search');
  });

  it('leaves out a tool whose schema is too large to send or whose name is too long to be one, and counts it', () => {
    const big = tool('big', { inputSchema: { description: 'x'.repeat(MCP_LIMITS.schemaChars) } });
    const named = tool('n'.repeat(MCP_LIMITS.toolName + 1));
    const approved = { big: 'h-big', [named.name]: `h-${named.name}`, ok: 'h-ok' };
    const offer = offerTools(server(approved), found([big, named, tool('ok')]));
    expect(offer.tools.map((one) => one.name)).toEqual(['ok']);
    expect(offer).toMatchObject({ held: 0, omitted: 2 });
  });

  it('stops at the most the office keeps of the definitions of one server, and counts what did not fit', () => {
    const heavy = (name: string) => tool(name, { description: 'd'.repeat(MCP_LIMITS.description), inputSchema: { description: 'x'.repeat(MCP_LIMITS.schemaChars / 2) } });
    const names = Array.from({ length: 10 }, (_, index) => `t${index}`);
    const offer = offerTools(server(Object.fromEntries(names.map((name) => [name, `h-${name}`]))), found(names.map(heavy)));
    const bytes = new TextEncoder().encode(JSON.stringify(offer.tools)).length;
    expect(bytes).toBeLessThanOrEqual(MCP_LIMITS.definitionsBytes);
    expect(offer.tools.length).toBeGreaterThan(0);
    expect(offer.tools.length + offer.omitted).toBe(10);
    expect(offer.omitted).toBeGreaterThan(0);
  });

  it('stops at the most tools a list may have', () => {
    const names = Array.from({ length: MCP_LIMITS.tools + 5 }, (_, index) => `t${index}`);
    const offer = offerTools(server(Object.fromEntries(names.map((name) => [name, `h-${name}`]))), found(names.map((name) => tool(name))));
    expect(offer.tools).toHaveLength(MCP_LIMITS.tools);
    expect(offer.omitted).toBe(5);
  });
});
