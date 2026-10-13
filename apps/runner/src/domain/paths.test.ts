import { describe, expect, it } from 'vitest';
import { folderName, isAbsolutePath, isInside, isRootPath, isSamePath, resolveAgainst, withoutDataVolumePrefix } from './paths.ts';

describe('paths on a system that writes them with slashes', () => {
  it.each([
    ['/', true],
    ['/Users/ana', true],
    ['relative/path', false],
    ['./here', false],
    ['', false],
    ['C:\\Users\\ana', false],
  ])('%j is absolute: %s', (path, absolute) => {
    expect(isAbsolutePath(path, false)).toBe(absolute);
  });

  it('knows the top of the disk', () => {
    expect(isRootPath('/', false)).toBe(true);
    expect(isRootPath('/..', false)).toBe(true);
    expect(isRootPath('/a/..', false)).toBe(true);
    expect(isRootPath('/a', false)).toBe(false);
  });

  it.each([
    ['/a/b', '/a/b', true],
    ['/a/b', '/a/b/c/d', true],
    ['/a/b', '/a/bc', false],
    ['/a/b', '/a', false],
    ['/a/b', '/a/b/../c', false],
    ['/a/b', '/a/b/c/../../x', false],
    ['/a/b', '/a/./b/./c', true],
    ['/', '/anything', true],
    ['/a/b', 'a/b/c', false],
    ['a/b', '/a/b/c', false],
  ])('%j holds %j: %s', (parent, child, inside) => {
    expect(isInside(parent, child, false)).toBe(inside);
  });

  it('does not tell /a/B from /a/b: what it compares is what the file system answered', () => {
    expect(isSamePath('/a/B', '/a/b', false)).toBe(false);
    expect(isSamePath('/a/b/', '/a/b', false)).toBe(true);
  });

  it('makes a path absolute against a base and takes out the dots, without following links', () => {
    expect(resolveAgainst('/work/repo', 'src/../README.md', false)).toBe('/work/repo/README.md');
    expect(resolveAgainst('/work/repo', '../other/file', false)).toBe('/work/other/file');
    expect(resolveAgainst('/work/repo', '/etc/passwd', false)).toBe('/etc/passwd');
    expect(resolveAgainst('/work/repo', '../../../../..', false)).toBe('/');
  });
});

describe('paths on Windows', () => {
  it.each([
    ['C:\\Users\\ana', true],
    ['c:/Users/ana', true],
    ['C:', true],
    ['\\\\?\\C:\\Users\\ana', true],
    ['\\\\server\\share\\dir', true],
    ['/Users/ana', false],
    ['Users\\ana', false],
  ])('%j is absolute: %s', (path, absolute) => {
    expect(isAbsolutePath(path, true)).toBe(absolute);
  });

  it('compares without regard to case or to the way the slashes lean, and sees through the long-path prefix', () => {
    expect(isInside('C:\\Work', 'c:/work/Repo/src', true)).toBe(true);
    expect(isInside('C:\\Work', '\\\\?\\C:\\Work\\Repo', true)).toBe(true);
    expect(isInside('C:\\Work', 'D:\\Work\\Repo', true)).toBe(false);
    expect(isInside('C:\\Work', 'C:\\Workshop', true)).toBe(false);
    expect(isSamePath('C:\\Work\\', 'c:/WORK', true)).toBe(true);
  });

  it('knows the top of a drive and of a share', () => {
    expect(isRootPath('C:\\', true)).toBe(true);
    expect(isRootPath('c:/', true)).toBe(true);
    expect(isRootPath('\\\\server\\share', true)).toBe(true);
    expect(isRootPath('C:\\Work', true)).toBe(false);
  });

  it('resolves against a base', () => {
    expect(resolveAgainst('C:\\Work\\Repo', '..\\Other', true)).toBe('c:\\work\\other');
  });
});

describe('the name of a folder', () => {
  it.each([
    ['/Users/ana/work/site', 'site'],
    ['/Users/ana/work/site/', 'site'],
    ['C:\\Users\\ana\\work\\My Site', 'My Site'],
    ['/', ''],
  ])('in %s is %j', (path, name) => {
    expect(folderName(path)).toBe(name);
  });
});

describe('a path through the data volume of macOS', () => {
  it.each([
    ['/System/Volumes/Data/Users/ana/work', '/Users/ana/work'],
    ['/System/Volumes/Data/Users', '/Users'],
    ['/system/volumes/data/users/ana', '/users/ana'],
    ['/System/Volumes/Data', '/'],
    ['/System/Volumes/Data/', '/'],
    ['/Users/ana/work', '/Users/ana/work'],
    ['/System/Volumes/DataBackup/x', '/System/Volumes/DataBackup/x'],
    ['/System/Volumes/Preboot', '/System/Volumes/Preboot'],
    ['/work/System/Volumes/Data/x', '/work/System/Volumes/Data/x'],
  ])('%s is the same as %s', (path, plain) => {
    expect(withoutDataVolumePrefix(path)).toBe(plain);
  });
});
