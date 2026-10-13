import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JournalRecord } from '../application/task-ports.ts';
import { createFileJournalStore, JOURNAL_FILE_NAME } from './file-journal-store.ts';

const onWindows = process.platform === 'win32';
let root: string;
let directory: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'escritoriio-runner-journal-'));
  directory = join(root, 'state');
});

afterEach(() => rm(root, { recursive: true, force: true }));

const file = () => join(directory, JOURNAL_FILE_NAME);
const mode = async (path: string) => (await stat(path)).mode & 0o777;
const records: JournalRecord[] = [
  { at: 1_000, entry: { state: 'running', taskId: 't1' } },
  { at: 2_000, entry: { state: 'done', taskId: 't2', text: 'Done.', branch: 'escritoriio/t2', diffStat: ' a.txt | 1 +', durationMs: 1_234, truncated: false } },
  { at: 3_000, entry: { state: 'failed', taskId: 't3', reason: 'timeout', message: 'The task ran for too long and was stopped.', durationMs: 5_000 } },
];

describe('the journal kept in a file', () => {
  it('is empty before there is one', async () => {
    expect(await createFileJournalStore(directory).load()).toEqual([]);
  });

  it('comes back as it was kept', async () => {
    await createFileJournalStore(directory).save(records);
    expect(await createFileJournalStore(directory).load()).toEqual(records);
  });

  it('is replaced whole by the next one, and two saves in a row leave no other file behind', async () => {
    const store = createFileJournalStore(directory);
    await Promise.all([store.save(records), store.save(records.slice(0, 1))]);
    await store.save(records);
    expect(await store.load()).toEqual(records);
    expect(await readdir(directory)).toEqual([JOURNAL_FILE_NAME]);
  });

  it.skipIf(onWindows)('is readable by its owner only, in a folder that is theirs only, since it holds what the coding agents said', async () => {
    await createFileJournalStore(directory).save(records);
    expect(await mode(directory)).toBe(0o700);
    expect(await mode(file())).toBe(0o600);
  });

  it.each([
    ['not json', 'this is not json'],
    ['empty', ''],
    ['of another shape', '{"version":1}'],
    ['of a version it does not know', JSON.stringify({ version: 9, records: [] })],
    ['with an entry that is not one', JSON.stringify({ version: 1, records: [{ at: 1, entry: { state: 'on fire', taskId: 't' } }] })],
    ['with a time that is not one', JSON.stringify({ version: 1, records: [{ at: 'yesterday', entry: { state: 'running', taskId: 't' } }] })],
    ['with more entries than it keeps', JSON.stringify({ version: 1, records: Array.from({ length: 21 }, (_, index) => ({ at: index, entry: { state: 'running', taskId: `t${index}` } })) })],
  ])('is let go of, with no failure, when it is %s', async (_what, content) => {
    await mkdir(directory, { recursive: true });
    await writeFile(file(), content);
    expect(await createFileJournalStore(directory).load()).toEqual([]);
  });

  it('is let go of, with no failure, when it cannot be read at all', async () => {
    await mkdir(file(), { recursive: true });
    expect(await createFileJournalStore(directory).load()).toEqual([]);
  });

  it('fails to keep what cannot be written, for its owner to be told', async () => {
    await mkdir(file(), { recursive: true });
    await expect(createFileJournalStore(directory).save(records)).rejects.toThrow();
    expect(await readdir(directory)).toEqual([JOURNAL_FILE_NAME]);
  });
});
