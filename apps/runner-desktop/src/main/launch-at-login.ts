import { OwnerError } from '@escritoriio/runner';
import type { AppSettings, AppSettingsStore } from './app-settings.ts';
import type { ConfirmDialog } from './confirmations.ts';
import { launchAtLoginRequest } from './confirmations.ts';

/** What of the system's login items the app uses. */
export interface LoginItems {
  set(enabled: boolean): void;
}

export interface LaunchAtLoginDeps {
  readonly settings: AppSettingsStore;
  readonly items: LoginItems;
  /** An installed app. One that runs from its sources would register the development binary of Electron to open at login. */
  readonly packaged: boolean;
  readonly platform: NodeJS.Platform;
}

/** Electron has login items on macOS and Windows; on Linux each way of installing has its own (an autostart entry), which the packaging makes. */
export const launchAtLoginSupported = (platform: NodeJS.Platform): boolean => platform === 'darwin' || platform === 'win32';

export const shouldAskLaunchAtLogin = ({ settings, packaged, platform }: { readonly settings: AppSettings; readonly packaged: boolean; readonly platform: NodeJS.Platform }): boolean =>
  !settings.launchAtLoginAsked && packaged && launchAtLoginSupported(platform);

/** The question of the first run, once. It is off unless the owner says yes, and what they said is remembered either way. */
export async function askLaunchAtLoginOnFirstRun({ dialog, ...deps }: LaunchAtLoginDeps & { readonly dialog: ConfirmDialog }): Promise<void> {
  const settings = await deps.settings.load();
  if (!shouldAskLaunchAtLogin({ settings, packaged: deps.packaged, platform: deps.platform })) return;
  const yes = await dialog.confirm(launchAtLoginRequest());
  if (yes) deps.items.set(true);
  await deps.settings.update({ launchAtLoginAsked: true, launchAtLogin: yes });
}

/** The owner's change of it, from the window. Throws, with words, where it cannot be done. */
export async function setLaunchAtLogin({ settings, items, packaged, platform }: LaunchAtLoginDeps, enabled: boolean): Promise<boolean> {
  if (!launchAtLoginSupported(platform)) throw new OwnerError('Opening at login is not supported on Linux by the app itself: add it to the autostart of your desktop.');
  if (!packaged) throw new OwnerError('Opening at login is for the installed app: this one runs from its sources.');
  items.set(enabled);
  await settings.update({ launchAtLoginAsked: true, launchAtLogin: enabled });
  return enabled;
}
