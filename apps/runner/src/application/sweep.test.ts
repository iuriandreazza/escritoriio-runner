import { describe, expect, it } from 'vitest';
import { describeSweep, sweepWhatWasLeft } from './sweep.ts';
import { FakeIsolation, FakeTaskLock } from './task-testing.ts';

describe('cleaning up what a runner that was killed left behind', () => {
  it('is done while the lock of the one task is held, and the lock is given up after', async () => {
    const lock = new FakeTaskLock();
    const isolation = new FakeIsolation();
    isolation.sweepResult = { copies: 2, branches: 1 };
    let heldWhileSweeping: boolean | undefined;
    const sweep = isolation.sweep.bind(isolation);
    isolation.sweep = () => {
      heldWhileSweeping = lock.held;
      return sweep();
    };
    expect(await sweepWhatWasLeft({ lock, isolation })).toEqual({ copies: 2, branches: 1 });
    expect(heldWhileSweeping).toBe(true);
    expect(lock.held).toBe(false);
  });

  it('is not done while another process runs a task: what it would find is that task’s', async () => {
    const lock = new FakeTaskLock();
    lock.heldElsewhere = true;
    const isolation = new FakeIsolation();
    expect(await sweepWhatWasLeft({ lock, isolation })).toBeUndefined();
    expect(isolation.sweeps).toBe(0);
  });

  it('gives up the lock when the clean-up fails, and says what failed', async () => {
    const lock = new FakeTaskLock();
    const isolation = new FakeIsolation();
    isolation.sweep = () => Promise.reject(new Error('the disk is full'));
    await expect(sweepWhatWasLeft({ lock, isolation })).rejects.toThrow('the disk is full');
    expect(lock.held).toBe(false);
  });

  it('says that the lock cannot be asked, when it cannot', async () => {
    const lock = new FakeTaskLock();
    lock.failWith = new Error('EACCES');
    await expect(sweepWhatWasLeft({ lock, isolation: new FakeIsolation() })).rejects.toThrow('EACCES');
  });
});

describe('what a clean-up says', () => {
  it.each([
    [{ copies: 0, branches: 0 }, undefined],
    [{ copies: 1, branches: 0 }, 'Cleaned up what an earlier run left behind when it was stopped abruptly: one copy of a folder.'],
    [{ copies: 1, branches: 1 }, 'Cleaned up what an earlier run left behind when it was stopped abruptly: one copy of a folder, and one branch with nothing on it.'],
    [{ copies: 3, branches: 2 }, 'Cleaned up what an earlier run left behind when it was stopped abruptly: 3 copies of folders, and 2 branches with nothing on them.'],
  ])('is %j said as %j', (report, words) => {
    expect(describeSweep(report)).toBe(words);
  });
});
