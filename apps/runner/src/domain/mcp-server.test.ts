import { describe, expect, it } from 'vitest';
import type { LocalMcpServer, LocalTool } from './mcp-server.ts';
import { canonicalDefinition, parseEnvAssignment, problemWithLaunch, standingOf } from './mcp-server.ts';

const tool: LocalTool = { name: 'search', title: null, description: 'Looks a word up.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, outputSchema: null, hints: {} };

const server = (approved: Record<string, string>): LocalMcpServer => ({ label: 'notes', command: 'notes-server', args: [], env: {}, folder: null, approved });

describe('the text a tool is approved by', () => {
  it('is the same however the server ordered the keys of a schema', () => {
    const shuffled: LocalTool = { ...tool, inputSchema: { properties: { q: { type: 'string' } }, type: 'object' } };
    expect(canonicalDefinition(shuffled)).toBe(canonicalDefinition(tool));
  });

  it('changes with the name, the title, the description and both schemas, and not with what the server hints at', () => {
    const base = canonicalDefinition(tool);
    for (const changed of [{ name: 'find' }, { title: 'Search' }, { description: 'Looks a word up, and deletes it.' }, { inputSchema: { type: 'object' } }, { outputSchema: { type: 'object' } }]) {
      expect(canonicalDefinition({ ...tool, ...changed })).not.toBe(base);
    }
    expect(canonicalDefinition({ ...tool, hints: { readOnly: true } })).toBe(base);
  });
});

describe('where a tool stands against what its owner approved on this machine', () => {
  it('is new when it was never approved here', () => {
    expect(standingOf(server({}), 'search', 'h1')).toBe('new');
  });

  it('is approved when its definition is the one that was approved', () => {
    expect(standingOf(server({ search: 'h1' }), 'search', 'h1')).toBe('approved');
  });

  it('has changed when the server now lists it differently: it is not approved again by itself', () => {
    expect(standingOf(server({ search: 'h1' }), 'search', 'h2')).toBe('changed');
  });

  it('is not made approved by another tool being so', () => {
    expect(standingOf(server({ other: 'h1' }), 'search', 'h1')).toBe('new');
  });
});

describe('what is typed for the environment of a server', () => {
  it('is a name and a value', () => {
    expect(parseEnvAssignment('API_KEY=abc=def')).toEqual({ ok: true, name: 'API_KEY', value: 'abc=def' });
    expect(parseEnvAssignment('EMPTY=')).toEqual({ ok: true, name: 'EMPTY', value: '' });
  });

  it.each([
    ['a word with no value', 'API_KEY'],
    ['a name that is not one', '1KEY=x'],
    ['a name with a dash', 'API-KEY=x'],
    ['a name that is the prototype', '__proto__=x'],
    ['a value with a NUL', 'KEY=a\u0000b'],
    ['a value too long to be one', `KEY=${'x'.repeat(5_000)}`],
  ])('refuses %s', (_what, text) => {
    expect(parseEnvAssignment(text).ok).toBe(false);
  });
});

describe('what a person asks to run', () => {
  it('is a program and its arguments', () => {
    expect(problemWithLaunch('npx', ['-y', 'some-server'])).toBeUndefined();
  });

  it.each([
    ['nothing', '', []],
    ['a program with a NUL', 'a\u0000b', []],
    ['a program too long to be a name', 'x'.repeat(2_000), []],
    ['an argument with a NUL', 'npx', ['a\u0000b']],
    ['more arguments than a command line has use for', 'npx', Array.from({ length: 101 }, () => 'x')],
    ['an argument too long to be one', 'npx', ['x'.repeat(5_000)]],
  ])('refuses %s', (_what, command, args) => {
    expect(problemWithLaunch(command, args)).toEqual(expect.any(String));
  });
});
