import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { RUNNER_CLOSE, RUNNER_PROTOCOL_VERSION, runnerSocketAddress } from '@escritoriio/runner-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Scheduler } from '../application/ports.ts';
import type { RunnerEnd } from '../application/runner-connection.ts';
import { RunnerConnection } from '../application/runner-connection.ts';
import type { RunnerStatus } from '../application/status.ts';
import { idleTasks, inventoryOf, pairedDevice } from '../application/testing.ts';
import type { ConnectionEnd } from '../domain/connection-end.ts';
import { eventually, FakeOffice } from '../testing/fake-office.ts';
import { createSystemScheduler } from './system-scheduler.ts';
import { webSocketFactory } from './ws-socket.ts';

let office: FakeOffice;
const stoppers: (() => void)[] = [];

beforeEach(async () => {
  office = await FakeOffice.start();
});

afterEach(async () => {
  for (const stop of stoppers.splice(0)) stop();
  await office.stop();
});

const address = () => runnerSocketAddress(office.origin);

/** Opens a connection the way the runner does, and keeps what it tells. */
function dial(token = 'a-token', to = address()) {
  const told: string[] = [];
  const ends: ConnectionEnd[] = [];
  const socket = webSocketFactory.open(to, token, {
    onOpen: () => void told.push('open'),
    onMessage: (raw) => void told.push(raw),
    onEnd: (end) => void ends.push(end),
  });
  stoppers.push(() => socket.close());
  return { socket, told, ends };
}

describe('the socket of the runner', () => {
  it('opens with the token in the Authorization header and no Origin', async () => {
    const { told } = dial('secret-token');
    await eventually(() => expect(told).toEqual(['open']));
    expect(office.sockets[0]?.authorization).toBe('Bearer secret-token');
    expect(office.sockets[0]?.origin).toBeUndefined();
  });

  it('sends what the runner says as text, and hands over what the office says', async () => {
    const { socket, told } = dial();
    await eventually(() => expect(told).toEqual(['open']));
    socket.send({ type: 'ping' });
    await eventually(() => expect(office.sockets[0]?.messages).toEqual([{ type: 'ping' }]));
    await eventually(() => expect(told).toEqual(['open', '{"type":"pong"}']));
  });

  it('does not hand over what is not text', async () => {
    const { told } = dial();
    await eventually(() => expect(told).toEqual(['open']));
    office.sockets[0]?.sendBinary(Buffer.from('{"type":"pong"}'));
    office.sockets[0]?.send({ type: 'pong' });
    await eventually(() => expect(told).toEqual(['open', '{"type":"pong"}']));
  });

  it('tells how the office closed it, once', async () => {
    const { ends, told } = dial();
    await eventually(() => expect(told).toEqual(['open']));
    office.sockets[0]?.close(RUNNER_CLOSE.revoked, 'This machine was removed in the office');
    await eventually(() => expect(ends).toHaveLength(1));
    expect(ends).toEqual([{ kind: 'closed', code: RUNNER_CLOSE.revoked }]);
  });

  it('tells that a connection was cut, as the code of a close that never came', async () => {
    const { ends, told } = dial();
    await eventually(() => expect(told).toEqual(['open']));
    office.sockets[0]?.drop();
    await eventually(() => expect(ends).toHaveLength(1));
    expect(ends[0]).toEqual({ kind: 'closed', code: 1006 });
  });

  it.each([401, 403, 429, 503])('tells the status when the office answers %i instead of opening, and only that, once', async (status) => {
    office.refuseSocketsWith = status;
    const { ends, told } = dial();
    await eventually(() => expect(ends).toHaveLength(1));
    // What the library does after that, with the request that was cut, must not reach the runner as anything more.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ends).toEqual([{ kind: 'refused', status }]);
    expect(told).toEqual([]);
  });

  it('tells that there was nobody to answer', async () => {
    const to = address();
    await office.stop();
    const { ends } = dial('a-token', to);
    await eventually(() => expect(ends).toHaveLength(1));
    expect(ends[0]).toMatchObject({ kind: 'failed', reason: expect.stringContaining('ECONNREFUSED') });
    office = await FakeOffice.start();
  });

  it('says nothing more once the runner hung up, and tells the office that it did', async () => {
    const { socket, ends, told } = dial();
    await eventually(() => expect(told).toEqual(['open']));
    socket.close();
    expect(await office.sockets[0]?.closed).toEqual({ code: 1000, reason: 'The runner stopped' });
    office.sockets[0]?.send({ type: 'pong' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(told).toEqual(['open']);
    expect(ends).toEqual([]);
  });

  it('can be hung up while it is still being opened, whatever the other side does', async () => {
    // A server that takes the connection and never answers: the runner is stuck in the opening.
    const silent = createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { socket, ends, told } = dial('a-token', `ws://127.0.0.1:${(silent.address() as AddressInfo).port}/runner`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(told).toEqual([]);
    expect(ends).toEqual([]);
    silent.close();
  });
});

/** The scheduler of the runner with its waits made fifty times shorter, so that a real connection can be seen to wait and try again. */
function fastScheduler(): Scheduler {
  const real = createSystemScheduler();
  return { now: real.now, after: (ms, task) => real.after(ms / 50, task), random: () => 0.5 };
}

/** A runner with the pairing it would have after `pair`, against the fake office, and what it said while it ran. */
function runRunner() {
  const statuses: RunnerStatus[] = [];
  const connection = new RunnerConnection({
    device: { ...pairedDevice, server: office.origin },
    runnerVersion: '0.1.0',
    os: 'darwin',
    sockets: webSocketFactory,
    scheduler: fastScheduler(),
    inventory: inventoryOf({ agents: [{ kind: 'claude-code', version: '2.1.0', loggedIn: true }], folders: ['site'] }),
    ...idleTasks,
    report: (status) => void statuses.push(status),
  });
  let end: RunnerEnd | undefined;
  connection.start().then((result) => (end = result));
  stoppers.push(() => connection.stop());
  return { connection, statuses, ended: () => end };
}

describe('the whole connection, over a real socket', () => {
  it('says hello with the token, is welcomed, and says it is connected', async () => {
    const { statuses } = runRunner();
    await eventually(() => expect(statuses).toHaveLength(1));
    expect(office.sockets[0]?.authorization).toBe(`Bearer ${pairedDevice.token}`);
    expect(office.sockets[0]?.messages).toEqual([
      { type: 'hello', protocol: RUNNER_PROTOCOL_VERSION, runnerVersion: '0.1.0', os: 'darwin', agents: [{ kind: 'claude-code', version: '2.1.0', loggedIn: true }], folders: ['site'], mcpServers: [], paused: false, tasks: [] },
    ]);
    expect(statuses[0]).toMatchObject({ kind: 'connected', deviceName: 'Laptop', agentName: 'Robo', workspaceName: 'Acme' });
  });

  it('hangs up with a normal close when it is stopped', async () => {
    const { connection, statuses, ended } = runRunner();
    await eventually(() => expect(statuses).toHaveLength(1));
    connection.stop();
    expect((await office.sockets[0]?.closed)?.code).toBe(1000);
    expect(ended()).toEqual({ reason: 'stopped' });
  });

  it.each([
    [RUNNER_CLOSE.revoked, 'revoked'],
    [RUNNER_CLOSE.unsupportedProtocol, 'unsupported-protocol'],
    [RUNNER_CLOSE.replaced, 'replaced'],
  ])('stops when the office closes it with %i, and does not dial again', async (code, cause) => {
    const { statuses, ended } = runRunner();
    await eventually(() => expect(statuses).toHaveLength(1));
    office.sockets[0]?.close(code, 'reason');
    await eventually(() => expect(ended()).toMatchObject({ reason: cause }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(office.sockets).toHaveLength(1);
  });

  it('stops when the office does not know the token', async () => {
    office.refuseSocketsWith = 401;
    const { ended } = runRunner();
    await eventually(() => expect(ended()).toMatchObject({ reason: 'unknown-device' }));
  });

  it('waits long to try again when the office says the machine is not allowed for now', async () => {
    office.refuseSocketsWith = 403;
    const { statuses, ended } = runRunner();
    await eventually(() => expect(statuses).toHaveLength(1));
    expect(statuses[0]).toMatchObject({ kind: 'reconnecting', slow: true, inMs: 5 * 60_000 });
    expect(ended()).toBeUndefined();
  });

  it('dials again when the connection is cut, and says hello again', async () => {
    const { statuses } = runRunner();
    await eventually(() => expect(statuses).toHaveLength(1));
    office.sockets[0]?.drop();
    await eventually(() => expect(statuses.map((status) => status.kind)).toEqual(['connected', 'reconnecting', 'connected']));
    expect(office.sockets).toHaveLength(2);
    expect(office.sockets[1]?.messages[0]).toMatchObject({ type: 'hello' });
  });

  it('tries again while the office is unavailable, and connects when it is back', async () => {
    office.refuseSocketsWith = 503;
    const { statuses } = runRunner();
    await eventually(() => expect(statuses.filter((status) => status.kind === 'reconnecting').length).toBeGreaterThanOrEqual(2));
    office.refuseSocketsWith = undefined;
    await eventually(() => expect(statuses.at(-1)).toMatchObject({ kind: 'connected' }));
  });

  it('keeps pinging, and keeps the connection while the office answers', async () => {
    const { statuses } = runRunner();
    await eventually(() => expect(statuses).toHaveLength(1));
    await eventually(() => expect(office.sockets[0]?.messages.filter((message) => message.type === 'ping').length).toBeGreaterThanOrEqual(3));
    expect(office.sockets).toHaveLength(1);
    expect(statuses).toHaveLength(1);
  });

  it('leaves a link that stopped answering, and dials again', async () => {
    office.answerPings = false;
    const { statuses } = runRunner();
    await eventually(() => expect(statuses).toHaveLength(1));
    await eventually(() => expect(office.sockets).toHaveLength(2));
    expect(statuses.slice(0, 2).map((status) => status.kind)).toEqual(['connected', 'reconnecting']);
    expect(office.sockets[0]?.messages.filter((message) => message.type === 'ping')).toHaveLength(2);
  });

  it('is paused when the office says so, over the socket', async () => {
    const { statuses } = runRunner();
    await eventually(() => expect(statuses).toHaveLength(1));
    office.sockets[0]?.send({ type: 'paused', paused: true });
    await eventually(() => expect(statuses).toContainEqual({ kind: 'paused-by-office', paused: true }));
  });
});
