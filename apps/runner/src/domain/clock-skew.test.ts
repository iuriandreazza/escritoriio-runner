import { describe, expect, it } from 'vitest';
import { clockSkewMs, CLOCK_WARN_MS } from './clock-skew.ts';

const OFFICE = 'Mon, 12 Oct 2026 10:00:00 GMT';
const officeMs = Date.parse(OFFICE);

describe('clockSkewMs', () => {
  it.each([
    ['a clock that agrees', officeMs, officeMs, 0],
    ['a clock a minute ahead', officeMs + 60_000, officeMs + 60_000, 60_000],
    ['a clock three minutes behind', officeMs - 180_000, officeMs - 180_000, -180_000],
    ['a slow answer, taking the middle of the time it took', officeMs - 1_000, officeMs + 1_000, 0],
  ])('says it for %s', (_name, sentAt, receivedAt, expected) => {
    expect(clockSkewMs(OFFICE, sentAt, receivedAt)).toBe(expected);
  });

  it.each([[undefined], [null], [''], ['yesterday-ish']])('says nothing for the header %j', (header) => {
    expect(clockSkewMs(header, 0, 0)).toBeUndefined();
  });

  it('warns from two minutes', () => {
    expect(CLOCK_WARN_MS).toBe(120_000);
  });
});
