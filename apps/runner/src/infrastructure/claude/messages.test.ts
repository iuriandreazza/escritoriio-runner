import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../application/task-ports.ts';
import { CLAUDE_CODE_FAILED, createMessageTranslator, summarizeToolInput } from './messages.ts';
import { assistantFailed, assistantSays, initialized, permissionDenied, resultOf, succeeded, text, toolAnswers, toolUse } from './testing.ts';
import { toolsFor } from './tools.ts';

const EDIT = toolsFor('edit');
const READ_ONLY = toolsFor('read-only');

function translate(messages: readonly SDKMessage[], denied: ReadonlySet<string> = new Set(), tools: readonly string[] = EDIT): AgentEvent[] {
  const translator = createMessageTranslator(denied, tools);
  return messages.flatMap((message) => translator.translate(message));
}

describe('what Claude Code says, told as events', () => {
  it('tells what it writes, and each use of a tool with what it works on', () => {
    expect(translate([initialized, assistantSays(text('I will look.'), toolUse('t1', 'Read', { file_path: '/work/site/README.md' }))])).toEqual([
      { kind: 'text', text: 'I will look.' },
      { kind: 'tool', name: 'Read', summary: '/work/site/README.md', denied: false },
    ]);
  });

  it('says nothing of what is not text or a tool: thinking, empty text, the setup', () => {
    expect(translate([initialized, assistantSays({ type: 'thinking', thinking: 'hmm' }, text('   '))])).toEqual([]);
  });

  it('tells a command by its first line, and a search by what it looks for', () => {
    expect(summarizeToolInput('Bash', { command: 'pnpm test\n  && echo done' })).toBe('pnpm test');
    expect(summarizeToolInput('Grep', { pattern: 'TODO', path: '/work/site' })).toBe('TODO');
    expect(summarizeToolInput('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts');
    expect(summarizeToolInput('Edit', { file_path: '/work/site/a.ts', old_string: 'the old text', new_string: 'the new text' })).toBe('/work/site/a.ts');
  });

  it('keeps a summary short, and has none for what it does not know or cannot read', () => {
    expect(summarizeToolInput('Bash', { command: 'x'.repeat(3000) })).toHaveLength(2000);
    // A long path is whole when it reaches the place that shortens the paths in it.
    expect(summarizeToolInput('Write', { file_path: `/Users/ana/${'dir/'.repeat(100)}file.txt` })).toHaveLength('/Users/ana/'.length + 400 + 'file.txt'.length);
    expect(summarizeToolInput('Unknown', { file_path: '/a' })).toBe('');
    expect(summarizeToolInput('Read', null)).toBe('');
    expect(summarizeToolInput('Read', { file_path: 3 })).toBe('');
  });

  it('leaves out what a subagent says: it is not the answer of the task', () => {
    const subagent = { ...assistantSays(text('inside'), toolUse('t9', 'Read', { file_path: '/a' })), parent_tool_use_id: 'task-1' } as SDKMessage;
    expect(translate([subagent])).toEqual([]);
  });

  describe('a call that was refused', () => {
    it('is told as refused, when the answer to it says so, after being told as made', () => {
      const events = translate([assistantSays(toolUse('t1', 'Read', { file_path: '/etc/passwd' })), toolAnswers('t1', 'That path is outside the folder.', true)], new Set(['t1']));
      expect(events).toEqual([
        { kind: 'tool', name: 'Read', summary: '/etc/passwd', denied: false },
        { kind: 'tool', name: 'Read', summary: '/etc/passwd', denied: true },
      ]);
    });

    it('is not said to be refused when it is not one of the refused, however its answer reads', () => {
      const events = translate([assistantSays(toolUse('t1', 'Edit', { file_path: '/work/site/a.ts' })), toolAnswers('t1', 'permission denied is what the file said', true)]);
      expect(events.map((event) => event.kind === 'tool' && event.denied)).toEqual([false]);
    });

    it('is told as refused when the permission mode refused it, which no hook of ours saw', () => {
      const events = translate([assistantSays(toolUse('t1', 'Write', { file_path: '/work/site/.git/config' })), permissionDenied('t1', 'Write')]);
      expect(events.at(-1)).toEqual({ kind: 'tool', name: 'Write', summary: '/work/site/.git/config', denied: true });
    });

    it('is told as refused once, though two things say so', () => {
      const events = translate([assistantSays(toolUse('t1', 'Write', { file_path: '/a' })), permissionDenied('t1', 'Write'), toolAnswers('t1', 'no', true)], new Set(['t1']));
      expect(events.filter((event) => event.kind === 'tool' && event.denied)).toHaveLength(1);
    });

    it('is told as refused, with what is known of it, when a refusal comes for a call that was never told', () => {
      expect(translate([permissionDenied('t7', 'Bash')])).toEqual([{ kind: 'tool', name: 'Bash', summary: '', denied: true }]);
    });

    it('is told as refused at once when the tool was never given to the task, which Claude Code refuses without asking the hook', () => {
      const events = translate([assistantSays(toolUse('t1', 'Bash', { command: 'rm -rf node_modules' }), toolUse('t2', 'WebFetch', { url: 'https://example.com' }))], new Set(), READ_ONLY);
      expect(events).toEqual([
        { kind: 'tool', name: 'Bash', summary: 'rm -rf node_modules', denied: true },
        { kind: 'tool', name: 'WebFetch', summary: '', denied: true },
      ]);
    });

    it('is told as refused at once when it is a command in a task that only reads, and not when the task may edit', () => {
      const command = assistantSays(toolUse('t1', 'Bash', { command: 'ls' }));
      const file = assistantSays(toolUse('t2', 'Read', { file_path: '/work/site/a.ts' }));
      expect(translate([command], new Set(), READ_ONLY)).toEqual([{ kind: 'tool', name: 'Bash', summary: 'ls', denied: true }]);
      expect(translate([command], new Set(), EDIT)).toEqual([{ kind: 'tool', name: 'Bash', summary: 'ls', denied: false }]);
      expect(translate([file], new Set(), EDIT)).toEqual([{ kind: 'tool', name: 'Read', summary: '/work/site/a.ts', denied: false }]);
    });

    it('is told as refused when the sandbox stopped the command from reaching a host', () => {
      const events = translate([assistantSays(toolUse('t1', 'Bash', { command: 'curl https://example.com' })), toolAnswers('t1', '403\n<sandbox_violations>\ndeny network-outbound example.com:443\n</sandbox_violations>')], new Set(), EDIT);
      expect(events.at(-1)).toEqual({ kind: 'tool', name: 'Bash', summary: 'curl https://example.com', denied: true });
    });

    it('is told as refused when that is said in the parts of an answer that has several', () => {
      const parts = [{ type: 'text', text: 'ok' }, { type: 'text', text: '<sandbox_violations>x</sandbox_violations>' }, { type: 'image' }];
      const events = translate([assistantSays(toolUse('t1', 'Bash', { command: 'curl x' })), toolAnswers('t1', parts)], new Set(), EDIT);
      expect(events.at(-1)).toMatchObject({ kind: 'tool', denied: true });
    });
  });

  describe('how it ends', () => {
    it('is a result, after what the model used, counting what it read from the cache too', () => {
      expect(translate([assistantSays(text('Fixed it.')), succeeded('Fixed it.')])).toEqual([
        { kind: 'text', text: 'Fixed it.' },
        { kind: 'usage', inputTokens: 115, outputTokens: 20 },
        { kind: 'result', text: 'Fixed it.' },
      ]);
    });

    it('is exactly one event that ends it: what comes after is nothing', () => {
      const translator = createMessageTranslator(new Set(), EDIT);
      expect(translator.translate(succeeded('Done.')).map((event) => event.kind)).toEqual(['usage', 'result']);
      expect(translator.translate(assistantSays(text('more')))).toEqual([]);
      expect(translator.translate(succeeded('Again.'))).toEqual([]);
      expect(translator.translate(resultOf('error_during_execution', true))).toEqual([]);
    });

    it('is an error when Claude Code says it is one, though it calls it a success', () => {
      const events = translate([resultOf('success', true, 'Failed to authenticate: OAuth session expired and could not be refreshed')]);
      expect(events.at(-1)).toEqual({ kind: 'error', message: CLAUDE_CODE_FAILED });
    });

    it('says why the model did not answer, in words that repeat nothing Claude Code said', () => {
      const events = translate([assistantFailed('authentication_failed', 'Failed to authenticate: token sk-ant-oat01-SECRET'), resultOf('success', true, 'Failed to authenticate: token sk-ant-oat01-SECRET')]);
      expect(events.at(-1)).toEqual({ kind: 'error', message: expect.stringContaining('logged in') });
      expect(JSON.stringify(events)).not.toContain('SECRET');
      expect(events.some((event) => event.kind === 'text')).toBe(false);
    });

    it.each(['rate_limit', 'overloaded', 'billing_error', 'invalid_request', 'model_not_found', 'max_output_tokens', 'server_error'])('has words of its own for %s', (error) => {
      const last = translate([assistantFailed(error), resultOf('success', true)]).at(-1);
      expect(last).toMatchObject({ kind: 'error' });
      expect(last?.kind === 'error' && last.message).not.toBe(CLAUDE_CODE_FAILED);
    });

    it('has general words for a reason it does not know', () => {
      expect(translate([assistantFailed('something_new'), resultOf('success', true)]).at(-1)).toEqual({ kind: 'error', message: CLAUDE_CODE_FAILED });
    });

    it.each([
      ['error_max_turns', 'turns'],
      ['error_max_budget_usd', 'spending'],
      ['error_during_execution', 'error'],
    ])('is an error with its own words when the run ended as %s', (subtype, word) => {
      const last = translate([resultOf(subtype, true, 'whatever it said at the time')]).at(-1);
      expect(last).toEqual({ kind: 'error', message: expect.stringContaining(word) });
      expect(JSON.stringify(last)).not.toContain('whatever');
    });

    it('counts what is not a number as nothing', () => {
      const broken = { type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 'many' } } as unknown as SDKMessage;
      expect(translate([broken])[0]).toEqual({ kind: 'usage', inputTokens: 0, outputTokens: 0 });
    });
  });
});
