import { describe, expect, it } from 'vitest';
import { RECONNECT_BASE_MS, RECONNECT_CAP_MS, reconnectDelay, SLOW_RETRY_MS } from './backoff.ts';

const longest = () => 0.999999;
const shortest = () => 0;

describe('the wait before a runner reconnects', () => {
  it('starts at a second and doubles until it reaches the cap', () => {
    const ceilings = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((failures) => reconnectDelay(failures, longest));
    expect(ceilings).toEqual([999, 1_999, 3_999, 7_999, 15_999, 31_999, 59_999, 59_999, 59_999]);
  });

  it('is a random point between nothing and that ceiling, so that machines cut off together do not return together', () => {
    expect(reconnectDelay(3, shortest)).toBe(0);
    expect(reconnectDelay(3, () => 0.5)).toBe(4_000);
    for (const failures of [0, 1, 5, 20]) {
      for (const random of [0, 0.25, 0.5, 0.999999]) {
        const delay = reconnectDelay(failures, () => random);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThan(Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** failures));
      }
    }
  });

  it('never passes the cap, however many times it failed', () => {
    expect(reconnectDelay(10_000, longest)).toBeLessThan(RECONNECT_CAP_MS);
  });

  it('is longer when the office said the machine is not allowed for now', () => {
    expect(SLOW_RETRY_MS).toBe(5 * 60_000);
    expect(SLOW_RETRY_MS).toBeGreaterThan(RECONNECT_CAP_MS);
  });
});
