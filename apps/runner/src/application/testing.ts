import type { PairingPreview, PairRequest, PairResponse, RunnerToServer, ServerToRunner } from '@escritoriio/runner-protocol';
import type { ConnectionEnd } from '../domain/connection-end.ts';
import type { PairedDevice } from '../domain/paired-device.ts';
import type { DeviceStore, Inventory, MachineInventory, OfficeProbe, OfficeReach, PairingApi, RunnerSocket, Scheduler, SocketFactory, SocketHandlers, SystemInfo } from './ports.ts';
import type { RunnerConnectionDeps } from './runner-connection.ts';

/** Lets what is waiting on an answer that is already there run. */
export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A clock that moves only when a test says so, and a chance that is whatever the test sets. */
export class FakeScheduler implements Scheduler {
  /** What `random()` answers: 0.5 makes the wait before a reconnection half of its ceiling. */
  randomValue = 0.5;
  private now_ = 0;
  private nextId = 0;
  private readonly timers = new Map<number, { readonly at: number; readonly task: () => void }>();

  after(ms: number, task: () => void): () => void {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now_ + ms, task });
    return () => void this.timers.delete(id);
  }

  now(): number {
    return this.now_;
  }

  random(): number {
    return this.randomValue;
  }

  /** Sets the clock back, as somebody correcting it would, without running anything. */
  setBack(ms: number): void {
    this.now_ -= ms;
  }

  /** How many things are waiting for their time. */
  get pending(): number {
    return this.timers.size;
  }

  /** Moves the clock on, running what falls due on the way in the order of its time, and lets what that starts settle. */
  async advance(ms: number): Promise<void> {
    const until = this.now_ + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= until).sort(([, a], [, b]) => a.at - b.at)[0];
      if (!due) break;
      const [id, timer] = due;
      this.timers.delete(id);
      this.now_ = Math.max(this.now_, timer.at);
      timer.task();
      await flush();
    }
    this.now_ = until;
    await flush();
  }
}

/** The office's end of a connection the runner opened, played by a test. */
export class FakeSocket implements RunnerSocket {
  readonly sent: RunnerToServer[] = [];
  closedByRunner = false;
  private opened = false;

  readonly address: string;
  readonly token: string;
  private readonly handlers: SocketHandlers;

  constructor(address: string, token: string, handlers: SocketHandlers) {
    this.address = address;
    this.token = token;
    this.handlers = handlers;
  }

  send(message: RunnerToServer): void {
    if (!this.opened) throw new Error('The runner sent something before the connection was open');
    if (this.closedByRunner) throw new Error('The runner sent something after it hung up');
    this.sent.push(message);
  }

  close(): void {
    this.closedByRunner = true;
  }

  open(): void {
    this.opened = true;
    this.handlers.onOpen();
  }

  /** The office says something. Delivered even to a socket the runner has hung up on, as a real one may still do for a moment. */
  receive(message: ServerToRunner | string): void {
    this.handlers.onMessage(typeof message === 'string' ? message : JSON.stringify(message));
  }

  end(end: ConnectionEnd): void {
    this.handlers.onEnd(end);
  }

  sentOfType<T extends RunnerToServer['type']>(type: T): Extract<RunnerToServer, { type: T }>[] {
    return this.sent.filter((message): message is Extract<RunnerToServer, { type: T }> => message.type === type);
  }
}

export class FakeSocketFactory implements SocketFactory {
  readonly sockets: FakeSocket[] = [];

  open(address: string, token: string, handlers: SocketHandlers): FakeSocket {
    const socket = new FakeSocket(address, token, handlers);
    this.sockets.push(socket);
    return socket;
  }

  get latest(): FakeSocket {
    const socket = this.sockets.at(-1);
    if (!socket) throw new Error('The runner has not opened a connection');
    return socket;
  }
}

export const welcome = (overrides: Partial<Extract<ServerToRunner, { type: 'welcome' }>> = {}): ServerToRunner => ({
  type: 'welcome',
  protocol: 1,
  device: { id: 'device-1', name: 'Laptop' },
  agent: { name: 'Robo' },
  workspace: { name: 'Acme' },
  paused: false,
  ...overrides,
});

export const pairedDevice: PairedDevice = {
  server: 'https://office.example.com',
  deviceId: 'device-1',
  token: 'a-token-that-is-never-printed',
  deviceName: 'Laptop',
  agentName: 'Robo',
  workspaceName: 'Acme',
};

/** A place to keep the pairing, that remembers what it was asked, in the order, and can be made to refuse. */
export class FakeDeviceStore implements DeviceStore {
  saved: PairedDevice | undefined;
  refuseToBeWritableWith: Error | undefined;
  refuseToSaveWith: Error | undefined;
  private readonly calls: string[];

  constructor(calls: string[] = []) {
    this.calls = calls;
  }

  load(): Promise<PairedDevice | undefined> {
    return Promise.resolve(this.saved);
  }

  ensureWritable(): Promise<void> {
    this.calls.push('ensureWritable');
    return this.refuseToBeWritableWith ? Promise.reject(this.refuseToBeWritableWith) : Promise.resolve();
  }

  save(device: PairedDevice): Promise<void> {
    this.calls.push('save');
    if (this.refuseToSaveWith) return Promise.reject(this.refuseToSaveWith);
    this.saved = device;
    return Promise.resolve();
  }
}

/** An office that agrees to everything it is asked, and remembers what it was asked. */
export class FakePairingApi implements PairingApi {
  readonly previews: { readonly server: string; readonly code: string }[] = [];
  readonly pairings: { readonly server: string; readonly request: PairRequest }[] = [];
  whoItPairsWith: PairingPreview = { agentName: 'Robo', workspaceName: 'Acme' };
  /** What the office refuses with when it is asked who a code is for, and when it is asked to use the code up. */
  refusePreviewWith: Error | undefined;
  refusePairWith: Error | undefined;
  private readonly calls: string[];

  constructor(calls: string[] = []) {
    this.calls = calls;
  }

  preview(server: string, code: string): Promise<PairingPreview> {
    this.calls.push('preview');
    this.previews.push({ server, code });
    return this.refusePreviewWith ? Promise.reject(this.refusePreviewWith) : Promise.resolve(this.whoItPairsWith);
  }

  pair(server: string, request: PairRequest): Promise<PairResponse> {
    this.calls.push('pair');
    this.pairings.push({ server, request });
    if (this.refusePairWith) return Promise.reject(this.refusePairWith);
    return Promise.resolve({ deviceId: 'device-1', token: pairedDevice.token, deviceName: request.deviceName, agentName: this.whoItPairsWith.agentName, workspaceName: this.whoItPairsWith.workspaceName });
  }
}

export const fakeSystem = (overrides: Partial<{ os: string; deviceName: string }> = {}): SystemInfo => ({
  os: () => overrides.os ?? 'darwin',
  deviceName: () => overrides.deviceName ?? 'Ana\u2019s MacBook',
});

export const inventoryOf = (inventory: Omit<MachineInventory, 'paused' | 'mcpServers'> & { readonly paused?: boolean; readonly mcpServers?: readonly string[] }): Inventory => ({ read: () => Promise.resolve({ paused: false, mcpServers: [], ...inventory }) });

/** Where tasks go when a test is about the connection and not about them: nothing is run, and nothing is remembered. */
export const idleTasks: Pick<RunnerConnectionDeps, 'tasks' | 'journal' | 'mcp'> = {
  tasks: { offer: () => Promise.resolve(), cancel: () => false, setPausedByOffice: () => undefined, localPauseChanged: () => undefined, stopAll: () => undefined },
  journal: { entries: () => [] },
  mcp: { list: (request) => Promise.resolve({ type: 'mcp.failed', id: request.id, failure: 'no-server' }), call: (request) => Promise.resolve({ type: 'mcp.failed', id: request.id, failure: 'no-server' }), setPausedByOffice: () => undefined, stopAll: () => undefined },
};

/** An office that answers a plain request as a test says: reached, with a time and a minimum, or not at all. */
export class FakeOfficeProbe implements OfficeProbe {
  readonly asked: string[] = [];
  reach_: OfficeReach = { reached: true, status: 200, date: new Date(0).toUTCString(), sentAt: 0, receivedAt: 0, minRunnerVersion: undefined };

  reach(server: string): Promise<OfficeReach> {
    this.asked.push(server);
    return Promise.resolve(this.reach_);
  }
}
