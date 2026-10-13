// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FoldersScreen } from './FoldersScreen.tsx';
import type { Reply } from '../shared/channels.ts';
import { fakeApi, HOSTILE, renderWithRunner } from './testing.tsx';

afterEach(cleanup);

type Folder = Reply<'folders:list'>[number]['folder'];

const website: Folder = { label: 'website', path: '/home/me/website', realPath: '/home/me/website', access: 'read-only', approval: 'auto', isolation: 'worktree', trusted: false, agent: null };
const views = (...folders: Folder[]) => folders.map((folder) => ({ folder }));
const api = (...folders: Folder[]) => fakeApi({ 'folders:list': views(...folders) });

describe('the folders', () => {
  it('says what sharing a folder is, when none is', async () => {
    renderWithRunner(<FoldersScreen />, api());
    expect(await screen.findByText(/No folder is shared yet/)).toBeTruthy();
  });

  it('lists each folder with its access, approval, isolation, trust and agent, in words', async () => {
    renderWithRunner(<FoldersScreen />, fakeApi({ 'folders:list': views(website, { ...website, label: 'api', access: 'edit', approval: 'ask', isolation: 'in-place', trusted: true, agent: 'claude-code' }) }));
    const list = await screen.findByRole('list', { name: 'Shared folders' });
    const [first, second] = Array.from(list.children);
    expect(first!.textContent).toContain('Read only');
    expect(first!.textContent).toContain('Runs without asking');
    expect(first!.textContent).toContain('A copy on its own branch');
    expect(first!.textContent).toContain('Not trusted');
    expect(first!.textContent).toContain('Any coding agent');
    expect(second!.textContent).toContain('Edit');
    expect(second!.textContent).toContain('Asks you first');
    expect(second!.textContent).toContain('In place');
    expect(second!.textContent).toContain('Trusted');
    expect(second!.textContent).toContain('Claude Code');
  });

  it('shows what is wrong with a folder', async () => {
    renderWithRunner(<FoldersScreen />, fakeApi({ 'folders:list': [{ folder: website, problem: 'The folder moved.' }] }));
    expect(await screen.findByText('The folder moved.')).toBeTruthy();
  });

  it('adds a folder with the options chosen and never a path: the system picker chooses it', async () => {
    const fake = fakeApi({ 'folders:list': [], 'folders:add': { added: true, label: 'notes' } });
    renderWithRunner(<FoldersScreen />, fake);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a folder' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Ask me first' }));
    fireEvent.click(screen.getByRole('radio', { name: 'In place' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Trusted/ }));
    fireEvent.change(screen.getByLabelText('Name in the office (optional)'), { target: { value: 'notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose the folder…' }));
    await waitFor(() => expect(fake.requests('folders:add')).toEqual([{ label: 'notes', access: 'edit', approval: 'ask', isolation: 'in-place', trusted: true, agent: null }]));
    expect(await screen.findByText('Shared "notes".')).toBeTruthy();
  });

  it('starts from the narrowest choices', async () => {
    const fake = fakeApi({ 'folders:list': [], 'folders:add': { added: false, message: 'No folder was chosen.' } });
    renderWithRunner(<FoldersScreen />, fake);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a folder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose the folder…' }));
    expect(await screen.findByText('No folder was chosen.')).toBeTruthy();
    expect(fake.requests('folders:add')).toEqual([{ access: 'read-only', approval: 'auto', isolation: 'worktree', trusted: false, agent: null }]);
  });

  it('says in one short line what each option does, and keeps what widens the machine in view', async () => {
    renderWithRunner(<FoldersScreen />, api());
    fireEvent.click(await screen.findByRole('button', { name: 'Add a folder' }));
    const visibleText = (root: HTMLElement) => Array.from(root.querySelectorAll('p.hint')).map((line) => line.textContent ?? '').join('\n');
    const form = screen.getByRole('form', { name: 'Share a folder' });
    expect(visibleText(form)).toMatch(/runs commands, and the shell can read the rest of this machine/);
    expect(visibleText(form)).toMatch(/Works on the files themselves/);
    expect(visibleText(form)).toMatch(/Lets an agent with no sandbox run here, with all your account can reach/);
    expect(screen.getByRole('radio', { name: 'Edit' }).getAttribute('aria-describedby')).toBeTruthy();
  });

  it('puts the longer explanations behind (i) buttons that are closed until pressed', async () => {
    renderWithRunner(<FoldersScreen />, api());
    fireEvent.click(await screen.findByRole('button', { name: 'Add a folder' }));
    const tips = screen.getAllByRole('button', { name: /^More about / });
    expect(tips.map((tip) => tip.getAttribute('aria-label'))).toEqual(['More about shared folders', 'More about edit', 'More about ask me first', 'More about a copy on its own branch', 'More about in place', 'More about trusted', 'More about the question']);
    expect(tips.every((tip) => tip.getAttribute('aria-expanded') === 'false')).toBe(true);
    const edit = tips[1]!;
    const words = () => document.getElementById(edit.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(words().hidden).toBe(true);
    fireEvent.click(edit);
    expect(words().hidden).toBe(false);
    expect(words().textContent).toMatch(/file tools and a shell/);
    expect(words().textContent).toMatch(/not inside that sandbox/);
    fireEvent.click(screen.getByRole('button', { name: 'More about trusted' }));
    expect((document.getElementById(screen.getByRole('button', { name: 'More about trusted' }).getAttribute('aria-controls') ?? '') as HTMLElement).textContent).toMatch(/cannot be contained on this system/);
  });

  it('changes only what was changed', async () => {
    const fake = fakeApi({ 'folders:list': views(website), 'folders:update': { updated: true } });
    renderWithRunner(<FoldersScreen />, fake);
    fireEvent.click(await screen.findByRole('button', { name: 'Change options' }));
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/only a yes keeps it/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Ask me first' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(fake.requests('folders:update')).toEqual([{ label: 'website', changes: { approval: 'ask' } }]));
  });

  it('removes after asking, by name', async () => {
    const fake = fakeApi({ 'folders:list': views(website), 'folders:remove': { label: 'website' } });
    renderWithRunner(<FoldersScreen />, fake);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(fake.requests('folders:remove')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, stop sharing' }));
    await waitFor(() => expect(fake.requests('folders:remove')).toEqual([{ label: 'website' }]));
  });

  it('shows hostile names as text only', async () => {
    const { container } = renderWithRunner(<FoldersScreen />, fakeApi({ 'folders:list': [{ folder: { ...website, label: HOSTILE.markup, path: HOSTILE.link }, problem: HOSTILE.rtl }] }));
    await screen.findByRole('list', { name: 'Shared folders' });
    expect(container.querySelector('img, script, a')).toBeNull();
    expect(container.textContent).toContain('‹U+202E›');
  });

  it('says in words when the list cannot be read', async () => {
    renderWithRunner(<FoldersScreen />, fakeApi({
      'folders:list': () => {
        throw new Error('The folders could not be read.');
      },
    }));
    expect((await screen.findByRole('alert')).textContent).toBe('The folders could not be read.');
  });

  describe('working folders', () => {
    const workspace: Folder = { ...website, label: 'build', path: '/home/me/build', realPath: '/home/me/build', access: 'edit', approval: 'ask', isolation: 'in-place', kind: 'workspace' };

    it('marks a working folder, and says in one line what the agent may do in it', async () => {
      renderWithRunner(<FoldersScreen />, api(website, workspace));
      const list = await screen.findByRole('list', { name: 'Shared folders' });
      const [plain, made] = Array.from(list.children);
      expect(plain!.textContent).not.toContain('Working folder');
      expect(made!.textContent).toContain('Working folder');
      expect(made!.textContent).toMatch(/may create folders in it and ask to clone repositories, which you approve one by one/);
      expect(made!.textContent).toContain('Edit');
      expect(made!.textContent).toContain('In place');
    });

    it('makes a new empty working folder with a name and the choices, and never a path: the system picker chooses where', async () => {
      const fake = fakeApi({ 'folders:list': [], 'folders:new-workspace': { added: true, label: 'build' } });
      renderWithRunner(<FoldersScreen />, fake);
      fireEvent.click(await screen.findByRole('button', { name: 'New empty working folder' }));
      const form = screen.getByRole('form', { name: 'New empty working folder' });
      expect(within(form).queryByRole('radio', { name: 'Read only' })).toBeNull();
      expect(within(form).queryByRole('radio', { name: 'A copy on its own branch' })).toBeNull();
      expect(form.textContent).toMatch(/always edited in place/);
      fireEvent.change(within(form).getByLabelText('Name of the new folder'), { target: { value: 'build' } });
      fireEvent.click(within(form).getByRole('radio', { name: 'Run what the office asks' }));
      fireEvent.click(within(form).getByRole('checkbox', { name: /Trusted/ }));
      fireEvent.click(within(form).getByRole('button', { name: 'Choose where to make it…' }));
      await waitFor(() => expect(fake.requests('folders:new-workspace')).toEqual([{ name: 'build', approval: 'auto', trusted: true, agent: null }]));
      expect(await screen.findByText('Made and shared "build".')).toBeTruthy();
    });

    it('starts from asking first, needs a name, and sends the name in the office only when one is typed', async () => {
      const fake = fakeApi({ 'folders:list': [], 'folders:new-workspace': { added: false, message: 'No folder was chosen.' } });
      renderWithRunner(<FoldersScreen />, fake);
      fireEvent.click(await screen.findByRole('button', { name: 'New empty working folder' }));
      const form = screen.getByRole('form', { name: 'New empty working folder' });
      const submit = within(form).getByRole('button', { name: 'Choose where to make it…' }) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
      expect((within(form).getByRole('radio', { name: 'Ask me first' }) as HTMLInputElement).checked).toBe(true);
      fireEvent.change(within(form).getByLabelText('Name of the new folder'), { target: { value: 'build' } });
      fireEvent.change(within(form).getByLabelText('Name in the office (optional)'), { target: { value: 'Builder' } });
      fireEvent.click(submit);
      expect(await screen.findByText('No folder was chosen.')).toBeTruthy();
      expect(fake.requests('folders:new-workspace')).toEqual([{ name: 'build', label: 'Builder', approval: 'ask', trusted: false, agent: null }]);
    });

    it('says in the runner’s own words why a folder was not made', async () => {
      const fake = fakeApi({
        'folders:list': [],
        'folders:new-workspace': () => {
          throw new Error('There is a folder or a file with that name there already: choose another name, or another folder to make it in.');
        },
      });
      renderWithRunner(<FoldersScreen />, fake);
      fireEvent.click(await screen.findByRole('button', { name: 'New empty working folder' }));
      fireEvent.change(screen.getByLabelText('Name of the new folder'), { target: { value: 'build' } });
      fireEvent.click(screen.getByRole('button', { name: 'Choose where to make it…' }));
      expect((await screen.findByRole('alert')).textContent).toMatch(/there already/);
    });

    it('explains the working folder behind an (i) button', async () => {
      renderWithRunner(<FoldersScreen />, api());
      fireEvent.click(await screen.findByRole('button', { name: 'New empty working folder' }));
      const tip = screen.getByRole('button', { name: 'More about the working folder' });
      expect(tip.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(tip);
      const words = document.getElementById(tip.getAttribute('aria-controls') ?? '') as HTMLElement;
      expect(words.hidden).toBe(false);
      expect(words.textContent).toMatch(/builds in it with no copy and no branch/);
      expect(words.textContent).toMatch(/Approvals/);
    });

    it('offers a working folder only the options that can change: not access, not where it works', async () => {
      const fake = fakeApi({ 'folders:list': views(workspace), 'folders:update': { updated: true } });
      renderWithRunner(<FoldersScreen />, fake);
      fireEvent.click(await screen.findByRole('button', { name: 'Change options' }));
      const form = screen.getByRole('form', { name: 'Options of build' });
      expect(within(form).queryByRole('radio', { name: 'Read only' })).toBeNull();
      expect(within(form).queryByRole('radio', { name: 'A copy on its own branch' })).toBeNull();
      fireEvent.click(within(form).getByRole('radio', { name: 'Run what the office asks' }));
      fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(fake.requests('folders:update')).toEqual([{ label: 'build', changes: { approval: 'auto' } }]));
    });

    it('shows the words of the runner when it refuses a change', async () => {
      const fake = fakeApi({
        'folders:list': views(workspace),
        'folders:update': () => {
          throw new Error('A workspace is always edited in place: its access and its isolation cannot be changed.');
        },
      });
      renderWithRunner(<FoldersScreen />, fake);
      fireEvent.click(await screen.findByRole('button', { name: 'Change options' }));
      fireEvent.click(screen.getByRole('radio', { name: 'Run what the office asks' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      expect((await screen.findByRole('alert')).textContent).toMatch(/always edited in place/);
    });

    it('shows hostile names of a working folder as text only', async () => {
      const { container } = renderWithRunner(<FoldersScreen />, fakeApi({ 'folders:list': [{ folder: { ...workspace, label: HOSTILE.markup, path: HOSTILE.link } }] }));
      await screen.findByRole('list', { name: 'Shared folders' });
      expect(container.querySelector('img, script, a')).toBeNull();
    });
  });
});
