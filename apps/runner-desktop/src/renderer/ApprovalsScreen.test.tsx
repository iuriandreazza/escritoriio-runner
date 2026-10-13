// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalsScreen } from './ApprovalsScreen.tsx';
import { fakeApi, HOSTILE, renderWithRunner } from './testing.tsx';

afterEach(cleanup);

const pending = { askId: 'ask-1', taskId: 'task-1', folder: 'website', access: 'edit', instruction: 'Change the title of the home page to "Hello".\nThen run the tests.' } as const;

describe('the approvals', () => {
  it('says nothing waits, when nothing waits', async () => {
    renderWithRunner(<ApprovalsScreen />);
    expect(await screen.findByText('Nothing is waiting for you.')).toBeTruthy();
  });

  it('shows the whole instruction, the folder and what the access means', async () => {
    renderWithRunner(<ApprovalsScreen />, fakeApi({ 'approvals:list': [pending] }));
    const item = (await screen.findAllByRole('listitem'))[0]!;
    expect(item.textContent).toContain('website');
    expect(item.textContent).toMatch(/edit/i);
    const instruction = within(item).getByRole('region', { name: 'Instruction of task task-1' });
    expect(instruction.textContent).toBe(pending.instruction);
    expect(instruction.getAttribute('tabindex')).toBe('0');
  });

  it('puts Deny first and focuses it: Enter on a fresh approval refuses', async () => {
    renderWithRunner(<ApprovalsScreen />, fakeApi({ 'approvals:list': [pending] }));
    const deny = await screen.findByRole('button', { name: 'Deny' });
    await waitFor(() => expect(document.activeElement).toBe(deny));
    const buttons = screen.getAllByRole('button').map((button) => button.textContent);
    expect(buttons.indexOf('Deny')).toBeLessThan(buttons.indexOf('Approve'));
  });

  it('approves and denies by the id of the task and of the ask, and says when the task is not waiting any more', async () => {
    const api = fakeApi({ 'approvals:list': [pending], 'approvals:answer': { answered: true } });
    renderWithRunner(<ApprovalsScreen />, api);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.requests('approvals:answer')).toEqual([{ taskId: 'task-1', askId: 'ask-1', answer: 'approved' }]));

    api.answer('approvals:answer', { answered: false });
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(await screen.findByText('That task is not waiting any more.')).toBeTruthy();
    expect(api.requests('approvals:answer')[1]).toEqual({ taskId: 'task-1', askId: 'ask-1', answer: 'denied' });
  });

  it('gets a new approval as it comes, and drops it when it is answered elsewhere', async () => {
    const api = fakeApi();
    renderWithRunner(<ApprovalsScreen />, api);
    await screen.findByText('Nothing is waiting for you.');
    api.emit({ kind: 'approvals', pending: [pending] });
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeTruthy();
    api.emit({ kind: 'approvals', pending: [] });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull());
  });

  it('shows a hostile instruction as text, whole, with what hides made visible', async () => {
    const instruction = `${HOSTILE.markup}\n${HOSTILE.link}\n${HOSTILE.rtl}\n${HOSTILE.long.slice(0, 7_000)}`;
    const { container } = renderWithRunner(<ApprovalsScreen />, fakeApi({ 'approvals:list': [{ ...pending, instruction, folder: HOSTILE.markup }] }));
    const region = await screen.findByRole('region', { name: 'Instruction of task task-1' });
    expect(container.querySelector('img, script, a, iframe')).toBeNull();
    expect(region.textContent).toContain('<img src=x onerror=');
    expect(region.textContent).toContain('javascript:alert(1)');
    expect(region.textContent).toContain('‹U+202E›');
    expect(region.textContent).not.toContain('‮');
    // Whole, up to the 8 000 characters the protocol allows: all of it is there, to be read by whoever approves.
    expect(region.textContent!.length).toBeGreaterThanOrEqual(7_000);
    expect(region.className).toContain('instruction');
  });

  describe('a repository the agent of a working folder asks to clone', () => {
    const clone = { kind: 'clone', askId: 'ask-2', taskId: 'task-9', workspace: 'build', url: 'https://github.com/acme/site.git', folder: 'site' } as const;

    it('shows the exact address whole, the folder it would go into and the working folder, apart from the approvals of tasks', async () => {
      renderWithRunner(<ApprovalsScreen />, fakeApi({ 'approvals:list': [pending, clone] }));
      const items = await screen.findAllByRole('listitem');
      const [task, ask] = items;
      expect(task!.textContent).toContain('Folder website');
      expect(task!.textContent).not.toContain('Clone');
      expect(within(ask!).getByRole('heading', { name: 'Clone a repository' })).toBeTruthy();
      expect(ask!.textContent).toContain('build');
      expect(ask!.textContent).toContain('site');
      const address = within(ask!).getByRole('region', { name: 'Address to clone for task task-9' });
      expect(address.textContent).toBe(clone.url);
      expect(address.getAttribute('tabindex')).toBe('0');
      expect(ask!.textContent).toMatch(/nothing is cloned unless you approve/i);
    });

    it('puts Deny first and focuses it when it is the first thing waiting', async () => {
      renderWithRunner(<ApprovalsScreen />, fakeApi({ 'approvals:list': [clone] }));
      const deny = await screen.findByRole('button', { name: 'Deny' });
      await waitFor(() => expect(document.activeElement).toBe(deny));
      const buttons = screen.getAllByRole('button').map((button) => button.textContent);
      expect(buttons.indexOf('Deny')).toBeLessThan(buttons.indexOf('Approve'));
    });

    it('answers by the ids of the task and of the ask, once, and says when it is not waiting any more', async () => {
      const api = fakeApi({ 'approvals:list': [clone], 'approvals:answer': { answered: true } });
      renderWithRunner(<ApprovalsScreen />, api);
      fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
      await waitFor(() => expect(api.requests('approvals:answer')).toEqual([{ taskId: 'task-9', askId: 'ask-2', answer: 'approved' }]));
      api.answer('approvals:answer', { answered: false });
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
      expect(await screen.findByText('That request is not waiting any more.')).toBeTruthy();
    });

    it('shows a hostile address as text, whole, with what hides made visible', async () => {
      const url = `https://example.com/${HOSTILE.markup}\u202E${'x'.repeat(400)}`;
      const { container } = renderWithRunner(<ApprovalsScreen />, fakeApi({ 'approvals:list': [{ ...clone, url, workspace: HOSTILE.markup, folder: HOSTILE.link }] }));
      const region = await screen.findByRole('region', { name: 'Address to clone for task task-9' });
      expect(container.querySelector('img, script, a, iframe')).toBeNull();
      expect(region.textContent).toContain('<img src=x onerror=');
      expect(region.textContent).toContain('‹U+202E›');
      expect(region.textContent).toContain('x'.repeat(400));
      expect(region.className).toContain('instruction');
    });

    it('is one of the approvals that are counted and shown as they come', async () => {
      const api = fakeApi();
      renderWithRunner(<ApprovalsScreen />, api);
      await screen.findByText('Nothing is waiting for you.');
      api.emit({ kind: 'approvals', pending: [clone] });
      expect(await screen.findByRole('heading', { name: 'Clone a repository' })).toBeTruthy();
    });
  });
});
