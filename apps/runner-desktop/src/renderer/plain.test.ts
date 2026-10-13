import { describe, expect, it } from 'vitest';
import { terminalLine, visible, wordsOf } from './plain.ts';

describe('the text of the office', () => {
  it('leaves ordinary text, accents and new lines alone', () => {
    expect(visible('Olá, mundo\nsegunda linha\tcom tab')).toBe('Olá, mundo\nsegunda linha\tcom tab');
  });

  it('shows by their code point the characters that reorder or hide text', () => {
    expect(visible('a\u202Eb\u202Cc')).toBe('a‹U+202E›b‹U+202C›c');
    expect(visible('a\u200Bb\u2066c\u2069')).toBe('a‹U+200B›b‹U+2066›c‹U+2069›');
    expect(visible('x\u0000y\u001by')).toBe('x‹U+0000›y‹U+001B›y');
    expect(visible('\ufeffz')).toBe('‹U+FEFF›z');
  });

  it('shows by their code point the characters the runner refuses too: tags, the soft hyphen, the Mongolian separator, the variation selectors', () => {
    expect(visible('a\u{E0041}b')).toBe('a‹U+E0041›b');
    expect(visible('a\u{E007F}b')).toBe('a‹U+E007F›b');
    expect(visible('a\u00ADb\u180Ec')).toBe('a‹U+00AD›b‹U+180E›c');
    expect(visible('a\u{E0100}b\u{E01EF}c')).toBe('a‹U+E0100›b‹U+E01EF›c');
    expect(visible('❤\uFE0F')).toBe('❤\uFE0F');
  });

  it('takes the colour codes of a terminal out of a line, and shows the rest', () => {
    expect(terminalLine('\u001b[31mred\u001b[0m and \u001b[1;32mgreen\u001b[0m')).toBe('red and green');
    expect(terminalLine('a\u001b]0;title\u0007b')).toContain('b');
  });

  it('says a failure in words, and never as an object or a stack', () => {
    expect(wordsOf(new Error('The office did not answer.'))).toBe('The office did not answer.');
    expect(wordsOf({ stack: 'at x' })).toBe('Something went wrong. Try again.');
    expect(wordsOf(new Error('   '))).toBe('Something went wrong. Try again.');
    expect(wordsOf(new Error('x'.repeat(1_000))).length).toBe(400);
    expect(wordsOf(new Error('a\u202Eb'))).toBe('a‹U+202E›b');
  });
});
