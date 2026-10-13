import { describe, expect, it } from 'vitest';
import { capLines } from './cap-lines.ts';

describe('capping a text at the end of a line', () => {
  it('leaves a text that fits as it is', () => {
    expect(capLines('a\nb', 3)).toBe('a\nb');
  });

  it('cuts at the last whole line and says so', () => {
    expect(capLines('one\ntwo\nthree\nfour', 14)).toBe('one\ntwo\n...');
  });

  it('never goes over the cap, closing line included', () => {
    for (const max of [5, 6, 10, 17]) expect(capLines('aaaa\nbbbb\ncccc\ndddd\neeee', max).length).toBeLessThanOrEqual(max);
  });

  it('cuts a single long line where it must', () => {
    expect(capLines('x'.repeat(50), 20)).toBe(`${'x'.repeat(16)}\n...`);
  });
});
