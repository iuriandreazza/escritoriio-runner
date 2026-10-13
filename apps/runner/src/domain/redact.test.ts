import { describe, expect, it } from 'vitest';
import type { Places } from './redact.ts';
import { homesIn, placesOf, redactPaths } from './redact.ts';

const places: Places = {
  workFolder: '/Users/ana/Library/Caches/escritoriio-runner/worktrees/t1',
  allowedFolder: '/Users/ana/work/site',
  home: '/Users/ana',
  stateDirectory: '/Users/ana/Library/Application Support/escritoriio-runner',
  worktreesDirectory: '/Users/ana/Library/Caches/escritoriio-runner/worktrees',
};

describe('what a task says, without the layout of the machine', () => {
  it('writes the folder it worked in as the folder, and the person’s home as ~', () => {
    expect(redactPaths(`Edit ${places.workFolder}/src/index.ts`, places)).toBe('Edit ./src/index.ts');
    expect(redactPaths('Read /Users/ana/work/site/README.md and /Users/ana/.zshrc', places)).toBe('Read ./README.md and ~/.zshrc');
  });

  it('does it for the longest place first: the work folder is inside the place of the copies, which is inside home', () => {
    expect(redactPaths(`${places.workFolder} and ${places.stateDirectory}/device.json`, places)).toBe('. and <runner>/device.json');
    expect(redactPaths(`${places.workFolder}/src and ${places.worktreesDirectory}/another-task/src`, places)).toBe('./src and <runner>/another-task/src');
  });

  it('leaves alone what only looks like a place: a longer name, an extension, and another person’s home', () => {
    expect(redactPaths('/Users/ana/work/site-two/x and /Users/ana/work/site.bak and /Users/anabel/y', places)).toBe('~/work/site-two/x and ~/work/site.bak and /Users/anabel/y');
  });

  it('finds the place at the end of a sentence, where the full stop stays, and in quotes', () => {
    expect(redactPaths('Opened /Users/ana/work/site. Then "/Users/ana/work/site/a.txt"', places)).toBe('Opened .. Then "./a.txt"');
  });

  it('finds the place written with the other slashes, and whatever the case on a system that ignores it', () => {
    const windows: Places = { workFolder: 'C:\\Users\\ana\\runner\\worktrees\\t1', allowedFolder: 'D:\\work\\site', home: 'C:\\Users\\ana', stateDirectory: 'C:\\Users\\ana\\runner', worktreesDirectory: 'C:\\Users\\ana\\runner\\worktrees' };
    expect(redactPaths('Edit c:/users/ana/runner/worktrees/t1/src/a.ts and D:\\work\\site\\b.ts', windows)).toBe('Edit ./src/a.ts and .\\b.ts');
  });

  it('finds the place written as a URL writes it: with the slashes and the spaces encoded', () => {
    expect(redactPaths('GET /open?file=%2FUsers%2Fana%2Fwork%2Fsite%2FREADME.md', places)).toBe('GET /open?file=.%2FREADME.md');
    expect(redactPaths('/Users/ana/Library/Application%20Support/escritoriio-runner/device.json', places)).toBe('<runner>/device.json');
    expect(redactPaths('%2fusers%2fana%2f.ssh', places)).toBe('~%2f.ssh');
  });

  it('finds the place written as JSON writes it: with escaped slashes, and doubled backslashes on Windows', () => {
    expect(redactPaths(String.raw`{"path":"\/Users\/ana\/work\/site\/a.txt"}`, places)).toBe(String.raw`{"path":".\/a.txt"}`);
    const windows: Places = { workFolder: 'C:\\Users\\ana\\runner\\worktrees\\t1', allowedFolder: 'D:\\work\\site', home: 'C:\\Users\\ana', stateDirectory: 'C:\\Users\\ana\\runner', worktreesDirectory: 'C:\\Users\\ana\\runner\\worktrees' };
    expect(redactPaths(JSON.stringify({ file: 'D:\\work\\site\\b.ts', other: 'C:\\Users\\ana\\notes.txt' }), windows)).toBe(String.raw`{"file":".\\b.ts","other":"~\\notes.txt"}`);
  });

  it('finds the home that the environment names when it is not the one the file system does', () => {
    const behindALink: Places = { ...places, home: '/mnt/disk/home/ana', otherHomes: ['/home/ana'], allowedFolder: '/mnt/disk/home/ana/work/site' };
    expect(redactPaths('Read /home/ana/.config/tool/token and /mnt/disk/home/ana/work/site/a.txt and /home/anabel/x', behindALink)).toBe('Read ~/.config/tool/token and ./a.txt and /home/anabel/x');
  });

  it('leaves a text with no place in it exactly as it is', () => {
    expect(redactPaths('I fixed the typo in README.md', places)).toBe('I fixed the typo in README.md');
  });

  it('has no use for a place that is only a slash', () => {
    expect(redactPaths('/etc/hosts', { ...places, home: '/' })).toBe('/etc/hosts');
  });
});

describe('the places of a task', () => {
  it('are the folders it worked in and on, the places of the machine, and the homes the coding agent was told of', () => {
    const surroundings = { home: places.home, stateDirectory: places.stateDirectory, worktreesDirectory: places.worktreesDirectory, windows: false };
    expect(placesOf(surroundings, { HOME: '/home/ana', PATH: '/bin' }, { workFolder: places.workFolder, allowedFolder: places.allowedFolder })).toEqual({ ...places, otherHomes: ['/home/ana'] });
  });

  it('name the homes of Windows as well, and no home that is empty', () => {
    expect(homesIn({ HOME: '', USERPROFILE: 'C:\\Users\\ana', PATH: '/bin' })).toEqual(['C:\\Users\\ana']);
    expect(homesIn({})).toEqual([]);
  });
});
