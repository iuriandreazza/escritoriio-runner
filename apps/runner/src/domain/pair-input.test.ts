import { pairingLink } from '@escritoriio/runner-protocol';
import { describe, expect, it } from 'vitest';
import { parsePairInput } from './pair-input.ts';

describe('what a person types to pair a machine', () => {
  it('may be the link the office shows', () => {
    expect(parsePairInput([pairingLink('https://office.example.com', 'ABCDEFGH')])).toEqual({ ok: true, server: 'https://office.example.com', code: 'ABCDEFGH' });
  });

  it('may be a server and a code', () => {
    expect(parsePairInput(['https://office.example.com', 'ABCDEFGH'])).toEqual({ ok: true, server: 'https://office.example.com', code: 'ABCDEFGH' });
  });

  it('is read the way the protocol reads them: without the scheme, with the code in lower case, with its dash or in two words', () => {
    const expected = { ok: true, server: 'https://office.example.com', code: 'ABCDEFGH' };
    expect(parsePairInput(['office.example.com/', 'abcd-efgh'])).toEqual(expected);
    expect(parsePairInput(['office.example.com', 'abcd', 'efgh'])).toEqual(expected);
  });

  it('allows a server on this machine without https, to try a server being developed', () => {
    expect(parsePairInput(['http://localhost:8201', 'ABCD-EFGH'])).toEqual({ ok: true, server: 'http://localhost:8201', code: 'ABCDEFGH' });
  });

  it.each([
    ['nothing', []],
    ['a server and no code', ['office.example.com']],
    ['a link that is not one', ['https://office.example.com/pair?code=ABCDEFGH']],
    ['a link with a code that is not one', ['escritoriio://pair?server=https%3A%2F%2Foffice.example.com&code=nope']],
    ['a link of a server that would take the token over plain http', ['escritoriio://pair?server=http%3A%2F%2Foffice.example.com&code=ABCDEFGH']],
    ['a server without https', ['http://office.example.com', 'ABCDEFGH']],
    ['a code that is too short', ['office.example.com', 'ABCDEFG']],
    ['a code with a character that is left out of codes', ['office.example.com', 'ABCDEFG0']],
  ])('refuses %s, and says what to give', (_name, args) => {
    const input = parsePairInput(args);
    expect(input.ok).toBe(false);
    expect(input.ok === false && input.error).not.toBe('');
  });

  it('does not write the code it refused back to the person', () => {
    const input = parsePairInput(['office.example.com', 'SECRET0']);
    expect(input.ok).toBe(false);
    const error = input.ok ? '' : input.error;
    expect(error).not.toContain('SECRET');
  });
});
