import type { ConnectionView } from '@escritoriio/runner';
import type { TrayStatus } from './tray-icon.ts';

export type { TrayStatus };

/** What the tray shows of the connection: the one thing a person needs at a glance. */
export function trayStatus(view: ConnectionView): TrayStatus {
  if (view.state === 'not-paired') return 'not-paired';
  if (view.paused) return 'paused';
  if (view.state === 'connected') return 'connected';
  return view.state === 'offline' ? 'offline' : 'connecting';
}

/** In words, what the machine is doing and for whom. */
export function trayTooltip(view: ConnectionView): string {
  const status = trayStatus(view);
  const who = view.device ? `${view.device.agentName} (${view.device.workspaceName})` : '';
  switch (status) {
    case 'not-paired':
      return 'Escritoriio Runner: not paired yet';
    case 'paused':
      return `Escritoriio Runner: paused${view.pausedHere ? ' on this machine' : ' by the office'}, no task is taken`;
    case 'connected':
      return `Escritoriio Runner: connected, working for ${who}`;
    case 'connecting':
      return `Escritoriio Runner: connecting to the office of ${who}`;
    case 'offline':
      return `Escritoriio Runner: not connected, paired with ${who}`;
  }
}

export interface TrayActions {
  setPaused(paused: boolean): void;
  openWindow(): void;
  quit(): void;
}

/** One line of the menu, as a plain description: the adapter turns it into the system's menu. */
export interface TrayMenuItem {
  readonly type?: 'separator';
  readonly label?: string;
  readonly enabled?: boolean;
  readonly click?: () => void;
}

const separator: TrayMenuItem = { type: 'separator' };

/** The menu of the tray: the status, pause or resume in one click, the window, and quitting. */
export function trayMenu(view: ConnectionView, actions: TrayActions): readonly TrayMenuItem[] {
  const paired = view.device !== null;
  const status = trayStatus(view);
  const statusLine = {
    'not-paired': 'Not paired',
    connected: `Connected: ${view.device?.agentName ?? ''}`,
    paused: view.pausedHere ? 'Paused on this machine' : 'Paused by the office',
    connecting: 'Connecting…',
    offline: 'Not connected',
  }[status];
  const resuming = view.pausedHere;
  return [
    { label: statusLine, enabled: false },
    separator,
    { label: resuming ? 'Resume' : 'Pause', enabled: paired, click: () => actions.setPaused(!resuming) },
    { label: 'Open window', click: actions.openWindow },
    separator,
    { label: 'Quit', click: actions.quit },
  ];
}
