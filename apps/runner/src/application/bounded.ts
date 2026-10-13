import type { Scheduler } from './ports.ts';

/** A signal that aborts when another does, or when a time is up, and what tells which of the two it was. */
export interface Bounded {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  /** Must be called when the work is over, so that nothing is left waiting for the signal or for the time. */
  readonly release: () => void;
}

/** The signal of a task, which also aborts when `ms` is up: for the work around a task that has a time of its own. */
export function bounded(scheduler: Scheduler, signal: AbortSignal, ms: number): Bounded {
  const controller = new AbortController();
  let late = false;
  const forward = (): void => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', forward, { once: true });
  const cancel = scheduler.after(ms, () => {
    late = true;
    controller.abort();
  });
  return {
    signal: controller.signal,
    timedOut: () => late,
    release: () => {
      cancel();
      signal.removeEventListener('abort', forward);
    },
  };
}

/**
 * Waits for an answer from the owner of the machine for at most `ms`, and no longer than the task: when the task stops, or the time is up,
 * whatever was shown is taken away and the answer is `whenStopped`. A place that ignores the signal does not keep the task waiting for ever.
 */
export async function answerWithin<T>(scheduler: Scheduler, signal: AbortSignal, ms: number, ask: (signal: AbortSignal) => Promise<T>, whenStopped: T): Promise<{ readonly answer: T; readonly timedOut: boolean }> {
  const waiting = bounded(scheduler, signal, ms);
  try {
    const stopped = new Promise<T>((resolve) => {
      if (waiting.signal.aborted) resolve(whenStopped);
      else waiting.signal.addEventListener('abort', () => resolve(whenStopped), { once: true });
    });
    const answer = await Promise.race([ask(waiting.signal), stopped]);
    return { answer, timedOut: waiting.timedOut() };
  } finally {
    waiting.release();
  }
}
