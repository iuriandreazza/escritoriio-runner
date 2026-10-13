import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '../../application/task-ports.ts';
import { MAX_TURNS } from './options.ts';
import { WORKSPACE_CLONE_TOOL, WORKSPACE_NEW_FOLDER_TOOL } from './tools.ts';

// Generous on purpose: the paths in a summary are shortened when it is told (a folder as `.`, home as `~`), and a path that was cut before that is not
// one that can be recognised. What is told is cut after, to what the protocol allows.
const SUMMARY_CHARACTERS = 2_000;

/** What each tool names that is worth telling: the file it works on, the pattern it looks for, or the command it runs. */
const SUMMARY_INPUTS: Readonly<Record<string, string>> = {
  Read: 'file_path',
  Edit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
  Glob: 'pattern',
  Grep: 'pattern',
  Bash: 'command',
  [WORKSPACE_NEW_FOLDER_TOOL]: 'name',
  [WORKSPACE_CLONE_TOOL]: 'url',
};

/** A short account of one call of a tool: its first line, cut. What the call carries beyond that, a whole file's new text for instance, is not passed on. */
export function summarizeToolInput(name: string, input: unknown): string {
  const field = SUMMARY_INPUTS[name];
  if (field === undefined || typeof input !== 'object' || input === null) return '';
  const value = (input as Readonly<Record<string, unknown>>)[field];
  return typeof value === 'string' ? (value.trim().split('\n')[0] ?? '').slice(0, SUMMARY_CHARACTERS) : '';
}

/** What Claude Code says went wrong with a request to the model, in the words a person at the other end can use. None of them repeats what Claude Code said. */
const WHY_THE_MODEL_DID_NOT_ANSWER: Readonly<Record<string, string>> = {
  authentication_failed: 'Nobody is logged in to Claude Code on this machine, or the login has expired. Log in again on the machine.',
  oauth_org_not_allowed: 'The organization of the Claude login on this machine does not allow Claude Code here.',
  account_on_hold: 'The Claude account on this machine cannot be used right now.',
  verification_required: 'The Claude account on this machine must be verified before it can be used.',
  billing_error: 'The Claude account on this machine has a billing problem.',
  rate_limit: 'Claude Code hit a usage limit. Try again later.',
  overloaded: 'The Claude service is too busy right now. Try again later.',
  server_error: 'The Claude service failed. Try again later.',
  invalid_request: 'Claude Code could not make its request to the model.',
  model_not_found: 'Claude Code could not find the model it was meant to use.',
  max_output_tokens: 'The answer was longer than Claude Code allows.',
  cloud_credential_error: 'The cloud credentials that Claude Code uses are not valid.',
};

const STOPPED_BY_RESULT: Readonly<Record<string, string>> = {
  error_max_turns: `Claude Code stopped after ${MAX_TURNS} turns, the most it is given for a task.`,
  error_max_budget_usd: 'Claude Code stopped because it reached its spending limit.',
};

export const CLAUDE_CODE_FAILED = 'Claude Code reported an error and stopped.';
export const CLAUDE_CODE_GAVE_NO_ANSWER = 'Claude Code ended without an answer.';

/** A count that Claude Code gave, which is whatever it is: a number that is not one is nothing. */
const count = (tokens: number | undefined): number => (typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : 0);

/** What Claude Code marks a shell command's answer with when the sandbox stopped it from reaching a host. */
const SANDBOX_VIOLATIONS = '<sandbox_violations>';

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part: unknown) => (typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string' ? part.text : '')).join('\n');
}

export interface MessageTranslator {
  /** What the coding agent did that this message tells of: nothing, or several things. Messages after the last event are said to be nothing. */
  translate(message: SDKMessage): AgentEvent[];
}

interface Call {
  readonly name: string;
  readonly summary: string;
}

/**
 * Turns what Claude Code streams into the events every coding agent tells, and tells exactly one that ends the task. A call is told as
 * refused when it is one of a tool the task was not given (`tools`: Claude Code refuses it without asking the hook), when the runner's own
 * hook refused it (`denied` holds the ids of those calls), when the permission mode did, and when the sandbox stopped a command from
 * reaching a host.
 */
export function createMessageTranslator(denied: ReadonlySet<string>, tools: readonly string[]): MessageTranslator {
  const calls = new Map<string, Call>();
  const toldAsDenied = new Set<string>();
  let whyNoAnswer: string | undefined;
  let finished = false;

  const deniedCall = (id: string, name?: string): AgentEvent[] => {
    if (toldAsDenied.has(id)) return [];
    toldAsDenied.add(id);
    const call = calls.get(id);
    return [{ kind: 'tool', name: call?.name ?? name ?? 'tool', summary: call?.summary ?? '', denied: true }];
  };

  const ended = (message: Extract<SDKMessage, { type: 'result' }>): AgentEvent[] => {
    // What the model read is what it was sent, whether it was read from the cache or not.
    const { usage } = message;
    const inputTokens = count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens);
    const events: AgentEvent[] = [{ kind: 'usage', inputTokens, outputTokens: count(usage.output_tokens) }];
    if (message.subtype === 'success' && !message.is_error) return [...events, { kind: 'result', text: message.result }];
    return [...events, { kind: 'error', message: whyNoAnswer ?? STOPPED_BY_RESULT[message.subtype] ?? CLAUDE_CODE_FAILED }];
  };

  return {
    translate(message) {
      if (finished) return [];
      switch (message.type) {
        case 'assistant': {
          // What a subagent says is not the task's own answer.
          if (message.parent_tool_use_id !== null) return [];
          // A request that failed is written by Claude Code as if the model had said it: that is not text to pass on, and the result says why.
          if (message.error !== undefined) {
            whyNoAnswer = WHY_THE_MODEL_DID_NOT_ANSWER[message.error] ?? CLAUDE_CODE_FAILED;
            return [];
          }
          return message.message.content.flatMap((block): AgentEvent[] => {
            if (block.type === 'text') return block.text.trim() === '' ? [] : [{ kind: 'text', text: block.text }];
            if (block.type !== 'tool_use') return [];
            const call = { name: block.name, summary: summarizeToolInput(block.name, block.input) };
            calls.set(block.id, call);
            if (!tools.includes(block.name)) return deniedCall(block.id);
            return [{ kind: 'tool', ...call, denied: false }];
          });
        }
        case 'user': {
          if (message.parent_tool_use_id !== null || !Array.isArray(message.message.content)) return [];
          return message.message.content.flatMap((block) => {
            if (block.type !== 'tool_result') return [];
            return denied.has(block.tool_use_id) || textOf(block.content).includes(SANDBOX_VIOLATIONS) ? deniedCall(block.tool_use_id) : [];
          });
        }
        case 'system':
          // A call that is refused by the permission mode, which no hook of ours saw.
          return message.subtype === 'permission_denied' ? deniedCall(message.tool_use_id, message.tool_name) : [];
        case 'result': {
          finished = true;
          return ended(message);
        }
        default:
          return [];
      }
    },
  };
}
