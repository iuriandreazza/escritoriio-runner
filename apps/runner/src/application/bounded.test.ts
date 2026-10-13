import { describe, expect, it } from 'vitest';
import { answerWithin, bounded } from './bounded.ts';
import { FakeScheduler } from './testing.ts';

describe('a signal bounded by a time', () => {
  it('aborts when the time is up, and says it was the time', async () => {
    const scheduler = new FakeScheduler();
    const waiting = bounded(scheduler, new AbortController().signal, 1_000);
    await scheduler.advance(999);
    expect(waiting.signal.aborted).toBe(false);
    await scheduler.advance(1);
    expect(waiting.signal.aborted).toBe(true);
    expect(waiting.timedOut()).toBe(true);
  });

  it('aborts when the signal it follows does, and says it was not the time', () => {
    const scheduler = new FakeScheduler();
    const parent = new AbortController();
    const waiting = bounded(scheduler, parent.signal, 1_000);
    parent.abort();
    expect(waiting.signal.aborted).toBe(true);
    expect(waiting.timedOut()).toBe(false);
  });

  it('is aborted from the start by a signal that is aborted already', () => {
    expect(bounded(new FakeScheduler(), AbortSignal.abort(), 1_000).signal.aborted).toBe(true);
  });

  it('leaves nothing waiting once it is released', () => {
    const scheduler = new FakeScheduler();
    bounded(scheduler, new AbortController().signal, 1_000).release();
    expect(scheduler.pending).toBe(0);
  });
});

describe('waiting for an answer', () => {
  it('gives the answer, and leaves nothing waiting', async () => {
    const scheduler = new FakeScheduler();
    const result = await answerWithin(scheduler, new AbortController().signal, 1_000, () => Promise.resolve('approved'), 'denied');
    expect(result).toEqual({ answer: 'approved', timedOut: false });
    expect(scheduler.pending).toBe(0);
  });

  it('gives the stopped answer, and says it was the time, when nobody answered in time', async () => {
    const scheduler = new FakeScheduler();
    const waiting = answerWithin(scheduler, new AbortController().signal, 1_000, () => new Promise<string>(() => undefined), 'denied');
    await scheduler.advance(1_000);
    expect(await waiting).toEqual({ answer: 'denied', timedOut: true });
  });

  it('gives the stopped answer when the task is stopped, even by a place that ignores the signal it was given', async () => {
    const scheduler = new FakeScheduler();
    const parent = new AbortController();
    const waiting = answerWithin(scheduler, parent.signal, 1_000, () => new Promise<string>(() => undefined), 'denied');
    parent.abort();
    expect(await waiting).toEqual({ answer: 'denied', timedOut: false });
  });

  it('gives the stopped answer, and asks nobody that is not there, when the task was stopped already', async () => {
    const asked: AbortSignal[] = [];
    const result = await answerWithin(new FakeScheduler(), AbortSignal.abort(), 1_000, (signal) => {
      asked.push(signal);
      return new Promise<string>(() => undefined);
    }, 'denied');
    expect(result.answer).toBe('denied');
  });
});
