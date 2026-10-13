import { describe, expect, it } from 'vitest';
import type { RunnerStatus } from './status.ts';
import { describeMachine, describePairing, describeStatus, describeTaskNote } from './status.ts';
import { pairedDevice } from './testing.ts';

describe('what a status says to a person', () => {
  it.each<[RunnerStatus, string]>([
    [{ kind: 'connected', host: 'office.example.com', deviceName: 'Laptop', agentName: 'Robo', workspaceName: 'Acme', paused: false }, 'connected to office.example.com as "Laptop", working for Robo of Acme'],
    [{ kind: 'connected', host: 'office.example.com', deviceName: 'Laptop', agentName: 'Robo', workspaceName: 'Acme', paused: true }, 'connected to office.example.com as "Laptop", working for Robo of Acme (paused from the office)'],
    [{ kind: 'paused-by-office', paused: true }, 'paused from the office'],
    [{ kind: 'paused-on-machine', paused: true }, 'paused on this machine: no task is taken, and the one that runs is stopped'],
    [{ kind: 'paused-on-machine', paused: false }, 'resumed on this machine'],
    [{ kind: 'task-error', message: 'Something broke' }, 'a task could not be handled because of a mistake of the runner: Something broke'],
    [{ kind: 'mcp-error', message: 'Something broke' }, 'a request for an MCP server could not be handled because of a mistake of the runner: Something broke'],
    [{ kind: 'paused-by-office', paused: false }, 'resumed from the office'],
    [{ kind: 'reconnecting', inMs: 500, slow: false, reason: 'the connection was lost' }, 'reconnecting in 1s: the connection was lost'],
    [{ kind: 'reconnecting', inMs: 4_200, slow: false, reason: 'the connection was lost' }, 'reconnecting in 5s: the connection was lost'],
    [{ kind: 'reconnecting', inMs: 5 * 60_000, slow: true, reason: 'its AI member is turned off' }, 'waiting in 5 min: its AI member is turned off'],
    [{ kind: 'office-complained' }, 'the office reported a problem with what this runner sent'],
    [{ kind: 'offer-unreadable', taskId: 'abc' }, 'the office offered task abc, which this runner could not read, and was told so: this runner or the office needs updating'],
    [{ kind: 'offer-unreadable', taskId: 'a\u001b[2Jb' }, 'the office offered task a [2Jb, which this runner could not read, and was told so: this runner or the office needs updating'],
  ])('%j is said as %s', (status, line) => {
    expect(describeStatus(status)).toBe(line);
  });
});

describe('what `status` says about the pairing', () => {
  it('is who the machine is paired with, and nothing that proves it is', () => {
    const lines = describePairing(pairedDevice);
    expect(lines).toEqual(['server:    office.example.com', 'AI member: Robo', 'workspace: Acme', 'device:    Laptop']);
    expect(lines.join('\n')).not.toContain(pairedDevice.token);
    expect(lines.join('\n')).not.toContain(pairedDevice.deviceId);
  });

  it('is that it is not paired, with how to pair it', () => {
    expect(describePairing(undefined)).toEqual(['not paired: run escritoriio-runner pair <server> <code>']);
  });
});

describe('the machine', () => {
  it('is not paused, shares nothing and has found nothing to begin with', () => {
    expect(describeMachine({ agents: [], folders: [], mcpServers: [], paused: false })).toEqual([
      'paused:    no',
      'folders:   none shared yet: escritoriio-runner folders add <path>',
      'agents:    none that can be used: escritoriio-runner agents says why',
      'mcp:       none set up yet: escritoriio-runner mcp add <label> -- <program> [arguments]',
    ]);
  });

  it('says that it is paused, which folders it shares and which coding agents it found', () => {
    expect(
      describeMachine({
        paused: true,
        folders: ['site', 'api'],
        mcpServers: ['notes', 'files'],
        agents: [
          { kind: 'claude-code', version: '2.1.250', loggedIn: true },
          { kind: 'codex', version: null, loggedIn: false },
          { kind: 'kimi-code', version: '1.0', loggedIn: null },
        ],
      }),
    ).toEqual([
      'paused:    yes, on this machine: escritoriio-runner resume lifts it',
      'folders:   2 shared: site, api',
      'agents:    claude-code 2.1.250, logged in; codex, not logged in; kimi-code 1.0, login not known',
      'mcp:       2 set up: notes, files',
    ]);
  });
});

describe('a task the machine was offered', () => {
  it.each([
    [{ kind: 'accepted' as const, taskId: 't1' }, 'task t1 taken'],
    [{ kind: 'rejected' as const, taskId: 't1', reason: 'paused' as const }, 'task t1 refused: the machine is paused'],
    [{ kind: 'rejected' as const, taskId: 't1', reason: 'not-contained' as const }, 'task t1 refused: the coding agent cannot be contained on this system and the folder is not trusted'],
    [{ kind: 'rejected' as const, taskId: 't1', reason: 'bad-offer' as const }, 'task t1 refused: the office sent a task this runner could not read'],
    [{ kind: 'ended' as const, taskId: 't1', outcome: 'done' as const, durationMs: 12_400 }, 'task t1 done in 12s'],
    [{ kind: 'ended' as const, taskId: 't1', outcome: 'timeout' as const, durationMs: 1_800_000 }, 'task t1 ended (timeout) after 1800s'],
  ])('is told as %j', (note, text) => {
    expect(describeTaskNote(note)).toBe(text);
  });

  it('is told with an id that the office chose cleaned, and never with what it asked or what came of it', () => {
    expect(describeTaskNote({ kind: 'accepted', taskId: 't\u001b[2J1' })).toBe('task t [2J1 taken');
  });
});
