import type { IncomingMessage, Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { RunnerToServer, ServerToRunner } from '@escritoriio/runner-protocol';
import { RUNNER_PAIR_PATHS, RUNNER_PROTOCOL_VERSION, RUNNER_REACH_PATH, RUNNER_SOCKET_PATH } from '@escritoriio/runner-protocol';
import { vi } from 'vitest';
import type { RawData, WebSocket } from 'ws';
import { WebSocketServer } from 'ws';

/** What the fake office makes a device token of; tests look for it where it must never be. */
export const FAKE_TOKEN = 'token-the-fake-office-made-for-a-device';

export interface PairingReply {
  readonly status: number;
  readonly body: string;
  readonly headers?: Record<string, string>;
}

/** A connection a runner opened to the fake office. */
export interface FakeOfficeSocket {
  readonly authorization: string | undefined;
  readonly origin: string | undefined;
  /** What the runner said, as it was said: nothing is checked, so that a test can see what is wrong with it. */
  readonly messages: RunnerToServer[];
  /** Resolves when the connection is over, with what the close said: 1005 when it said nothing, 1006 when it was cut. */
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>;
  send(message: ServerToRunner): void;
  /** A frame that is not text, which the protocol does not use. */
  sendBinary(data: Buffer): void;
  close(code: number, reason: string): void;
  /** Cuts the connection as a network that fails does, with no close frame. */
  drop(): void;
}

/** Waits for what a test expects of a server in another part of the process: for the time it takes, and no longer. */
export const eventually = (check: () => void): Promise<void> => vi.waitFor(check, { timeout: 4_000, interval: 5 });

/**
 * An office, as far as a runner can tell: the two calls that pair it and the socket it dials. Everything is real (HTTP, the upgrade, the
 * frames), so that what a test shows is what happens on a network, and what the runner meets is decided by the test.
 */
export class FakeOffice {
  readonly origin: string;
  readonly sockets: FakeOfficeSocket[] = [];
  readonly pairingCalls: { readonly path: string; readonly contentType: string | undefined; readonly body: unknown }[] = [];
  /** What the two pairing calls answer, or that they are not answered at all. The default is an office that pairs whoever asks. */
  pairingReply: (path: string, body: unknown) => PairingReply | 'silence' = (path, body) => this.agreeToPair(path, body);
  /** When set, the runner socket is refused with this HTTP status, in the raw way the real server does. */
  refuseSocketsWith: number | undefined;
  /** Whether it answers `hello` with `welcome`, as the real one does. */
  answerHello = true;
  /** Whether it answers `ping` with `pong`, as the real one does. */
  answerPings = true;
  /** What the welcome calls the device. */
  deviceName = 'Laptop';
  /** The oldest runner it says it lets in, when it is asked whether it is there. */
  minRunnerVersion: string | undefined = '0.1.0';
  private readonly server: Server;
  private readonly websockets = new WebSocketServer({ noServer: true });
  private readonly connections = new Set<Duplex>();

  private constructor(server: Server) {
    this.server = server;
    this.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    server.on('request', (request, response) => void this.answer(request, (reply) => {
      response.writeHead(reply.status, { 'Content-Type': 'application/json', ...reply.headers });
      response.end(reply.body);
    }));
    server.on('upgrade', (request, socket, head) => this.upgrade(request, socket, head));
    server.on('connection', (connection) => {
      this.connections.add(connection);
      connection.once('close', () => this.connections.delete(connection));
    });
  }

  static async start(): Promise<FakeOffice> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return new FakeOffice(server);
  }

  async stop(): Promise<void> {
    for (const client of this.websockets.clients) client.terminate();
    for (const connection of this.connections) connection.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private agreeToPair(path: string, body: unknown): PairingReply {
    const request = body as { deviceName?: string };
    if (path === RUNNER_REACH_PATH) return { status: 200, body: JSON.stringify({ status: 'ok', revision: 'fake', ...(this.minRunnerVersion ? { minRunnerVersion: this.minRunnerVersion } : {}) }) };
    if (path === RUNNER_PAIR_PATHS.preview) return { status: 200, body: JSON.stringify({ agentName: 'Robo', workspaceName: 'Acme' }) };
    this.deviceName = request.deviceName ?? this.deviceName;
    return { status: 201, body: JSON.stringify({ deviceId: 'device-1', token: FAKE_TOKEN, deviceName: this.deviceName, agentName: 'Robo', workspaceName: 'Acme' }) };
  }

  private async answer(request: IncomingMessage, send: (reply: PairingReply) => void): Promise<void> {
    const path = new URL(request.url ?? '/', this.origin).pathname;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Kept as text: a test may have sent something that is not JSON.
    }
    this.pairingCalls.push({ path, contentType: request.headers['content-type'], body });
    const reply = this.pairingReply(path, body);
    if (reply !== 'silence') send(reply);
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (new URL(request.url ?? '/', this.origin).pathname !== RUNNER_SOCKET_PATH) return void socket.destroy();
    if (this.refuseSocketsWith !== undefined) {
      // As the real server does: the status line and nothing more.
      socket.write(`HTTP/1.1 ${this.refuseSocketsWith} Refused\r\nConnection: close\r\n\r\n`);
      return void socket.destroy();
    }
    this.websockets.handleUpgrade(request, socket, head, (websocket) => this.serve(websocket, request));
  }

  private serve(websocket: WebSocket, request: IncomingMessage): void {
    const messages: RunnerToServer[] = [];
    const send = (message: ServerToRunner) => websocket.send(JSON.stringify(message));
    const closed = new Promise<{ code: number; reason: string }>((resolve) => websocket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    this.sockets.push({
      authorization: request.headers.authorization,
      origin: request.headers.origin,
      messages,
      closed,
      send,
      sendBinary: (data) => websocket.send(data, { binary: true }),
      close: (code, reason) => websocket.close(code, reason),
      drop: () => websocket.terminate(),
    });
    websocket.on('message', (data: RawData) => {
      const message = JSON.parse(data.toString()) as RunnerToServer;
      messages.push(message);
      if (message.type === 'hello' && this.answerHello) {
        send({ type: 'welcome', protocol: RUNNER_PROTOCOL_VERSION, device: { id: 'device-1', name: this.deviceName }, agent: { name: 'Robo' }, workspace: { name: 'Acme' }, paused: false });
      }
      if (message.type === 'ping' && this.answerPings) send({ type: 'pong' });
    });
  }
}
