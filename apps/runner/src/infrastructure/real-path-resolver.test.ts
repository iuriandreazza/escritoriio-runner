import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { realPathOfNearest, realPathResolver } from './real-path-resolver.ts';

const onWindows = process.platform === 'win32';
let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'escritoriio-runner-real-')));
});

afterEach(() => rm(root, { recursive: true, force: true }));

describe('where a folder really is', () => {
  it('is the folder itself when nothing leads elsewhere', async () => {
    await mkdir(join(root, 'site'));
    expect(await realPathResolver.resolve(join(root, 'site'))).toBe(join(root, 'site'));
  });

  it('is what a link leads to, which is what the policy has to judge', async () => {
    await mkdir(join(root, 'real'));
    await symlink(join(root, 'real'), join(root, 'link'), onWindows ? 'junction' : 'dir');
    expect(await realPathResolver.resolve(join(root, 'link'))).toBe(join(root, 'real'));
  });

  it('follows a link in the middle of the path too', async () => {
    await mkdir(join(root, 'real', 'inner'), { recursive: true });
    await symlink(join(root, 'real'), join(root, 'link'), onWindows ? 'junction' : 'dir');
    expect(await realPathResolver.resolve(join(root, 'link', 'inner'))).toBe(join(root, 'real', 'inner'));
  });

  it('removes the dots of a way back out', async () => {
    await mkdir(join(root, 'a', 'b'), { recursive: true });
    expect(await realPathResolver.resolve(join(root, 'a', 'b', '..'))).toBe(join(root, 'a'));
  });

  it('is nothing when there is no such folder', async () => {
    expect(await realPathResolver.resolve(join(root, 'nowhere'))).toBeUndefined();
  });

  it('is nothing for a file', async () => {
    await writeFile(join(root, 'file.txt'), 'x');
    expect(await realPathResolver.resolve(join(root, 'file.txt'))).toBeUndefined();
  });

  it.skipIf(onWindows)('is nothing for a link that leads nowhere', async () => {
    await symlink(join(root, 'nowhere'), join(root, 'broken'));
    expect(await realPathResolver.resolve(join(root, 'broken'))).toBeUndefined();
  });

  it('gives the case the file system keeps, on a system that does not tell the two apart', async (context) => {
    await mkdir(join(root, 'My Site'));
    // Not every disk of a system that usually does not tell them apart is one that does not.
    if (!(await stat(join(root, 'my site')).then(() => true, () => false))) context.skip();
    expect(await realPathResolver.resolve(join(root, 'my site'))).toBe(join(root, 'My Site'));
  });
});

// Making a link takes a privilege that a person on Windows does not usually have.
describe.skipIf(onWindows)('where a path that may not be there yet really is', () => {
  beforeEach(async () => {
    await mkdir(join(root, 'work', 'src'), { recursive: true });
    await mkdir(join(root, 'outside'));
    await writeFile(join(root, 'work', 'a.txt'), 'a');
    await writeFile(join(root, 'outside', 'secret.txt'), 'secret');
    await symlink(join(root, 'outside'), join(root, 'work', 'link-out'));
    await symlink(join(root, 'work', 'src'), join(root, 'work', 'link-in'));
    await symlink(join(root, 'work', 'missing-target'), join(root, 'work', 'dangling'));
  });

  it('is the path itself when it has no links in it', async () => {
    expect(await realPathOfNearest(join(root, 'work', 'a.txt'))).toBe(join(root, 'work', 'a.txt'));
    expect(await realPathOfNearest(root)).toBe(root);
  });

  it('follows the links of the folders on the way', async () => {
    expect(await realPathOfNearest(join(root, 'work', 'link-out', 'secret.txt'))).toBe(join(root, 'outside', 'secret.txt'));
    expect(await realPathOfNearest(join(root, 'work', 'link-in'))).toBe(join(root, 'work', 'src'));
  });

  it('is where a file that is not there yet would be, by the folder that is', async () => {
    expect(await realPathOfNearest(join(root, 'work', 'src', 'new.ts'))).toBe(join(root, 'work', 'src', 'new.ts'));
    expect(await realPathOfNearest(join(root, 'work', 'link-out', 'new', 'deep', 'file.txt'))).toBe(join(root, 'outside', 'new', 'deep', 'file.txt'));
  });

  it('is where a name that is not there under a file would be, which is no place at all', async () => {
    expect(await realPathOfNearest(join(root, 'work', 'a.txt', 'inside'))).toBe(join(root, 'work', 'a.txt', 'inside'));
  });

  it('cannot tell for a link that leads nowhere: writing through it would make a file wherever it points', async () => {
    await expect(realPathOfNearest(join(root, 'work', 'dangling'))).rejects.toThrow('leads nowhere');
    await expect(realPathOfNearest(join(root, 'work', 'dangling', 'x.txt'))).rejects.toThrow('leads nowhere');
  });
});
