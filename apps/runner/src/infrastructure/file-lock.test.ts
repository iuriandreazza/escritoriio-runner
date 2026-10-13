import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileLock } from './file-lock.ts';
import { privateFile } from './private-file.ts';

let root: string;
let directory: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'escritoriio-runner-file-lock-'));
  directory = join(root, 'state');
});

afterEach(() => rm(root, { recursive: true, force: true }));

describe('a lock that this process left behind', () => {
  it('is taken over by this process: it is alive, and holds nothing', async () => {
    // What a release that failed leaves: the file of this very process, which nobody holds any more.
    await privateFile(directory, 'task.lock').write(JSON.stringify({ pid: process.pid, startedAt: 1, token: 'left-by-a-release-that-failed' }));
    const release = await createFileLock(directory, 'task.lock').acquire();
    expect(release).toBeDefined();
    await release?.();
    expect(await readdir(directory)).toEqual([]);
  });

  it('is still held while this process holds it, by whichever lock of that name asks', async () => {
    const first = await createFileLock(directory, 'task.lock').acquire();
    expect(first).toBeDefined();
    expect(await createFileLock(directory, 'task.lock').acquire()).toBeUndefined();
    await first?.();
    expect(await createFileLock(directory, 'task.lock').acquire()).toBeDefined();
  });
});

describe('locks of different names in one folder', () => {
  it('are independent: what holds one does not hold the other', async () => {
    const task = createFileLock(directory, 'task.lock');
    const settings = createFileLock(directory, 'policy.lock');
    const releaseTask = await task.acquire();
    expect(releaseTask).toBeDefined();
    expect(await task.acquire()).toBeUndefined();

    const releaseSettings = await settings.acquire();
    expect(releaseSettings).toBeDefined();
    expect(await settings.acquire()).toBeUndefined();
    expect((await readdir(directory)).sort()).toEqual(['policy.lock', 'task.lock']);

    await releaseTask?.();
    await releaseSettings?.();
    expect(await readdir(directory)).toEqual([]);
  });

  it('are each taken over by the next when the process that held it is not alive, and not by the other name', async () => {
    const dead = createFileLock(directory, 'policy.lock', { pid: 4_000_001, isAlive: () => false });
    await dead.acquire();
    expect(await createFileLock(directory, 'policy.lock', { pid: 4_000_002, isAlive: (pid) => pid === 4_000_002 }).acquire()).toBeDefined();
  });
});
