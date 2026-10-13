import { isOlderThan } from '@escritoriio/runner-protocol';
import { CLOCK_WARN_MS, clockSkewMs } from '../domain/clock-skew.ts';
import type { PairedDevice } from '../domain/paired-device.ts';
import { serverHost } from '../domain/paired-device.ts';
import { plainText } from '../domain/plain-text.ts';
import { placesOf, redactPaths } from '../domain/redact.ts';
import { scrubSecrets } from '../domain/scrub-diagnostics.ts';
import type { AgentView } from './agents.ts';
import { inspectAgents } from './agents.ts';
import type { FolderView } from './folders.ts';
import { inspectFolders } from './folders.ts';
import type { DeviceStore, OfficeProbe, OfficeReach } from './ports.ts';
import type { CodingAgents, FolderResolver, PolicyStore } from './task-ports.ts';
import type { Surroundings } from '../domain/folder-policy.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail';

/** One thing the doctor looked at: how it is, and in words for a person what that means. */
export interface DoctorCheck {
  readonly id: string;
  readonly status: CheckStatus;
  readonly title: string;
  readonly message: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  /** No check failed. A warning is something to know, not a machine that does not work. */
  readonly healthy: boolean;
}

const check = (id: string, status: CheckStatus, title: string, message: string): DoctorCheck => ({ id, status, title, message });

// --- what each check says, from plain values ------------------------------------------------------------------------

/** How a coding agent stands on this machine: found, logged in and contained, or what is missing. No path is said: the report is meant to be shared. */
export function judgeAgent(view: AgentView): DoctorCheck {
  const id = `agent-${view.kind}`;
  if (!view.drivable) return check(id, 'ok', view.kind, 'This runner cannot drive it yet.');
  const { detection } = view;
  if (!detection) return check(id, 'warn', view.kind, 'It could not be looked at.');
  if (!detection.installed) return check(id, 'warn', view.kind, `Not found${view.pickedPath === undefined ? '' : ', not at the path that was picked'}.${detection.problem ? ` ${plainText(detection.problem)}` : ''}`);
  const version = detection.version ? ` ${plainText(detection.version, 40)}` : '';
  if (!detection.supported) return check(id, 'warn', view.kind, `Found${version}, but this runner cannot drive that version.${detection.problem ? ` ${plainText(detection.problem)}` : ''}`);
  if (detection.loggedIn === false) return check(id, 'warn', view.kind, `Found${version}, but nobody is logged in to it: log in to it, as you do when you use it yourself.`);
  const login = detection.loggedIn === null ? 'login not known (the tool cannot tell)' : 'logged in';
  if (detection.containment === 'none') return check(id, 'warn', view.kind, `Found${version}, ${login}. Nothing contains it on this system, so it runs only in a folder marked as trusted.`);
  return check(id, 'ok', view.kind, `Found${version}, ${login}, contained by a sandbox of its own on this system.`);
}

/** Whether any coding agent can do work here at all: the one thing a runner is for. */
export function judgeAgentsUsable(views: readonly AgentView[]): DoctorCheck {
  const usable = views.filter((view) => view.detection?.installed && view.detection.supported && view.detection.loggedIn !== false);
  return usable.length > 0
    ? check('agents', 'ok', 'Coding agents', `Ready: ${usable.map((view) => view.kind).join(', ')}.`)
    : check('agents', 'fail', 'Coding agents', 'None is installed, supported and logged in, so this machine cannot do any work. Install Claude Code and log in to it.');
}

/** The folders shared: how many, and which no longer resolve. Labels only: where they are is the owner's business. */
export function judgeFolders(views: readonly FolderView[]): DoctorCheck {
  if (views.length === 0) return check('folders', 'warn', 'Folders', 'No folder is shared yet, so no task can run. Share one first.');
  const lost = views.filter((view) => view.problem !== undefined);
  if (lost.length === 0) return check('folders', 'ok', 'Folders', `${views.length} shared, every one where it was when it was shared.`);
  return check('folders', 'warn', 'Folders', `${views.length} shared, but ${lost.map((view) => `"${plainText(view.folder.label, 64)}" (${view.problem})`).join(', ')}. A task for ${lost.length === 1 ? 'it is' : 'them is'} refused until ${lost.length === 1 ? 'it is' : 'they are'} put back or shared again.`);
}

const describeSkew = (ms: number): string => {
  const seconds = Math.round(Math.abs(ms) / 1000);
  const amount = seconds >= 120 ? `${Math.round(seconds / 60)} minutes` : `${seconds} seconds`;
  return `${amount} ${ms > 0 ? 'ahead of' : 'behind'}`;
};

/** The clock of this machine against the office's, from the time in the office's answer. */
export function judgeClock(skewMs: number | undefined): DoctorCheck {
  if (skewMs === undefined) return check('clock', 'ok', 'Clock', 'Not checked: the office did not say what time it is.');
  if (Math.abs(skewMs) > CLOCK_WARN_MS) return check('clock', 'warn', 'Clock', `The clock of this machine is ${describeSkew(skewMs)} the office's. Set it to be kept by the system, or logins and tasks may misbehave.`);
  return check('clock', 'ok', 'Clock', 'It agrees with the office’s, within two minutes.');
}

/** This runner against the oldest the office lets in, when the office said. */
export function judgeVersion(version: string, minimum: string | undefined): DoctorCheck {
  if (minimum === undefined) return check('version', 'ok', 'Version', `${version}. The oldest the office accepts was not asked.`);
  if (isOlderThan(version, minimum)) {
    return check('version', 'fail', 'Version', `This runner is ${version} and the office needs ${minimum} or newer: it will be turned away. Update the runner (the latest version is on the My machines panel of the office) and start it again.`);
  }
  return check('version', 'ok', 'Version', `${version}, and the office needs ${minimum} or newer.`);
}

/** Whether the office could be reached, from what its answer to a plain request was. */
export function judgeConnection(host: string, reach: OfficeReach): DoctorCheck {
  if (!reach.reached) return check('connection', 'fail', 'Connection', `${host} could not be reached (${plainText(reach.reason)}).`);
  if (reach.status < 200 || reach.status >= 300) return check('connection', 'fail', 'Connection', `${host} answered, but with HTTP ${reach.status}.`);
  return check('connection', 'ok', 'Connection', `${host} answered.`);
}

// --- looking at the machine ---------------------------------------------------------------------------------------

export interface DoctorDeps {
  readonly policy: PolicyStore;
  readonly resolver: FolderResolver;
  readonly surroundings: Surroundings;
  readonly agents: CodingAgents;
  readonly devices: DeviceStore;
  readonly probe: OfficeProbe;
  readonly runnerVersion: string;
  readonly os: string;
}

async function pairing(devices: DeviceStore): Promise<PairedDevice | undefined | 'unreadable'> {
  try {
    return await devices.load();
  } catch {
    return 'unreadable';
  }
}

/**
 * Looks at everything a person would otherwise have to find out one command at a time, and says how each stands. Nothing here connects as
 * the device (the office would take that for a second connection of it): the office is asked as anybody may ask it. What it says is meant to be
 * shown to whoever helps, so the checks name no path, and what a tool says of itself is cleaned: the home of the person is written `~`, and what
 * looks like a secret, and the token of the device, are taken out.
 */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [check('runner', 'ok', 'Runner', `Version ${deps.runnerVersion} on ${deps.os}.`)];

  try {
    await deps.policy.load();
    checks.push(check('settings', 'ok', 'Settings', 'They can be read.'));
    const agents = await inspectAgents(deps);
    checks.push(judgeAgentsUsable(agents), ...agents.map(judgeAgent));
    checks.push(judgeFolders(await inspectFolders(deps)));
  } catch (error) {
    checks.push(check('settings', 'fail', 'Settings', `They cannot be read: ${plainText(error instanceof Error ? error.message : String(error))} Until they are mended, no task is taken.`));
  }

  const device = await pairing(deps.devices);
  let minimum: string | undefined;
  let skew: number | undefined;
  if (device === 'unreadable') {
    checks.push(check('connection', 'fail', 'Connection', 'The pairing of this machine cannot be read. Pair it again.'));
  } else if (device === undefined) {
    checks.push(check('connection', 'warn', 'Connection', 'This machine is not paired with an AI member yet, so the office cannot reach it.'));
  } else {
    const reach = await deps.probe.reach(device.server);
    checks.push(judgeConnection(serverHost(device.server), reach));
    if (reach.reached) {
      minimum = reach.minRunnerVersion;
      skew = clockSkewMs(reach.date, reach.sentAt, reach.receivedAt);
    }
  }
  checks.push(judgeClock(skew), judgeVersion(deps.runnerVersion, minimum));

  const known = device !== undefined && device !== 'unreadable' ? [device.token] : [];
  const places = placesOf(deps.surroundings, {}, { workFolder: '', allowedFolder: '' });
  const clean = checks.map((one) => ({ ...one, message: scrubSecrets(redactPaths(one.message, places), known), title: scrubSecrets(one.title, known) }));
  return { checks: clean, healthy: clean.every((one) => one.status !== 'fail') };
}

const MARKS: Readonly<Record<CheckStatus, string>> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };

/** The report as lines of text, one for each check. */
export const describeDoctor = (report: DoctorReport): readonly string[] => [
  ...report.checks.map((one) => `[${MARKS[one.status]}] ${one.title}: ${one.message}`),
  report.healthy ? 'Nothing is failing.' : 'Something is failing: see the lines marked FAIL.',
];
