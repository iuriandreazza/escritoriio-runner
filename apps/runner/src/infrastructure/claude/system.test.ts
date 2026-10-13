import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSystemExec, isExecutableFile } from './system.ts';

const node = process.execPath;
const exec = createSystemExec({ PATH: process.env.PATH, HOME: process.env.HOME, ANTHROPIC_API_KEY: 'sk-ant-in-the-runner', GITHUB_TOKEN: 'ghp_x' });

describe('running a program to ask it something', () => {
  it('gives what it printed, and how it ended', async () => {
    expect(await exec(node, ['-e', 'process.stdout.write("2.1.250 (Claude Code)")'], 10_000)).toEqual({ stdout: '2.1.250 (Claude Code)', exitCode: 0 });
  });

  it('gives what it printed even when it ended with an error, as `claude auth status` does when nobody is logged in', async () => {
    expect(await exec(node, ['-e', 'process.stdout.write(JSON.stringify({loggedIn:false})); process.exit(1)'], 10_000)).toEqual({ stdout: '{"loggedIn":false}', exitCode: 1 });
  });

  it('starts it with the environment of a coding agent: no key or token of the runner', async () => {
    const { stdout } = await exec(node, ['-e', 'process.stdout.write(Object.keys(process.env).join(" "))'], 10_000);
    expect(stdout).not.toMatch(/ANTHROPIC|GITHUB|TOKEN|KEY/);
    expect(stdout).toContain('PATH');
  });

  it('types nothing to it, so that a program that waits to be asked is not waited for', async () => {
    expect(await exec(node, ['-e', 'process.stdin.on("end", () => process.stdout.write("end")); process.stdin.resume()'], 10_000)).toEqual({ stdout: 'end', exitCode: 0 });
  });

  it('gives no exit code for a program that is not there, and for one that ran out of time', async () => {
    expect(await exec('/definitely/not/a/program', [], 10_000)).toEqual({ stdout: '', exitCode: null });
    expect((await exec(node, ['-e', 'setTimeout(() => {}, 60000)'], 300)).exitCode).toBeNull();
  });

  it('gives its arguments to the program as they are, with no shell to read them', async () => {
    const { stdout } = await exec(node, ['-e', 'process.stdout.write(process.argv[1])', '$(echo injected); `id`'], 10_000);
    expect(stdout).toBe('$(echo injected); `id`');
  });
});

describe('a file that can be run', () => {
  let folder: string;

  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), 'escritoriio-runner-system-'));
    await writeFile(join(folder, 'program'), '#!/bin/sh\n');
    await chmod(join(folder, 'program'), 0o755);
    await writeFile(join(folder, 'notes.txt'), 'text');
    await chmod(join(folder, 'notes.txt'), 0o644);
  });

  afterAll(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  // Windows has no execute permission: any file that is there can be run.
  it.skipIf(process.platform === 'win32')('is a file with the permission to run, and not a text file, a folder or what is not there', async () => {
    expect(await isExecutableFile(join(folder, 'program'))).toBe(true);
    expect(await isExecutableFile(join(folder, 'notes.txt'))).toBe(false);
    expect(await isExecutableFile(folder)).toBe(false);
    expect(await isExecutableFile(join(folder, 'missing'))).toBe(false);
  });
});
