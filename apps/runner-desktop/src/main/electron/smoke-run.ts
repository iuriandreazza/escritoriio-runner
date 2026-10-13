import { app, BrowserWindow, ipcMain } from 'electron';
import { WIRE } from '../../shared/channels.ts';
import { APP_ENTRY_URL } from '../app-url.ts';
import { bundleFile } from '../app-paths.ts';
import { windowOptions } from '../window-policy.ts';
import { hardenSession, serveBundle } from './bundle-protocol.ts';
import { applyPagePolicy } from './window-controller.ts';

const SMOKE_TIMEOUT_MS = 30_000;
const POLL_MS = 100;

const PAGE_IS_UP = `Boolean(document.getElementById('root')?.childElementCount) && typeof window.escritoriioRunner?.call === 'function'`;

/** Loads the bundle, the preload and the page in a window that is never shown, and says so: nothing of the real app (lock, tray, token, updater, protocol) is touched. */
export async function runSmoke(mainDirectory: string, say: (line: string) => void): Promise<void> {
  const timer = setTimeout(() => {
    say('smoke failed: the page did not come up in time.');
    app.exit(1);
  }, SMOKE_TIMEOUT_MS);
  try {
    await app.whenReady();
    serveBundle(bundleFile(mainDirectory, 'renderer'));
    hardenSession();
    applyPagePolicy();
    // There is no runner here, so the page's calls are left unanswered: the check is that the page loads, not what it shows.
    ipcMain.handle(WIRE.call, () => new Promise(() => undefined));
    const window = new BrowserWindow(windowOptions(bundleFile(mainDirectory, 'preload')));
    await window.loadURL(APP_ENTRY_URL);
    while (!(await window.webContents.executeJavaScript(PAGE_IS_UP, true))) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    say('smoke ok');
    clearTimeout(timer);
    app.exit(0);
  } catch (error) {
    say(`smoke failed: ${error instanceof Error ? error.message : String(error)}`);
    app.exit(1);
  }
}
