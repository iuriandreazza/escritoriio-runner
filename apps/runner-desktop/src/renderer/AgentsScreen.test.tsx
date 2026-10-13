// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentsScreen } from './AgentsScreen.tsx';
import { fakeApi, HOSTILE, renderWithRunner } from './testing.tsx';

afterEach(cleanup);

const claude = { kind: 'claude-code', drivable: true, detection: { installed: true, path: '/usr/local/bin/claude', version: '2.1.250', loggedIn: true, supported: true, containment: 'sandbox' } } as const;
const kimi = { kind: 'kimi-code', drivable: false, detection: { installed: false, loggedIn: null, supported: false, containment: 'none' } } as const;

const item = (name: string) => screen.getByRole('heading', { name }).closest('li')!;

describe('the coding agents', () => {
  it('says where each was found, its version, whether it is logged in, and that it is contained', async () => {
    renderWithRunner(<AgentsScreen />, fakeApi({ 'agents:inspect': [claude] }));
    await screen.findByRole('heading', { name: 'Claude Code' });
    const card = item('Claude Code');
    expect(card.textContent).toContain('/usr/local/bin/claude');
    expect(card.textContent).toContain('2.1.250');
    expect(card.textContent).toContain('Logged in');
    expect(card.textContent).toMatch(/Contained by the sandbox of the system/);
  });

  it('says that a coding agent with no containment runs only in trusted folders', async () => {
    renderWithRunner(<AgentsScreen />, fakeApi({ 'agents:inspect': [{ ...claude, detection: { ...claude.detection, containment: 'none' } }] }));
    await screen.findByRole('heading', { name: 'Claude Code' });
    expect(item('Claude Code').textContent).toMatch(/No containment here: it runs only in trusted folders/);
  });

  it('says when one is not found, not logged in, not supported, or cannot be driven yet', async () => {
    renderWithRunner(
      <AgentsScreen />,
      fakeApi({
        'agents:inspect': [
          { ...claude, kind: 'codex', detection: { installed: true, version: '0.1', loggedIn: false, supported: false, problem: 'This version is too old.', containment: 'sandbox' } },
          kimi,
        ],
      }),
    );
    await screen.findByRole('heading', { name: 'Codex' });
    expect(item('Codex').textContent).toContain('Not logged in');
    expect(item('Codex').textContent).toContain('This version is too old.');
    expect(item('Kimi Code').textContent).toContain('Not found');
    expect(item('Kimi Code').textContent).toMatch(/cannot be driven by this runner yet/);
  });

  it('picks the place in the system window and never types a path', async () => {
    const api = fakeApi({ 'agents:inspect': [kimi], 'agents:set-path': { picked: true } });
    renderWithRunner(<AgentsScreen />, api);
    await screen.findByRole('heading', { name: 'Kimi Code' });
    expect(within(item('Kimi Code')).queryByRole('textbox')).toBeNull();
    fireEvent.click(within(item('Kimi Code')).getByRole('button', { name: 'Choose where it is…' }));
    await waitFor(() => expect(api.requests('agents:set-path')).toEqual([{ kind: 'kimi-code' }]));
    await waitFor(() => expect(api.requests('agents:inspect').length).toBe(2));
  });

  it('says when no file was chosen', async () => {
    renderWithRunner(<AgentsScreen />, fakeApi({ 'agents:inspect': [kimi], 'agents:set-path': { picked: false } }));
    fireEvent.click(await screen.findByRole('button', { name: 'Choose where it is…' }));
    expect(await screen.findByText('No file was chosen.')).toBeTruthy();
  });

  it('clears a place that was chosen, and offers it only then', async () => {
    const api = fakeApi({ 'agents:inspect': [{ ...claude, pickedPath: '/opt/claude' }, { ...kimi, kind: 'codex' }], 'agents:clear-path': { cleared: true } });
    renderWithRunner(<AgentsScreen />, api);
    await screen.findByRole('heading', { name: 'Claude Code' });
    expect(item('Claude Code').textContent).toContain('/opt/claude');
    expect(within(item('Codex')).queryByRole('button', { name: /Look for it by itself/ })).toBeNull();
    fireEvent.click(within(item('Claude Code')).getByRole('button', { name: 'Look for it by itself' }));
    await waitFor(() => expect(api.requests('agents:clear-path')).toEqual([{ kind: 'claude-code' }]));
  });

  it('shows what a hostile machine reports as text', async () => {
    const { container } = renderWithRunner(<AgentsScreen />, fakeApi({ 'agents:inspect': [{ ...claude, detection: { ...claude.detection, version: HOSTILE.markup, problem: HOSTILE.link, path: HOSTILE.rtl } }] }));
    await screen.findByRole('heading', { name: 'Claude Code' });
    expect(container.querySelector('img, script, a')).toBeNull();
    expect(container.textContent).toContain('‹U+202E›');
  });
});
