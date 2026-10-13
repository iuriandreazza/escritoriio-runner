import { describe, expect, it } from 'vitest';
import { describeSeconds } from './describe-seconds.ts';

describe('how long something took', () => {
  it.each([
    [0, '1s'],
    [400, '1s'],
    [1_499, '1s'],
    [1_500, '2s'],
    [61_000, '61s'],
  ])('%d milliseconds are %s', (ms, said) => {
    expect(describeSeconds(ms)).toBe(said);
  });
});
