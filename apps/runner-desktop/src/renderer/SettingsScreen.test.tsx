// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsScreen } from './SettingsScreen.tsx';
import { fakeApi, HOSTILE, renderWithRunner } from './testing.tsx';

afterEach(cleanup);

const info = { appVersion: '1.2.3', runnerVersion: '0.2.0', platform: 'darwin', launchAtLogin: false, launchAtLoginSupported: true, updatesSupported: true, stateDirectory: '/home/me/.escritoriio-runner' };

describe('the settings', () => {
  it('shows the versions and the folder where the runner keeps its state', async () => {
    renderWithRunner(<SettingsScreen />);
    const facts = await screen.findByRole('list', { name: 'About this app' });
    expect(facts.textContent).toContain('1.2.3');
    expect(facts.textContent).toContain('0.2.0');
    expect(facts.textContent).toContain('/home/me/.escritoriio-runner');
  });

  it('has launch at login off, says what it does, and turns it on by a click', async () => {
    const api = fakeApi({ 'app:set-launch-at-login': { launchAtLogin: true } });
    renderWithRunner(<SettingsScreen />, api);
    const box = (await screen.findByRole('checkbox', { name: 'Open the app when I log in' })) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText(/Off by default/)).toBeTruthy();
    fireEvent.click(box);
    await waitFor(() => expect(api.requests('app:set-launch-at-login')).toEqual([{ enabled: true }]));
    await waitFor(() => expect(box.checked).toBe(true));
  });

  it('shows what the system really did when it did not allow it', async () => {
    renderWithRunner(<SettingsScreen />, fakeApi({ 'app:set-launch-at-login': { launchAtLogin: false } }));
    const box = (await screen.findByRole('checkbox', { name: 'Open the app when I log in' })) as HTMLInputElement;
    fireEvent.click(box);
    expect(await screen.findByText('The system did not change it.')).toBeTruthy();
    expect(box.checked).toBe(false);
  });

  it('cannot be turned on where the system does not allow it, and says so', async () => {
    renderWithRunner(<SettingsScreen />, fakeApi({ 'app:info': { ...info, launchAtLoginSupported: false } }));
    const box = (await screen.findByRole('checkbox', { name: 'Open the app when I log in' })) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(screen.getByText(/This system cannot do it, so it cannot be turned on/)).toBeTruthy();
  });

  it('checks for an update on request and says what it found, with Accept only when there is one', async () => {
    const api = fakeApi({ 'app:check-update': { state: 'available', version: '1.3.0' }, 'app:accept-update': { state: 'downloaded', version: '1.3.0' } });
    renderWithRunner(<SettingsScreen />, api);
    expect(await screen.findByText('Not checked yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept the update…' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check for an update' }));
    expect(await screen.findByText('Version 1.3.0 is available.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept the update…' }));
    await waitFor(() => expect(api.requests('app:accept-update')).toHaveLength(1));
    expect(await screen.findByText(/Version 1.3.0 is downloaded/)).toBeTruthy();
  });

  it('says it is up to date, and follows an update that the main process announces', async () => {
    const api = fakeApi({ 'app:check-update': { state: 'none' } });
    renderWithRunner(<SettingsScreen />, api);
    fireEvent.click(await screen.findByRole('button', { name: 'Check for an update' }));
    expect(await screen.findByText('You have the latest version.')).toBeTruthy();
    api.emit({ kind: 'update', update: { state: 'downloading', version: '1.4.0' } });
    expect(await screen.findByText('Downloading version 1.4.0…')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Check for an update' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says why updates are not looked for, when the app is not an installed one', async () => {
    renderWithRunner(<SettingsScreen />, fakeApi({ 'app:info': { ...info, updatesSupported: false } }));
    expect(await screen.findByText(/Only an installed app looks for updates/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Check for an update' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the words of a failed update as text', async () => {
    const { container } = renderWithRunner(<SettingsScreen />, fakeApi({ 'app:check-update': { state: 'error', message: HOSTILE.markup } }));
    fireEvent.click(await screen.findByRole('button', { name: 'Check for an update' }));
    await screen.findByText(/The update failed/);
    expect(container.querySelector('img, script, a')).toBeNull();
    expect(container.textContent).toContain('<img src=x');
  });
});
