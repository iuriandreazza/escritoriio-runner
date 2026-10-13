import type { JournalEntry } from '@escritoriio/runner-protocol';
import { byteLength } from './byte-length.ts';

/**
 * The tasks `hello` can tell of without the message growing past what the office takes in one frame. Each finished task may carry what the
 * coding agent said at the end, so twenty of them are more than a frame holds: the ones that still run are always told, since the office
 * has to know they are there, and then the finished ones from the newest, for as long as they fit. `bytesWithoutTasks` is what the message
 * weighs as it will be sent, with an empty list of tasks.
 */
export function tasksThatFit(entries: readonly JournalEntry[], bytesWithoutTasks: number, limitBytes: number): JournalEntry[] {
  // A comma goes between the entries of a list.
  const weigh = (entry: JournalEntry): number => byteLength(JSON.stringify(entry)) + 1;
  const kept = new Set<JournalEntry>(entries.filter((entry) => entry.state === 'running'));
  let used = bytesWithoutTasks + [...kept].reduce((sum, entry) => sum + weigh(entry), 0);
  for (const entry of [...entries].reverse()) {
    if (kept.has(entry)) continue;
    if (used + weigh(entry) > limitBytes) continue;
    used += weigh(entry);
    kept.add(entry);
  }
  return entries.filter((entry) => kept.has(entry));
}
