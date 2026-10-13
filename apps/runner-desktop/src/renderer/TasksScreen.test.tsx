// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TasksScreen } from './TasksScreen.tsx';
import { fakeApi, HOSTILE, renderWithRunner } from './testing.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const running = { taskId: 'task-1', folder: 'website', startedAt: 1_700_000_000_000, waitingForApproval: false, tail: ['Reading the repository', 'Editing index.html'] };
const ended = { taskId: 'task-0', outcome: 'completed', durationMs: 185_000, branch: 'escritoriio/task-0', summary: 'Fixed the title of the home page.' };

describe('the tasks', () => {
  it('says there is nothing, when there is nothing', async () => {
    renderWithRunner(<TasksScreen />);
    expect(await screen.findByText('Nothing is running.')).toBeTruthy();
    expect(screen.getByText('No task has ended since this app started.')).toBeTruthy();
  });

  it('shows the running tasks with the last lines of what the coding agent says', async () => {
    renderWithRunner(<TasksScreen />, fakeApi({ 'tasks:get': { running: [running], recent: [] } }));
    const item = (await screen.findAllByRole('listitem'))[0]!;
    expect(item.textContent).toContain('website');
    const log = within(item).getByRole('log', { name: 'Output of task task-1' });
    expect(log.textContent).toBe('Reading the repository\nEditing index.html');
    expect(log.getAttribute('tabindex')).toBe('0');
  });

  it('follows the tail as lines come, and keeps it where it was when the owner scrolled up to read', async () => {
    const api = fakeApi({ 'tasks:get': { running: [running], recent: [] } });
    renderWithRunner(<TasksScreen />, api);
    const log = await screen.findByRole('log');
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 100 });

    log.scrollTop = 900;
    fireEvent.scroll(log);
    act(() => api.emit({ kind: 'tasks', view: { running: [{ ...running, tail: [...running.tail, 'Running the tests'] }], recent: [] } }));
    expect(log.scrollTop).toBe(1000);

    log.scrollTop = 100;
    fireEvent.scroll(log);
    act(() => api.emit({ kind: 'tasks', view: { running: [{ ...running, tail: [...running.tail, 'Running the tests', 'All passed'] }], recent: [] } }));
    expect(log.scrollTop).toBe(100);
    expect(log.textContent).toContain('All passed');
  });

  it('shows a task that waits for the owner, and does not pretend it runs', async () => {
    renderWithRunner(<TasksScreen />, fakeApi({ 'tasks:get': { running: [{ ...running, waitingForApproval: true, tail: [] }], recent: [] } }));
    expect(await screen.findByText('Waiting for your approval')).toBeTruthy();
    expect(screen.getByText('Nothing has been printed yet.')).toBeTruthy();
  });

  it('cancels after asking, and keeps the task when the owner keeps it', async () => {
    const api = fakeApi({ 'tasks:get': { running: [running], recent: [] }, 'tasks:cancel': { cancelled: true } });
    renderWithRunner(<TasksScreen />, api);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel task' }));
    const keep = screen.getByRole('button', { name: 'Keep it running' });
    await waitFor(() => expect(document.activeElement).toBe(keep));
    fireEvent.click(keep);
    expect(api.requests('tasks:cancel')).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel it' }));
    await waitFor(() => expect(api.requests('tasks:cancel')).toEqual([{ taskId: 'task-1' }]));
  });

  it('says in words when a cancel did not take', async () => {
    const api = fakeApi({
      'tasks:get': { running: [running], recent: [] },
      'tasks:cancel': () => {
        throw new Error('The app refused that request.');
      },
    });
    renderWithRunner(<TasksScreen />, api);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel it' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The app refused that request.');
  });

  it('lists what ended: how it ended, how long it took, the branch and what it said', async () => {
    renderWithRunner(<TasksScreen />, fakeApi({ 'tasks:get': { running: [], recent: [ended] } }));
    const list = await screen.findByRole('list', { name: 'Recent tasks' });
    expect(list.textContent).toContain('completed');
    expect(list.textContent).toContain('3 min 5 s');
    expect(list.textContent).toContain('escritoriio/task-0');
    expect(list.textContent).toContain('Fixed the title of the home page.');
  });

  it('shows what a hostile office put in a tail, a summary and a name as text, and nothing else', async () => {
    const hostile = { ...running, folder: HOSTILE.markup, tail: [HOSTILE.markup, HOSTILE.link, HOSTILE.rtl, '\u001b[31mred\u001b[0m'] };
    const { container } = renderWithRunner(<TasksScreen />, fakeApi({ 'tasks:get': { running: [hostile], recent: [{ ...ended, summary: HOSTILE.markup, branch: HOSTILE.link }] } }));
    await screen.findByRole('log');
    expect(container.querySelector('img, script, a, iframe')).toBeNull();
    const log = screen.getByRole('log');
    expect(log.textContent).toContain('<img src=x onerror=');
    expect(log.textContent).toContain('javascript:alert(1)');
    expect(log.textContent).toContain('‹U+202E›');
    expect(log.textContent).not.toContain('‮');
    expect(log.textContent).toContain('red');
    expect(log.textContent).not.toContain('\u001b');
  });

  it('shows a long line whole, in a place that scrolls, and does not break the screen', async () => {
    renderWithRunner(<TasksScreen />, fakeApi({ 'tasks:get': { running: [{ ...running, tail: [HOSTILE.long] }], recent: [] } }));
    const log = await screen.findByRole('log');
    // The main process cuts a line to a length; what the screen is given, it shows.
    expect(log.textContent!.length).toBeGreaterThan(300);
    expect(log.className).toContain('tail');
  });
});
