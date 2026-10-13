import type { CodingAgents } from '../application/task-ports.ts';
import { createClaudeCodeAgent } from './claude/claude-code-agent.ts';

/** The coding agents this runner can drive: one adapter for each tool. */
export function createCodingAgents(): CodingAgents {
  return { 'claude-code': createClaudeCodeAgent() };
}
