import type { JournalEntry } from '@escritoriio/runner-protocol';
import { describe, expect, it } from 'vitest';
import { appendToTail, endedFromJournal, RECENT_TASKS, TAIL_LINES, TaskBoard } from './task-board.ts';

describe('the tail of a task', () => {
  it('keeps the lines of what was said, without blank ones, and a line for each tool', () => {
    let tail: readonly string[] = [];
    tail = appendToTail(tail, { kind: 'text', text: 'Reading the tests\n\nFound two.   ' });
    tail = appendToTail(tail, { kind: 'tool', name: 'Edit', summary: 'README.md', denied: false });
    tail = appendToTail(tail, { kind: 'tool', name: 'Bash', summary: '', denied: true });
    expect(tail).toEqual(['Reading the tests', 'Found two.', '> Edit: README.md', '> Bash (not allowed)']);
  });

  it('ignores the counts of tokens', () => {
    expect(appendToTail(['a'], { kind: 'usage', inputTokens: 1, outputTokens: 2 })).toEqual(['a']);
  });

  it('keeps only the last lines, and cuts a line that is too long', () => {
    const lines = Array.from({ length: TAIL_LINES + 5 }, (_, index) => `line ${index}`);
    const tail = appendToTail([], { kind: 'text', text: lines.join('\n') });
    expect(tail).toHaveLength(TAIL_LINES);
    expect(tail.at(-1)).toBe(`line ${TAIL_LINES + 4}`);
    expect(tail[0]).toBe('line 5');
    expect(appendToTail([], { kind: 'text', text: 'x'.repeat(1_000) })[0]).toHaveLength(300);
  });
});

describe('the tasks as a screen shows them', () => {
  const done = { text: 'Fixed the typo.\nAnd more.', branch: 'escritoriio/t1', diffStat: ' README.md | 2 +-', durationMs: 5_000, truncated: false };

  it('shows a task from the moment it began, with what it says as it says it, and moves it to the ended ones when it is over', () => {
    const board = new TaskBoard();
    const views: unknown[] = [];
    board.subscribe((view) => void views.push(view));
    board.began({ taskId: 't1', folder: 'site', startedAt: 10 });
    board.said('t1', { kind: 'text', text: 'Working' });
    expect(board.current.running).toEqual([{ taskId: 't1', folder: 'site', startedAt: 10, waitingForApproval: false, tail: ['Working'] }]);
    board.ended('t1', { done });
    expect(board.current.running).toEqual([]);
    expect(board.current.recent).toEqual([{ taskId: 't1', outcome: 'done', durationMs: 5_000, branch: 'escritoriio/t1', summary: 'Fixed the typo.\nAnd more.' }]);
    expect(views).toHaveLength(3);
  });

  it('says that a task waits for its owner, and that it does not any more', () => {
    const board = new TaskBoard();
    board.began({ taskId: 't1', folder: 'site', startedAt: 0 });
    board.approval('t1', true);
    expect(board.current.running[0]?.waitingForApproval).toBe(true);
    board.approval('t1', false);
    expect(board.current.running[0]?.waitingForApproval).toBe(false);
  });

  it('shows how a task that did not end well ended, in its words', () => {
    const board = new TaskBoard();
    board.began({ taskId: 't1', folder: 'site', startedAt: 0 });
    board.ended('t1', { failed: { reason: 'cancelled', message: 'The task was cancelled.', durationMs: 7 } });
    expect(board.current.recent).toEqual([{ taskId: 't1', outcome: 'cancelled', durationMs: 7, branch: null, summary: 'The task was cancelled.' }]);
  });

  it('ignores what it hears of a task it was not told began, and shows the newest ended first, a limited number of them', () => {
    const board = new TaskBoard();
    board.said('nobody', { kind: 'text', text: 'x' });
    board.approval('nobody', true);
    expect(board.current.running).toEqual([]);
    for (let index = 0; index < RECENT_TASKS + 3; index++) board.ended(`t${index}`, { failed: { reason: 'error', message: 'x', durationMs: 1 } });
    expect(board.current.recent).toHaveLength(RECENT_TASKS);
    expect(board.current.recent[0]?.taskId).toBe(`t${RECENT_TASKS + 2}`);
  });

  it('remembers the tasks of the journal, newest first, and never the ones that run', () => {
    const entries: JournalEntry[] = [
      { state: 'failed', taskId: 'old', reason: 'timeout', message: 'too long', durationMs: 3 },
      { state: 'running', taskId: 'now' },
      { state: 'done', taskId: 'new', ...done },
    ];
    expect(endedFromJournal(entries).map((task) => [task.taskId, task.outcome])).toEqual([['new', 'done'], ['old', 'timeout']]);
    const board = new TaskBoard();
    board.remember(entries);
    expect(board.current.recent).toHaveLength(2);
  });
});
