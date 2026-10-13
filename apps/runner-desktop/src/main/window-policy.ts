import type { BrowserWindowConstructorOptions } from 'electron';
import { isOwnUrl } from './app-url.ts';

/**
 * What the window may load and do: only its own scripts and styles, images from itself and data, and no connection of any kind: whatever the
 * renderer needs from outside it asks the main process for, through the preload. The bundle has no inline script and no inline style.
 * The same text is in the page itself (a `meta` of `index.html`, which a test keeps equal to this) and in the headers of every answer.
 */
export const CONTENT_SECURITY_POLICY = ["default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; ');

/** The window of the app: a page that cannot reach Node, the preload or the system except through what the preload exposes. */
export function windowOptions(preloadPath: string, icon?: string): BrowserWindowConstructorOptions {
  return {
    ...(icon === undefined ? {} : { icon }),
    width: 960,
    height: 680,
    minWidth: 560,
    minHeight: 420,
    title: 'Escritoriio Runner',
    // Shown once there is something drawn, so that it does not flash white.
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      devTools: false,
    },
  };
}

/** A page of the app goes to another page of the app and nowhere else: never a web address, a file, or the link that pairs. */
export const decideNavigation = (url: string): 'allow' | 'refuse' => (isOwnUrl(url) ? 'allow' : 'refuse');

/** The app opens no window of any kind, whatever asks. */
export const decideWindowOpen = (): { readonly action: 'deny' } => ({ action: 'deny' });

/** What the page may be granted: nothing. No camera, no location, no notifications of its own (the main process shows those). */
const GRANTED_PERMISSIONS: ReadonlySet<string> = new Set();
export const decidePermission = (permission: string): boolean => GRANTED_PERMISSIONS.has(permission);

/** A second net under the policy: a request for anything that is not of the bundle is cancelled before it leaves. */
export const shouldCancelRequest = (url: string): boolean => !isOwnUrl(url);
