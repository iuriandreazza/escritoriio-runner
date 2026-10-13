import { describe, expect, it } from 'vitest';
import { scrubJson, scrubText, secretsOf } from './mcp-scrub.ts';

describe('what of a server’s environment must not leave the machine', () => {
  it('is every long value, and every value of a name that sounds like a secret', () => {
    const secrets = secretsOf({ API_KEY: 'k-123', REGION: 'eu', NOTES_DIR: '/home/ana/notes', LOG_LEVEL: 'info', GITHUB_TOKEN: 'ab', PASSWORD: 'hunter2' });
    expect(secrets).toEqual(expect.arrayContaining(['k-123', '/home/ana/notes', 'hunter2']));
    // Short values of names that are not secrets are words too common to hide: replacing "eu" would spoil every text that has one.
    expect(secrets).not.toContain('eu');
    expect(secrets).not.toContain('info');
    // A secret that is too short to be told from a word of text is not hidden either.
    expect(secrets).not.toContain('ab');
  });

  it('is longest first, so that a value that holds another is taken out whole', () => {
    expect(secretsOf({ A_KEY: 'abcdef', B_KEY: 'abcdefghij' })).toEqual(['abcdefghij', 'abcdef']);
  });

  it('also takes the form a value has inside JSON, where quotes and backslashes are escaped', () => {
    expect(secretsOf({ API_KEY: 'ab"c\\d-12345' })).toEqual(expect.arrayContaining(['ab"c\\d-12345', 'ab\\"c\\\\d-12345']));
  });

  it('is nothing for a server with no environment', () => {
    expect(secretsOf({})).toEqual([]);
  });
});

describe('taking secrets out of text', () => {
  it('replaces every place one is, and leaves the rest', () => {
    expect(scrubText('key k-123456 and again k-123456, not k-12345', ['k-123456'])).toBe('key [removed] and again [removed], not k-12345');
  });

  it('takes the longer value out whole, not the shorter one inside it', () => {
    expect(scrubText('token abcdefghij', ['abcdefghij', 'abcdef'])).toBe('token [removed]');
  });

  it('does nothing when there is nothing to take out', () => {
    expect(scrubText('plain', [])).toBe('plain');
  });
});

describe('taking secrets out of a definition or an answer', () => {
  it('goes through every string in it, the keys of an object included, and leaves the shape alone', () => {
    const value = { description: 'use k-123456', schema: { 'k-123456': { enum: ['a', 'k-123456'] } }, n: 3, ok: true, none: null };
    expect(scrubJson(value, ['k-123456'])).toEqual({ description: 'use [removed]', schema: { '[removed]': { enum: ['a', '[removed]'] } }, n: 3, ok: true, none: null });
  });

  it('is the same value when there is nothing to take out', () => {
    const value = { a: ['b'] };
    expect(scrubJson(value, [])).toBe(value);
  });
});
