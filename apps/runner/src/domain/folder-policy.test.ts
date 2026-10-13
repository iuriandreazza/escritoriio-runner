import { describe, expect, it } from 'vitest';
import type { AllowedFolder, Surroundings } from './folder-policy.ts';
import { DESCRIBE_FOLDER_PROBLEM, problemWithFolder, problemWithNewFolder } from './folder-policy.ts';

const mac: Surroundings = { home: '/Users/ana', stateDirectory: '/Users/ana/Library/Application Support/escritoriio-runner', worktreesDirectory: '/Users/ana/Library/Caches/escritoriio-runner/worktrees', windows: false };
const windows: Surroundings = { home: 'C:\\Users\\ana', stateDirectory: 'C:\\Users\\ana\\AppData\\Roaming\\escritoriio-runner', worktreesDirectory: 'C:\\Users\\ana\\AppData\\Local\\escritoriio-runner\\worktrees', windows: true };

describe('a folder that may be put on the list', () => {
  it.each([
    ['a project inside home', '/Users/ana/work/site'],
    ['a project outside home', '/srv/projects/site'],
    ['a folder that merely starts like home', '/Users/ana2/site'],
    ['a folder next to the settings', '/Users/ana/Library/Application Support/other'],
    ['a folder next to the place of the copies', '/Users/ana/Library/Caches/escritoriio-runner/other'],
  ])('is %s: %s', (_what, path) => {
    expect(problemWithNewFolder(path, mac)).toBeUndefined();
  });

  it.each([
    ['not absolute', 'work/site', 'not-absolute'],
    ['the top of the disk', '/', 'is-root'],
    ['the top of the disk, however it is written', '/Users/..', 'is-root'],
    ['home itself', '/Users/ana', 'is-home'],
    ['home, with a stray dot', '/Users/ana/./', 'is-home'],
    ['a folder that holds home', '/Users', 'holds-home'],
    ['the folder that holds the settings', '/Users/ana/Library/Application Support', 'holds-state'],
    ['the settings themselves', '/Users/ana/Library/Application Support/escritoriio-runner', 'holds-state'],
    ['a folder inside the settings', '/Users/ana/Library/Application Support/escritoriio-runner/worktrees', 'inside-state'],
    ['a way back out through dots', '/Users/ana/work/../..', 'holds-home'],
    ['the place where the copies are made', '/Users/ana/Library/Caches/escritoriio-runner/worktrees', 'holds-worktrees'],
    ['the folder that holds the place of the copies', '/Users/ana/Library/Caches', 'holds-worktrees'],
    ['a copy that a task works in', '/Users/ana/Library/Caches/escritoriio-runner/worktrees/t1', 'inside-worktrees'],
    ['a folder in a copy that a task works in', '/Users/ana/Library/Caches/escritoriio-runner/worktrees/t1/docs', 'inside-worktrees'],
  ])('is refused when it is %s', (_what, path, problem) => {
    expect(problemWithNewFolder(path, mac)).toBe(problem);
  });

  describe('where credentials are kept', () => {
    it.each([
      ['the keys of ssh', '/Users/ana/.ssh', 'inside-credentials'],
      ['a folder in the keys of ssh', '/Users/ana/.ssh/keys', 'inside-credentials'],
      ['the login to a cloud', '/Users/ana/.aws', 'inside-credentials'],
      ['a folder in the settings of a tool that keeps its login there', '/Users/ana/.config/gh/hosts', 'inside-credentials'],
      ['the keychains', '/Users/ana/Library/Keychains', 'inside-credentials'],
      ['a folder that holds the settings of two tools that keep their login in them', '/Users/ana/.config', 'holds-credentials'],
      ['the folder of the coding agent’s own settings, which has its login in it', '/Users/ana/.claude', 'holds-credentials'],
    ])('is refused when it is %s', (_what, path, problem) => {
      expect(problemWithNewFolder(path, mac)).toBe(problem);
    });

    it('is not what a folder next to them is: a folder is refused for holding or being in one, and not for being near', () => {
      expect(problemWithNewFolder('/Users/ana/.config/other-tool', mac)).toBeUndefined();
      expect(problemWithNewFolder('/Users/ana/.ssh-notes', mac)).toBeUndefined();
      expect(problemWithNewFolder('/Users/ana/work/.aws', mac)).toBeUndefined();
    });

    it('includes where the coding agent keeps its login when that is elsewhere', () => {
      const elsewhere: Surroundings = { ...mac, claudeConfigDirectory: '/opt/claude-config' };
      expect(problemWithNewFolder('/opt/claude-config', elsewhere)).toBe('holds-credentials');
      expect(problemWithNewFolder('/opt', elsewhere)).toBe('holds-credentials');
      expect(problemWithNewFolder('/opt/other', elsewhere)).toBeUndefined();
      expect(problemWithNewFolder('/opt/claude-config', mac)).toBeUndefined();
    });

    it('is judged as Windows judges its paths', () => {
      expect(problemWithNewFolder('c:\\users\\ana\\.ssh', windows)).toBe('inside-credentials');
      expect(problemWithNewFolder('C:\\Users\\ana\\.config', windows)).toBe('holds-credentials');
    });
  });

  describe('through the data volume of macOS, which names the same folders a second way', () => {
    it.each([
      ['the whole disk', '/System/Volumes/Data', 'is-root'],
      ['the folder that holds home', '/System/Volumes/Data/Users', 'holds-home'],
      ['home itself', '/System/Volumes/Data/Users/ana', 'is-home'],
      ['the settings', '/System/Volumes/Data/Users/ana/Library/Application Support/escritoriio-runner', 'holds-state'],
      ['a folder in the copies', '/System/Volumes/Data/Users/ana/Library/Caches/escritoriio-runner/worktrees/t1', 'inside-worktrees'],
      ['the keys of ssh', '/System/Volumes/Data/Users/ana/.ssh', 'inside-credentials'],
    ])('refuses %s', (_what, path, problem) => {
      expect(problemWithNewFolder(path, mac)).toBe(problem);
    });

    it('refuses a folder by the first name when the places are known by the second', () => {
      const other: Surroundings = { ...mac, home: '/System/Volumes/Data/Users/ana', stateDirectory: `/System/Volumes/Data${mac.stateDirectory}`, worktreesDirectory: `/System/Volumes/Data${mac.worktreesDirectory}` };
      expect(problemWithNewFolder('/Users/ana', other)).toBe('is-home');
      expect(problemWithNewFolder('/Users/ana/Library/Application Support/escritoriio-runner', other)).toBe('holds-state');
    });

    it('leaves a project alone, by either name', () => {
      expect(problemWithNewFolder('/System/Volumes/Data/Users/ana/work/site', mac)).toBeUndefined();
    });

    it('is the same on a recheck, which judges what the folder resolves to now', () => {
      expect(problemWithFolder({ realPath: '/System/Volumes/Data/Users/ana' }, '/System/Volumes/Data/Users/ana', mac)).toBe('is-home');
    });
  });

  it('is judged as Windows judges its paths', () => {
    expect(problemWithNewFolder('D:\\work\\site', windows)).toBeUndefined();
    expect(problemWithNewFolder('c:/users/ana', windows)).toBe('is-home');
    expect(problemWithNewFolder('C:\\', windows)).toBe('is-root');
    expect(problemWithNewFolder('C:\\Users', windows)).toBe('holds-home');
    expect(problemWithNewFolder('\\\\?\\C:\\Users\\ana\\AppData\\Roaming\\escritoriio-runner\\x', windows)).toBe('inside-state');
    expect(problemWithNewFolder('/Users/ana/site', windows)).toBe('not-absolute');
    expect(problemWithNewFolder('c:/users/ana/appdata/local/escritoriio-runner/worktrees/t1', windows)).toBe('inside-worktrees');
    expect(problemWithNewFolder('C:\\Users\\ana\\AppData\\Local', windows)).toBe('holds-worktrees');
  });

  it('says in words what is wrong with it', () => {
    for (const problem of ['not-absolute', 'is-root', 'is-home', 'holds-home', 'holds-state', 'inside-state', 'holds-worktrees', 'inside-worktrees', 'holds-credentials', 'inside-credentials', 'gone', 'moved'] as const) expect(DESCRIBE_FOLDER_PROBLEM[problem]).toMatch(/\.$/);
  });
});

describe('a folder on the list, when a task is about to run in it', () => {
  const folder: Pick<AllowedFolder, 'realPath'> = { realPath: '/Users/ana/work/site' };

  it('is fine while it is where it was', () => {
    expect(problemWithFolder(folder, '/Users/ana/work/site', mac)).toBeUndefined();
    expect(problemWithFolder(folder, '/Users/ana/work/site/', mac)).toBeUndefined();
  });

  it('is gone when the file system has nothing there', () => {
    expect(problemWithFolder(folder, undefined, mac)).toBe('gone');
  });

  it('has moved when it now resolves elsewhere: renamed, or a link in its path now leads somewhere else', () => {
    expect(problemWithFolder(folder, '/Users/ana/work/site-renamed', mac)).toBe('moved');
    expect(problemWithFolder(folder, '/Users/ana/.ssh', mac)).toBe('moved');
    expect(problemWithFolder(folder, '/', mac)).toBe('moved');
  });

  it('is refused if what it is has become what no folder may be: the file system moved home to meet it', () => {
    expect(problemWithFolder(folder, '/Users/ana/work/site', { ...mac, home: '/Users/ana/work/site' })).toBe('is-home');
    expect(problemWithFolder(folder, '/Users/ana/work/site', { ...mac, stateDirectory: '/Users/ana/work/site/.runner' })).toBe('holds-state');
    expect(problemWithFolder(folder, '/Users/ana/work/site', { ...mac, worktreesDirectory: '/Users/ana/work/site/.copies' })).toBe('holds-worktrees');
  });

  it('is compared as Windows compares paths', () => {
    expect(problemWithFolder({ realPath: 'D:\\Work\\Site' }, 'd:/work/site', windows)).toBeUndefined();
    expect(problemWithFolder({ realPath: 'D:\\Work\\Site' }, 'D:\\Work\\Other', windows)).toBe('moved');
  });
});
