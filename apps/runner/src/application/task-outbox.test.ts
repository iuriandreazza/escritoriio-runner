import type { RunnerToServer } from '@escritoriio/runner-protocol';
import { describe, expect, it } from 'vitest';
import { EVENT_BURST, EVENTS_PER_SECOND, OUTBOX_LIMIT, TaskOutbox } from './task-outbox.ts';
import { FakeScheduler } from './testing.ts';

const event = (seq: number, taskId = 't1'): RunnerToServer => ({ type: 'task.event', taskId, seq, event: { kind: 'text', text: `piece ${seq}` } });
const done = (taskId = 't1'): RunnerToServer => ({ type: 'task.done', taskId, text: 'Done.', branch: null, diffStat: null, durationMs: 1, truncated: false });
const failed = (taskId = 't1'): RunnerToServer => ({ type: 'task.failed', taskId, reason: 'error', message: 'It failed.', durationMs: 1 });

function setup() {
  const scheduler = new FakeScheduler();
  const sent: RunnerToServer[] = [];
  const outbox = new TaskOutbox((message) => sent.push(message), scheduler);
  return { scheduler, sent, outbox };
}

const seqs = (sent: readonly RunnerToServer[]): number[] => sent.flatMap((message) => (message.type === 'task.event' ? [message.seq] : []));

describe('what is said of a task', () => {
  it('waits until the office has welcomed the machine, and is then said in the order it was said in', () => {
    const { outbox, sent } = setup();
    outbox.push(event(0));
    outbox.push(event(1));
    outbox.push(done());
    expect(sent).toEqual([]);
    outbox.welcome();
    expect(sent.map((message) => message.type)).toEqual(['task.event', 'task.event', 'task.done']);
    expect(seqs(sent)).toEqual([0, 1]);
  });

  it('is said at once when the office has welcomed the machine already, and there is no wait', () => {
    const { outbox, sent } = setup();
    outbox.welcome();
    outbox.push(event(0));
    expect(sent).toEqual([event(0)]);
    outbox.push(done());
    expect(sent).toEqual([event(0), done()]);
  });
});

describe('the events of a task, at a pace', () => {
  it('go at once up to the burst and then at the pace, one when each is due', async () => {
    const { outbox, sent, scheduler } = setup();
    outbox.welcome();
    for (let seq = 0; seq < 30; seq++) outbox.push(event(seq));
    expect(seqs(sent)).toEqual(Array.from({ length: EVENT_BURST }, (_, index) => index));

    await scheduler.advance(49);
    expect(sent).toHaveLength(EVENT_BURST);
    await scheduler.advance(1);
    expect(sent).toHaveLength(EVENT_BURST + 1);
    await scheduler.advance(450);
    expect(seqs(sent)).toEqual(Array.from({ length: 30 }, (_, index) => index));
    expect(scheduler.pending).toBe(0);
  });

  it('are never more than the pace in any second once the burst is over', async () => {
    const { outbox, sent, scheduler } = setup();
    outbox.welcome();
    for (let seq = 0; seq < 200; seq++) outbox.push(event(seq));
    const atOnce = sent.length;
    await scheduler.advance(2_000);
    expect(sent.length - atOnce).toBeLessThanOrEqual(2 * EVENTS_PER_SECOND);
    expect(sent.length - atOnce).toBeGreaterThanOrEqual(2 * EVENTS_PER_SECOND - 1);
  });

  it('are let go in a burst again after a while of quiet: the pace is a rate and not a count', async () => {
    const { outbox, sent, scheduler } = setup();
    outbox.welcome();
    for (let seq = 0; seq < 20; seq++) outbox.push(event(seq));
    await scheduler.advance(5_000);
    for (let seq = 20; seq < 40; seq++) outbox.push(event(seq));
    expect(sent).toHaveLength(40);
  });

  it('keep the end of the task behind them, and in the order the task said them', async () => {
    const { outbox, sent, scheduler } = setup();
    outbox.welcome();
    for (let seq = 0; seq < 25; seq++) outbox.push(event(seq));
    outbox.push(done());
    expect(sent.some((message) => message.type === 'task.done')).toBe(false);
    await scheduler.advance(1_000);
    expect(sent.at(-1)).toEqual(done());
    expect(seqs(sent)).toEqual(Array.from({ length: 25 }, (_, index) => index));
  });

  it('do not hold what is not an event, which is said as soon as nothing is before it', () => {
    const { outbox, sent } = setup();
    outbox.welcome();
    outbox.push({ type: 'task.accept', taskId: 't1' });
    expect(sent).toEqual([{ type: 'task.accept', taskId: 't1' }]);
  });
});

describe('what the outbox holds', () => {
  it('is no more than the limit: the oldest events go first', () => {
    const { outbox, sent } = setup();
    for (let seq = 0; seq < OUTBOX_LIMIT + 50; seq++) outbox.push(event(seq));
    outbox.welcome();
    const said = seqs(sent);
    expect(said.length).toBeLessThanOrEqual(EVENT_BURST);
    // What is held is the newest 200: the burst takes the first of them.
    expect(said[0]).toBe(50);
  });

  it('never loses the end of a task, however much came before it', async () => {
    const { outbox, sent, scheduler } = setup();
    for (let seq = 0; seq < 1_000; seq++) outbox.push(event(seq));
    outbox.push(done());
    outbox.push(failed('t2'));
    outbox.welcome();
    await scheduler.advance(60_000);
    expect(sent.filter((message) => message.type === 'task.done')).toEqual([{ ...done(), truncated: true }]);
    expect(sent.filter((message) => message.type === 'task.failed')).toEqual([failed('t2')]);
    expect(seqs(sent).length).toBeLessThanOrEqual(OUTBOX_LIMIT);
    expect(seqs(sent).at(-1)).toBe(999);
  });

  it('says in the ending of a task that events were dropped, and of that task only', async () => {
    const { outbox, sent, scheduler } = setup();
    for (let seq = 0; seq < OUTBOX_LIMIT + 10; seq++) outbox.push(event(seq, 'long'));
    outbox.push(event(0, 'short'));
    outbox.push(done('short'));
    outbox.push(done('long'));
    outbox.welcome();
    await scheduler.advance(60_000);
    const endings = sent.filter((message) => message.type === 'task.done');
    expect(endings).toEqual([{ ...done('short'), truncated: false }, { ...done('long'), truncated: true }]);
  });

  it('keeps its pace when the clock is set back: events are not held for as long as it was set back', async () => {
    const { outbox, sent, scheduler } = setup();
    outbox.welcome();
    for (let seq = 0; seq < EVENT_BURST; seq++) outbox.push(event(seq));
    scheduler.setBack(3_600_000);
    outbox.push(event(EVENT_BURST));
    outbox.push(done());
    await scheduler.advance(1_000);
    expect(seqs(sent)).toHaveLength(EVENT_BURST + 1);
    expect(sent.at(-1)).toMatchObject({ type: 'task.done' });
  });

  it('says in the ending that the events it held when the connection went were lost, to the outbox of the next', async () => {
    const lost = new Set<string>();
    const scheduler = new FakeScheduler();
    const first = new TaskOutbox(() => undefined, scheduler, lost);
    first.push(event(0));
    first.close();
    const sent: RunnerToServer[] = [];
    const next = new TaskOutbox((message) => sent.push(message), scheduler, lost);
    next.welcome();
    next.push(done());
    expect(sent).toEqual([{ ...done(), truncated: true }]);
    // Said once: it is not carried over to a task that is not this one.
    next.push(done());
    expect(sent.at(-1)).toEqual(done());
  });

  it('says what it was told to say, whatever it said before: an answer to an offer is never swallowed', () => {
    const { outbox, sent } = setup();
    outbox.welcome();
    outbox.push(done());
    outbox.push({ type: 'task.reject', taskId: 't1', reason: 'cannot-isolate', message: 'A copy or a branch for this task exists already in that repository.' });
    expect(sent.map((message) => message.type)).toEqual(['task.done', 'task.reject']);
  });

  it('does not say again that a task is over when it is told from the journal and the task said it itself', () => {
    const { outbox, sent } = setup();
    outbox.push(done());
    outbox.pushUnlessTold(done());
    outbox.pushUnlessTold(failed());
    outbox.pushUnlessTold(done('t2'));
    outbox.pushUnlessTold({ type: 'task.accept', taskId: 't1' });
    outbox.welcome();
    expect(sent).toEqual([done(), done('t2'), { type: 'task.accept', taskId: 't1' }]);
  });

  it('is gone with the connection: nothing is said afterwards, and no time is waited for', async () => {
    const { outbox, sent, scheduler } = setup();
    outbox.welcome();
    for (let seq = 0; seq < 40; seq++) outbox.push(event(seq));
    const before = sent.length;
    expect(scheduler.pending).toBeGreaterThan(0);
    outbox.close();
    expect(scheduler.pending).toBe(0);
    outbox.push(event(99));
    outbox.welcome();
    await scheduler.advance(5_000);
    expect(sent).toHaveLength(before);
  });
});
