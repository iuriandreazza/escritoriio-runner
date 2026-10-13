import { describe, expect, it } from 'vitest';
import { describeNetworkError } from './network-error.ts';

describe('what went wrong with a request', () => {
  it('is the code found under the error the library gives', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
    expect(describeNetworkError(new TypeError('fetch failed', { cause }))).toBe('ECONNREFUSED');
  });

  it('is the code of an error with no message of its own, as a name with two addresses gives', () => {
    expect(describeNetworkError(Object.assign(new AggregateError([]), { code: 'ECONNREFUSED' }))).toBe('ECONNREFUSED');
  });

  it('is the message when there is no code', () => {
    expect(describeNetworkError(new Error('Max payload size exceeded'))).toBe('Max payload size exceeded');
  });

  it('is something even for what is not an error', () => {
    expect(describeNetworkError('nope')).toBe('unknown error');
    expect(describeNetworkError(new Error(''))).toBe('unknown error');
  });
});
