import { describe, expect, it } from 'vitest';
import { DESCRIBE_WORKSPACE_NAME_PROBLEM, MAX_WORKSPACE_NAME_CHARACTERS, problemWithWorkspaceName } from './workspace-names.ts';

describe('the name of a folder in a workspace', () => {
  it.each(['hello', 'my-project', 'my_project.v2', 'café', 'a', 'a'.repeat(MAX_WORKSPACE_NAME_CHARACTERS), 'conclusion', 'console', 'com10', 'nul-device', 'v1.0', '日本語', 'a-b.c'])('may be %j', (name) => {
    expect(problemWithWorkspaceName(name)).toBeUndefined();
  });

  it.each([
    ['', 'empty'],
    ['a'.repeat(MAX_WORKSPACE_NAME_CHARACTERS + 1), 'too-long'],
    // 64 characters that take four bytes each are more than a file system keeps in a name.
    ['\u{1F600}'.repeat(MAX_WORKSPACE_NAME_CHARACTERS), 'too-long'],
    ['a/b', 'not-one-segment'],
    ['a\\b', 'not-one-segment'],
    ['/etc', 'not-one-segment'],
    ['..\\x', 'not-one-segment'],
    ['.', 'dots'],
    ['..', 'dots'],
    ['a..b', 'dots'],
    ['.hidden', 'leading-dot'],
    ['.git', 'leading-dot'],
    ['.claude', 'leading-dot'],
    ['two\nlines', 'hidden-characters'],
    ['tab\there', 'hidden-characters'],
    ['bell\u0007', 'hidden-characters'],
    ['nul\u0000byte', 'hidden-characters'],
    ['evil\u{202E}txt', 'hidden-characters'],
    ['zero\u{200B}width', 'hidden-characters'],
    ['soft\u{AD}hyphen', 'hidden-characters'],
    ['bom\u{FEFF}', 'hidden-characters'],
    ['tag\u{E0041}', 'hidden-characters'],
    ['cafe\u{301}', 'not-normalized'],
    ['CON', 'reserved'],
    ['con', 'reserved'],
    ['Nul', 'reserved'],
    ['PRN', 'reserved'],
    ['AUX', 'reserved'],
    ['COM1', 'reserved'],
    ['com9', 'reserved'],
    ['LPT1', 'reserved'],
    ['lpt9', 'reserved'],
    ['COM\u{B9}', 'reserved'],
    ['CON.txt', 'reserved'],
    ['nul.tar.gz', 'reserved'],
    ['name.', 'trailing'],
    ['name ', 'spaces'],
    ['name. ', 'spaces'],
    ['CON .txt', 'spaces'],
    ['two words', 'spaces'],
    ['no\u{A0}break', 'spaces'],
    ['em\u{2003}space', 'spaces'],
    ['line\u{2028}sep', 'spaces'],
    ['CONIN$', 'reserved'],
    ['conout$', 'reserved'],
    ['CLOCK$.txt', 'reserved'],
    ['join\u{200D}er', 'hidden-characters'],
    ['hangul\u{3164}fill', 'hidden-characters'],
    ['hangul\u{115F}x', 'hidden-characters'],
    ['hangul\u{1160}x', 'hidden-characters'],
    ['half\u{FFA0}x', 'hidden-characters'],
    ['braille\u{2800}blank', 'hidden-characters'],
    ['joiner\u{34F}x', 'hidden-characters'],
    ['khmer\u{17B4}x', 'hidden-characters'],
    ['khmer\u{17B5}x', 'hidden-characters'],
    ['variation\u{FE0F}x', 'hidden-characters'],
    ['variation\u{FE00}x', 'hidden-characters'],
    [' name', 'spaces'],
    ['a:b', 'forbidden-characters'],
    ['a*b', 'forbidden-characters'],
    ['a?b', 'forbidden-characters'],
    ['a"b', 'forbidden-characters'],
    ['a<b', 'forbidden-characters'],
    ['a>b', 'forbidden-characters'],
    ['a|b', 'forbidden-characters'],
  ])('is refused when it is %j', (name, problem) => {
    expect(problemWithWorkspaceName(name)).toBe(problem);
  });

  it('is refused when it is not text', () => {
    expect(problemWithWorkspaceName(undefined as unknown as string)).toBe('empty');
    expect(problemWithWorkspaceName(42 as unknown as string)).toBe('empty');
  });

  it('has words for every problem, none of which repeats what was typed', () => {
    for (const words of Object.values(DESCRIBE_WORKSPACE_NAME_PROBLEM)) expect(words).toMatch(/^A folder name /);
  });
});
