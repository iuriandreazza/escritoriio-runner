import electronUpdater from 'electron-updater';
import type { UpdaterPort } from '../update-service.ts';

/**
 * The updater of an installed app, reading the feed that the build wrote from its `publish` setting (the public releases of the runner). It looks
 * and downloads when it is told to and never on its own: nothing is downloaded or installed because a newer version exists, and nothing is
 * installed when the app quits. The signature of what is downloaded is checked by the updater (a signed build is what makes that mean something:
 * on macOS an unsigned app cannot be updated at all).
 */
export function createElectronUpdater(): UpdaterPort {
  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;

  return {
    async check() {
      const result = await autoUpdater.checkForUpdates();
      return result?.isUpdateAvailable ? { version: result.updateInfo.version } : undefined;
    },
    async download() {
      await autoUpdater.downloadUpdate();
    },
    installAndRestart() {
      autoUpdater.quitAndInstall();
    },
  };
}
