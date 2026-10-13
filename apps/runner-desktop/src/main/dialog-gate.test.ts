import { describe, expect, it, vi } from 'vitest';
import { createDialogGate, DECLINE_COOLDOWN_MS } from './dialog-gate.ts';

/** A dialog that stays open until the test answers it. */
function openDialog<T>() {
  let answer!: (value: T) => void;
  const shown = vi.fn(() => new Promise<T>((resolve) => void (answer = resolve)));
  return { shown, answer: (value: T) => answer(value) };
}

describe('the native dialogs, one at a time', () => {
  it('shows a dialog after the one before it was answered, never beside it', async () => {
    const gate = createDialogGate({ now: () => 0 });
    const first = openDialog<boolean>();
    const second = openDialog<boolean>();
    const one = gate.run('confirm:a', false, first.shown);
    const two = gate.run('pick-folder', false, second.shown);
    await Promise.resolve();
    expect(first.shown).toHaveBeenCalledTimes(1);
    expect(second.shown).not.toHaveBeenCalled();
    first.answer(true);
    expect(await one).toBe(true);
    await vi.waitFor(() => expect(second.shown).toHaveBeenCalledTimes(1));
    second.answer(true);
    expect(await two).toBe(true);
  });

  it('is a no, with nothing shown, for a dialog of the same kind that is open or waiting: a page cannot stack them', async () => {
    const gate = createDialogGate({ now: () => 0 });
    const open = openDialog<boolean>();
    const again = vi.fn(() => Promise.resolve(true));
    const first = gate.run('confirm:a', false, open.shown);
    expect(await gate.run('confirm:a', false, again)).toBe(false);
    expect(again).not.toHaveBeenCalled();
    open.answer(true);
    expect(await first).toBe(true);
  });

  it('is a no, with nothing shown, for a short while after the owner said no to that kind', async () => {
    let now = 1_000;
    const gate = createDialogGate({ now: () => now });
    expect(await gate.run('pick-folder', undefined, () => Promise.resolve(undefined))).toBeUndefined();
    const again = vi.fn(() => Promise.resolve('/Users/ana/site' as string | undefined));
    expect(await gate.run('pick-folder', undefined, again)).toBeUndefined();
    expect(again).not.toHaveBeenCalled();
    now += DECLINE_COOLDOWN_MS;
    expect(await gate.run('pick-folder', undefined, again)).toBe('/Users/ana/site');
  });

  it('does not hold back another kind of dialog after a no, nor the same kind after a yes', async () => {
    const gate = createDialogGate({ now: () => 0 });
    expect(await gate.run('confirm:a', false, () => Promise.resolve(false))).toBe(false);
    expect(await gate.run('confirm:b', false, () => Promise.resolve(true))).toBe(true);
    expect(await gate.run('confirm:b', false, () => Promise.resolve(true))).toBe(true);
  });

  it('goes on with the next dialog when one fails, and says the failure to whoever asked', async () => {
    const gate = createDialogGate({ now: () => 0 });
    await expect(gate.run('confirm:a', false, () => Promise.reject(new Error('no window')))).rejects.toThrow('no window');
    expect(await gate.run('confirm:b', false, () => Promise.resolve(true))).toBe(true);
    expect(await gate.run('confirm:a', false, () => Promise.resolve(true))).toBe(true);
  });
});
