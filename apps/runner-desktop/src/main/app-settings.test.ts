import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppSettingsStore, DEFAULT_SETTINGS } from './app-settings.ts';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'escritoriio-desktop-settings-'));
});
afterEach(() => rm(directory, { recursive: true, force: true }));

describe('the settings of the app', () => {
  it('start with everything off and nothing asked', async () => {
    expect(await createAppSettingsStore(directory).load()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({ launchAtLoginAsked: false, launchAtLogin: false });
  });

  it('keep what is changed, and nothing else with it, in a file only its owner reads', async () => {
    const store = createAppSettingsStore(directory);
    await store.update({ launchAtLoginAsked: true });
    await store.update({ launchAtLogin: true });
    expect(await createAppSettingsStore(directory).load()).toEqual({ launchAtLoginAsked: true, launchAtLogin: true });
    expect((await stat(join(directory, 'app-settings.json'))).mode & 0o777).toBe(0o600);
  });

  it('go back to off, and ask again, when the file is damaged or says something else', async () => {
    await writeFile(join(directory, 'app-settings.json'), '{"launchAtLogin": "yes"');
    expect(await createAppSettingsStore(directory).load()).toEqual(DEFAULT_SETTINGS);
    await writeFile(join(directory, 'app-settings.json'), JSON.stringify({ launchAtLogin: 'yes', allowWeakTokenStorage: 1 }));
    expect(await createAppSettingsStore(directory).load()).toEqual(DEFAULT_SETTINGS);
  });
});
