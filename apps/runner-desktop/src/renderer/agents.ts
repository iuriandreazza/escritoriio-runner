import type { Request } from '../shared/channels.ts';

export type AgentKind = Request<'agents:set-path'>['kind'];

/** The coding agents the runner can drive, by the name a person knows them by. A record, so that a new kind of the protocol does not compile until it is named here. */
export const AGENT_NAMES: Readonly<Record<AgentKind, string>> = { 'claude-code': 'Claude Code', codex: 'Codex', 'kimi-code': 'Kimi Code' };

export const AGENT_KINDS = Object.keys(AGENT_NAMES) as readonly AgentKind[];
