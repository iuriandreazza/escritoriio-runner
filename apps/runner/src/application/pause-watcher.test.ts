import { describe, expect, it } from 'vitest';
import { PAUSE_POLL_MS, PauseWatcher } from './pause-watcher.ts';
import { EMPTY_POLICY } from './task-ports.ts';
import { FakePolicyStore } from './task-testing.ts';
import { FakeScheduler } from './testing.ts';

function setup() {
  const policy = new FakePolicyStore(EMPTY_POLICY);
  const scheduler = new FakeScheduler();
  const changes: boolean[] = [];
  const errors: unknown[] = [];
  const watcher = new PauseWatcher({ policy, scheduler, onChange: (paused) => void changes.push(paused), onError: (error) => void errors.push(error) });
  const setPaused = (paused: boolean) => void (policy.policy = { ...policy.policy, paused });
  return { policy, scheduler, watcher, changes, errors, setPaused };
}

describe('looking for the pause of the owner, at once when asked', () => {
  it('tells a change now, and goes on looking at the usual times without looking twice as often', async () => {
    const { watcher, scheduler, changes, setPaused } = setup();
    watcher.start(false);
    setPaused(true);
    await watcher.checkNow();
    expect(changes).toEqual([true]);
    expect(scheduler.pending).toBe(1);
    setPaused(false);
    await scheduler.advance(PAUSE_POLL_MS);
    expect(changes).toEqual([true, false]);
  });

  it('does not start a second chain of looks when a look is under way', async () => {
    const { watcher, scheduler, policy, changes } = setup();
    watcher.start(false);
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const load = policy.load.bind(policy);
    policy.load = async () => {
      await slow;
      return load();
    };
    await scheduler.advance(PAUSE_POLL_MS);
    const now = watcher.checkNow();
    release();
    await now;
    await scheduler.advance(0);
    expect(scheduler.pending).toBe(1);
    expect(changes).toEqual([]);
  });

  it('does nothing when it is not looking', async () => {
    const { watcher, changes, setPaused } = setup();
    setPaused(true);
    await watcher.checkNow();
    expect(changes).toEqual([]);
  });
});

describe('looking for the pause of the owner', () => {
  it('tells a pause that was set on the machine within a second, once', async () => {
    const { watcher, scheduler, changes, setPaused } = setup();
    watcher.start(false);
    await scheduler.advance(PAUSE_POLL_MS * 3);
    expect(changes).toEqual([]);

    setPaused(true);
    await scheduler.advance(PAUSE_POLL_MS - 1);
    expect(changes).toEqual([]);
    await scheduler.advance(1);
    expect(changes).toEqual([true]);
    await scheduler.advance(PAUSE_POLL_MS * 5);
    expect(changes).toEqual([true]);
  });

  it('tells that it was lifted', async () => {
    const { watcher, scheduler, changes, setPaused } = setup();
    setPaused(true);
    watcher.start(true);
    await scheduler.advance(PAUSE_POLL_MS * 2);
    expect(changes).toEqual([]);
    setPaused(false);
    await scheduler.advance(PAUSE_POLL_MS);
    expect(changes).toEqual([false]);
  });

  it('tells a pause that is already there when it starts looking only if the runner did not know of it', async () => {
    const { watcher, scheduler, changes, setPaused } = setup();
    setPaused(true);
    watcher.start(false);
    await scheduler.advance(PAUSE_POLL_MS);
    expect(changes).toEqual([true]);
  });

  it('tells each change, however quickly they come back and forth between looks it did not make', async () => {
    const { watcher, scheduler, changes, setPaused } = setup();
    watcher.start(false);
    setPaused(true);
    await scheduler.advance(PAUSE_POLL_MS);
    setPaused(false);
    await scheduler.advance(PAUSE_POLL_MS);
    setPaused(true);
    await scheduler.advance(PAUSE_POLL_MS);
    expect(changes).toEqual([true, false, true]);
  });

  it('stops looking when it is stopped, and leaves nothing waiting', async () => {
    const { watcher, scheduler, changes, setPaused } = setup();
    watcher.start(false);
    watcher.stop();
    expect(scheduler.pending).toBe(0);
    setPaused(true);
    await scheduler.advance(PAUSE_POLL_MS * 5);
    expect(changes).toEqual([]);
  });

  it('does not tell what it finds after it was stopped, by a look that was under way', async () => {
    const { watcher, scheduler, policy, changes } = setup();
    let finish: () => void = () => undefined;
    policy.load = () => new Promise((resolve) => (finish = () => resolve({ ...EMPTY_POLICY, paused: true })));
    watcher.start(false);
    await scheduler.advance(PAUSE_POLL_MS);
    watcher.stop();
    finish();
    await scheduler.advance(PAUSE_POLL_MS * 2);
    expect(changes).toEqual([]);
    expect(scheduler.pending).toBe(0);
  });

  it('can be started again', async () => {
    const { watcher, scheduler, changes, setPaused } = setup();
    watcher.start(false);
    watcher.stop();
    watcher.start(false);
    setPaused(true);
    await scheduler.advance(PAUSE_POLL_MS);
    expect(changes).toEqual([true]);
    expect(scheduler.pending).toBe(1);
  });

  it('is not started twice by being told to start twice', async () => {
    const { watcher, scheduler } = setup();
    watcher.start(false);
    watcher.start(false);
    expect(scheduler.pending).toBe(1);
  });

  it('tells that the settings cannot be read once, and not at every look, and goes on looking', async () => {
    const { watcher, scheduler, policy, changes, errors, setPaused } = setup();
    const load = policy.load.bind(policy);
    policy.load = () => Promise.reject(new Error('cannot be read'));
    watcher.start(false);
    await scheduler.advance(PAUSE_POLL_MS * 5);
    expect(errors).toHaveLength(1);
    expect(changes).toEqual([]);

    policy.load = load;
    setPaused(true);
    await scheduler.advance(PAUSE_POLL_MS);
    expect(changes).toEqual([true]);

    policy.load = () => Promise.reject(new Error('cannot be read'));
    await scheduler.advance(PAUSE_POLL_MS * 2);
    expect(errors).toHaveLength(2);
  });
});
