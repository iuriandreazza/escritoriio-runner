import { describe, expect, it } from 'vitest';
import { formatPairingCode, normalizePairingCode, normalizeServerAddress, PAIRING_CODE_ALPHABET, pairingLink, parsePairingLink, runnerSocketAddress } from './pairing.ts';

describe('the pairing code', () => {
  it('has thirty-two characters, none of which look alike', () => {
    expect(PAIRING_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(PAIRING_CODE_ALPHABET).size).toBe(32);
    for (const confusing of '01OI') expect(PAIRING_CODE_ALPHABET).not.toContain(confusing);
  });

  it('is compared without the case, the spaces and the dash of how it was shown', () => {
    expect(normalizePairingCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizePairingCode(' ABCD EFGH ')).toBe('ABCDEFGH');
    expect(normalizePairingCode(formatPairingCode('ABCDEFGH'))).toBe('ABCDEFGH');
  });

  it.each(['', 'ABCDEFG', 'ABCDEFGHJ', 'ABCDEFG0', 'ABCDEFGI', 'ABCD-EFG!', 'ÁBCDEFGH'])('refuses %j', (input) => {
    expect(normalizePairingCode(input)).toBeUndefined();
  });

  it('is shown in two groups of four', () => {
    expect(formatPairingCode('ABCDEFGH')).toBe('ABCD-EFGH');
  });
});

describe('the address of a server', () => {
  it.each([
    ['https://office.example.com', 'https://office.example.com'],
    ['office.example.com', 'https://office.example.com'],
    ['  https://office.example.com/  ', 'https://office.example.com'],
    ['https://office.example.com/some/path?x=1', 'https://office.example.com'],
    ['https://office.example.com:8443', 'https://office.example.com:8443'],
    ['http://localhost:8201', 'http://localhost:8201'],
    ['http://127.0.0.1:8201/', 'http://127.0.0.1:8201'],
    ['http://[::1]:8201', 'http://[::1]:8201'],
    ['localhost:8201', 'http://localhost:8201'],
    ['127.0.0.1:8201', 'http://127.0.0.1:8201'],
    ['[::1]:8201', 'http://[::1]:8201'],
    ['localhost', 'http://localhost'],
    ['https://localhost:8201', 'https://localhost:8201'],
  ])('reads %j as %j', (input, origin) => {
    expect(normalizeServerAddress(input)).toBe(origin);
  });

  it.each(['', '   ', 'http://office.example.com', 'ftp://office.example.com', 'https://user:secret@office.example.com', 'javascript:alert(1)', 'https://'])(
    'refuses %j: the token travels there',
    (input) => {
      expect(normalizeServerAddress(input)).toBeUndefined();
    },
  );

  it('opens the socket on the secure scheme when the server is', () => {
    expect(runnerSocketAddress('https://office.example.com')).toBe('wss://office.example.com/runner');
    expect(runnerSocketAddress('http://localhost:8201')).toBe('ws://localhost:8201/runner');
  });
});

describe('the pairing link', () => {
  it('carries the server and the code, and reads back as they were', () => {
    const link = pairingLink('https://office.example.com', 'ABCDEFGH');
    expect(link.startsWith('escritoriio://pair?')).toBe(true);
    expect(parsePairingLink(link)).toEqual({ server: 'https://office.example.com', code: 'ABCDEFGH' });
  });

  it('reads a code typed in lower case, as a person may edit the link', () => {
    expect(parsePairingLink('escritoriio://pair?server=https%3A%2F%2Foffice.example.com&code=abcd-efgh')).toEqual({ server: 'https://office.example.com', code: 'ABCDEFGH' });
  });

  it.each([
    'https://pair?server=https%3A%2F%2Foffice.example.com&code=ABCDEFGH',
    'escritoriio://settings?server=https%3A%2F%2Foffice.example.com&code=ABCDEFGH',
    'escritoriio://pair?server=http%3A%2F%2Foffice.example.com&code=ABCDEFGH',
    'escritoriio://pair?server=https%3A%2F%2Foffice.example.com',
    'escritoriio://pair?code=ABCDEFGH',
    'escritoriio://pair?server=https%3A%2F%2Foffice.example.com&code=nope',
    'not a link',
  ])('is not a link to pair with: %s', (link) => {
    expect(parsePairingLink(link)).toBeUndefined();
  });
});
