import type { FolderQuestion } from '@escritoriio/runner';
import { describe, expect, it } from 'vitest';
import { describeFolderForDialog } from './folder-words.ts';

const base: FolderQuestion = {
  aiMember: 'Ana',
  folder: { label: 'site', path: '/Users/me/site', realPath: '/Users/me/site', access: 'read-only', approval: 'ask', isolation: 'worktree', trusted: false, agent: null },
};
const withFolder = (changes: Partial<FolderQuestion['folder']>): FolderQuestion => ({ ...base, folder: { ...base.folder, ...changes } });
const words = (question: FolderQuestion, platform: NodeJS.Platform = 'darwin') => describeFolderForDialog(question, platform).join('\n');

describe('the folder question of the dialog', () => {
  it('names the folder, where it is, and where it really is when a link leads elsewhere', () => {
    expect(words(base)).toContain('Folder "site": /Users/me/site');
    expect(words(base)).not.toContain('really');
    expect(words(withFolder({ realPath: '/Volumes/disk/site' }))).toContain('really /Volumes/disk/site');
  });

  it('says that edit means file tools and a shell that can read the rest of the machine, and read only does not', () => {
    expect(words(withFolder({ access: 'edit' }))).toMatch(/file tools.*shell.*read the rest of this machine/);
    expect(words(base)).toMatch(/runs nothing/i);
    expect(words(base)).not.toMatch(/shell/);
  });

  it('says whether each task starts by itself or waits for the owner', () => {
    expect(words(withFolder({ approval: 'auto' }))).toMatch(/without asking/);
    expect(words(base)).toMatch(/approve each task/);
  });

  it('says whether it works on the files themselves or on a copy', () => {
    expect(words(withFolder({ isolation: 'in-place' }))).toMatch(/files themselves/);
    expect(words(base)).toMatch(/copy.*own branch.*nothing is pushed/i);
  });

  it('says in one line that what a task adds to git and would run programs is removed, for a folder worked in place and not for one worked in a copy', () => {
    expect(words(withFolder({ isolation: 'in-place' }))).toMatch(/Git hooks and settings that a task adds and that would run programs are removed after it/);
    expect(words(base)).not.toMatch(/Git hooks and settings/);
  });

  it('says what trusted widens, and only when it is trusted', () => {
    expect(words(withFolder({ trusted: true }))).toMatch(/no sandbox.*everything your user account can reach/);
    expect(words(base)).not.toMatch(/everything your user account can reach/);
  });

  it('says which coding agent, or that any can', () => {
    expect(words(withFolder({ agent: 'claude-code' }))).toContain('claude-code');
    expect(words(base)).toMatch(/first one that can run/);
  });

  it('says that nothing contains the commands on Windows', () => {
    expect(words(withFolder({ access: 'edit' }), 'win32')).toMatch(/no sandbox on this system/);
    expect(words(withFolder({ access: 'edit' }), 'darwin')).not.toMatch(/no sandbox on this system/);
  });

  it('says how to take it back in the words of the window, and not those of the command line', () => {
    expect(words(base)).toMatch(/Folders.*Remove/);
    expect(words(base)).not.toMatch(/escritoriio-runner|--/);
  });

  it('says what a working folder is: made for the agent, edited in place, folders without asking, clones one by one', () => {
    const workspace = withFolder({ kind: 'workspace', access: 'edit', isolation: 'in-place' });
    expect(words(workspace)).toMatch(/Working folder.*made empty.*works in place.*create folders inside without asking.*ask to clone repositories.*approve one by one/s);
    expect(words(base)).not.toMatch(/Working folder/);
    expect(words(withFolder({ kind: 'plain' }))).not.toMatch(/Working folder/);
    expect(words(workspace)).not.toMatch(/escritoriio-runner|--/);
  });

  it('is short: a line for each thing', () => {
    expect(describeFolderForDialog(withFolder({ kind: 'workspace', access: 'edit', trusted: true, isolation: 'in-place' }), 'darwin').length).toBeLessThanOrEqual(9);
    expect(describeFolderForDialog(withFolder({ access: 'edit', trusted: true, isolation: 'in-place' }), 'win32').length).toBeLessThanOrEqual(9);
  });
});
