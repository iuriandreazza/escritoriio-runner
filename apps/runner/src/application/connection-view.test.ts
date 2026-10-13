import { describe, expect, it } from 'vitest';
import type { ConnectionEvent, ConnectionView } from './connection-view.ts';
import { deviceView, initialConnectionView, nextConnectionView, sameConnectionView } from './connection-view.ts';

const robo = { host: 'office.example.com', deviceName: 'Laptop', agentName: 'Robo', workspaceName: 'Acme' };
const paired = initialConnectionView(robo, false);
const connected: ConnectionEvent = { kind: 'status', status: { kind: 'connected', ...robo, paused: false } };
const run = (view: ConnectionView, ...events: ConnectionEvent[]) => events.reduce(nextConnectionView, view);

describe('the view of the connection', () => {
  it('starts as not paired, or as offline when there is a pairing, with the owner’s own pause as it is on the machine', () => {
    expect(initialConnectionView(null, false)).toMatchObject({ state: 'not-paired', device: null, paused: false });
    expect(initialConnectionView(robo, true)).toMatchObject({ state: 'offline', device: robo, paused: true, pausedHere: true, pausedByOffice: false });
  });

  it('is connecting from the start of a run, and connected once the office welcomed the machine, with who it works for', () => {
    expect(run(paired, { kind: 'starting' }).state).toBe('connecting');
    expect(run(paired, { kind: 'starting' }, connected)).toMatchObject({ state: 'connected', device: robo, lastError: null, paused: false });
  });

  it('is paused when either the office or the owner paused it, and not when both lifted it', () => {
    let view = run(paired, { kind: 'starting' }, connected);
    view = run(view, { kind: 'status', status: { kind: 'paused-by-office', paused: true } });
    expect(view).toMatchObject({ paused: true, pausedByOffice: true, pausedHere: false });
    view = run(view, { kind: 'paused-here', paused: true });
    expect(view).toMatchObject({ paused: true, pausedByOffice: true, pausedHere: true });
    view = run(view, { kind: 'status', status: { kind: 'paused-by-office', paused: false } });
    expect(view).toMatchObject({ paused: true, pausedByOffice: false, pausedHere: true });
    view = run(view, { kind: 'status', status: { kind: 'paused-on-machine', paused: false } });
    expect(view.paused).toBe(false);
  });

  it('says it is reconnecting, in how long and why, and is connected again when the office welcomes it', () => {
    const view = run(paired, { kind: 'starting' }, connected, { kind: 'status', status: { kind: 'reconnecting', inMs: 4_000, slow: false, reason: 'the connection was lost' } });
    expect(view).toMatchObject({ state: 'reconnecting', retryInMs: 4_000, slowRetry: false, lastError: 'the connection was lost' });
    expect(run(view, connected)).toMatchObject({ state: 'connected', retryInMs: null, lastError: null });
  });

  it('keeps what went wrong in words, without ending the connection', () => {
    const view = run(paired, { kind: 'starting' }, connected, { kind: 'status', status: { kind: 'task-error', message: 'broke' } });
    expect(view.state).toBe('connected');
    expect(view.lastError).toBe('a task could not be handled because of a mistake of the runner: broke');
  });

  it('is offline with the words of why when the run ends for good, and without an error when it was stopped', () => {
    const failed = run(paired, { kind: 'starting' }, connected, { kind: 'ended', end: { reason: 'revoked', message: 'This machine was removed in the office.' } });
    expect(failed).toMatchObject({ state: 'offline', lastError: 'This machine was removed in the office.', pausedByOffice: false });
    expect(run(paired, { kind: 'starting' }, connected, { kind: 'ended', end: { reason: 'stopped' } })).toMatchObject({ state: 'offline', lastError: null });
  });

  it('forgets the pause of the office when the run ends, since only a connection knows it, and keeps the owner’s own', () => {
    const view = run(paired, { kind: 'starting' }, { kind: 'status', status: { kind: 'connected', ...robo, paused: true } }, { kind: 'paused-here', paused: true }, { kind: 'ended', end: { reason: 'stopped' } });
    expect(view).toMatchObject({ pausedByOffice: false, pausedHere: true, paused: true });
  });

  it('says why a run could not begin: not paired, or another runner of this machine is connected', () => {
    expect(run(paired, { kind: 'starting' }, { kind: 'ended', end: { reason: 'already-running', message: 'Another runner is connected.' } })).toMatchObject({ state: 'offline', lastError: 'Another runner is connected.' });
    expect(run(initialConnectionView(null, false), { kind: 'starting' }, { kind: 'ended', end: { reason: 'not-paired', message: 'Not paired.' } })).toMatchObject({ state: 'not-paired', lastError: 'Not paired.' });
  });

  it('follows a pairing that is made or taken away while it is not connected', () => {
    const unpaired = initialConnectionView(null, false);
    expect(run(unpaired, { kind: 'pairing', device: robo })).toMatchObject({ state: 'offline', device: robo });
    expect(run(paired, { kind: 'pairing', device: null })).toMatchObject({ state: 'not-paired', device: null });
  });

  it('tells a view that says the same from one that says something else', () => {
    expect(sameConnectionView(paired, { ...paired, device: { ...robo } })).toBe(true);
    expect(sameConnectionView(paired, run(paired, { kind: 'starting' }))).toBe(false);
  });

  it('shows no token: a device is only its names and the host', () => {
    expect(deviceView({ server: 'https://office.example.com', deviceId: 'd1', token: 'tok-secret', deviceName: 'Laptop', agentName: 'Robo', workspaceName: 'Acme' })).toEqual(robo);
  });
});
