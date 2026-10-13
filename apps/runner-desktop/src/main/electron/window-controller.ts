import type { BrowserWindow as BrowserWindowType, WebContents } from 'electron';
import { app, BrowserWindow, Menu } from 'electron';
import { APP_ENTRY_URL } from '../app-url.ts';
import { windowIconFile } from '../app-paths.ts';
import { WIRE } from '../../shared/channels.ts';
import { decideNavigation, decideWindowOpen, windowOptions } from '../window-policy.ts';

/**
 * The window of the app: made when it is asked for and let go when it is closed (the app lives on in the tray, and a window costs a browser process
 * that need not stay), with the policy of what it may load and open applied to every page that is ever made.
 */
export class WindowController {
  private window: BrowserWindowType | undefined;
  private readonly preloadPath: string;
  private readonly icon: string | undefined;

  constructor(preloadPath: string, mainDirectory: string, platform: NodeJS.Platform) {
    this.preloadPath = preloadPath;
    this.icon = windowIconFile(mainDirectory, platform);
  }

  /** Whether a page is the window of the app: what the router counts as ours. */
  owns(contents: WebContents): boolean {
    return this.window !== undefined && !this.window.isDestroyed() && this.window.webContents === contents;
  }

  show = (): void => {
    if (this.window && !this.window.isDestroyed()) {
      if (this.window.isMinimized()) this.window.restore();
      this.window.show();
      this.window.focus();
      return;
    }
    const window = new BrowserWindow(windowOptions(this.preloadPath, this.icon));
    this.window = window;
    window.once('ready-to-show', () => window.show());
    window.on('closed', () => {
      if (this.window === window) this.window = undefined;
    });
    void window.loadURL(APP_ENTRY_URL);
  };

  /** Sends what the main process tells the window, if there is one. */
  push = (event: unknown): void => {
    if (this.window && !this.window.isDestroyed() && !this.window.webContents.isDestroyed()) this.window.webContents.send(WIRE.event, event);
  };
}

/** The policy for every page the app ever makes, not only the first window: it navigates inside the bundle, opens nothing, and has no webview. */
export function applyPagePolicy(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(decideWindowOpen);
    const guard = (event: Electron.Event, url: string): void => {
      if (decideNavigation(url) === 'refuse') event.preventDefault();
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

/** The menu of the app: on macOS the standard one, so that Quit and Copy have their keys, and none elsewhere. */
export function setApplicationMenu(platform: NodeJS.Platform): void {
  Menu.setApplicationMenu(platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
}
