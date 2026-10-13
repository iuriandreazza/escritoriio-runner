import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONNECTION_LOCK_FILE_NAME, createFileConnectionLock } from './file-connection-lock.ts';

let directory: string;
beforeEach(async () => void (directory = await mkdtemp(join(tmpdir(), 'escritoriio-runner-connection-lock-'))));
afterEach(() => rm(directory, { recursive: true, force: true }));

describe('the lock of the machine’s one connection', () => {
  it('is held by whoever took it, in a file of its own, until it is given up', async () => {
    const release = await createFileConnectionLock(directory).acquire();
    expect(release).toBeDefined();
    expect(JSON.parse(await readFile(join(directory, CONNECTION_LOCK_FILE_NAME), 'utf8'))).toMatchObject({ pid: process.pid });
    expect(await createFileConnectionLock(directory).acquire()).toBeUndefined();
    await release?.();
    const again = await createFileConnectionLock(directory).acquire();
    expect(again).toBeDefined();
    await again?.();
  });

  it('is refused while a process that is alive holds it, and taken over from one that is gone', async () => {
    const holder = createFileConnectionLock(directory, { pid: 41_001, isAlive: () => true });
    expect(await holder.acquire()).toBeDefined();
    expect(await createFileConnectionLock(directory, { pid: 41_002, isAlive: () => true }).acquire()).toBeUndefined();
    const gone = await createFileConnectionLock(directory, { pid: 41_002, isAlive: () => false }).acquire();
    expect(gone).toBeDefined();
    await gone?.();
  });
});
