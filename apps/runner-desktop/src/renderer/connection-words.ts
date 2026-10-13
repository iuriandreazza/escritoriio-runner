import type { ConnectionView } from './runner-state.tsx';

const STATE_WORDS: Record<ConnectionView['state'], string> = {
  'not-paired': 'Not paired',
  offline: 'Not connected',
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
};

/** The one line that says what the machine is doing: a pause comes before the state of the wire, since it is what decides whether a task is taken. */
export function headline(view: ConnectionView): string {
  if (view.pausedHere) return 'Paused on this machine';
  if (view.pausedByOffice) return 'Paused from the office';
  return STATE_WORDS[view.state];
}

export function tone(view: ConnectionView): string {
  if (view.paused) return 'paused';
  return { 'not-paired': 'idle', offline: 'idle', connecting: 'busy', reconnecting: 'busy', connected: 'ok' }[view.state];
}
