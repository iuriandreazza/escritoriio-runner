import type { JournalEntry, TaskDone, TaskEvent, TaskFailed, TaskFailure } from '@escritoriio/runner-protocol';
import { Feed } from './feed.ts';
import type { Followable } from './feed.ts';
import type { TaskObserver } from './task-service.ts';

/** How much of what a task said a screen keeps to show while it runs. */
export const TAIL_LINES = 40;
const TAIL_LINE_CHARS = 300;
/** How many ended tasks are shown. */
export const RECENT_TASKS = 20;
const SUMMARY_CHARS = 300;

export interface RunningTaskView {
  readonly taskId: string;
  readonly folder: string;
  readonly startedAt: number;
  readonly waitingForApproval: boolean;
  /** The last lines of what the coding agent said and did, newest last. */
  readonly tail: readonly string[];
}

export interface EndedTaskView {
  readonly taskId: string;
  readonly outcome: 'done' | TaskFailure;
  readonly durationMs: number;
  readonly branch: string | null;
  /** The first lines of its answer, or the words of why it did not end well. */
  readonly summary: string;
}

export interface TasksView {
  readonly running: readonly RunningTaskView[];
  readonly recent: readonly EndedTaskView[];
}

const cut = (line: string): string => (line.length <= TAIL_LINE_CHARS ? line : `${line.slice(0, TAIL_LINE_CHARS - 1)}…`);

/** What an event adds to the tail: the lines of what was said, and a line for each tool used. Usage is for the office's counts, not for reading. */
export function appendToTail(tail: readonly string[], event: TaskEvent): readonly string[] {
  let added: string[];
  if (event.kind === 'text') added = event.text.split('\n').map((line) => line.trimEnd());
  else if (event.kind === 'tool') added = [`> ${event.name}${event.summary === '' ? '' : `: ${event.summary}`}${event.denied ? ' (not allowed)' : ''}`];
  else return tail;
  const lines = [...tail, ...added.filter((line) => line !== '').map(cut)];
  return lines.length <= TAIL_LINES ? lines : lines.slice(lines.length - TAIL_LINES);
}

const summaryOfDone = (text: string): string => text.trim().slice(0, SUMMARY_CHARS);
const summaryOfFailure = (message: string): string => message.slice(0, SUMMARY_CHARS);

const endedFrom = (taskId: string, ending: { readonly done: Omit<TaskDone, 'taskId'> } | { readonly failed: Omit<TaskFailed, 'taskId'> }): EndedTaskView =>
  'done' in ending
    ? { taskId, outcome: 'done', durationMs: ending.done.durationMs, branch: ending.done.branch, summary: summaryOfDone(ending.done.text) }
    : { taskId, outcome: ending.failed.reason, durationMs: ending.failed.durationMs, branch: null, summary: summaryOfFailure(ending.failed.message) };

/** What the journal remembers of the tasks that ended, newest first. */
export function endedFromJournal(entries: readonly JournalEntry[]): readonly EndedTaskView[] {
  const ended: EndedTaskView[] = [];
  for (const entry of entries) {
    if (entry.state === 'done') ended.unshift({ taskId: entry.taskId, outcome: 'done', durationMs: entry.durationMs, branch: entry.branch, summary: summaryOfDone(entry.text) });
    else if (entry.state === 'failed') ended.unshift({ taskId: entry.taskId, outcome: entry.reason, durationMs: entry.durationMs, branch: null, summary: summaryOfFailure(entry.message) });
  }
  return ended.slice(0, RECENT_TASKS);
}

/**
 * The tasks as a screen shows them: the one that runs, with the tail of what it says, and the ones that ended lately. It is fed by the
 * service that runs the tasks, and what it holds is on this machine alone: nothing of it is sent anywhere.
 */
export class TaskBoard implements TaskObserver, Followable<TasksView> {
  private readonly feed: Feed<TasksView>;

  constructor(onError?: (error: unknown) => void) {
    this.feed = new Feed<TasksView>({ running: [], recent: [] }, onError);
  }

  get current(): TasksView {
    return this.feed.current;
  }

  subscribe(listener: (view: TasksView) => void): () => void {
    return this.feed.subscribe(listener);
  }

  /** The tasks the journal remembers, for a runner that was just opened: what ended in the last hour, before it began. */
  remember(entries: readonly JournalEntry[]): void {
    this.feed.set({ ...this.current, recent: endedFromJournal(entries) });
  }

  began(task: { readonly taskId: string; readonly folder: string; readonly startedAt: number }): void {
    this.feed.set({ ...this.current, running: [...this.current.running.filter((running) => running.taskId !== task.taskId), { ...task, waitingForApproval: false, tail: [] }] });
  }

  said(taskId: string, event: TaskEvent): void {
    this.change(taskId, (task) => ({ ...task, tail: appendToTail(task.tail, event) }));
  }

  approval(taskId: string, waiting: boolean): void {
    this.change(taskId, (task) => ({ ...task, waitingForApproval: waiting }));
  }

  ended(taskId: string, ending: { readonly done: Omit<TaskDone, 'taskId'> } | { readonly failed: Omit<TaskFailed, 'taskId'> }): void {
    const { running, recent } = this.current;
    this.feed.set({ running: running.filter((task) => task.taskId !== taskId), recent: [endedFrom(taskId, ending), ...recent.filter((task) => task.taskId !== taskId)].slice(0, RECENT_TASKS) });
  }

  private change(taskId: string, change: (task: RunningTaskView) => RunningTaskView): void {
    const { running } = this.current;
    if (!running.some((task) => task.taskId === taskId)) return;
    this.feed.set({ ...this.current, running: running.map((task) => (task.taskId === taskId ? change(task) : task)) });
  }
}
