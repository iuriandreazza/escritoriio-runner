import type { CodingAgentFound, PairingPreview, PairRequest, PairResponse, RunnerToServer } from '@escritoriio/runner-protocol';
import type { ConnectionEnd } from '../domain/connection-end.ts';
import type { PairedDevice } from '../domain/paired-device.ts';

/**
 * The two calls that turn a pairing code into a device. Whatever goes wrong is thrown as an `Error` whose message can be shown to a
 * person as it is: the office's own words when it refused, or what happened to the request.
 */
export interface PairingApi {
  /** Who the code would pair this machine with. The code is not used up. */
  preview(server: string, code: string): Promise<PairingPreview>;
  /** Uses the code up. The token in the answer is shown this once. */
  pair(server: string, request: PairRequest): Promise<PairResponse>;
}

/** Where the one pairing of this machine is kept. The token in it is a secret: an adapter keeps it as safely as the place it lives in allows. */
export interface DeviceStore {
  load(): Promise<PairedDevice | undefined>;
  /** Fails when a pairing could not be kept. Asked before a code is used up, since the token the office gives for it is shown once and cannot be had again. */
  ensureWritable(): Promise<void>;
  save(device: PairedDevice): Promise<void>;
}

export interface SystemInfo {
  /** The name of the operating system, as `process.platform` writes it. */
  os(): string;
  /** What this machine calls itself: the device name when the person gives none. */
  deviceName(): string;
}

/** What `hello` says about the machine: the coding agents found on it, the labels of the folders its person shares and of the MCP servers they set up, and whether they paused it on the machine itself. */
export interface MachineInventory {
  readonly agents: readonly CodingAgentFound[];
  readonly folders: readonly string[];
  readonly mcpServers: readonly string[];
  readonly paused: boolean;
}

export interface Inventory {
  read(): Promise<MachineInventory>;
}

/** Time and chance, so that a wait of a minute is a line of a test and not a minute of it. */
export interface Scheduler {
  /** The time now, in milliseconds. */
  now(): number;
  /** Runs `task` once, after `ms`. The function that comes back cancels it. */
  after(ms: number, task: () => void): () => void;
  /** A number from 0 up to, but not including, 1. */
  random(): number;
}

/** What the office answered to a plain request for its health, which is how it is reached without connecting as the device. */
export type OfficeReach =
  | {
      readonly reached: true;
      readonly status: number;
      /** The `Date` header of the answer, if it had one. */
      readonly date: string | null;
      /** The time before the request was sent and after the answer came, on this machine's clock. */
      readonly sentAt: number;
      readonly receivedAt: number;
      /** The oldest runner the office lets in, when it says. */
      readonly minRunnerVersion: string | undefined;
    }
  | { readonly reached: false; readonly reason: string };

/** Asks an office whether it is there. It never opens the runner's socket: a second connection of the same device would replace the first. */
export interface OfficeProbe {
  reach(server: string): Promise<OfficeReach>;
}

/** The one connection of this machine to the office, across every process of the runner on it: whoever holds it is the one that is connected. */
export interface ConnectionLock {
  /** Takes the lock. What comes back gives it up. Nothing comes back when another process holds it. */
  acquire(): Promise<(() => Promise<void>) | undefined>;
}

/** What a connection tells whoever opened it. */
export interface SocketHandlers {
  onOpen(): void;
  /** A text frame. */
  onMessage(raw: string): void;
  /** The connection is over, or never was one. Called once. */
  onEnd(end: ConnectionEnd): void;
}

export interface RunnerSocket {
  /** Only after `onOpen`. */
  send(message: RunnerToServer): void;
  /** Hangs up, without waiting for the other side. After this none of the handlers is called. */
  close(): void;
}

/** Dials out to the office. The token goes in the request that opens the connection, and in nothing that is logged. */
export interface SocketFactory {
  open(address: string, token: string, handlers: SocketHandlers): RunnerSocket;
}

/** What ended a program that is asked to stop: Ctrl-C, or the system asking it to end. */
export type InterruptSignal = 'SIGINT' | 'SIGTERM';

/** What a command needs of a terminal, so that a test can be the person at it. */
export interface Terminal {
  out(line: string): void;
  err(line: string): void;
  /** Asks a question and gives the answer. An input that ended gives an empty one, and so does a `signal` that aborts: the question is taken away. */
  ask(question: string, signal?: AbortSignal): Promise<string>;
  /** Calls `handler` when the person presses Ctrl-C or the process is asked to end, with which of the two it was. Gives back what undoes it. */
  onInterrupt(handler: (signal: InterruptSignal) => void): () => void;
}
