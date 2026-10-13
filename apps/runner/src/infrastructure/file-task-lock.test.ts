import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileTaskLock, TASK_LOCK_FILE_NAME } from './file-task-lock.ts';

const onWindows = process.platform === 'win32';
let root: string;
let directory: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'escritoriio-runner-lock-'));
  // A folder the lock makes itself, not the one `mkdtemp` made: that one is private already, and would hide a mistake.
  directory = join(root, 'state');
});

afterEach(() => rm(root, { recursive: true, force: true }));

const lockFile = () => join(directory, TASK_LOCK_FILE_NAME);
const files = async (): Promise<string[]> => (await readdir(directory).catch(() => [])).sort();

/** The processes of this test that are alive, so that two locks over one folder can be two runners of two processes. */
function processes(...alive: number[]) {
  const live = new Set(alive);
  return {
    live,
    isAlive: (pid: number) => live.has(pid),
    lockOf: (pid: number) => createFileTaskLock(directory, { pid, isAlive: (other) => live.has(other) }),
  };
}

describe('the lock of the machine’s one task, kept in a file', () => {
  it('is taken by the first that asks, and refused to a second while the first holds it', async () => {
    const first = createFileTaskLock(directory);
    const second = createFileTaskLock(directory);
    const release = await first.acquire();
    expect(release).toBeDefined();
    expect(await second.acquire()).toBeUndefined();
    await release?.();
    const next = await second.acquire();
    expect(next).toBeDefined();
    await next?.();
  });

  it('says in the file who holds it and since when, with something that tells this hold from another of the same process', async () => {
    const release = await createFileTaskLock(directory, { pid: 4242, now: () => 1_234_567, isAlive: () => true }).acquire();
    expect(JSON.parse(await readFile(lockFile(), 'utf8'))).toEqual({ pid: 4242, startedAt: 1_234_567, token: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    await release?.();
  });

  it.skipIf(onWindows)('is a file that only its owner reads, in a folder that is theirs only', async () => {
    const release = await createFileTaskLock(directory).acquire();
    expect((await stat(lockFile())).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    await release?.();
  });

  it('is gone when it is given up, and leaves nothing else in the folder, however many tried', async () => {
    const release = await createFileTaskLock(directory).acquire();
    await Promise.all([createFileTaskLock(directory).acquire(), createFileTaskLock(directory).acquire()]);
    await release?.();
    expect(await files()).toEqual([]);
  });

  it('may be given up twice without harm', async () => {
    const lock = createFileTaskLock(directory);
    const release = await lock.acquire();
    await release?.();
    await release?.();
    expect(await lock.acquire()).toBeDefined();
  });

  it('is refused while the one that holds it is a process that is alive, even one that is not this process’s to signal', async () => {
    const holder = processes(1001, 1002);
    const release = await holder.lockOf(1001).acquire();
    expect(await holder.lockOf(1002).acquire()).toBeUndefined();
    await release?.();
  });

  it('asks the system about the holder, and is held by a real process that is alive', async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(lockFile(), JSON.stringify({ pid: process.ppid, startedAt: 1, token: 'x' }));
    expect(await createFileTaskLock(directory).acquire()).toBeUndefined();
    expect(JSON.parse(await readFile(lockFile(), 'utf8')).pid).toBe(process.ppid);
  });
});

describe('a lock that a run that was killed left behind', () => {
  it('is taken over by the next that asks, and the file is the new holder’s', async () => {
    const holder = processes(1001, 1002);
    await holder.lockOf(1001).acquire();
    holder.live.delete(1001);
    const release = await holder.lockOf(1002).acquire();
    expect(release).toBeDefined();
    expect(JSON.parse(await readFile(lockFile(), 'utf8')).pid).toBe(1002);
    await release?.();
    expect(await files()).toEqual([]);
  });

  it('is taken over from a process that really is gone: one that was started and ended', async () => {
    const child = spawn(process.execPath, ['-e', '']);
    const ended = new Promise<void>((resolve) => child.once('close', () => resolve()));
    await ended;
    await mkdir(directory, { recursive: true });
    await writeFile(lockFile(), JSON.stringify({ pid: child.pid, startedAt: 1, token: 'left behind' }));
    const release = await createFileTaskLock(directory).acquire();
    expect(release).toBeDefined();
    expect(JSON.parse(await readFile(lockFile(), 'utf8')).pid).toBe(process.pid);
    await release?.();
  });

  it('is not given up by the one that held it, if that one comes back to give it up after it was taken over', async () => {
    const holder = processes(1001, 1002);
    const first = holder.lockOf(1001);
    const releaseFirst = await first.acquire();
    holder.live.delete(1001);
    const releaseSecond = await holder.lockOf(1002).acquire();
    await releaseFirst?.();
    expect(JSON.parse(await readFile(lockFile(), 'utf8')).pid).toBe(1002);
    expect(await holder.lockOf(1003).acquire()).toBeUndefined();
    await releaseSecond?.();
    expect(await files()).toEqual([]);
  });

  it('is taken by only one of two that find it at the same moment, every time', async () => {
    for (let round = 0; round < 30; round++) {
      const holder = processes(1002, 1003);
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { recursive: true });
      await writeFile(lockFile(), JSON.stringify({ pid: 1001, startedAt: 1, token: 'left behind' }));
      const [one, other] = await Promise.all([holder.lockOf(1002).acquire(), holder.lockOf(1003).acquire()]);
      expect([one, other].filter((release) => release !== undefined)).toHaveLength(1);
      const winner = one ? 1002 : 1003;
      expect(JSON.parse(await readFile(lockFile(), 'utf8')).pid).toBe(winner);
      await (one ?? other)?.();
      expect(await files()).toEqual([]);
    }
  });

  it('is taken by only one of several that find it at the same moment, and is not taken away from the one that took it', async () => {
    const holder = processes(2001, 2002, 2003, 2004, 2005);
    await mkdir(directory, { recursive: true });
    await writeFile(lockFile(), JSON.stringify({ pid: 1, startedAt: 1, token: 'left behind' }));
    const releases = await Promise.all([2001, 2002, 2003, 2004, 2005].map((pid) => holder.lockOf(pid).acquire()));
    expect(releases.filter((release) => release !== undefined)).toHaveLength(1);
  });

  it.each([
    ['not json', 'this is not json'],
    ['empty', ''],
    ['without a process', JSON.stringify({ startedAt: 1 })],
    ['a process that is zero, which would be a whole group', JSON.stringify({ pid: 0, startedAt: 1 })],
    ['a process that is below zero, which would be every process', JSON.stringify({ pid: -1, startedAt: 1 })],
    ['a process that is not a whole number', JSON.stringify({ pid: 1.5, startedAt: 1 })],
    ['a process that is a word', JSON.stringify({ pid: 'self', startedAt: 1 })],
  ])('is taken over when what is in it is %s, and no process is asked about it', async (_what, content) => {
    await mkdir(directory, { recursive: true });
    await writeFile(lockFile(), content);
    const asked: number[] = [];
    const release = await createFileTaskLock(directory, { isAlive: (pid) => (asked.push(pid), true) }).acquire();
    expect(release).toBeDefined();
    expect(asked).toEqual([]);
    await release?.();
  });

  it('is taken over although the one that was taking it over died in the middle of it: its file is what is in the way, and it is dead too', async () => {
    const holder = processes(1002);
    await mkdir(directory, { recursive: true });
    await writeFile(lockFile(), JSON.stringify({ pid: 1001, startedAt: 1, token: 'left behind' }));
    await writeFile(join(directory, 'task.lock.takeover'), JSON.stringify({ pid: 1003, startedAt: 1 }));
    const release = await holder.lockOf(1002).acquire();
    expect(release).toBeDefined();
    expect(JSON.parse(await readFile(lockFile(), 'utf8')).pid).toBe(1002);
    await release?.();
    expect(await files()).toEqual([]);
  });

  it('is not taken over while another process that is alive is in the middle of taking it over', async () => {
    const holder = processes(1002, 1003);
    await mkdir(directory, { recursive: true });
    await writeFile(lockFile(), JSON.stringify({ pid: 1001, startedAt: 1, token: 'left behind' }));
    await writeFile(join(directory, 'task.lock.takeover'), JSON.stringify({ pid: 1003, startedAt: 1 }));
    expect(await holder.lockOf(1002).acquire()).toBeUndefined();
    expect(JSON.parse(await readFile(lockFile(), 'utf8')).pid).toBe(1001);
  });
});

describe('a lock that cannot be made', () => {
  it('is an error, for the caller to say, when the folder cannot take a file', async () => {
    await writeFile(join(root, 'a-file'), 'in the way');
    await expect(createFileTaskLock(join(root, 'a-file', 'state')).acquire()).rejects.toThrow();
  });
});
