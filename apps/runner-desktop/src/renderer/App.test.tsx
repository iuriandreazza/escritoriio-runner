// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App.tsx';
import { connected, fakeApi, HOSTILE } from './testing.tsx';

afterEach(cleanup);

const nav = () => screen.getByRole('navigation', { name: 'Sections' });

describe('the window', () => {
  it('has a place for each thing the app does, and starts at the connection', async () => {
    render(<App api={fakeApi()} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Escritoriio Runner' })).toBeTruthy();
    for (const name of ['Connection', 'Tasks', 'Approvals', 'Folders', 'Coding agents', 'MCP servers', 'Doctor', 'Settings']) {
      expect(within(nav()).getByRole('button', { name: new RegExp(`^${name}`) })).toBeTruthy();
    }
    expect(await screen.findByRole('heading', { level: 2, name: 'Connection' })).toBeTruthy();
    expect(within(nav()).getByRole('button', { name: /^Connection/ }).getAttribute('aria-current')).toBe('page');
  });

  it('goes to a place and puts the focus on its title, so that a screen reader says where it is', async () => {
    render(<App api={fakeApi()} />);
    await screen.findByRole('heading', { level: 2, name: 'Connection' });
    fireEvent.click(within(nav()).getByRole('button', { name: /^Folders/ }));
    const title = await screen.findByRole('heading', { level: 2, name: 'Folders' });
    await waitFor(() => expect(document.activeElement).toBe(title));
    expect(within(nav()).getByRole('button', { name: /^Folders/ }).getAttribute('aria-current')).toBe('page');
    expect(within(nav()).getByRole('button', { name: /^Connection/ }).getAttribute('aria-current')).toBeNull();
  });

  it('says in the header how the machine is, wherever you are', async () => {
    const api = fakeApi();
    render(<App api={api} />);
    expect(await screen.findByRole('status', { name: 'Connection status' })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('status', { name: 'Connection status' }).textContent).toBe('Connected'));
    act(() => api.emit({ kind: 'connection', view: { ...connected, paused: true, pausedHere: true } }));
    expect(screen.getByRole('status', { name: 'Connection status' }).textContent).toBe('Paused on this machine');
  });

  it('counts the approvals that wait and the tasks that run', async () => {
    const api = fakeApi({ 'approvals:list': [{ askId: 'a1', taskId: 't1', folder: 'a', access: 'edit', instruction: 'x' }], 'tasks:get': { running: [{ taskId: 't2', folder: 'a', startedAt: 1, waitingForApproval: false, tail: [] }], recent: [] } });
    render(<App api={api} />);
    expect(await within(nav()).findByRole('button', { name: 'Approvals, 1 waiting' })).toBeTruthy();
    expect(within(nav()).getByRole('button', { name: 'Tasks, 1 running' })).toBeTruthy();
  });

  it('tells a notice politely and a problem at once, and lets either be dismissed', async () => {
    const api = fakeApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { level: 2, name: 'Connection' });
    act(() => {
      api.emit({ kind: 'notice', message: 'Paired with Robby.' });
      api.emit({ kind: 'problem', message: 'The folder moved.' });
    });
    expect(screen.getByText('Paired with Robby.').closest('[role="status"]')).toBeTruthy();
    const problem = screen.getByText('The folder moved.').closest('[role="alert"]')!;
    fireEvent.click(within(problem as HTMLElement).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('The folder moved.')).toBeNull();
  });

  it('shows words, never a stack, when the app does not answer', async () => {
    const api = fakeApi({
      'connection:get': () => {
        throw new Error('The app did not answer.');
      },
    });
    render(<App api={api} />);
    expect((await screen.findByRole('alert')).textContent).toBe('The app did not answer.');
  });

  it('shows hostile text from events as text', async () => {
    const api = fakeApi();
    const { container } = render(<App api={api} />);
    await screen.findByRole('heading', { level: 2, name: 'Connection' });
    act(() => api.emit({ kind: 'notice', message: `${HOSTILE.markup} ${HOSTILE.link} ${HOSTILE.rtl}` }));
    expect(container.querySelector('img, script, a')).toBeNull();
    expect(container.textContent).toContain('‹U+202E›');
  });

  it('keeps what an event said, when the first look comes back with older words', async () => {
    let release: (view: typeof connected) => void = () => undefined;
    const api = fakeApi({ 'connection:get': () => new Promise((resolve) => (release = resolve)) });
    render(<App api={api} />);
    act(() => api.emit({ kind: 'connection', view: { ...connected, state: 'reconnecting', retryInMs: 3_000 } }));
    await act(async () => release(connected));
    expect(screen.getByRole('status', { name: 'Connection status' }).textContent).toBe('Reconnecting');
  });
});
