import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findProgram } from './find-program.ts';

const onWindows = process.platform === 'win32';
let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'escritoriio-runner-find-')));
});

afterEach(() => rm(root, { recursive: true, force: true }));

async function program(folder: string, name: string, mode = 0o755): Promise<string> {
  await mkdir(join(root, folder), { recursive: true });
  const path = join(root, folder, onWindows ? `${name}.exe` : name);
  await writeFile(path, '#!/bin/sh\n');
  await chmod(path, mode);
  return path;
}

const pathOf = (...folders: string[]) => ({ PATH: folders.map((folder) => join(root, folder)).join(onWindows ? ';' : ':') });

describe('finding a program', () => {
  it('is the first one of the PATH, by its full path', async () => {
    const first = await program('first', 'tool');
    await program('second', 'tool');
    expect(await findProgram('tool', pathOf('first', 'second'), onWindows)).toBe(first);
  });

  it('goes on to the next folder when the first has none', async () => {
    const second = await program('second', 'tool');
    expect(await findProgram('tool', pathOf('first', 'second'), onWindows)).toBe(second);
  });

  it('is nothing when no folder of the PATH has it', async () => {
    await program('first', 'other');
    expect(await findProgram('tool', pathOf('first'), onWindows)).toBeUndefined();
    expect(await findProgram('tool', {}, onWindows)).toBeUndefined();
  });

  it.skipIf(onWindows)('does not take a file that cannot be run, nor a folder of that name', async () => {
    await program('first', 'tool', 0o644);
    await mkdir(join(root, 'second', 'tool'), { recursive: true });
    const third = await program('third', 'tool');
    expect(await findProgram('tool', pathOf('first', 'second', 'third'), false)).toBe(third);
  });

  it.skipIf(onWindows)('never looks in the folder it is run from, which an empty entry or a dot of the PATH means', async () => {
    const here = process.cwd();
    const planted = join(here, 'a-program-planted-for-the-test');
    await writeFile(planted, '#!/bin/sh\n');
    await chmod(planted, 0o755);
    try {
      expect(await findProgram('a-program-planted-for-the-test', { PATH: `:.:${here.replace(/[^/]+$/, 'nowhere')}` }, false)).toBeUndefined();
    } finally {
      await rm(planted, { force: true });
    }
  });

  it('reads the PATH of Windows in any case, on Windows', async () => {
    expect(await findProgram('tool', { Path: 'C:\\Nowhere\\bin' }, true)).toBeUndefined();
  });
});
