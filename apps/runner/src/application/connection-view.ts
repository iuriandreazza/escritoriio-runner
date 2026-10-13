import type { PairedDevice } from '../domain/paired-device.ts';
import { serverHost } from '../domain/paired-device.ts';
import type { RunnerEnd } from './runner-connection.ts';
import type { RunnerStatus } from './status.ts';
import { describeStatus } from './status.ts';

/** Who the machine is paired with, as a screen may show it: the token is not here, and nothing here can be used to connect. */
export interface DeviceView {
  readonly host: string;
  readonly deviceName: string;
  readonly agentName: string;
  readonly workspaceName: string;
}

export const deviceView = (device: PairedDevice): DeviceView => ({ host: serverHost(device.server), deviceName: device.deviceName, agentName: device.agentName, workspaceName: device.workspaceName });

/** How a run ended: as the connection says, or because it could not begin. */
export type RunEnd = RunnerEnd | { readonly reason: 'not-paired'; readonly message: string } | { readonly reason: 'already-running'; readonly message: string };

export type ConnectionState = 'not-paired' | 'offline' | 'connecting' | 'connected' | 'reconnecting';

/** What a screen shows of the connection: plain values, with words for whatever went wrong. */
export interface ConnectionView {
  readonly state: ConnectionState;
  /** Who it is paired with; null when it is not paired. */
  readonly device: DeviceView | null;
  /** Paused by either, which is the only thing a person needs to know to see that no task will be taken. */
  readonly paused: boolean;
  readonly pausedByOffice: boolean;
  /** Paused by its owner on the machine itself. */
  readonly pausedHere: boolean;
  /** While reconnecting: how long until the next try, and whether the office said to wait a long while. */
  readonly retryInMs: number | null;
  readonly slowRetry: boolean;
  /** The last thing that went wrong, in words, until the next connection is made. */
  readonly lastError: string | null;
}

export type ConnectionEvent =
  /** What is known of the pairing: when it is read, and after it changes. */
  | { readonly kind: 'pairing'; readonly device: DeviceView | null }
  | { readonly kind: 'starting' }
  | { readonly kind: 'status'; readonly status: RunnerStatus }
  | { readonly kind: 'ended'; readonly end: RunEnd }
  /** The owner's own pause, as it is on the machine. */
  | { readonly kind: 'paused-here'; readonly paused: boolean };

export const initialConnectionView = (device: DeviceView | null, pausedHere: boolean): ConnectionView => ({
  state: device ? 'offline' : 'not-paired',
  device,
  paused: pausedHere,
  pausedByOffice: false,
  pausedHere,
  retryInMs: null,
  slowRetry: false,
  lastError: null,
});

const withPauses = (view: ConnectionView, pausedByOffice: boolean, pausedHere: boolean): ConnectionView => ({ ...view, pausedByOffice, pausedHere, paused: pausedByOffice || pausedHere });

/** Whether a view says what another says, so that a screen is not told of a change that is none. */
export const sameConnectionView = (a: ConnectionView, b: ConnectionView): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The next view, given what happened. Pure: it is what the screens of the app and the tests of the rules both stand on. */
export function nextConnectionView(view: ConnectionView, event: ConnectionEvent): ConnectionView {
  switch (event.kind) {
    case 'pairing':
      // A pairing that changes while connected is a pairing of a connection that is going away: the next run reads it again.
      return { ...view, device: event.device, state: view.state === 'connecting' || view.state === 'connected' || view.state === 'reconnecting' ? view.state : event.device ? 'offline' : 'not-paired' };
    case 'starting':
      return { ...view, state: 'connecting', retryInMs: null, slowRetry: false, lastError: null };
    case 'paused-here':
      return withPauses(view, view.pausedByOffice, event.paused);
    case 'ended':
      // The office's pause is only known while connected.
      return withPauses({ ...view, state: view.device ? 'offline' : 'not-paired', retryInMs: null, slowRetry: false, lastError: event.end.reason === 'stopped' ? null : event.end.message }, false, view.pausedHere);
    case 'status':
      return nextAfterStatus(view, event.status);
  }
}

function nextAfterStatus(view: ConnectionView, status: RunnerStatus): ConnectionView {
  switch (status.kind) {
    case 'connected':
      return withPauses(
        { ...view, state: 'connected', device: { host: status.host, deviceName: status.deviceName, agentName: status.agentName, workspaceName: status.workspaceName }, retryInMs: null, slowRetry: false, lastError: null },
        status.paused,
        view.pausedHere,
      );
    case 'paused-by-office':
      return withPauses(view, status.paused, view.pausedHere);
    case 'paused-on-machine':
      return withPauses(view, view.pausedByOffice, status.paused);
    case 'reconnecting':
      return { ...view, state: 'reconnecting', retryInMs: status.inMs, slowRetry: status.slow, lastError: status.reason };
    case 'office-complained':
    case 'task-error':
    case 'mcp-error':
    case 'offer-unreadable':
      return { ...view, lastError: describeStatus(status) };
  }
}
