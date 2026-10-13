import { RUNNER_LIMITS } from '@escritoriio/runner-protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AllowedFolder } from '../domain/folder-policy.ts';
import type { FolderQuestion, NewFolder } from './folders.ts';
import type { NewWorkspace } from './folders.ts';
import { addFolder, createWorkspace, describeFolderChoice, SETTINGS_REMOVED_LINE, describeFolders, inspectFolders, removeFolder, updateFolder } from './folders.ts';
import { FakeWorkspaceOps } from './workspace-testing.ts';
import { EMPTY_POLICY } from './task-ports.ts';
import { FakeAgent, FakeIsolation, FakePolicyStore, FakeResolver, site, surroundings } from './task-testing.ts';

let policy: FakePolicyStore;
let resolver: FakeResolver;
let isolation: FakeIsolation;
let asked: FolderQuestion[];
let answer: boolean;

beforeEach(() => {
  policy = new FakePolicyStore(EMPTY_POLICY);
  resolver = new FakeResolver();
  isolation = new FakeIsolation();
  asked = [];
  answer = true;
});

const deps = () => ({ policy, resolver, surroundings, isolation, agents: { 'claude-code': new FakeAgent() } });
const confirm = (question: FolderQuestion): Promise<boolean> => {
  asked.push(question);
  return Promise.resolve(answer);
};
const request: NewFolder = { path: '/Users/ana/work/site', label: undefined, access: 'read-only', approval: 'auto', isolation: 'worktree', trusted: false, agent: null };
const add = (overrides: Partial<NewFolder> = {}, aiMember: string | null = 'Robo') => addFolder(deps(), { ...request, ...overrides }, aiMember ?? undefined, confirm);
const labels = () => policy.policy.folders.map((folder) => folder.label);

describe('sharing a folder', () => {
  it('keeps it as the person chose, under the name of the folder, after asking', async () => {
    const outcome = await add({ access: 'edit', approval: 'ask', isolation: 'in-place', trusted: true, agent: 'claude-code' });
    expect(outcome).toEqual({ added: true, folder: { label: 'site', path: '/Users/ana/work/site', realPath: '/Users/ana/work/site', access: 'edit', approval: 'ask', isolation: 'in-place', trusted: true, agent: 'claude-code' } });
    expect(policy.policy.folders).toEqual([(outcome as { folder: AllowedFolder }).folder]);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.aiMember).toBe('Robo');
  });

  it('is shared read-only unless the person chooses otherwise: the narrowest is what is asked for', async () => {
    await add();
    expect(policy.policy.folders[0]).toMatchObject({ access: 'read-only', approval: 'auto', isolation: 'worktree', trusted: false, agent: null });
  });

  it('keeps nothing when the person says no', async () => {
    answer = false;
    expect(await add()).toEqual({ added: false });
    expect(policy.policy).toEqual(EMPTY_POLICY);
  });

  it('keeps nothing else that the policy had', async () => {
    policy.policy = { folders: [site], agentPaths: { 'claude-code': '/opt/claude' }, paused: true };
    await add({ path: '/Users/ana/work/other' });
    expect(policy.policy).toMatchObject({ agentPaths: { 'claude-code': '/opt/claude' }, paused: true });
    expect(labels()).toEqual(['site', 'other']);
  });

  it('is under the place the file system says, which is what is judged and what is kept, with the path as it was given beside it', async () => {
    resolver.answers.set('/Users/ana/link', '/srv/projects/real-site');
    const outcome = await add({ path: '/Users/ana/link' });
    expect(outcome).toMatchObject({ folder: { label: 'real-site', path: '/Users/ana/link', realPath: '/srv/projects/real-site' } });
  });

  it('is asked about with “your AI member” when the machine is not paired and there is no AI member to name', async () => {
    await add({}, null);
    expect(asked[0]?.aiMember).toBe('your AI member');
  });

  describe('is refused, with words, and nothing is asked or kept', () => {
    it.each([
      ['a folder that is not there', '/Users/ana/nowhere', undefined, /no folder at that path/],
      ['home itself', '/Users/ana', undefined, /home folder.*choose a folder inside it/],
      ['a folder that holds home', '/Users', undefined, /holds your home folder/],
      ['the whole disk', '/', undefined, /whole disk/],
      ['the runner’s own settings', '/Users/ana/Library/Application Support/escritoriio-runner', undefined, /settings and token/],
      ['a link that leads to home', '/Users/ana/work/link-home', '/Users/ana', /home folder/],
      ['a way back out to home, through dots', '/Users/ana/work/../..', undefined, /holds your home folder/],
      ['the keys of ssh', '/Users/ana/.ssh', undefined, /where credentials are kept/],
      ['a link that leads to the login of a cloud', '/Users/ana/work/link-aws', '/Users/ana/.aws', /where credentials are kept/],
      ['home reached through the data volume of macOS', '/System/Volumes/Data/Users/ana', undefined, /home folder/],
    ])('%s', async (_what, path, realPath, message) => {
      if (path === '/Users/ana/nowhere') resolver.answers.set(path, null);
      else if (realPath) resolver.answers.set(path, realPath);
      else resolver.answers.set(path, path.includes('..') ? '/Users' : path);
      await expect(add({ path })).rejects.toThrow(message);
      expect(asked).toEqual([]);
      expect(policy.policy).toEqual(EMPTY_POLICY);
    });

    it('a folder that is shared already, even by another way to it, and says as what', async () => {
      policy.policy = { ...EMPTY_POLICY, folders: [site] };
      resolver.answers.set('/Users/ana/link', '/Users/ana/work/site');
      await expect(add({ path: '/Users/ana/link' })).rejects.toThrow(/already shared as "site".*folders remove "site"/);
    });

    it('a label that is taken, whatever the case', async () => {
      policy.policy = { ...EMPTY_POLICY, folders: [site] };
      await expect(add({ path: '/Users/ana/work/other', label: 'SITE' })).rejects.toThrow(/folder called "SITE" already/);
    });

    it.each([
      ['a path', 'work/site', /not a path/],
      ['a line break', 'a\nb', /one plain line/],
      ['nothing', '', /cannot be empty/],
      ['too much', 'x'.repeat(RUNNER_LIMITS.folderLabel + 1), /at most 64/],
    ])('a label that is %s', async (_what, label, message) => {
      await expect(add({ label })).rejects.toThrow(message);
      expect(asked).toEqual([]);
    });


    it.each(['codex', 'kimi-code'] as const)('the coding agent %s, which this runner cannot drive yet, naming those it can', async (agent) => {
      await expect(add({ agent })).rejects.toThrow(`This runner cannot drive ${agent} yet. It can drive: claude-code.`);
      expect(asked).toEqual([]);
      expect(isolation.checked).toEqual([]);
    });

    it('a hundred and one folders', async () => {
      policy.policy = { ...EMPTY_POLICY, folders: Array.from({ length: RUNNER_LIMITS.folders }, (_, index) => ({ ...site, label: `f${index}`, realPath: `/srv/f${index}`, path: `/srv/f${index}` })) };
      await expect(add({ path: '/Users/ana/work/one-more' })).rejects.toThrow(/at most 100 folders/);
    });
  });

  it('gives a folder that has the name of another a number after it, when it was not given a label', async () => {
    policy.policy = { ...EMPTY_POLICY, folders: [site] };
    resolver.answers.set('/Users/ana/other/site', '/Users/ana/other/site');
    await add({ path: '/Users/ana/other/site' });
    expect(labels()).toEqual(['site', 'site-2']);
  });
});

describe('a folder that cannot be copied', () => {
  it('is refused, before anything is asked, with what a task would be refused with and the way to share it anyway', async () => {
    isolation.checkResult = 'That folder holds no git repository: put it under git (git init, then a first commit), or change the folder to work in place.';
    await expect(add({ access: 'edit' })).rejects.toThrow('That folder holds no git repository: put it under git (git init, then a first commit), or change the folder to work in place. To share it anyway, work on the folder itself: --isolation in-place.');
    expect(asked).toEqual([]);
    expect(policy.policy).toEqual(EMPTY_POLICY);
    expect(isolation.checked.map((folder) => folder.realPath)).toEqual(['/Users/ana/work/site']);
  });

  it('is refused for a folder that is only read as well: its task is worked in a copy too', async () => {
    isolation.checkResult = 'That repository has no commit yet.';
    await expect(add({ access: 'read-only' })).rejects.toThrow(/no commit yet/);
  });

  it('is shared when it is to be worked in place, which needs no copy', async () => {
    isolation.checkResult = 'That folder holds no git repository.';
    expect(await add({ isolation: 'in-place' })).toMatchObject({ added: true });
    expect(isolation.checked).toEqual([]);
  });

  it('is shared when a copy can be made of it, and the question is about the folder as it would be kept', async () => {
    await add({ access: 'edit', label: 'docs' });
    expect(isolation.checked).toHaveLength(1);
    expect(isolation.checked[0]).toMatchObject({ label: 'docs', realPath: '/Users/ana/work/site', isolation: 'worktree' });
    expect(labels()).toEqual(['docs']);
  });
});

describe('what the person changed while they were asked', () => {
  /** The owner pauses the machine in another terminal while this one waits for their answer. */
  const pauseWhileAsking = (question: FolderQuestion): Promise<boolean> => {
    asked.push(question);
    policy.policy = { ...policy.policy, paused: true };
    return Promise.resolve(true);
  };

  it('is kept: a machine that was paused meanwhile is still paused once the folder is shared', async () => {
    const outcome = await addFolder(deps(), request, 'Robo', pauseWhileAsking);
    expect(outcome).toMatchObject({ added: true });
    expect(policy.policy.paused).toBe(true);
    expect(labels()).toEqual(['site']);
  });

  it('is kept with the folders that were shared meanwhile, which the sharing is added to', async () => {
    const other: AllowedFolder = { ...site, label: 'api', path: '/srv/api', realPath: '/srv/api' };
    await addFolder(deps(), request, 'Robo', (question) => {
      asked.push(question);
      policy.policy = { ...policy.policy, folders: [other] };
      return Promise.resolve(true);
    });
    expect(labels()).toEqual(['api', 'site']);
  });

  it('is not a reason to share what is not allowed any more: a folder shared meanwhile under the label this one was to have is refused, with words', async () => {
    const taken: AllowedFolder = { ...site, label: 'site', path: '/srv/other-site', realPath: '/srv/other-site' };
    await expect(
      addFolder(deps(), request, 'Robo', () => {
        policy.policy = { ...policy.policy, folders: [taken] };
        return Promise.resolve(true);
      }),
    ).rejects.toThrow('There is a folder called "site" already. Choose another label with --label.');
    expect(labels()).toEqual(['site']);
    expect(policy.policy.folders[0]?.realPath).toBe('/srv/other-site');
  });

  it('is not a reason to share the same folder twice: the folder was shared meanwhile by another command', async () => {
    await expect(
      addFolder(deps(), request, 'Robo', () => {
        policy.policy = { ...policy.policy, folders: [{ ...site, label: 'other-name' }] };
        return Promise.resolve(true);
      }),
    ).rejects.toThrow(/already shared as "other-name"/);
    expect(labels()).toEqual(['other-name']);
  });

  it('is not a reason to share a hundred and one folders', async () => {
    await expect(
      addFolder(deps(), request, 'Robo', () => {
        policy.policy = { ...policy.policy, folders: Array.from({ length: RUNNER_LIMITS.folders }, (_, index) => ({ ...site, label: `f${index}`, realPath: `/srv/f${index}`, path: `/srv/f${index}` })) };
        return Promise.resolve(true);
      }),
    ).rejects.toThrow(/at most 100 folders/);
  });
});

describe('what the choice is said to mean', () => {
  const folder: AllowedFolder = { ...site, access: 'edit', approval: 'auto', isolation: 'worktree', trusted: false, agent: null };
  const said = (overrides: Partial<AllowedFolder> = {}, aiMember = 'Robo'): string => describeFolderChoice({ folder: { ...folder, ...overrides }, aiMember }).join('\n');

  it('says for edit with no questions, in a copy, in the words that a person can weigh', () => {
    const text = said();
    expect(text).toContain('Requests from you to Robo will have a coding agent read and change the files in /Users/ana/work/site without asking each time, in a copy of the files on a branch of its own');
    expect(text).toContain('for at most 30 minutes each');
    expect(text).toContain('Nothing is pushed');
    expect(text).toContain('the files you have in the folder are not touched');
    expect(text).toContain('Each runner that is running does one task at a time');
    expect(text).toContain('this machine cannot tell who wrote it');
    expect(text).toContain('Whatever the office says, this machine checks for every task that the folder is still shared and where it was');
    expect(text).toContain('that the machine is not paused');
    expect(text).toContain('escritoriio-runner pause');
    expect(text).toContain('escritoriio-runner folders remove "site"');
    expect(text).toContain('It is not trusted');
  });

  it('shows the choice itself as it is kept', () => {
    expect(said({ agent: 'claude-code' }).split('\n').slice(0, 6)).toEqual([
      'Folder "site": /Users/ana/work/site',
      '  access:     edit',
      '  approval:   auto',
      '  isolation:  worktree',
      '  trusted:    no',
      '  agent:      claude-code',
    ]);
  });

  it('says that each task waits for its owner when the folder asks', () => {
    expect(said({ approval: 'ask' })).toContain('only after you approve each one on this machine, with the exact text in front of you');
    expect(said({ approval: 'ask' })).not.toContain('without asking each time');
  });

  it('says that a read-only folder is read and not changed, and that nothing is run in it', () => {
    const text = said({ access: 'read-only' });
    expect(text).toContain('will have a coding agent read the files in /Users/ana/work/site');
    expect(text).toContain('It is not allowed to change any, and it runs nothing.');
    expect(text).not.toContain('Nothing is pushed');
    expect(text).not.toContain('sandbox');
  });

  it('says that edit gives the coding agent file tools and a shell, which runs in the sandbox of the system and reads the rest of the machine', () => {
    const text = said({ access: 'edit' });
    expect(text).toContain('read and change the files in /Users/ana/work/site');
    expect(text).toContain('It is given file tools and a shell, so it can run commands as well.');
    expect(text).toContain('it writes only in the work folder and in a temporary folder of its own, has no network and cannot read the places where credentials are kept (such as ~/.ssh), but it can read the rest of this machine.');
    expect(text).toContain('Windows has no such sandbox: nothing contains the commands there, and a folder is edited only if you trusted it.');
    expect(text).not.toContain('It can run nothing');
  });

  it('says that the file tools are outside the sandbox, and that a command can swap a link under the check of their paths', () => {
    const text = said({ access: 'edit' });
    expect(text).toContain('The file tools are not inside that sandbox.');
    expect(text).toContain('a command can swap a link inside the folder before the tool uses the path');
    expect(text).toContain('may, in some cases the check cannot catch, read or write a file outside the folder');
  });

  it('says what working in place is: no copy, no branch, the person’s own files', () => {
    const text = said({ isolation: 'in-place' });
    expect(text).toContain('on the files in the folder themselves, with no copy and no branch');
    expect(text).toContain('mixed with whatever you had not committed');
    expect(text).not.toContain('Nothing is pushed');
    expect(text).not.toContain('must be inside a git repository');
  });

  it('says what a trusted folder allows beyond the others', () => {
    const text = said({ trusted: true });
    expect(text).toContain('It is trusted');
    expect(text).toContain('everything your user account can reach');
    expect(text).not.toContain('It is not trusted');
  });

  it('says that the folder must be in a repository when the work is done in a copy', () => {
    expect(said()).toContain('must be inside a git repository that has a commit');
  });

  it('says where the folder really is when that is not where the person put it', () => {
    expect(said({ path: '/Users/ana/link' }).split('\n')[0]).toBe('Folder "site": /Users/ana/link (really /Users/ana/work/site)');
  });
});

describe('stopping sharing a folder', () => {
  beforeEach(() => {
    policy.policy = { ...EMPTY_POLICY, folders: [site, { ...site, label: 'api', path: '/srv/api', realPath: '/srv/api' }], paused: true };
  });

  it('takes it off the list and leaves the rest as it was', async () => {
    expect(await removeFolder({ policy }, 'site')).toMatchObject({ label: 'site' });
    expect(labels()).toEqual(['api']);
    expect(policy.policy.paused).toBe(true);
  });

  it('takes the folder that is called so even when the person wrote it in another case', async () => {
    await removeFolder({ policy }, 'API');
    expect(labels()).toEqual(['site']);
  });

  it('says which folders there are when there is none by that name, without showing what the person typed raw', async () => {
    await expect(removeFolder({ policy }, 'nope\u001b[2J')).rejects.toThrow('No folder is shared as "nope [2J". Shared: "site", "api".');
    expect(labels()).toEqual(['site', 'api']);
  });

  it('says so when nothing is shared at all', async () => {
    policy.policy = EMPTY_POLICY;
    await expect(removeFolder({ policy }, 'site')).rejects.toThrow(/None is shared yet/);
  });
});

describe('the folders that are shared', () => {
  it('say how to share one when there is none', async () => {
    expect(await describeFolders(deps())).toEqual(['No folder is shared yet. Share one with: escritoriio-runner folders add <path>']);
  });

  it('are listed with what was chosen and whether each is still where it was', async () => {
    const moved: AllowedFolder = { ...site, label: 'moved', path: '/Users/ana/work/moved', realPath: '/Users/ana/work/moved' };
    const gone: AllowedFolder = { ...site, label: 'gone', path: '/Users/ana/work/gone', realPath: '/Users/ana/work/gone', agent: 'claude-code', trusted: true, access: 'read-only', approval: 'ask', isolation: 'in-place' };
    policy.policy = { ...EMPTY_POLICY, folders: [site, moved, gone] };
    resolver.answers.set('/Users/ana/work/moved', '/Users/ana/work/elsewhere');
    resolver.answers.set('/Users/ana/work/gone', null);
    expect(await describeFolders(deps())).toEqual([
      'site: /Users/ana/work/site',
      '  access: edit, approval: auto, isolation: worktree, trusted: no, agent: any',
      '  It is where it was when it was shared.',
      'moved: /Users/ana/work/moved',
      '  access: edit, approval: auto, isolation: worktree, trusted: no, agent: any',
      '  The folder is not where it was when it was allowed: it was moved, or a link now leads elsewhere. Allow it again to confirm it is the one you mean.',
      'gone: /Users/ana/work/gone',
      '  access: read-only, approval: ask, isolation: in-place, trusted: yes, agent: claude-code',
      '  The folder is not there any more.',
    ]);
  });
});

describe('changing how a folder is shared', () => {
  const change = (changes: Parameters<typeof updateFolder>[2], label = 'site') => updateFolder(deps(), label, changes, 'Robo', confirm);

  beforeEach(() => {
    policy.policy = { ...EMPTY_POLICY, folders: [site, { ...site, label: 'blog', path: '/Users/ana/work/blog', realPath: '/Users/ana/work/blog' }] };
  });

  it('keeps what the person changed, after asking about the folder as it would be, and leaves the rest alone', async () => {
    const outcome = await change({ approval: 'ask', trusted: true });
    expect(outcome).toEqual({ updated: true, folder: { ...site, approval: 'ask', trusted: true } });
    expect(policy.policy.folders).toEqual([{ ...site, approval: 'ask', trusted: true }, expect.objectContaining({ label: 'blog' })]);
    expect(asked).toEqual([{ folder: { ...site, approval: 'ask', trusted: true }, aiMember: 'Robo' }]);
  });

  it('finds the folder by a label that differs only in case, as the commands do', async () => {
    await change({ access: 'read-only' }, 'SITE');
    expect(policy.policy.folders[0]).toMatchObject({ label: 'site', access: 'read-only' });
  });

  it('keeps nothing when the person says no', async () => {
    answer = false;
    expect(await change({ access: 'read-only' })).toEqual({ updated: false });
    expect(policy.writes).toBe(0);
  });

  it('says so, and asks nothing, when it is shared that way already', async () => {
    await expect(change({ access: 'edit', approval: 'auto' })).rejects.toThrow('"site" is shared that way already.');
    expect(asked).toEqual([]);
  });

  it('says which folders there are when none has that label', async () => {
    await expect(change({ access: 'read-only' }, 'nowhere')).rejects.toThrow('No folder is shared as "nowhere". Shared: "site", "blog".');
  });

  it('refuses a coding agent this runner cannot drive, as sharing a folder does', async () => {
    await expect(change({ agent: 'codex' })).rejects.toThrow('This runner cannot drive codex yet.');
    expect(asked).toEqual([]);
  });

  it('refuses a folder that is not where it was, whatever is asked for, with the words of its own', async () => {
    resolver.answers.set(site.path, null);
    await expect(change({ access: 'read-only' })).rejects.toThrow('The folder is not there any more.');
    expect(asked).toEqual([]);
  });

  it('asks whether a copy can be made only when the folder is going to be worked in one', async () => {
    isolation.checkResult = 'That folder holds no git repository.';
    await change({ trusted: true });
    expect(isolation.checked).toEqual([]);
    policy.policy = { ...policy.policy, folders: [{ ...site, isolation: 'in-place' }] };
    await expect(change({ isolation: 'worktree' })).rejects.toThrow(/holds no git repository\. To share it anyway/);
  });

  it('is kept on the settings as they are when it is kept, not as they were when the person was asked', async () => {
    const taking = (question: FolderQuestion): Promise<boolean> => {
      asked.push(question);
      policy.policy = { ...policy.policy, paused: true };
      return Promise.resolve(true);
    };
    await updateFolder(deps(), 'site', { access: 'read-only' }, 'Robo', taking);
    expect(policy.policy.paused).toBe(true);
    expect(policy.policy.folders[0]).toMatchObject({ access: 'read-only' });
  });

  it('refuses when the folder was taken away while the person was asked', async () => {
    const taking = (): Promise<boolean> => {
      policy.policy = { ...policy.policy, folders: [] };
      return Promise.resolve(true);
    };
    await expect(updateFolder(deps(), 'site', { access: 'read-only' }, 'Robo', taking)).rejects.toThrow('No folder is shared as "site".');
  });
});

describe('looking at the folders that are shared', () => {
  it('gives each folder with what is wrong with it now, in words, and nothing for one that is as it was', async () => {
    policy.policy = { ...EMPTY_POLICY, folders: [site, { ...site, label: 'gone', path: '/Users/ana/work/gone', realPath: '/Users/ana/work/gone' }] };
    resolver.answers.set('/Users/ana/work/gone', null);
    expect(await inspectFolders(deps())).toEqual([
      { folder: site, problem: undefined },
      { folder: expect.objectContaining({ label: 'gone' }), problem: 'The folder is not there any more.' },
    ]);
  });
});

describe('making a workspace', () => {
  let ops: FakeWorkspaceOps;
  beforeEach(() => {
    ops = new FakeWorkspaceOps();
    // The fake file system has every path, unless it is told there is none: nothing is where a workspace is about to be made.
    for (const target of ['/Users/ana/work/build', '/Users/ana/work/other', '/Users/ana/work/Robo’s desk', '/srv/projects/build']) resolver.answers.set(target, null);
  });

  const workspaceRequest: NewWorkspace = { parent: '/Users/ana/work', name: 'build', label: undefined, approval: 'auto', trusted: false, agent: null };
  const wsDeps = () => ({ ...deps(), workspace: ops });
  const make = (overrides: Partial<NewWorkspace> = {}, aiMember: string | null = 'Robo') => createWorkspace(wsDeps(), { ...workspaceRequest, ...overrides }, aiMember ?? undefined, confirm);

  it('makes the empty folder in the parent and shares it as a workspace, edited in place, after the person is asked', async () => {
    const outcome = await make();
    expect(outcome).toEqual({
      added: true,
      folder: { label: 'build', path: '/Users/ana/work/build', realPath: '/Users/ana/work/build', access: 'edit', approval: 'auto', isolation: 'in-place', trusted: false, agent: null, kind: 'workspace' },
    });
    expect(policy.policy.folders).toEqual([(outcome as { folder: AllowedFolder }).folder]);
    expect(ops.calls).toEqual(['make build']);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.folder.kind).toBe('workspace');
    expect(asked[0]?.aiMember).toBe('Robo');
  });

  it('asks before anything is made, and makes and keeps nothing when the person says no', async () => {
    answer = false;
    expect(await make()).toEqual({ added: false });
    expect(ops.calls).toEqual([]);
    expect(policy.policy).toEqual(EMPTY_POLICY);
  });

  it('is called as the person says, or after the folder', async () => {
    expect(await make({ label: 'Robo’s desk' })).toMatchObject({ folder: { label: 'Robo’s desk' } });
    policy.policy = { ...EMPTY_POLICY };
    ops = new FakeWorkspaceOps();
    expect(await make({ name: 'other' })).toMatchObject({ folder: { label: 'other' } });
  });

  it('is shared as the person chose for the approval, the trust and the coding agent, and never read only or in a copy', async () => {
    const outcome = await make({ approval: 'ask', trusted: true, agent: 'claude-code' });
    expect(outcome).toMatchObject({ folder: { approval: 'ask', trusted: true, agent: 'claude-code', access: 'edit', isolation: 'in-place' } });
  });

  it.each([
    ['', /cannot be empty/],
    ['../x', /one name and not a path/],
    ['a/b', /one name and not a path/],
    ['.git', /begin with a dot/],
    ['CON', /Windows/],
    ['bad\u{202E}name', /hide or reorder/],
  ])('refuses the name %j, with the words of the rule, before anything is asked', async (name, words) => {
    await expect(make({ name })).rejects.toThrow(words);
    expect(asked).toEqual([]);
    expect(ops.calls).toEqual([]);
  });

  it.each([
    ['a parent that is not there', { parent: '/Users/ana/nowhere' }, /no folder at that path/],
    ['a coding agent this runner cannot drive', { agent: 'codex' as const }, /cannot drive codex/],
    ['a label with a slash', { label: 'a/b' }, /label is a name/],
  ])('refuses %s, with words, and asks and makes nothing', async (_what, overrides, words) => {
    resolver.answers.set('/Users/ana/nowhere', null);
    await expect(make(overrides)).rejects.toThrow(words);
    expect(asked).toEqual([]);
    expect(ops.calls).toEqual([]);
  });

  it.each([
    ['inside the keys of ssh', '/Users/ana/.ssh', /where credentials are kept/],
    ['inside the settings of the runner', '/Users/ana/Library/Application Support/escritoriio-runner', /runner’s own settings/],
    ['inside the copies of the runner', '/Users/ana/Library/Caches/escritoriio-runner/worktrees', /place where the runner makes its copies/],
    ['by a link that leads into the keys of ssh', '/Users/ana/work/link', /where credentials are kept/],
  ])('refuses a workspace %s, as sharing a folder does, and makes nothing', async (_what, parent, words) => {
    resolver.answers.set('/Users/ana/work/link', '/Users/ana/.aws');
    await expect(make({ parent })).rejects.toThrow(words);
    expect(ops.calls).toEqual([]);
  });

  it('is made in the folder the file system says the parent really is in, links followed', async () => {
    resolver.answers.set('/Users/ana/link', '/srv/projects');
    const outcome = await make({ parent: '/Users/ana/link' });
    expect(outcome).toMatchObject({ folder: { path: '/srv/projects/build', realPath: '/srv/projects/build' } });
  });

  it('refuses a folder that is there already, whatever it is, and asks nothing', async () => {
    resolver.answers.delete('/Users/ana/work/build');
    await expect(make()).rejects.toThrow(/already/);
    expect(asked).toEqual([]);
    // Or something that is not a folder, which only the making finds out.
    resolver.answers.set('/Users/ana/work/build', null);
    ops.made = 'exists';
    await expect(make()).rejects.toThrow(/already/);
    expect(policy.policy).toEqual(EMPTY_POLICY);
  });

  it('refuses, with words, when the parent is not where it was by the time the folder is made, and keeps nothing', async () => {
    ops.made = 'moved';
    await expect(make()).rejects.toThrow(/not where it was/);
    expect(policy.policy).toEqual(EMPTY_POLICY);
  });

  it('refuses a label or a folder that is shared already, before asking', async () => {
    policy.policy = { ...EMPTY_POLICY, folders: [{ ...site, label: 'Build' }] };
    await expect(make({ label: 'build' })).rejects.toThrow(/called "build" already/);
    expect(ops.calls).toEqual([]);
    // Without a label of its own it is numbered, as any shared folder is.
    expect(await make()).toMatchObject({ folder: { label: 'build-2' } });
  });

  it('takes the folder away again when what is kept turns out to be refused after the person said yes', async () => {
    const original = policy.update.bind(policy);
    policy.update = (change) => {
      policy.policy = { ...policy.policy, folders: [{ ...site, label: 'BUILD', path: '/x', realPath: '/x' }] };
      return original(change);
    };
    await expect(make({ label: 'build' })).rejects.toThrow(/called "build" already/);
    expect(ops.calls).toEqual(['make build', 'discard build']);
  });

  it('says what a workspace means: in place, folders made without asking, and each clone approved one by one', async () => {
    await make();
    const words = describeFolderChoice(asked[0] as FolderQuestion).join('\n');
    expect(words).toMatch(/IN PLACE/);
    expect(words).toMatch(/create folders inside the workspace without asking/);
    expect(words).toMatch(/ask to clone git repositories.*approve each clone one by one/);
    expect(words).toMatch(/removes the hooks and settings that run programs that the task added/);
    expect(words).toMatch(/never shared separately/);
    expect(words).toMatch(/Workspace "build"/);
  });
});

describe('what an in-place share says of git settings', () => {
  it('says in one line that what a task adds and would run programs is removed, and what the owner had is left, for a folder worked in place', () => {
    const folder: AllowedFolder = { ...site, isolation: 'in-place', access: 'edit' };
    const lines = describeFolderChoice({ folder, aiMember: 'Robo' }).filter((line) => line.includes('Git hooks and settings'));
    expect(lines).toEqual([SETTINGS_REMOVED_LINE]);
    expect(describeFolderChoice({ folder: { ...site, isolation: 'worktree' }, aiMember: 'Robo' }).join('\n')).not.toContain('Git hooks and settings');
  });
});

describe('a workspace that is shared', () => {
  const workspace: AllowedFolder = { label: 'build', path: '/Users/ana/work/build', realPath: '/Users/ana/work/build', access: 'edit', approval: 'auto', isolation: 'in-place', trusted: false, agent: null, kind: 'workspace' };
  beforeEach(() => {
    policy.policy = { ...EMPTY_POLICY, folders: [workspace] };
  });

  it.each([{ access: 'read-only' as const }, { isolation: 'worktree' as const }])('cannot be changed to %j: it is edited in place and nothing else', async (changes) => {
    await expect(updateFolder(deps(), 'build', changes, 'Robo', confirm)).rejects.toThrow(/always edited in place/);
    expect(asked).toEqual([]);
    expect(policy.policy.folders[0]).toEqual(workspace);
  });

  it('can have its approval, trust and coding agent changed, and stays a workspace', async () => {
    const outcome = await updateFolder(deps(), 'build', { approval: 'ask', trusted: true }, 'Robo', confirm);
    expect(outcome).toMatchObject({ updated: true, folder: { kind: 'workspace', approval: 'ask', trusted: true, access: 'edit', isolation: 'in-place' } });
  });

  it('is told of in the list as a workspace', async () => {
    expect((await describeFolders(deps())).join('\n')).toMatch(/build: \/Users\/ana\/work\/build \(workspace\)/);
  });
});

describe('sharing a folder is never making a workspace', () => {
  it('keeps a plain folder, whatever it is called or where it is', async () => {
    await addFolder(deps(), { ...request, path: '/Users/ana/work/workspace' }, 'Robo', confirm);
    expect(policy.policy.folders[0]?.kind).toBeUndefined();
  });
});
