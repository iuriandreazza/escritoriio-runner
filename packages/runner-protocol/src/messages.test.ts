import { describe, expect, it } from 'vitest';
import { MAX_RUNNER_MESSAGE_BYTES, parseRunnerMessage, parseServerMessage, RUNNER_LIMITS, RUNNER_PROTOCOL_VERSION } from './index.ts';

const hello = { type: 'hello', protocol: RUNNER_PROTOCOL_VERSION, runnerVersion: '0.1.0', os: 'darwin', agents: [{ kind: 'claude-code', version: '2.1.0', loggedIn: true }], folders: ['site'], paused: false };

describe('what a runner says', () => {
  it('reads a hello', () => {
    // A runner that keeps no journal says none, and is read as having an empty one.
    expect(parseRunnerMessage(JSON.stringify(hello))).toEqual({ ok: true, message: { ...hello, tasks: [], mcpServers: [] } });
  });

  it('reads a ping and a pause', () => {
    expect(parseRunnerMessage('{"type":"ping"}').ok).toBe(true);
    expect(parseRunnerMessage('{"type":"paused","paused":true}').ok).toBe(true);
  });

  it('says to update the runner of another protocol version, before looking at the rest of its hello', () => {
    const other = parseRunnerMessage(JSON.stringify({ type: 'hello', protocol: RUNNER_PROTOCOL_VERSION + 1, somethingNew: true }));
    expect(other).toMatchObject({ ok: false, unsupportedProtocol: true });
    expect(other.ok === false && other.error).toContain('Update the runner');
  });

  it.each([
    ['text that is not JSON', 'hello'],
    ['an unknown type', '{"type":"run","command":"rm -rf /"}'],
    ['a coding agent it does not know', JSON.stringify({ ...hello, agents: [{ kind: 'shell', version: null, loggedIn: null }] })],
    ['a hello without its fields', '{"type":"hello","protocol":1}'],
    ['a pause that is not a boolean', '{"type":"paused","paused":"yes"}'],
  ])('refuses %s', (_what, raw) => {
    expect(parseRunnerMessage(raw).ok).toBe(false);
  });

  it('caps what a hello may carry', () => {
    const tooManyFolders = Array.from({ length: RUNNER_LIMITS.folders + 1 }, (_, index) => `f${index}`);
    expect(parseRunnerMessage(JSON.stringify({ ...hello, folders: tooManyFolders })).ok).toBe(false);
    expect(parseRunnerMessage(JSON.stringify({ ...hello, folders: ['x'.repeat(RUNNER_LIMITS.folderLabel + 1)] })).ok).toBe(false);
    expect(parseRunnerMessage(JSON.stringify({ ...hello, os: 'x'.repeat(RUNNER_LIMITS.os + 1) })).ok).toBe(false);
  });

  it('does not read what is larger than a frame may be', () => {
    expect(parseRunnerMessage(JSON.stringify({ type: 'ping', padding: 'x'.repeat(MAX_RUNNER_MESSAGE_BYTES) })).ok).toBe(false);
  });
});

describe('what the server says', () => {
  it('reads a welcome, a pong, a pause and an error', () => {
    const welcome = { type: 'welcome', protocol: 1, device: { id: 'd1', name: 'Laptop' }, agent: { name: 'Robo' }, workspace: { name: 'Acme' }, paused: false };
    expect(parseServerMessage(JSON.stringify(welcome))).toEqual({ ok: true, message: welcome });
    expect(parseServerMessage('{"type":"pong"}').ok).toBe(true);
    expect(parseServerMessage('{"type":"paused","paused":false}').ok).toBe(true);
    expect(parseServerMessage('{"type":"error","message":"slow down"}').ok).toBe(true);
  });

  it('refuses a welcome with a name that is not a name', () => {
    const long = 'x'.repeat(201);
    const welcome = { type: 'welcome', protocol: 1, device: { id: 'd1', name: 'Laptop' }, agent: { name: 'Robo' }, workspace: { name: 'Acme' }, paused: false };
    for (const bad of [{ ...welcome, device: { id: 'd1', name: long } }, { ...welcome, agent: { name: long } }, { ...welcome, workspace: { name: long } }]) expect(parseServerMessage(JSON.stringify(bad)).ok).toBe(false);
  });

  it('refuses what it does not know', () => {
    expect(parseServerMessage('{"type":"run"}').ok).toBe(false);
    expect(parseServerMessage('nope').ok).toBe(false);
  });
});
