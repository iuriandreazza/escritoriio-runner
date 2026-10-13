import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppSettingsStore } from './app-settings.ts';
import { askLaunchAtLoginOnFirstRun, launchAtLoginSupported, setLaunchAtLogin, shouldAskLaunchAtLogin } from './launch-at-login.ts';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'escritoriio-desktop-login-'));
});
afterEach(() => rm(directory, { recursive: true, force: true }));

describe('whether to ask about opening at login', () => {
  const fresh = { launchAtLoginAsked: false, launchAtLogin: false };
  it('asks once, in an installed app, where the system has such a thing', () => {
    expect(shouldAskLaunchAtLogin({ settings: fresh, packaged: true, platform: 'darwin' })).toBe(true);
    expect(shouldAskLaunchAtLogin({ settings: fresh, packaged: true, platform: 'win32' })).toBe(true);
    expect(shouldAskLaunchAtLogin({ settings: { ...fresh, launchAtLoginAsked: true }, packaged: true, platform: 'darwin' })).toBe(false);
  });
  it('does not ask a run from sources, which would register the development binary to open at login, nor where Electron cannot do it', () => {
    expect(shouldAskLaunchAtLogin({ settings: fresh, packaged: false, platform: 'darwin' })).toBe(false);
    expect(shouldAskLaunchAtLogin({ settings: fresh, packaged: true, platform: 'linux' })).toBe(false);
    expect(launchAtLoginSupported('linux')).toBe(false);
  });
});

describe('the first-run question', () => {
  const login = () => ({ set: vi.fn() });

  it('is off unless the owner says yes, and is remembered whatever they said', async () => {
    const settings = createAppSettingsStore(directory);
    const items = login();
    await askLaunchAtLoginOnFirstRun({ settings, items, dialog: { confirm: () => Promise.resolve(false) }, packaged: true, platform: 'darwin' });
    expect(items.set).not.toHaveBeenCalled();
    expect(await settings.load()).toMatchObject({ launchAtLoginAsked: true, launchAtLogin: false });
  });

  it('opens at login after a yes, and the choice is kept in the app’s own settings', async () => {
    const settings = createAppSettingsStore(directory);
    const items = login();
    await askLaunchAtLoginOnFirstRun({ settings, items, dialog: { confirm: () => Promise.resolve(true) }, packaged: true, platform: 'darwin' });
    expect(items.set).toHaveBeenCalledWith(true);
    expect(await settings.load()).toMatchObject({ launchAtLoginAsked: true, launchAtLogin: true });
  });

  it('does not ask a second time', async () => {
    const settings = createAppSettingsStore(directory);
    const confirm = vi.fn(() => Promise.resolve(true));
    const deps = { settings, items: login(), dialog: { confirm }, packaged: true, platform: 'darwin' as const };
    await askLaunchAtLoginOnFirstRun(deps);
    await askLaunchAtLoginOnFirstRun(deps);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

describe('changing it afterwards', () => {
  it('is applied and kept, and refused where the system cannot', async () => {
    const settings = createAppSettingsStore(directory);
    const items = { set: vi.fn() };
    expect(await setLaunchAtLogin({ settings, items, packaged: true, platform: 'win32' }, true)).toBe(true);
    expect(items.set).toHaveBeenCalledWith(true);
    expect((await settings.load()).launchAtLogin).toBe(true);
    await expect(setLaunchAtLogin({ settings, items, packaged: true, platform: 'linux' }, true)).rejects.toThrow(/Linux|not supported/i);
    await expect(setLaunchAtLogin({ settings, items, packaged: false, platform: 'darwin' }, true)).rejects.toThrow(/installed/i);
  });
});
