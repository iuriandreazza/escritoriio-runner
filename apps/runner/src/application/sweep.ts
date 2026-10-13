import type { Isolation, SweepReport, TaskLock } from './task-ports.ts';

/** What a clean-up came to, in words for the person: nothing at all when it found nothing to do. */
export function describeSweep(report: SweepReport): string | undefined {
  if (report.copies === 0 && report.branches === 0) return undefined;
  const copies = report.copies === 1 ? 'one copy of a folder' : `${report.copies} copies of folders`;
  const branches = report.branches === 0 ? '' : `, and ${report.branches === 1 ? 'one branch' : `${report.branches} branches`} with nothing on ${report.branches === 1 ? 'it' : 'them'}`;
  return `Cleaned up what an earlier run left behind when it was stopped abruptly: ${copies}${branches}.`;
}

/**
 * Cleans up what a runner that was killed left behind, which only is safe while no task runs: the lock of the machine's one task is held
 * for it, and when somebody else holds it a task is running and there is nothing to do now. Gives what it did, or nothing when it did
 * not. Throws what the clean-up throws, which is for the caller to say and not to stop at: it is housekeeping.
 */
export async function sweepWhatWasLeft({ lock, isolation }: { readonly lock: TaskLock; readonly isolation: Isolation }): Promise<SweepReport | undefined> {
  const release = await lock.acquire();
  if (!release) return undefined;
  try {
    return await isolation.sweep();
  } finally {
    await release().catch(() => undefined);
  }
}
