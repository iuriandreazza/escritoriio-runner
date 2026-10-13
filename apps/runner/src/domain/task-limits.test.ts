import { describe, expect, it } from 'vitest';
import { effectiveCeilings, LOCAL_CEILINGS, OutputBudget } from './task-limits.ts';

describe('the ceilings of a task', () => {
  it('are the machine’s own when the office asks for nothing', () => {
    expect(effectiveCeilings({})).toEqual({ seconds: 1_800, outputBytes: 64 * 1024 });
    expect(LOCAL_CEILINGS).toEqual({ seconds: 1_800, outputBytes: 65_536 });
  });

  it('are what the office asks when that is less, and never more than the machine allows', () => {
    expect(effectiveCeilings({ maxSeconds: 60, maxOutputBytes: 1_000 })).toEqual({ seconds: 60, outputBytes: 1_000 });
    expect(effectiveCeilings({ maxSeconds: 99_999, maxOutputBytes: 9_999_999 })).toEqual({ seconds: 1_800, outputBytes: 65_536 });
    expect(effectiveCeilings({ maxSeconds: 120 }, { seconds: 60, outputBytes: 10 })).toEqual({ seconds: 60, outputBytes: 10 });
  });
});

describe('the output a task may keep', () => {
  it('takes what fits, whole', () => {
    const budget = new OutputBudget(10);
    expect(budget.take('hello')).toBe('hello');
    expect(budget.take('world')).toBe('world');
    expect(budget.truncated).toBe(false);
  });

  it('cuts the piece that does not fit and drops everything after it', () => {
    const budget = new OutputBudget(8);
    expect(budget.take('hello')).toBe('hello');
    expect(budget.take('worlds')).toBe('wor');
    expect(budget.take('x')).toBe('');
    expect(budget.truncated).toBe(true);
  });

  it('counts bytes, not characters, and never cuts a character in two', () => {
    const budget = new OutputBudget(7);
    expect(budget.take('ação')).toBe('ação');
    expect(budget.take('é')).toBe('');
    const small = new OutputBudget(4);
    expect(small.take('ab€')).toBe('ab');
    expect(small.truncated).toBe(true);
  });

  it('takes nothing from a budget of nothing, and does not mind a negative one', () => {
    expect(new OutputBudget(0).take('a')).toBe('');
    expect(new OutputBudget(-5).take('a')).toBe('');
  });
});
