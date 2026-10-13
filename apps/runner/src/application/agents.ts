import type { CodingAgentKind } from '@escritoriio/runner-protocol';
import { CODING_AGENT_KINDS } from '@escritoriio/runner-protocol';
import { isAbsolutePath } from '../domain/paths.ts';
import { plainText } from '../domain/plain-text.ts';
import type { AgentDetection, CodingAgent, CodingAgents, PolicyStore } from './task-ports.ts';
import { OwnerError } from './owner-error.ts';

export interface AgentsDeps {
  readonly policy: PolicyStore;
  readonly agents: CodingAgents;
  /** Whether paths here are written as Windows writes them. */
  readonly windows: boolean;
}

const describeLogin = (loggedIn: boolean | null): string => (loggedIn === null ? 'not known: the tool cannot tell' : loggedIn ? 'yes' : 'no: log in to it, as you do when you use it yourself');

function describeDetection(kind: CodingAgentKind, detection: AgentDetection, pickedByHand: boolean): readonly string[] {
  if (!detection.installed) {
    return [kind, `  found:        no${pickedByHand ? ', not at the path you picked' : ''}`, ...(detection.problem ? [`  problem:      ${plainText(detection.problem)}`] : [])];
  }
  return [
    kind,
    `  found:        yes, at ${plainText(detection.path ?? 'a place this runner cannot say')}${pickedByHand ? ' (the path you picked)' : ''}`,
    `  version:      ${detection.version ? plainText(detection.version) : 'not known'}`,
    `  logged in:    ${describeLogin(detection.loggedIn)}`,
    `  supported:    ${detection.supported ? 'yes' : 'no: this runner cannot drive this version'}`,
    `  containment:  ${detection.containment === 'sandbox' ? 'it has a sandbox of its own on this system' : 'none on this system: it runs only in a folder marked as trusted'}`,
    ...(detection.problem ? [`  problem:      ${plainText(detection.problem)}`] : []),
  ];
}

async function look(agent: CodingAgent, path: string | undefined): Promise<AgentDetection | undefined> {
  try {
    return await agent.detect(path);
  } catch {
    return undefined;
  }
}

/** One coding agent as this machine has it: what it is here, or why that is not known. */
export interface AgentView {
  readonly kind: CodingAgentKind;
  /** Whether this runner has an adapter to drive it. */
  readonly drivable: boolean;
  /** Nothing when it cannot be driven, or when looking at it failed. */
  readonly detection: AgentDetection | undefined;
  /** The path its owner picked by hand, when they did. */
  readonly pickedPath: string | undefined;
}

/** Each coding agent, looked at: what a screen, or the words below, are made from. */
export async function inspectAgents({ policy, agents }: Pick<AgentsDeps, 'policy' | 'agents'>): Promise<readonly AgentView[]> {
  const { agentPaths } = await policy.load();
  return Promise.all(
    CODING_AGENT_KINDS.map(async (kind) => {
      const agent = agents[kind];
      return { kind, drivable: agent !== undefined, detection: agent ? await look(agent, agentPaths[kind]) : undefined, pickedPath: agentPaths[kind] };
    }),
  );
}

/** Each coding agent, whether it is here and ready, and what contains it: what a person needs to know to choose where to let one run. */
export async function describeAgents(deps: AgentsDeps): Promise<readonly string[]> {
  const lines: string[] = [];
  for (const view of await inspectAgents(deps)) {
    if (!view.drivable) lines.push(view.kind, '  this runner cannot drive it yet');
    else lines.push(...(view.detection ? describeDetection(view.kind, view.detection, view.pickedPath !== undefined) : [view.kind, '  it could not be looked at']));
  }
  return lines;
}

function agentOf(agents: CodingAgents, kind: CodingAgentKind): CodingAgent {
  const agent = agents[kind];
  if (!agent) throw new OwnerError(`This runner cannot drive ${kind} yet.`);
  return agent;
}

/**
 * Keeps where the person says a coding agent is, for one that is not found by itself. It is looked at before it is kept: what cannot be
 * run as that tool, or is a version this runner cannot drive, is not worth keeping. Throws, with words for the person, when it is not a
 * full path or nothing that can be used is there.
 */
export async function setAgentPath(deps: AgentsDeps, kind: CodingAgentKind, path: string): Promise<AgentDetection> {
  const agent = agentOf(deps.agents, kind);
  if (!isAbsolutePath(path, deps.windows)) throw new OwnerError('That is not the full path of a program.');
  const detection = await look(agent, path);
  const problem = detection?.problem ? ` ${plainText(detection.problem)}` : '';
  if (!detection?.installed) throw new OwnerError(`Nothing that can be run as ${kind} was found at that path.${problem}`);
  if (!detection.supported) throw new OwnerError(`${kind} is at that path, but this runner cannot drive that version of it.${problem}`);
  await deps.policy.update((current) => ({ policy: { ...current, agentPaths: { ...current.agentPaths, [kind]: path } }, result: undefined }));
  return detection;
}

/** Goes back to finding the coding agent by itself. False when there was no path kept. */
export function clearAgentPath({ policy, agents }: Pick<AgentsDeps, 'policy' | 'agents'>, kind: CodingAgentKind): Promise<boolean> {
  agentOf(agents, kind);
  return policy.update((current) => {
    if (current.agentPaths[kind] === undefined) return { policy: current, result: false };
    const { [kind]: _removed, ...rest } = current.agentPaths;
    return { policy: { ...current, agentPaths: rest }, result: true };
  });
}
