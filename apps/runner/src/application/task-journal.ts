import type { JournalEntry, TaskDone, TaskFailed } from '@escritoriio/runner-protocol';
import { TASK_LIMITS } from '@escritoriio/runner-protocol';
import type { JournalRecord, JournalStore } from './task-ports.ts';

/** How long what a task came to is remembered: long enough for a connection that dropped to come back and say so, and no longer. */
export const JOURNAL_KEEPS_MS = 60 * 60_000;

/**
 * What the runner remembers of its tasks. A task that was running when the runner stopped did not finish, and nothing runs it now, so it
 * is written down as interrupted the next time the journal is opened.
 */
export class TaskJournal {
  private records: JournalRecord[] = [];
  private readonly store: JournalStore;
  private readonly now: () => number;
  private readonly reportError: (error: unknown) => void;

  constructor(store: JournalStore, now: () => number, reportError: (error: unknown) => void) {
    this.store = store;
    this.now = now;
    this.reportError = reportError;
  }

  async open(): Promise<void> {
    const at = this.now();
    this.records = (await this.store.load()).map((record) =>
      record.entry.state === 'running'
        ? { at, entry: { state: 'failed', taskId: record.entry.taskId, reason: 'interrupted', message: 'The runner stopped while this task was running.', durationMs: 0 } satisfies JournalEntry }
        : record,
    );
    await this.save();
  }

  async started(taskId: string): Promise<void> {
    this.records = [...this.records.filter((record) => record.entry.taskId !== taskId), { at: this.now(), entry: { state: 'running', taskId } }];
    await this.save();
  }

  async done(done: TaskDone): Promise<void> {
    await this.ended({ state: 'done', ...done });
  }

  async failed(failed: TaskFailed): Promise<void> {
    await this.ended({ state: 'failed', ...failed });
  }

  /** Ends a task that is written down as running, and does nothing for one that is not: for a task that ended in a way that was nobody's decision. */
  async failIfRunning(failed: TaskFailed): Promise<void> {
    if (this.records.some((record) => record.entry.state === 'running' && record.entry.taskId === failed.taskId)) await this.failed(failed);
  }

  /** What `hello` tells the office: the tasks that are running, and how the lately finished ones ended. */
  entries(): JournalEntry[] {
    const oldest = this.now() - JOURNAL_KEEPS_MS;
    return this.records.filter((record) => record.entry.state === 'running' || record.at >= oldest).map((record) => record.entry).slice(-TASK_LIMITS.journal);
  }

  private async ended(entry: JournalEntry): Promise<void> {
    this.records = [...this.records.filter((record) => record.entry.taskId !== entry.taskId), { at: this.now(), entry }];
    await this.save();
  }

  /** Not being able to write the journal is reported and is no reason to fail a task: what it is for is only to say, later, how it ended. */
  private async save(): Promise<void> {
    const oldest = this.now() - JOURNAL_KEEPS_MS;
    this.records = this.records.filter((record) => record.entry.state === 'running' || record.at >= oldest).slice(-TASK_LIMITS.journal);
    try {
      await this.store.save(this.records);
    } catch (error) {
      this.reportError(error);
    }
  }
}
