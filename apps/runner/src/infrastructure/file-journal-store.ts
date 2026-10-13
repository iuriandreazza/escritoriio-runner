import { journalEntrySchema, TASK_LIMITS } from '@escritoriio/runner-protocol';
import { z } from 'zod';
import type { JournalRecord, JournalStore } from '../application/task-ports.ts';
import { privateFile } from './private-file.ts';

export const JOURNAL_FILE_NAME = 'journal.json';

const journalFileSchema = z.strictObject({
  version: z.literal(1),
  records: z.array(z.strictObject({ at: z.number().int().min(0), entry: journalEntrySchema })).max(TASK_LIMITS.journal),
});

/**
 * What the runner remembers of how its tasks ended, in `journal.json`, private like the rest: it holds what the coding agents said. It
 * only serves to tell the office, after a connection that dropped, how a task came out, so a file that cannot be read is let go of and
 * is no failure: nothing is told, and the next task starts a new one.
 */
export function createFileJournalStore(directory: string): JournalStore {
  const file = privateFile(directory, JOURNAL_FILE_NAME);

  return {
    async load() {
      let json: unknown;
      try {
        json = JSON.parse((await file.read()) ?? '');
      } catch {
        return [];
      }
      const parsed = journalFileSchema.safeParse(json);
      return parsed.success ? parsed.data.records : [];
    },

    async save(records: readonly JournalRecord[]) {
      await file.write(`${JSON.stringify({ version: 1, records }, null, 2)}\n`);
    },
  };
}
