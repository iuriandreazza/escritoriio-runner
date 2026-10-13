import { describe, expect, it } from 'vitest';
import type { GitDirState } from './git-settings.ts';
import { INCOMPLETE_WORDS, isBenignSetting, isRunningSetting, isSampleHook, planGitDir, settingId, summarizeGitSettings } from './git-settings.ts';

describe('a setting of a git repository that makes something run', () => {
  it.each([
    ['core.hooksPath', '/tmp/hooks'],
    ['core.hookspath', '.husky'],
    ['core.fsmonitor', '/tmp/watch'],
    ['core.fsmonitor', 'true'],
    ['core.sshCommand', 'ssh -o ProxyCommand=evil'],
    ['core.pager', 'sh -c evil'],
    ['core.editor', 'evil'],
    ['core.askPass', 'evil'],
    ['core.gitProxy', 'evil'],
    ['credential.helper', '!evil'],
    ['credential.https://github.com.helper', '!evil'],
    ['filter.lfs.smudge', 'git-lfs smudge'],
    ['filter.evil.clean', 'evil'],
    ['filter.evil.required', 'true'],
    ['url.https://evil.example/.insteadOf', 'https://github.com/'],
    ['url.ssh://git@evil.example/.pushInsteadOf', 'https://github.com/'],
    ['diff.external', 'evil'],
    ['diff.word.textconv', 'evil'],
    ['diff.word.command', 'evil'],
    ['merge.custom.driver', 'evil %A'],
    ['gpg.program', 'evil'],
    ['gpg.ssh.program', 'evil'],
    ['sequence.editor', 'evil'],
    ['include.path', '../evil'],
    ['includeIf.gitdir:/tmp/.path', '../evil'],
    ['alias.st', '!evil'],
    ['submodule.lib.update', '!evil'],
    ['gpg.ssh.defaultKeyCommand', 'evil'],
    ['trailer.x.cmd', 'evil'],
    ['trailer.x.command', 'evil'],
    ['browser.x.cmd', 'evil'],
    ['browser.x.path', 'evil'],
    ['man.x.cmd', 'evil'],
    ['instaweb.httpd', 'evil'],
    ['instaweb.browser', 'evil'],
    ['core.worktree', '../elsewhere'],
    ['sendemail.smtpServer', '/usr/bin/evil'],
    ['sendemail.smtpServer', './evil'],
    ['pager.log', 'evil'],
    ['pager.diff', 'false'],
    ['remote.origin.uploadpack', 'evil'],
    ['remote.origin.receivepack', 'evil'],
    ['remote.origin.vcs', 'evil'],
    ['mergetool.evil.cmd', 'evil'],
    ['difftool.evil.cmd', 'evil'],
    ['mergetool.evil.path', 'evil'],
    ['core.alternateRefsCommand', 'evil'],
    ['interactive.diffFilter', 'evil'],
  ])('is %s', (key, value) => {
    expect(isRunningSetting(key, value)).toBe(true);
  });

  it.each([
    ['core.bare', 'false'],
    ['core.filemode', 'true'],
    ['core.ignorecase', 'true'],
    ['remote.origin.url', 'https://github.com/octocat/Hello-World.git'],
    ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
    ['branch.main.remote', 'origin'],
    ['user.name', 'Ana'],
    ['user.email', 'ana@example.com'],
    ['alias.st', 'status'],
    ['core.editorconfig', 'true'],
    ['diff.algorithm', 'patience'],
    ['credential.useHttpPath', 'true'],
    ['submodule.lib.update', 'merge'],
    ['sendemail.smtpServer', 'smtp.example.org'],
    ['filter.lfs', 'nothing'],
  ])('is not %s', (key, value) => {
    expect(isRunningSetting(key, value)).toBe(false);
  });
});

describe('a hook of a git repository', () => {
  it.each([
    ['pre-commit.sample', true],
    ['applypatch-msg.sample', true],
    ['pre-commit', false],
    ['post-checkout', false],
    ['pre-commit.SAMPLE', false],
    ['not-a-sample.sample.sh', false],
    ['', false],
  ])('%j is a sample: %s', (name, sample) => {
    expect(isSampleHook(name)).toBe(sample);
  });
});


describe('a setting that is nothing to worry about in a repository that a task made', () => {
  it.each(['core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates', 'core.ignorecase', 'core.precomposeunicode', 'remote.origin.url', 'remote.origin.fetch', 'branch.main.remote', 'branch.main.merge', 'user.name', 'user.email', 'gc.auto'])('is %s', (key) => {
    expect(isBenignSetting(key)).toBe(true);
  });

  it.each(['core.hooksPath', 'core.editor', 'alias.x', 'commit.gpgsign', 'remote.origin.uploadpack', 'url.https://x/.insteadOf', 'include.path', 'diff.external', 'core.excludesfile'])('is not %s', (key) => {
    expect(isBenignSetting(key)).toBe(false);
  });
});

const state = (hooks: Record<string, string> = {}, settings: Record<string, readonly string[]> = {}): GitDirState => ({ hooks, settings });
const id = (key: string) => settingId('config', key);

describe('what a task changed in a git directory, against what was there before it', () => {
  it('leaves what the owner had, as it was: a hook, and the settings that run programs', () => {
    const before = state({ 'pre-commit': 'aaa' }, { [id('core.hookspath')]: ['.husky'], [id('core.sshcommand')]: ['ssh -i key'], [id('credential.helper')]: ['osxkeychain'] });
    expect(planGitDir(before, before)).toEqual({ removeHooks: [], changedHooks: [], unset: [], restore: [] });
  });

  it('takes away a hook that is new, and says one that changed is changed', () => {
    const before = state({ 'pre-commit': 'aaa' });
    const after = state({ 'pre-commit': 'bbb', 'post-merge': 'ccc', 'pre-commit.sample': 'ddd' });
    expect(planGitDir(before, after)).toEqual({ removeHooks: ['post-merge'], changedHooks: ['pre-commit'], unset: [], restore: [] });
  });

  it('takes away a setting that is new, and puts back the value of one that was changed', () => {
    const before = state({}, { [id('core.sshcommand')]: ['ssh -i key'], [id('alias.st')]: ['status'] });
    const after = state({}, { [id('core.sshcommand')]: ['ssh -o ProxyCommand=evil'], [id('core.fsmonitor')]: ['true'], [id('alias.st')]: ['!evil'], [id('user.name')]: ['Ana'] });
    const plan = planGitDir(before, after);
    expect([...plan.unset].sort()).toEqual([id('alias.st'), id('core.fsmonitor'), id('core.sshcommand')].sort());
    expect(plan.restore).toEqual(expect.arrayContaining([{ id: id('core.sshcommand'), values: ['ssh -i key'] }, { id: id('alias.st'), values: ['status'] }]));
    expect(plan.restore).toHaveLength(2);
  });

  it('has nothing from before for a repository the task made: everything that is not benign goes, hooks included', () => {
    const after = state({ 'pre-commit': 'aaa', 'pre-commit.sample': 'bbb' }, { [id('core.bare')]: ['false'], [id('remote.origin.url')]: ['https://github.com/a/b.git'], [id('core.editor')]: ['vim'], [id('commit.gpgsign')]: ['true'], [id('core.hookspath')]: ['x'] });
    const plan = planGitDir(undefined, after);
    expect(plan.removeHooks).toEqual(['pre-commit']);
    expect([...plan.unset].sort()).toEqual([id('commit.gpgsign'), id('core.editor'), id('core.hookspath')].sort());
    expect(plan.restore).toEqual([]);
  });

  it('tells a setting by the file it is in', () => {
    expect(settingId('config.worktree', 'core.hookspath')).not.toBe(settingId('config', 'core.hookspath'));
  });
});

describe('what is told of the git settings of a task', () => {
  const finding = (over: object = {}) => ({ repository: 'api', hooks: [] as string[], settings: [] as string[], restored: [] as string[], notes: [] as string[], ...over });

  it('says nothing when nothing was found and the check was complete', () => {
    expect(summarizeGitSettings({ findings: [], incomplete: [] })).toBeUndefined();
    expect(summarizeGitSettings({ findings: [finding()], incomplete: [] })).toBeUndefined();
  });

  it('names each repository, what was removed from it, and what was put back', () => {
    const words = summarizeGitSettings({
      findings: [finding({ hooks: ['pre-commit', 'post-checkout'], settings: ['core.hookspath'] }), finding({ repository: '.', settings: ['filter.evil.smudge'], restored: ['core.sshcommand'] })],
      incomplete: [],
    });
    expect(words).toBe('The task changed git settings that run programs; they were removed: api (hooks pre-commit, post-checkout; settings core.hookspath); . (settings filter.evil.smudge). Put back as they were before the task: . (core.sshcommand).');
  });

  it('puts warnings first, in fixed words, before what was removed', () => {
    const words = summarizeGitSettings({
      findings: [finding({ hooks: ['pre-push'] }), finding({ repository: 'b', notes: ['its .git is a file that points to another place, left as it is'] })],
      incomplete: ['budget', 'no-baseline'],
    }) as string;
    expect(words.startsWith('WARNING: ')).toBe(true);
    expect(words.indexOf(INCOMPLETE_WORDS.budget)).toBeLessThan(words.indexOf('were removed'));
    expect(words).toContain(INCOMPLETE_WORDS['no-baseline']);
    expect(words).toContain('b: its .git is a file that points to another place, left as it is.');
  });

  it('is told when the check was incomplete even though nothing was found', () => {
    expect(summarizeGitSettings({ findings: [], incomplete: ['aborted'] })).toBe(`WARNING: ${INCOMPLETE_WORDS.aborted}`);
  });

  it('never cuts a warning, however long what was removed is, and says how many repositories are left out of the list', () => {
    const many = Array.from({ length: 200 }, (_, index) => finding({ repository: `repository-number-${index}`, hooks: ['pre-commit'], settings: ['core.hooksPath'] }));
    const words = summarizeGitSettings({ findings: [...many, finding({ repository: 'z', notes: ['a rebase there runs commands'] })], incomplete: ['depth', 'unreadable'] }) as string;
    expect(words).toContain('z: a rebase there runs commands.');
    expect(words).toContain(INCOMPLETE_WORDS.depth);
    expect(words).toContain(INCOMPLETE_WORDS.unreadable);
    expect(words).toMatch(/and \d+ more repositories/);
    expect(words.length).toBeLessThan(2_000);
  });
});
