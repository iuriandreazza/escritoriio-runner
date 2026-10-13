import type { JournalEntry } from '@escritoriio/runner-protocol';
import { MAX_RUNNER_MESSAGE_BYTES, parseRunnerMessage, RUNNER_PROTOCOL_VERSION, TASK_LIMITS } from '@escritoriio/runner-protocol';
import { describe, expect, it } from 'vitest';
import { tasksThatFit } from './tasks-that-fit.ts';

const done = (taskId: string, text = 'Done.', diffStat: string | null = null): JournalEntry => ({ state: 'done', taskId, text, branch: null, diffStat, durationMs: 1, truncated: false });
const running = (taskId: string): JournalEntry => ({ state: 'running', taskId });
const bytes = (text: string): number => new TextEncoder().encode(text).length;
const hello = (tasks: JournalEntry[]) => ({ type: 'hello', protocol: RUNNER_PROTOCOL_VERSION, runnerVersion: '0.1.0', os: 'darwin', agents: [{ kind: 'claude-code', version: '2.1.250', loggedIn: true }], folders: ['site'], paused: false, tasks });

describe('the tasks that hello tells of', () => {
  it('are all of them when they fit', () => {
    const entries = [done('a'), running('b'), done('c')];
    expect(tasksThatFit(entries, 300, 10_000)).toEqual(entries);
  });

  it('are the newest that fit, in the order they were, when they do not', () => {
    const big = (id: string) => done(id, 'x'.repeat(1_000));
    const entries = [big('old'), big('middle'), big('new')];
    const room = bytes(JSON.stringify(entries[0])) * 2 + 10;
    expect(tasksThatFit(entries, 0, room).map((entry) => entry.taskId)).toEqual(['middle', 'new']);
  });

  it('always include the ones that still run, however little room there is', () => {
    const entries = [running('r1'), done('d1', 'x'.repeat(5_000)), running('r2')];
    expect(tasksThatFit(entries, 0, 100).map((entry) => entry.taskId)).toEqual(['r1', 'r2']);
  });

  it('skip one that does not fit and still tell of an older one that does', () => {
    const entries = [done('small'), done('huge', 'x'.repeat(8_000))];
    expect(tasksThatFit(entries, 0, 500).map((entry) => entry.taskId)).toEqual(['small']);
  });

  it('keep a hello of twenty finished tasks as big as one can be, with text that takes more bytes than characters, within one frame that the office takes', () => {
    const text = 'Conclu\u00eddo: a\u00e7\u00e3o e aten\u00e7\u00e3o, \u4f60\u597d, \u{1F600} '.repeat(400).slice(0, TASK_LIMITS.finalText - 20).concat('\n"quoted" \\ back\n');
    const diffStat = ' src/a\u00e7\u00e3o.ts | 12 +++++\n'.repeat(100).slice(0, TASK_LIMITS.diffStat);
    const entries = Array.from({ length: TASK_LIMITS.journal }, (_, index) => done(`task-${index}`, text, diffStat));

    const whole = JSON.stringify(hello(entries));
    expect(bytes(whole)).toBeGreaterThan(MAX_RUNNER_MESSAGE_BYTES);

    const fitting = hello(tasksThatFit(entries, bytes(JSON.stringify(hello([]))), MAX_RUNNER_MESSAGE_BYTES - 512));
    const sent = JSON.stringify(fitting);
    expect(bytes(sent)).toBeLessThanOrEqual(MAX_RUNNER_MESSAGE_BYTES);
    expect(parseRunnerMessage(sent)).toMatchObject({ ok: true });
    expect(fitting.tasks.length).toBeGreaterThan(0);
    expect(fitting.tasks.at(-1)).toEqual(entries.at(-1));
  });
});
