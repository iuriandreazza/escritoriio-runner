import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitSettingsReport } from '../domain/git-settings.ts';
import { createRepository, neverAborted, plainGit } from '../testing/git-fixtures.ts';
import { createGitSettingsScan } from './git-settings-scan.ts';
import { runProcess } from './run-process.ts';

let root: string;
let workspace: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'escritoriio-runner-scan-')));
  workspace = join(root, 'workspace');
  await mkdir(workspace);
});

afterEach(() => rm(root, { recursive: true, force: true }));

const scanner = (options: Partial<Parameters<typeof createGitSettingsScan>[0]> = {}) => createGitSettingsScan({ exec: runProcess, environment: { PATH: process.env.PATH, HOME: join(root, 'home') }, windows: false, ...options });
const exists = (path: string) => stat(path).then(() => true, () => false);
const hook = async (repository: string, name: string, body = '#!/bin/sh\nexit 0\n') => {
  await mkdir(join(repository, '.git', 'hooks'), { recursive: true });
  await writeFile(join(repository, '.git', 'hooks', name), body);
  await chmod(join(repository, '.git', 'hooks', name), 0o755);
};
const configKeys = async (repository: string) => (await plainGit(repository, 'config', '--local', '--list', '--name-only')).split('\n').filter((key) => key !== '');
const configValue = async (repository: string, key: string) => (await plainGit(repository, 'config', '--local', '--get', key)).trim();

/** A task: what was there is recorded, the task does what `during` says, and what is found after it is what is told. */
async function around(during: () => Promise<void>, options: Parameters<typeof scanner>[0] = {}, baseline = true): Promise<GitSettingsReport> {
  const scan = scanner(options);
  const before = baseline ? await scan.snapshot(workspace, neverAborted()) : undefined;
  await during();
  return scan.scan(workspace, neverAborted(), before);
}

const repositoryWith = async (name: string, files: Record<string, string> = { 'a.txt': 'a' }) => {
  const repository = join(workspace, name);
  await createRepository(repository, files);
  return repository;
};

describe('what a task adds to the git repositories of a folder worked in place', () => {
  it('finds nothing, and changes nothing, in a folder with no repository, or with ordinary ones', async () => {
    await mkdir(join(workspace, 'plain'));
    const api = await repositoryWith('api');
    await plainGit(api, 'remote', 'add', 'origin', 'https://github.com/octocat/Hello-World.git');
    const before = await configKeys(api);
    expect(await around(async () => undefined)).toEqual({ findings: [], incomplete: [] });
    expect(await configKeys(api)).toEqual(before);
  });

  it('leaves alone the hooks and the settings that the owner had before the task, which are theirs', async () => {
    const api = await repositoryWith('api');
    await hook(api, 'pre-commit', '#!/bin/sh\necho husky\n');
    await plainGit(api, 'config', 'core.hooksPath', '.husky');
    await plainGit(api, 'config', 'core.sshCommand', 'ssh -i ~/.ssh/work');
    await plainGit(api, 'config', 'credential.helper', 'osxkeychain');
    await plainGit(api, 'config', 'filter.lfs.smudge', 'git-lfs smudge -- %f');
    const report = await around(async () => undefined);
    expect(report).toEqual({ findings: [], incomplete: [] });
    expect(await configValue(api, 'core.sshcommand')).toBe('ssh -i ~/.ssh/work');
    expect(await readFile(join(api, '.git', 'hooks', 'pre-commit'), 'utf8')).toContain('husky');
  });

  it('removes the hooks that the task added, keeps the samples, and says which', async () => {
    const api = await repositoryWith('api');
    const report = await around(async () => {
      await hook(api, 'pre-commit.sample');
      await hook(api, 'pre-commit');
      await hook(api, 'post-checkout');
    });
    expect(report.findings).toEqual([{ repository: 'api', hooks: ['post-checkout', 'pre-commit'], settings: [], restored: [], notes: [] }]);
    const left = await readdir(join(api, '.git', 'hooks'));
    expect(left).toContain('pre-commit.sample');
    expect(left.filter((name) => !name.endsWith('.sample'))).toEqual([]);
  });

  it('removes the settings that the task added and keeps the rest', async () => {
    const api = await repositoryWith('api');
    await plainGit(api, 'remote', 'add', 'origin', 'https://github.com/octocat/Hello-World.git');
    const report = await around(async () => {
      for (const [key, value] of [
        ['core.hooksPath', '.husky'],
        ['core.fsmonitor', 'true'],
        ['core.sshCommand', 'ssh -o ProxyCommand=evil'],
        ['filter.evil.smudge', 'evil'],
        ['credential.helper', '!evil'],
        ['url.https://evil.example/.insteadOf', 'https://github.com/'],
        ['include.path', '../evil'],
        ['alias.st', '!evil'],
        ['alias.ok', 'status'],
        ['submodule.lib.update', '!evil'],
        ['trailer.x.cmd', 'evil'],
        ['core.worktree', '../elsewhere'],
      ] as const) {
        await plainGit(api, 'config', key, value);
      }
    });
    expect([...(report.findings[0]?.settings ?? [])].sort()).toEqual(['alias.st', 'core.hookspath', 'core.fsmonitor', 'core.sshcommand', 'core.worktree', 'credential.helper', 'filter.evil.smudge', 'include.path', 'submodule.lib.update', 'trailer.x.cmd', 'url.https://evil.example/.insteadof'].sort());
    const kept = await configKeys(api);
    expect(kept).toEqual(expect.arrayContaining(['remote.origin.url', 'alias.ok']));
    expect(kept).not.toContain('core.hookspath');
    expect(kept.some((key) => key.startsWith('url.'))).toBe(false);
  });

  it('puts back what the owner had when the task changed it, and does not take it away', async () => {
    const api = await repositoryWith('api');
    await plainGit(api, 'config', 'core.sshCommand', 'ssh -i ~/.ssh/work');
    await hook(api, 'pre-commit', '#!/bin/sh\necho mine\n');
    const report = await around(async () => {
      await plainGit(api, 'config', 'core.sshCommand', 'ssh -o ProxyCommand=evil');
      await writeFile(join(api, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho evil\n');
    });
    expect(await configValue(api, 'core.sshcommand')).toBe('ssh -i ~/.ssh/work');
    expect(await readFile(join(api, '.git', 'hooks', 'pre-commit'), 'utf8')).toBe('#!/bin/sh\necho mine\n');
    expect((await stat(join(api, '.git', 'hooks', 'pre-commit'))).mode & 0o111).not.toBe(0);
    expect(report.findings[0]).toMatchObject({ repository: 'api', hooks: [], settings: [], restored: expect.arrayContaining(['core.sshcommand', 'pre-commit']) });
  });

  it('takes away from a repository that the task made everything that git does not write itself, hooks included', async () => {
    let made = '';
    const report = await around(async () => {
      made = await repositoryWith('fresh');
      await plainGit(made, 'remote', 'add', 'origin', 'https://github.com/octocat/Hello-World.git');
      await plainGit(made, 'config', 'user.name', 'Ana');
      await plainGit(made, 'config', 'core.editor', 'evil');
      await plainGit(made, 'config', 'commit.gpgsign', 'true');
      await hook(made, 'pre-commit');
    });
    expect(report.findings[0]).toMatchObject({ repository: 'fresh', hooks: ['pre-commit'] });
    expect([...(report.findings[0]?.settings ?? [])].sort()).toEqual(['commit.gpgsign', 'core.editor']);
    const kept = await configKeys(made);
    expect(kept).toEqual(expect.arrayContaining(['remote.origin.url', 'user.name', 'core.bare']));
    expect(kept).not.toContain('core.editor');
  });

  it('runs none of what it removes: not a hook, not a monitor, not a pager', async () => {
    const api = await repositoryWith('api');
    const marker = join(root, 'ran');
    await around(async () => {
      await hook(api, 'pre-commit', `#!/bin/sh\ntouch ${marker}\n`);
      await hook(api, 'post-checkout', `#!/bin/sh\ntouch ${marker}\n`);
      await plainGit(api, 'config', 'core.fsmonitor', `touch ${marker}; true`);
      await plainGit(api, 'config', 'core.hooksPath', join(api, '.git', 'hooks'));
      await plainGit(api, 'config', 'core.pager', `touch ${marker}`);
    });
    expect(await exists(marker)).toBe(false);
  });

  it('looks into the folder itself and into repositories inside repositories', async () => {
    await createRepository(workspace, { 'a.txt': 'a' });
    await createRepository(join(workspace, 'one', 'two'), { 'b.txt': 'b' });
    const report = await around(async () => {
      await hook(workspace, 'pre-push');
      await hook(join(workspace, 'one', 'two'), 'pre-push');
    });
    expect(report.findings.map((finding) => finding.repository).sort()).toEqual(['.', 'one/two']);
  });

  it('looks into node_modules as far as a package and a scoped one, and says nothing of what is deeper', async () => {
    await createRepository(join(workspace, 'node_modules', 'pkg'), { 'c.txt': 'c' });
    await createRepository(join(workspace, 'node_modules', '@scope', 'pkg'), { 'c.txt': 'c' });
    await createRepository(join(workspace, 'node_modules', 'a', 'node_modules', 'b', 'node_modules', 'c', 'node_modules', 'd'), { 'c.txt': 'c' });
    const report = await around(async () => {
      await hook(join(workspace, 'node_modules', 'pkg'), 'pre-push');
      await hook(join(workspace, 'node_modules', '@scope', 'pkg'), 'pre-push');
    });
    expect(report.findings.map((finding) => finding.repository).sort()).toEqual(['node_modules/@scope/pkg', 'node_modules/pkg']);
    expect(report.incomplete).toEqual([]);
  });

  it('says that folders deeper than it looks were not checked', async () => {
    await mkdir(join(workspace, 'a', 'b', 'c', 'd', 'e', 'f', 'g'), { recursive: true });
    expect((await around(async () => undefined)).incomplete).toEqual(['depth']);
  });

  it('says it stopped when it had looked at as many folders as it may, and when it was told to stop', async () => {
    for (let index = 0; index < 20; index++) await mkdir(join(workspace, `d${index}`));
    expect((await around(async () => undefined, { maxDirectories: 5 })).incomplete).toEqual(expect.arrayContaining(['budget']));
    const scan = scanner();
    const before = await scan.snapshot(workspace, neverAborted());
    expect((await scan.scan(workspace, AbortSignal.abort(), before)).incomplete).toEqual(['aborted']);
  });

  it('removes nothing, and says so, when it has no record of what was there before', async () => {
    const api = await repositoryWith('api');
    const report = await around(async () => {
      await hook(api, 'pre-commit');
      await plainGit(api, 'config', 'core.hooksPath', '.x');
    }, {}, false);
    expect(report.incomplete).toContain('no-baseline');
    expect(await exists(join(api, '.git', 'hooks', 'pre-commit'))).toBe(true);
    expect(await configKeys(api)).toContain('core.hookspath');
  });

  it('removes nothing from a repository it cannot tell from one the task made, when its record is not whole', async () => {
    for (let index = 0; index < 5; index++) await mkdir(join(workspace, `d${index}`));
    const owner = await repositoryWith('zz-owners');
    await hook(owner, 'pre-commit');
    const scan = scanner({ maxDirectories: 3 });
    const before = await scan.snapshot(workspace, neverAborted());
    const report = await scanner().scan(workspace, neverAborted(), before);
    expect(report.incomplete).toContain('budget');
    expect(await exists(join(owner, '.git', 'hooks', 'pre-commit'))).toBe(true);
  });

  it('does not follow a link, not to a folder with a repository', async () => {
    const outside = join(root, 'outside');
    await createRepository(outside, { 'o.txt': 'o' });
    await symlink(outside, join(workspace, 'link'));
    const report = await around(async () => hook(outside, 'pre-commit'));
    expect(report.findings).toEqual([]);
    expect(await exists(join(outside, '.git', 'hooks', 'pre-commit'))).toBe(true);
  });

  it('takes away a hooks folder that is a link, and leaves what it led to alone', async () => {
    const api = await repositoryWith('api');
    const elsewhere = join(root, 'elsewhere-hooks');
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, 'pre-commit'), '#!/bin/sh\n');
    const report = await around(async () => {
      await rm(join(api, '.git', 'hooks'), { recursive: true, force: true });
      await symlink(elsewhere, join(api, '.git', 'hooks'));
    });
    expect(report.findings[0]?.hooks).toEqual(['hooks (a link)']);
    expect(await exists(join(api, '.git', 'hooks'))).toBe(false);
    expect(await readFile(join(elsewhere, 'pre-commit'), 'utf8')).toBe('#!/bin/sh\n');
  });

  it('takes away a settings file that is a link, and writes nothing through it', async () => {
    const api = await repositoryWith('api');
    const elsewhere = join(root, 'elsewhere-config');
    await writeFile(elsewhere, '[core]\n\thooksPath = /tmp/x\n');
    const report = await around(async () => {
      await rm(join(api, '.git', 'config'));
      await symlink(elsewhere, join(api, '.git', 'config'));
    });
    expect(report.findings[0]?.settings).toEqual([]);
    expect(report.findings[0]?.hooks).toEqual(['config (a link)']);
    expect(await readFile(elsewhere, 'utf8')).toBe('[core]\n\thooksPath = /tmp/x\n');
  });

  it('takes away a .git that is a link, and tells it', async () => {
    const outside = join(root, 'outside');
    await createRepository(outside, { 'o.txt': 'o' });
    const report = await around(async () => {
      await mkdir(join(workspace, 'api'));
      await symlink(join(outside, '.git'), join(workspace, 'api', '.git'));
    });
    expect(report.findings).toEqual([{ repository: 'api', hooks: [], settings: [], restored: [], notes: ['its .git was a link, which was removed'] }]);
    expect(await exists(join(workspace, 'api', '.git'))).toBe(false);
    expect(await exists(join(outside, '.git', 'HEAD'))).toBe(true);
  });

  it('tells a .git that is a file pointing elsewhere when the task made it, and is silent for one that was there before', async () => {
    await mkdir(join(workspace, 'before'));
    await writeFile(join(workspace, 'before', '.git'), 'gitdir: ../somewhere\n');
    const report = await around(async () => {
      await mkdir(join(workspace, 'after'));
      await writeFile(join(workspace, 'after', '.git'), 'gitdir: ../somewhere-else\n');
    });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.repository).toBe('after');
    expect(report.findings[0]?.notes[0]).toMatch(/points to another place/);
    expect(await readFile(join(workspace, 'after', '.git'), 'utf8')).toBe('gitdir: ../somewhere-else\n');
  });

  it('looks at a git directory that has no .git around it, at the repositories of submodules and at linked worktrees', async () => {
    const bare = join(workspace, 'bare.git');
    await mkdir(bare);
    await plainGit(bare, 'init', '--bare', '--quiet');
    const api = await repositoryWith('api');
    await mkdir(join(api, '.git', 'modules', 'lib', 'hooks'), { recursive: true });
    await writeFile(join(api, '.git', 'modules', 'lib', 'HEAD'), 'ref: refs/heads/main\n');
    await mkdir(join(api, '.git', 'worktrees', 'wt'), { recursive: true });
    const report = await around(async () => {
      await hook(bare.replace('.git', ''), 'x').catch(() => undefined);
      await writeFile(join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\n');
      await writeFile(join(api, '.git', 'modules', 'lib', 'hooks', 'post-merge'), '#!/bin/sh\n');
      await writeFile(join(api, '.git', 'modules', 'lib', 'config'), '[core]\n\tfsmonitor = true\n');
      await writeFile(join(api, '.git', 'worktrees', 'wt', 'config.worktree'), '[core]\n\thooksPath = /tmp/x\n');
    });
    const byRepository = Object.fromEntries(report.findings.map((finding) => [finding.repository, finding]));
    expect(byRepository['bare.git (bare)']?.hooks).toEqual(['pre-receive']);
    expect(byRepository['api (module lib)']).toMatchObject({ hooks: ['post-merge'], settings: ['core.fsmonitor'] });
    expect(byRepository['api (worktree wt)']?.settings).toEqual(['core.hookspath']);
  });

  it('says it cannot trust a settings file that is larger than git writes, or that git cannot read, and does not take it for one with nothing in it', async () => {
    const big = await repositoryWith('big');
    const broken = await repositoryWith('broken');
    const report = await around(async () => {
      await writeFile(join(big, '.git', 'config'), `[core]\n${'\t# padding\n'.repeat(10_000)}\thooksPath = /tmp/x\n`);
      await writeFile(join(broken, '.git', 'config'), '[core\n\t= = =\n');
    });
    expect(report.incomplete).toContain('unreadable');
    const notes = report.findings.flatMap((finding) => finding.notes).join(' ');
    expect(notes).toMatch(/larger than git writes/);
    expect(notes).toMatch(/could not be read/);
  });

  it('warns of a rebase that waits to run commands', async () => {
    const api = await repositoryWith('api');
    const report = await around(async () => {
      await mkdir(join(api, '.git', 'rebase-merge'));
      await writeFile(join(api, '.git', 'rebase-merge', 'git-rebase-todo'), 'pick abc123 one\nexec touch /tmp/x\n');
    });
    expect(report.findings[0]?.notes[0]).toMatch(/rebase waiting there runs commands/);
  });

  it('does not fail for a folder that is not there', async () => {
    const scan = scanner();
    const before = await scan.snapshot(join(root, 'nothing'), neverAborted());
    expect((await scan.scan(join(root, 'nothing'), neverAborted(), before)).findings).toEqual([]);
  });

  it('runs git for the settings files in a folder of its own, not in the one it looks at', async () => {
    const neutral = join(root, 'neutral');
    const seen: string[] = [];
    const api = await repositoryWith('api');
    await around(async () => undefined, { neutralDirectory: neutral, exec: (file, args, options) => (seen.push(options.cwd), runProcess(file, args, options)) });
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([neutral]));
    expect(api).toBeTruthy();
    expect((await stat(neutral)).mode & 0o777).toBe(0o700);
  });
});
