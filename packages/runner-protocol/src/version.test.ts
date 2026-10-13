import { describe, expect, it } from 'vitest';
import { compareVersions, isOlderThan, officeReachSchema } from './version.ts';

describe('compareVersions', () => {
  it.each([
    ['0.1.0', '0.1.0', 0],
    ['0.2.0', '0.1.9', 1],
    ['0.1.9', '0.2.0', -1],
    ['1.0.0', '0.99.99', 1],
    ['0.10.0', '0.9.0', 1],
    ['2.0.0-beta.1', '2.0.0', 0],
    ['1.2.3+build.7', '1.2.3', 0],
  ] as const)('puts %s against %s as %s', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });

  it.each([['dev', '0.1.0'], ['0.1.0', ''], ['1.2', '1.2.0'], ['v1.2.3', '1.2.3'], ['1.2.3.4', '1.2.3'], ['1.2.x', '1.2.3']])('does not compare %s with %s', (a, b) => {
    expect(compareVersions(a, b)).toBeUndefined();
  });
});

describe('isOlderThan', () => {
  it('is true only for a version that is older', () => {
    expect(isOlderThan('0.1.0', '0.2.0')).toBe(true);
    expect(isOlderThan('0.2.0', '0.2.0')).toBe(false);
    expect(isOlderThan('0.3.0', '0.2.0')).toBe(false);
  });

  it('does not turn away a version it cannot read, on either side', () => {
    expect(isOlderThan('dev', '0.2.0')).toBe(false);
    expect(isOlderThan('0.1.0', 'soon')).toBe(false);
  });
});

describe('officeReachSchema', () => {
  it('reads the minimum and ignores the rest of what the office says', () => {
    expect(officeReachSchema.parse({ status: 'ok', revision: 'abc', minRunnerVersion: '0.1.0' })).toEqual({ minRunnerVersion: '0.1.0' });
    expect(officeReachSchema.parse({ status: 'ok' })).toEqual({});
  });

  it('does not take a minimum that is not a short text', () => {
    expect(officeReachSchema.safeParse({ minRunnerVersion: 'x'.repeat(100) }).success).toBe(false);
    expect(officeReachSchema.safeParse({ minRunnerVersion: 3 }).success).toBe(false);
  });
});
