import type { TaskRejection } from '@escritoriio/runner-protocol';
import type { MachineInventory } from './ports.ts';
import type { PairedDevice } from '../domain/paired-device.ts';
import { describeSeconds } from '../domain/describe-seconds.ts';
import { serverHost } from '../domain/paired-device.ts';
import { plainText } from '../domain/plain-text.ts';
import type { TaskNote } from './task-service.ts';

/**
 * What a connection tells whoever runs it, so that a person can see what it is doing. States and times, and the names the office
 * gave a device, an AI member and a workspace: nothing else that the office says, and never the token.
 */
export type RunnerStatus =
  | { readonly kind: 'connected'; readonly host: string; readonly deviceName: string; readonly agentName: string; readonly workspaceName: string; readonly paused: boolean }
  /** The machine was paused, or let work again, from the office. */
  | { readonly kind: 'paused-by-office'; readonly paused: boolean }
  | { readonly kind: 'reconnecting'; readonly inMs: number; readonly slow: boolean; readonly reason: string }
  /** The office said something was wrong with what the runner sent. What it said is not kept: only that it did. */
  | { readonly kind: 'office-complained' }
  /** The machine's owner paused or resumed it on the machine itself. */
  | { readonly kind: 'paused-on-machine'; readonly paused: boolean }
  /** A mistake of this program while it handled a task, in its own words. */
  | { readonly kind: 'task-error'; readonly message: string }
  /** The office offered a task that this runner could not read, and was told so. The id is the office's own word for it. */
  | { readonly kind: 'offer-unreadable'; readonly taskId: string }
  /** A mistake of this program while it handled a request for an MCP server, in its own words. */
  | { readonly kind: 'mcp-error'; readonly message: string };

const describeWait = (ms: number): string => (ms < 60_000 ? `${Math.max(1, Math.ceil(ms / 1000))}s` : `${Math.round(ms / 60_000)} min`);

export function describeStatus(status: RunnerStatus): string {
  switch (status.kind) {
    case 'connected':
      return `connected to ${status.host} as "${status.deviceName}", working for ${status.agentName} of ${status.workspaceName}${status.paused ? ' (paused from the office)' : ''}`;
    case 'paused-by-office':
      return status.paused ? 'paused from the office' : 'resumed from the office';
    case 'reconnecting':
      return `${status.slow ? 'waiting' : 'reconnecting'} in ${describeWait(status.inMs)}: ${status.reason}`;
    case 'office-complained':
      return 'the office reported a problem with what this runner sent';
    case 'paused-on-machine':
      return status.paused ? 'paused on this machine: no task is taken, and the one that runs is stopped' : 'resumed on this machine';
    case 'task-error':
      return `a task could not be handled because of a mistake of the runner: ${status.message}`;
    case 'mcp-error':
      return `a request for an MCP server could not be handled because of a mistake of the runner: ${status.message}`;
    case 'offer-unreadable':
      return `the office offered task ${plainText(status.taskId, 64)}, which this runner could not read, and was told so: this runner or the office needs updating`;
  }
}

const DESCRIBE_REJECTION: Readonly<Record<TaskRejection, string>> = {
  'not-allowed': 'the folder is not one this machine shares, or it is not as it was',
  paused: 'the machine is paused',
  busy: 'another task is running',
  'agent-missing': 'the coding agent is not installed, or cannot be driven',
  'not-logged-in': 'nobody is logged in to the coding agent',
  'cannot-isolate': 'a copy of the folder could not be made',
  'needs-approval': 'the folder asks its owner to approve each task on this machine',
  'not-contained': 'the coding agent cannot be contained on this system and the folder is not trusted',
  'bad-offer': 'the office sent a task this runner could not read',
};

/** A task the machine was offered, as its owner reads it: which one, and how it went, and never what it asked or what came of it. */
export function describeTaskNote(note: TaskNote): string {
  // The id is the office's own word for the task, and is cleaned like the rest of what it says.
  const task = `task ${plainText(note.taskId, 64)}`;
  switch (note.kind) {
    case 'accepted':
      return `${task} taken`;
    case 'rejected':
      return `${task} refused: ${DESCRIBE_REJECTION[note.reason]}`;
    case 'waiting-for-approval':
      return `${task} waits for its owner to approve it on this machine`;
    case 'ended':
      return note.outcome === 'done' ? `${task} done in ${describeSeconds(note.durationMs)}` : `${task} ended (${note.outcome}) after ${describeSeconds(note.durationMs)}`;
  }
}

/** The lines of `status`: who the machine is paired with. Field by field, so that the token cannot end up in them. */
export function describePairing(device: PairedDevice | undefined): readonly string[] {
  if (!device) return ['not paired: run escritoriio-runner pair <server> <code>'];
  return [`server:    ${serverHost(device.server)}`, `AI member: ${device.agentName}`, `workspace: ${device.workspaceName}`, `device:    ${device.deviceName}`];
}

const describeFound = (agent: MachineInventory['agents'][number]): string =>
  `${agent.kind}${agent.version ? ` ${agent.version}` : ''}, ${agent.loggedIn === null ? 'login not known' : agent.loggedIn ? 'logged in' : 'not logged in'}`;

/** The lines of `status` about the machine itself: whether its owner paused it, which folders it shares, which coding agents it found and which MCP servers it has. */
export function describeMachine(inventory: MachineInventory): readonly string[] {
  const { agents, folders, mcpServers, paused } = inventory;
  return [
    `paused:    ${paused ? 'yes, on this machine: escritoriio-runner resume lifts it' : 'no'}`,
    folders.length === 0 ? 'folders:   none shared yet: escritoriio-runner folders add <path>' : `folders:   ${folders.length} shared: ${folders.join(', ')}`,
    agents.length === 0 ? 'agents:    none that can be used: escritoriio-runner agents says why' : `agents:    ${agents.map(describeFound).join('; ')}`,
    mcpServers.length === 0 ? 'mcp:       none set up yet: escritoriio-runner mcp add <label> -- <program> [arguments]' : `mcp:       ${mcpServers.length} set up: ${mcpServers.join(', ')}`,
  ];
}
