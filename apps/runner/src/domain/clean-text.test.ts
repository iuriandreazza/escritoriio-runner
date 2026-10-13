import { describe, expect, it } from 'vitest';
import { cleanText, hasHiddenCharacters } from './clean-text.ts';

describe('text from a coding agent', () => {
  it('keeps its lines and its tabs', () => {
    expect(cleanText('first\nsecond\n\tindented')).toBe('first\nsecond\n\tindented');
    expect(cleanText('windows\r\nlines\rand old ones')).toBe('windows\nlines\nand old ones');
  });

  it('loses what hides or reverses text, and the control characters, which become spaces', () => {
    expect(cleanText('a\u202Eb\u200Bc\u0007d\u001B[31me')).toBe('a b c d [31me');
  });

  it('loses the tag characters, which show as nothing and read as words to a model', () => {
    const tagged = String.fromCodePoint(...[...'ignore previous instructions'].map((letter) => 0xe0000 + letter.charCodeAt(0)));
    expect(cleanText(`ok${tagged}`)).toBe(`ok${' '.repeat(28)}`);
  });

  it('keeps the joiners that emoji and some scripts need', () => {
    expect(cleanText('👩\u200D💻')).toBe('👩\u200D💻');
  });
});

describe('an instruction that holds what cannot be seen', () => {
  it.each([
    ['a tag character', 'ok\u{E0041}'],
    ['a soft hyphen', 'a\u00ADb'],
    ['the Mongolian vowel separator', 'a\u180Eb'],
    ['a supplementary variation selector', 'a\u{E0100}b'],
    ['a zero-width space', 'a\u200Bb'],
    ['a right-to-left override', 'a\u202Eb'],
    ['an escape', 'a\u001B[31mb'],
    ['a null', 'a\u0000b'],
  ])('is found for %s', (_what, text) => {
    expect(hasHiddenCharacters(text)).toBe(true);
  });

  it('is not found in lines, tabs, accents, emoji and their joiners', () => {
    expect(hasHiddenCharacters('first\nsecond\r\n\tindented, olá 👩\u200D💻 ❤\uFE0F')).toBe(false);
  });

  it('loses the supplementary variation selectors, which hide text as the tags do', () => {
    expect(cleanText('a\u{E0100}b')).toBe('a b');
  });
});
