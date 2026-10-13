import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHardenedGit, gitHardening, OWNER_SSH_COMMAND } from './hardened-git.ts';
import type { ProcessOptions, ProcessResult, RunProcess } from './run-process.ts';

let root: string;
let fakeGit: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'escritoriio-runner-hardened-'));
  fakeGit = join(root, 'git');
  await writeFile(fakeGit, '#!/bin/sh\n');
  await chmod(fakeGit, 0o755);
});

afterEach(() => rm(root, { recursive: true, force: true }));

interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: ProcessOptions;
}

function recording(): { readonly calls: Call[]; readonly exec: RunProcess } {
  const calls: Call[] = [];
  const result: ProcessResult = { exitCode: 0, stdout: '', stderr: '', stopped: undefined };
  return { calls, exec: (file, args, options) => (calls.push({ file, args, options }), Promise.resolve(result)) };
}

const shell = { PATH: '', HOME: '/Users/ana', SSH_AUTH_SOCK: '/private/tmp/agent.sock', GITHUB_TOKEN: 'ghp_x', ANTHROPIC_API_KEY: 'sk-ant', GIT_ASKPASS: '/bin/evil', SSH_ASKPASS: '/bin/evil' };

describe('git as the runner starts it for what a repository controls', () => {
  it('blanks the credential helper and keeps the settings of the system out of it', async () => {
    const { calls, exec } = recording();
    await createHardenedGit({ exec, environment: { ...shell, PATH: root }, windows: false }).run({ cwd: root }, [], ['status']);
    const [call] = calls;
    expect(call?.args).toContain('credential.helper=');
    expect(call?.options.env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(call?.options.env).not.toHaveProperty('SSH_AUTH_SOCK');
    expect(call?.options.env).not.toHaveProperty('GIT_SSH_COMMAND');
  });
});

describe('git as the runner starts it to reach a remote, on its own and never for the agent', () => {
  async function started() {
    const { calls, exec } = recording();
    await createHardenedGit({ exec, environment: { ...shell, PATH: root }, windows: false, reach: 'network' }).run({ cwd: root }, [], ['clone', '--', 'https://github.com/a/b.git', 'b']);
    const [call] = calls;
    if (!call) throw new Error('git was not started');
    return call;
  }

  it('lets only https and ssh through, and refuses file, ext and everything else, in the settings and in the environment', async () => {
    const { args, options } = await started();
    const settings = args.filter((_, index) => args[index - 1] === '-c');
    expect(settings).toEqual(expect.arrayContaining(['protocol.allow=never', 'protocol.https.allow=always', 'protocol.ssh.allow=always', 'protocol.file.allow=never', 'protocol.ext.allow=never', 'http.followRedirects=false', 'transfer.fsckObjects=true', 'core.hooksPath=/dev/null', 'core.fsmonitor=false', 'submodule.recurse=false']));
    expect(options.env.GIT_ALLOW_PROTOCOL).toBe('https:ssh');
  });

  it('leaves the credential helper of the owner as it is, and does not leave out the settings of the system', async () => {
    const { args, options } = await started();
    expect(args).not.toContain('credential.helper=');
    expect(options.env).not.toHaveProperty('GIT_CONFIG_NOSYSTEM');
  });

  it('hands over the agent of the owner’s ssh keys and the folder of their settings, and no secret of the runner’s own environment', async () => {
    const { options } = await started();
    expect(options.env.SSH_AUTH_SOCK).toBe('/private/tmp/agent.sock');
    expect(options.env.HOME).toBe('/Users/ana');
    expect(Object.keys(options.env).join(' ')).not.toMatch(/GITHUB|ANTHROPIC|ASKPASS|TOKEN|KEY/);
  });

  it('keeps the check of the host keys on, whatever the settings of ssh say, and never asks anyone', async () => {
    const { options } = await started();
    expect(options.env.GIT_SSH_COMMAND).toBe(OWNER_SSH_COMMAND);
    expect(OWNER_SSH_COMMAND).toContain('StrictHostKeyChecking=yes');
    expect(OWNER_SSH_COMMAND).toContain('BatchMode=yes');
    expect(options.env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('is not given a socket that the environment does not have', async () => {
    const { calls, exec } = recording();
    const { SSH_AUTH_SOCK: _socket, ...without } = shell;
    await createHardenedGit({ exec, environment: { ...without, PATH: root }, windows: false, reach: 'network' }).run({ cwd: root }, [], ['status']);
    expect(calls[0]?.options.env).not.toHaveProperty('SSH_AUTH_SOCK');
  });

  it('has the same hardening whatever it is told to do, so that the clone is as hardened as the copy', () => {
    const local = gitHardening('/dev/null');
    const network = gitHardening('/dev/null', 'network');
    for (const setting of local.filter((word) => word !== 'credential.helper=')) expect(network).toContain(setting);
  });
});
