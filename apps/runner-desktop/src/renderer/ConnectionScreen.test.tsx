// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionScreen } from './ConnectionScreen.tsx';
import { connected, device, fakeApi, HOSTILE, renderWithRunner } from './testing.tsx';

afterEach(cleanup);

const notPaired = { state: 'not-paired', device: null, paused: false, pausedByOffice: false, pausedHere: false, retryInMs: null, slowRetry: false, lastError: null } as const;

describe('the connection', () => {
  it('says which AI member this machine works for, where, and that it is connected', async () => {
    renderWithRunner(<ConnectionScreen />);
    expect(await screen.findByText('Connected')).toBeTruthy();
    const facts = screen.getByRole('list', { name: 'This machine' });
    expect(facts.textContent).toContain('Robby');
    expect(facts.textContent).toContain('Acme');
    expect(facts.textContent).toContain('office.example');
    expect(facts.textContent).toContain('Work laptop');
  });

  it('pauses with one big button, and the same button resumes', async () => {
    const api = fakeApi({ 'pause:set': { changed: true } });
    renderWithRunner(<ConnectionScreen />, api);
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(api.requests('pause:set')).toEqual([{ paused: true }]));

    api.emit({ kind: 'connection', view: { ...connected, paused: true, pausedHere: true } });
    expect(await screen.findByText('Paused on this machine')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(api.requests('pause:set')).toEqual([{ paused: true }, { paused: false }]));
  });

  it('says when the office paused it, and that resuming here does not undo that', async () => {
    const api = fakeApi({ 'connection:get': { ...connected, paused: true, pausedByOffice: true } });
    renderWithRunner(<ConnectionScreen />, api);
    expect(await screen.findByText('Paused from the office')).toBeTruthy();
    expect(screen.getByText(/only the office can resume/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });

  it('says when it paused for both reasons', async () => {
    renderWithRunner(<ConnectionScreen />, fakeApi({ 'connection:get': { ...connected, paused: true, pausedByOffice: true, pausedHere: true } }));
    expect(await screen.findByText('Paused on this machine')).toBeTruthy();
    expect(screen.getByText(/also paused from the office/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
  });

  it('says it is reconnecting, when it tries again, and that it tries less often after a while', async () => {
    const api = fakeApi({ 'connection:get': { ...connected, state: 'reconnecting', retryInMs: 8_000, slowRetry: true, lastError: 'The office did not answer.' } });
    renderWithRunner(<ConnectionScreen />, api);
    expect(await screen.findByText('Reconnecting')).toBeTruthy();
    expect(screen.getByText(/in about 8 s/)).toBeTruthy();
    expect(screen.getByText(/less often/)).toBeTruthy();
    expect(screen.getByText('The office did not answer.')).toBeTruthy();
  });

  it('starts the connection when there is none, and says why when it did not begin', async () => {
    const api = fakeApi({ 'connection:get': { ...connected, state: 'offline' }, 'connection:start': { started: false, message: 'Another runner holds the connection.' } });
    renderWithRunner(<ConnectionScreen />, api);
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    expect(await screen.findByText('Another runner holds the connection.')).toBeTruthy();
    expect(api.requests('connection:start')).toHaveLength(1);
  });

  it('offers no Start while it is connected or on its way', async () => {
    renderWithRunner(<ConnectionScreen />);
    await screen.findByText('Connected');
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
  });

  it('shows the words of the office as text: no markup, no link, nothing that opens', async () => {
    const hostile = { ...device, agentName: HOSTILE.markup, workspaceName: HOSTILE.link, deviceName: HOSTILE.rtl, host: 'office.example' };
    const { container } = renderWithRunner(<ConnectionScreen />, fakeApi({ 'connection:get': { ...connected, device: hostile, lastError: HOSTILE.markup } }));
    await screen.findByText('Connected');
    expect(container.querySelector('img, script, a')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=');
    expect(container.textContent).toContain('‹U+202E›');
    expect(container.textContent).not.toContain('‮');
  });
});

describe('pairing', () => {
  it('asks to pair when the machine is not paired, with a link or an address and a code', async () => {
    renderWithRunner(<ConnectionScreen />, fakeApi({ 'connection:get': notPaired }));
    expect(await screen.findByText('Not paired')).toBeTruthy();
    expect(screen.getByLabelText('Pairing link or the address of the office')).toBeTruthy();
    expect(screen.getByLabelText('Code')).toBeTruthy();
  });

  it('pairs with the address and the code that were typed, and shows what the office said it paired with', async () => {
    const api = fakeApi({ 'connection:get': notPaired, 'pairing:pair': { paired: true, agentName: 'Robby', workspaceName: 'Acme', host: 'office.example', deviceName: 'Work laptop' } });
    renderWithRunner(<ConnectionScreen />, api);
    fireEvent.change(await screen.findByLabelText('Pairing link or the address of the office'), { target: { value: 'https://office.example' } });
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'ABCD-EFGH' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    expect(await screen.findByText(/Paired with Robby of Acme/)).toBeTruthy();
    expect(api.requests('pairing:pair')).toEqual([{ server: 'https://office.example', code: 'ABCD-EFGH' }]);
  });

  it('takes the address and the code out of a pasted link, and asks for no code of its own', async () => {
    const api = fakeApi({ 'connection:get': notPaired, 'pairing:pair': { paired: false } });
    renderWithRunner(<ConnectionScreen />, api);
    fireEvent.change(await screen.findByLabelText('Pairing link or the address of the office'), { target: { value: 'escritoriio://pair?server=https%3A%2F%2Foffice.example&code=ABCD-EFGH' } });
    expect((screen.getByLabelText('Code') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    expect(await screen.findByText(/Nothing was paired/)).toBeTruthy();
    expect(api.requests('pairing:pair')).toEqual([{ server: 'https://office.example', code: 'ABCD-EFGH' }]);
  });

  it('refuses a link that is not a pairing link, without asking the main process', async () => {
    const api = fakeApi({ 'connection:get': notPaired });
    renderWithRunner(<ConnectionScreen />, api);
    fireEvent.change(await screen.findByLabelText('Pairing link or the address of the office'), { target: { value: 'escritoriio://folders/add?path=/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/not a pairing link/i);
    expect(api.requests('pairing:pair')).toEqual([]);
  });

  it('needs both an address and a code', async () => {
    renderWithRunner(<ConnectionScreen />, fakeApi({ 'connection:get': notPaired }));
    expect((await screen.findByRole('button', { name: 'Pair' })).hasAttribute('disabled')).toBe(true);
  });

  it('says in words what went wrong, never a stack', async () => {
    const api = fakeApi({
      'connection:get': notPaired,
      'pairing:pair': () => {
        throw new Error('Could not reach office.example (connection refused)');
      },
    });
    renderWithRunner(<ConnectionScreen />, api);
    fireEvent.change(await screen.findByLabelText('Pairing link or the address of the office'), { target: { value: 'https://office.example' } });
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'ABCD-EFGH' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not reach office.example (connection refused)');
  });

  it('shows a link that was opened, by its host only, and pairs with it by its id: the code is not in the window', async () => {
    const api = fakeApi({ 'connection:get': notPaired, 'pairing:pending-link': { linkId: 'link-1', host: 'office.example' }, 'pairing:pair': { paired: true, agentName: 'Robby', workspaceName: 'Acme', host: 'office.example' } });
    renderWithRunner(<ConnectionScreen />, api);
    const waiting = await screen.findByRole('region', { name: 'A link was opened' });
    expect(waiting.textContent).toContain('office.example');
    expect(waiting.textContent).toMatch(/shows you the office's own words/i);
    fireEvent.click(screen.getByRole('button', { name: 'Pair with office.example' }));
    await waitFor(() => expect(api.requests('pairing:pair')).toEqual([{ linkId: 'link-1' }]));
  });

  it('shows a link that is opened while the window is open', async () => {
    const api = fakeApi({ 'connection:get': notPaired });
    renderWithRunner(<ConnectionScreen />, api);
    await screen.findByText('Not paired');
    api.emit({ kind: 'pair-link', linkId: 'link-2', host: HOSTILE.markup });
    const waiting = await screen.findByRole('region', { name: 'A link was opened' });
    expect(waiting.querySelector('img, script, a')).toBeNull();
    expect(waiting.textContent).toContain('<img src=x');
  });

  it('refuses to pair while connected, and says why, instead of offering a form that would fail', async () => {
    renderWithRunner(<ConnectionScreen />);
    await screen.findByText('Connected');
    expect(screen.queryByLabelText('Code')).toBeNull();
    expect(screen.getByText(/Pairing again is possible only when the connection is off/)).toBeTruthy();
  });

  it('offers to pair again when it is paired and not connected', async () => {
    renderWithRunner(<ConnectionScreen />, fakeApi({ 'connection:get': { ...connected, state: 'offline' } }));
    fireEvent.click(await screen.findByText('Pair with a different AI member'));
    expect(screen.getByLabelText('Code')).toBeTruthy();
  });
});
