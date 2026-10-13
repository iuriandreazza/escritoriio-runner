import { describe, expect, it } from 'vitest';
import { displayName, plainText } from './plain-text.ts';

describe('text that came from the office', () => {
  it('is left as it is when there is nothing wrong with it', () => {
    expect(plainText('Robo, of Acme')).toBe('Robo, of Acme');
  });

  it('loses the characters a terminal would act on', () => {
    // An escape sequence that moves the cursor and clears the line would redraw what the person is asked.
    const text = plainText('Robo\r\u001b[2KPair with nobody at example.com');
    expect(text).toBe('Robo [2KPair with nobody at example.com');
    expect(text).not.toMatch(/\p{Cc}/u);
    expect(plainText('a\u0000b\u007fc\u009bd')).toBe('a b c d');
  });

  it('loses the invisible characters that reorder or hide text', () => {
    expect(plainText('evil\u202Egpj.exe')).toBe('evil gpj.exe');
    expect(plainText('a\u200Bb')).toBe('a b');
  });

  it('puts the lines on one', () => {
    expect(plainText('one\ntwo\r\n\tthree')).toBe('one two three');
  });

  it('is cut to a length, and says that it was with an ellipsis that counts in the length', () => {
    expect(plainText('x'.repeat(500))).toHaveLength(200);
    expect(plainText('x'.repeat(500))).toBe(`${'x'.repeat(199)}\u2026`);
    expect(plainText('abcdef', 4)).toBe('abc\u2026');
    expect(plainText('ab  def', 4)).toBe('ab\u2026');
  });

  it('is not marked when it fits, however close to the length', () => {
    expect(plainText('abc', 3)).toBe('abc');
    expect(plainText('x'.repeat(200))).toBe('x'.repeat(200));
  });
});

describe('a name the office gave', () => {
  it('is cleaned as any text of the office is', () => {
    expect(displayName('Robo\r\u001b[2K at evil.example')).toBe('Robo [2K at evil.example');
  });

  it('has no double quote that could close the quotes it is shown in', () => {
    expect(displayName('Robo" of the workspace "Other')).toBe("Robo' of the workspace 'Other");
  });

  it('is cut to a length that fits a line', () => {
    expect(displayName('x'.repeat(500))).toHaveLength(100);
    expect(displayName('x'.repeat(500)).endsWith('\u2026')).toBe(true);
  });
});
