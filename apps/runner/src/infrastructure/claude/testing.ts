import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRequest } from '../../application/task-ports.ts';

export const folder = '/Users/ana/work/site';

export function agentRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    folder,
    instruction: 'Fix the typo in the README.',
    access: 'edit',
    executable: '/Users/ana/.local/bin/claude',
    environment: { PATH: '/usr/bin:/bin', HOME: '/Users/ana', LANG: 'en_US.UTF-8' },
    surroundings: { home: '/Users/ana', stateDirectory: '/Users/ana/Library/Application Support/escritoriio-runner', worktreesDirectory: '/Users/ana/Library/Caches/escritoriio-runner/worktrees', windows: false },
    ...overrides,
  };
}

/** Messages as Claude Code streams them, with only the parts the adapter reads: the rest of each is cast, not built. */
const message = (shape: object): SDKMessage => shape as unknown as SDKMessage;

export const assistantSays = (...content: readonly object[]): SDKMessage => message({ type: 'assistant', parent_tool_use_id: null, message: { content } });
export const text = (words: string): object => ({ type: 'text', text: words });
export const toolUse = (id: string, name: string, input: object): object => ({ type: 'tool_use', id, name, input });
export const assistantFailed = (error: string, words = 'Failed to authenticate'): SDKMessage => message({ type: 'assistant', parent_tool_use_id: null, error, message: { content: [text(words)] } });
export const toolAnswers = (id: string, content: unknown = 'ok', isError = false): SDKMessage =>
  message({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
export const permissionDenied = (id: string, name: string): SDKMessage => message({ type: 'system', subtype: 'permission_denied', tool_use_id: id, tool_name: name, message: 'denied' });
export const initialized: SDKMessage = message({ type: 'system', subtype: 'init', tools: [] });

const usage = { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 20 };
export const succeeded = (result: string): SDKMessage => message({ type: 'result', subtype: 'success', is_error: false, result, usage });
export const resultOf = (subtype: string, isError: boolean, words = 'something Claude Code said'): SDKMessage => message({ type: 'result', subtype, is_error: isError, result: words, usage });
