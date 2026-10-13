import type { Scheduler } from '../application/ports.ts';

export function createSystemScheduler(): Scheduler {
  return {
    now: Date.now,
    after(ms, task) {
      const timer = setTimeout(task, ms);
      return () => clearTimeout(timer);
    },
    random: Math.random,
  };
}
