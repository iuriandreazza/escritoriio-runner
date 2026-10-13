import { describe, expect, it } from 'vitest';
import { frameBytes, MAX_RUNNER_MESSAGE_BYTES, MCP_LIMITS, parseRunnerMessage, parseServerMessage, RUNNER_PROTOCOL_VERSION } from './index.ts';

const hello = { type: 'hello', protocol: RUNNER_PROTOCOL_VERSION, runnerVersion: '0.1.0', os: 'darwin', agents: [], folders: [], paused: false };

const tool = { name: 'search', title: null, description: 'Looks a word up.', inputSchema: { type: 'object' }, outputSchema: null, hints: { readOnly: true } };
const listed = { type: 'mcp.listed', id: 'r1', server: { name: 'Notes' }, tools: [tool], held: 0, omitted: 0 };

describe('the local MCP servers a machine says it has', () => {
  it('says none when an older runner says nothing', () => {
    expect(parseRunnerMessage(JSON.stringify(hello))).toMatchObject({ ok: true, message: { mcpServers: [] } });
  });

  it('carries their labels, and only labels', () => {
    const parsed = parseRunnerMessage(JSON.stringify({ ...hello, mcpServers: ['notes', 'files'] }));
    expect(parsed).toMatchObject({ ok: true, message: { mcpServers: ['notes', 'files'] } });
  });

  it('caps how many there are and how long a label is', () => {
    const many = Array.from({ length: MCP_LIMITS.servers + 1 }, (_, index) => `s${index}`);
    expect(parseRunnerMessage(JSON.stringify({ ...hello, mcpServers: many })).ok).toBe(false);
    expect(parseRunnerMessage(JSON.stringify({ ...hello, mcpServers: ['x'.repeat(MCP_LIMITS.serverLabel + 1)] })).ok).toBe(false);
  });

  it('cleans a label to one line, like every name a runner gives of itself', () => {
    const parsed = parseRunnerMessage(JSON.stringify({ ...hello, mcpServers: ['no‪tes\nt'] }));
    expect(parsed).toMatchObject({ ok: true, message: { mcpServers: ['no tes t'] } });
  });
});

describe('what the office asks of a local MCP server', () => {
  const list = { type: 'mcp.list', id: 'r1', server: 'notes' };
  const call = { type: 'mcp.call', id: 'r2', server: 'notes', tool: 'search', arguments: { q: 'milk' }, timeoutMs: 20_000 };

  it('reads a request to list the tools and a request to call one', () => {
    expect(parseServerMessage(JSON.stringify(list))).toEqual({ ok: true, message: list });
    expect(parseServerMessage(JSON.stringify(call))).toEqual({ ok: true, message: call });
  });

  it('reads a request for more time as a request for what the machine allows', () => {
    expect(parseServerMessage(JSON.stringify({ ...call, timeoutMs: 10 * 60_000 }))).toMatchObject({ ok: true, message: { timeoutMs: MCP_LIMITS.callMs } });
  });

  it('knows no command, argument list or environment of a server: what the office adds to a request is not read', () => {
    const imposed = parseServerMessage(JSON.stringify({ ...call, command: 'rm', args: ['-rf', '/'], env: { PATH: '/tmp' }, cwd: '/' }));
    expect(imposed.ok && imposed.message).toEqual(call);
    const imposedList = parseServerMessage(JSON.stringify({ ...list, command: 'rm' }));
    expect(imposedList.ok && imposedList.message).toEqual(list);
  });

  it.each([
    ['an id that is not one', { ...call, id: 'a b' }],
    ['a request without an id', { ...call, id: undefined }],
    ['a server that is not named', { ...call, server: '' }],
    ['arguments that are not an object', { ...call, arguments: 'q=milk' }],
    ['arguments that are a list', { ...call, arguments: ['milk'] }],
    ['arguments too large to read first', { ...call, arguments: { q: 'x'.repeat(MCP_LIMITS.argumentsChars) } }],
    ['a tool that is not named', { ...call, tool: '' }],
    ['no time to call in', { ...call, timeoutMs: 0 }],
  ])('refuses %s', (_what, message) => {
    expect(parseServerMessage(JSON.stringify(message)).ok).toBe(false);
  });
});

describe('what a machine answers', () => {
  it('reads the tools a local server has, with what was left out of the list and why', () => {
    expect(parseRunnerMessage(JSON.stringify({ ...listed, held: 2, omitted: 1 }))).toEqual({ ok: true, message: { ...listed, held: 2, omitted: 1 } });
  });

  it('reads what a tool answered, and that it failed when it did', () => {
    const answered = { type: 'mcp.answered', id: 'r2', text: 'Two notes.', isError: false };
    expect(parseRunnerMessage(JSON.stringify(answered))).toEqual({ ok: true, message: answered });
    expect(parseRunnerMessage(JSON.stringify({ ...answered, isError: true })).ok).toBe(true);
  });

  it('reads why a request came to nothing, by a code and never by words of the server', () => {
    expect(parseRunnerMessage(JSON.stringify({ type: 'mcp.failed', id: 'r2', failure: 'not-approved' }))).toEqual({ ok: true, message: { type: 'mcp.failed', id: 'r2', failure: 'not-approved' } });
    expect(parseRunnerMessage(JSON.stringify({ type: 'mcp.failed', id: 'r2', failure: 'my own words' })).ok).toBe(false);
  });

  it('caps what a tool may be and say', () => {
    const withTool = (changes: object) => JSON.stringify({ ...listed, tools: [{ ...tool, ...changes }] });
    expect(parseRunnerMessage(withTool({ name: 'x'.repeat(MCP_LIMITS.toolName + 1) })).ok).toBe(false);
    expect(parseRunnerMessage(withTool({ title: 'x'.repeat(MCP_LIMITS.title + 1) })).ok).toBe(false);
    expect(parseRunnerMessage(withTool({ description: 'x'.repeat(MCP_LIMITS.description + 1) })).ok).toBe(false);
    expect(parseRunnerMessage(withTool({ inputSchema: { description: 'x'.repeat(MCP_LIMITS.schemaChars) } })).ok).toBe(false);
    expect(parseRunnerMessage(JSON.stringify({ ...listed, tools: Array.from({ length: MCP_LIMITS.tools + 1 }, (_, index) => ({ ...tool, name: `t${index}` })) })).ok).toBe(false);
    expect(parseRunnerMessage(JSON.stringify({ type: 'mcp.answered', id: 'r2', text: 'x'.repeat(MCP_LIMITS.resultChars + 1), isError: false })).ok).toBe(false);
  });

  it('does not read an answer with no id to match it to a request', () => {
    expect(parseRunnerMessage(JSON.stringify({ type: 'mcp.answered', text: 'hi', isError: false })).ok).toBe(false);
  });
});

describe('what fits in a frame', () => {
  it('counts a message by the bytes it takes on the wire, which is more than its characters', () => {
    expect(frameBytes({ type: 'ping' })).toBe(15);
    expect(frameBytes({ text: 'é' })).toBe(JSON.stringify({ text: 'é' }).length + 1);
  });

  it('keeps a plain answer of the largest size, and the largest list of definitions, under a frame', () => {
    // The characters of a result that escape to six each (control characters) are what make a result larger than a frame.
    const answered = { type: 'mcp.answered', id: 'r'.repeat(64), text: '\u0001'.repeat(MCP_LIMITS.resultChars), isError: false };
    expect(frameBytes(answered)).toBeGreaterThan(MAX_RUNNER_MESSAGE_BYTES);
    const plain = { ...answered, text: 'x'.repeat(MCP_LIMITS.resultChars) };
    expect(frameBytes(plain)).toBeLessThan(MAX_RUNNER_MESSAGE_BYTES);
    expect(MCP_LIMITS.definitionsBytes).toBeLessThan(MAX_RUNNER_MESSAGE_BYTES);
  });
});
