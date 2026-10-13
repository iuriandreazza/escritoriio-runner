import type { RunnerToServer } from '@escritoriio/runner-protocol';
import type { Scheduler } from './ports.ts';

/** What the office takes of a runner in a second, as far as the events of a task go: a little under what its connection allows. */
export const EVENTS_PER_SECOND = 20;
/** How many events go at once before the pace holds in: what a task that says a few things sees no wait for. */
export const EVENT_BURST = 20;
/**
 * How many messages wait at most. The events that wait longest are dropped first, and a message that ends a task is never dropped. A task
 * that lost events says so in its ending (`truncated`), and what the office reads of it has gaps in the numbers of its events.
 */
export const OUTBOX_LIMIT = 200;

const isEvent = (message: RunnerToServer): boolean => message.type === 'task.event';

/** Whether the message says that a task is over, which the office is to hear once. */
const endsTask = (message: RunnerToServer): message is Extract<RunnerToServer, { type: 'task.done' | 'task.failed' | 'task.reject' }> =>
  message.type === 'task.done' || message.type === 'task.failed' || message.type === 'task.reject';

/**
 * What a connection says of its tasks, in the order it was said: it waits until the office has welcomed the machine (a task that ends
 * between the `hello` and the welcome says so afterwards), and it lets the events of a task through at a pace, so that a long answer
 * that comes in a burst is not more than the office takes. The message that ends a task waits behind the events that were said before
 * it, so what the office reads is in order. It is one outbox for one connection: when the connection goes, what it held goes with it,
 * and how the tasks ended is in the journal, which the next `hello` tells.
 */
export class TaskOutbox {
  private queue: RunnerToServer[] = [];
  private readonly told = new Set<string>();
  private readonly cutShort: Set<string>;
  private open = false;
  private closed = false;
  private tokens = EVENT_BURST;
  private refilledAt: number;
  private cancelWake: (() => void) | undefined;
  private readonly send: (message: RunnerToServer) => void;
  private readonly scheduler: Scheduler;

  /** `cutShort` is what the connection remembers of the tasks that lost events, on this connection and on those before it. */
  constructor(send: (message: RunnerToServer) => void, scheduler: Scheduler, cutShort: Set<string> = new Set()) {
    this.send = send;
    this.scheduler = scheduler;
    this.cutShort = cutShort;
    this.refilledAt = scheduler.now();
  }

  /** Says it when it can be said. */
  push(message: RunnerToServer): void {
    if (this.closed) return;
    if (endsTask(message)) this.told.add(message.taskId);
    this.queue.push(message);
    this.keepWithinLimit();
    this.drain();
  }

  /** Says it unless it says that a task is over and the office has been told so already: for what is told from the journal, which may be what the task said itself. */
  pushUnlessTold(message: RunnerToServer): void {
    if (endsTask(message) && this.told.has(message.taskId)) return;
    this.push(message);
  }

  /** The office has welcomed the machine: what waited is said, at the pace. */
  welcome(): void {
    this.open = true;
    this.drain();
  }

  /** The connection is gone: nothing more is said, and nothing waits for a time. */
  close(): void {
    this.closed = true;
    this.open = false;
    for (const message of this.queue) if (message.type === 'task.event') this.cutShort.add(message.taskId);
    this.queue = [];
    this.cancelWake?.();
    this.cancelWake = undefined;
  }

  private keepWithinLimit(): void {
    while (this.queue.length > OUTBOX_LIMIT) {
      const oldestEvent = this.queue.findIndex(isEvent);
      if (oldestEvent === -1) return;
      const [dropped] = this.queue.splice(oldestEvent, 1);
      if (dropped?.type === 'task.event') this.cutShort.add(dropped.taskId);
    }
  }

  private refill(): void {
    const now = this.scheduler.now();
    // A clock that was set back must not take events away that were never said.
    this.tokens = Math.min(EVENT_BURST, this.tokens + (Math.max(0, now - this.refilledAt) * EVENTS_PER_SECOND) / 1_000);
    this.refilledAt = now;
  }

  private drain(): void {
    this.cancelWake?.();
    this.cancelWake = undefined;
    if (!this.open) return;
    this.refill();
    for (let next = this.queue[0]; next !== undefined; next = this.queue[0]) {
      if (isEvent(next)) {
        if (this.tokens < 1) {
          this.cancelWake = this.scheduler.after(Math.ceil(((1 - this.tokens) * 1_000) / EVENTS_PER_SECOND), () => this.drain());
          return;
        }
        this.tokens -= 1;
      }
      this.queue.shift();
      // Said when it leaves the queue, since what was dropped from before it is known only then.
      this.send(next.type === 'task.done' && this.cutShort.delete(next.taskId) ? { ...next, truncated: true } : next);
    }
  }
}
