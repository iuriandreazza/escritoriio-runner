import { describe, expect, it } from 'vitest';
import { programCandidates } from './program-path.ts';

describe('where a program may be', () => {
  it('is each folder of the PATH, in order', () => {
    expect(programCandidates('git', '/usr/local/bin:/usr/bin:/bin', false)).toEqual(['/usr/local/bin/git', '/usr/bin/git', '/bin/git']);
  });

  it('is nowhere when there is no PATH', () => {
    expect(programCandidates('git', undefined, false)).toEqual([]);
    expect(programCandidates('git', '', false)).toEqual([]);
  });

  it.each([
    ['an empty entry, which is the folder the program is started in', ':/usr/bin'],
    ['an empty entry at the end', '/usr/bin:'],
    ['a dot', '.:/usr/bin'],
    ['a relative folder', 'bin:/usr/bin'],
    ['a folder under the one the program is started in', './node_modules/.bin:/usr/bin'],
  ])('leaves out %s', (_what, path) => {
    expect(programCandidates('git', path, false)).toEqual(['/usr/bin/git']);
  });

  it('writes a folder that ends in a slash once', () => {
    expect(programCandidates('git', '/usr/bin/', false)).toEqual(['/usr/bin/git']);
  });

  describe('on Windows', () => {
    it('is the .exe of each folder, in the way Windows writes it', () => {
      expect(programCandidates('git', 'C:\\Program Files\\Git\\cmd;C:\\Windows\\System32\\', true)).toEqual(['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Windows\\System32\\git.exe']);
    });

    it('leaves out the folder the program is started in, which Windows searches first, and every entry that is not a full path', () => {
      expect(programCandidates('git', ';.;bin;C:\\Git\\cmd;\\\\server\\share\\tools', true)).toEqual(['C:\\Git\\cmd\\git.exe', '\\\\server\\share\\tools\\git.exe']);
    });

    it('takes a folder written in quotes as the folder', () => {
      expect(programCandidates('git', '"C:\\Tools; and more";C:\\Git', true)).toEqual(['C:\\Tools; and more\\git.exe', 'C:\\Git\\git.exe']);
    });
  });
});
