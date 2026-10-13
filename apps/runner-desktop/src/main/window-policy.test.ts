import { describe, expect, it } from 'vitest';
import { APP_ENTRY_URL, APP_ORIGIN } from './app-url.ts';
import { CONTENT_SECURITY_POLICY, decideNavigation, decidePermission, decideWindowOpen, shouldCancelRequest, windowOptions } from './window-policy.ts';

describe('the options of the window', () => {
  const { webPreferences } = windowOptions('/opt/app/preload/index.cjs');

  it('isolates the page from Node and from the preload, and sandboxes it', () => {
    expect(webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true });
  });

  it('turns off what could let remote content or Node in by another door', () => {
    expect(webPreferences).toMatchObject({ nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false, allowRunningInsecureContent: false, experimentalFeatures: false });
    expect(webPreferences).not.toHaveProperty('enableRemoteModule');
  });

  it('has no developer tools, which would give whoever opens them a console in the page that holds the preload', () => {
    expect(webPreferences).toMatchObject({ devTools: false });
  });

  it('loads the preload it is given', () => {
    expect(webPreferences?.preload).toBe('/opt/app/preload/index.cjs');
  });

  it('shows the icon it is given, and none when it is not given one', () => {
    expect(windowOptions('/p', '/opt/app/build/icon.png').icon).toBe('/opt/app/build/icon.png');
    expect(windowOptions('/p')).not.toHaveProperty('icon');
  });

  it('does not show before there is something to show', () => {
    expect(windowOptions('/p').show).toBe(false);
  });
});

describe('the content security policy', () => {
  const directives = Object.fromEntries(CONTENT_SECURITY_POLICY.split(';').map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));

  it('allows nothing by default and nothing from the network', () => {
    expect(directives['default-src']).toEqual(["'none'"]);
    expect(directives['connect-src']).toEqual(["'none'"]);
  });

  it('allows scripts and styles only from the bundle, never inline or eval', () => {
    expect(directives['script-src']).toEqual(["'self'"]);
    expect(directives['style-src']).toEqual(["'self'"]);
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/);
  });

  it('allows images from the bundle and data, and closes the doors a page can leave by', () => {
    expect(directives['img-src']).toEqual(["'self'", 'data:']);
    expect(directives['base-uri']).toEqual(["'none'"]);
    expect(directives['form-action']).toEqual(["'none'"]);
    expect(directives['frame-ancestors']).toEqual(["'none'"]);
  });
});

describe('navigation', () => {
  it('stays inside the bundle', () => {
    expect(decideNavigation(APP_ENTRY_URL)).toBe('allow');
    expect(decideNavigation(`${APP_ORIGIN}/other.html`)).toBe('allow');
  });

  it.each(['https://example.com/', 'http://localhost:8201/', 'file:///etc/passwd', 'escritoriio://pair?server=a&code=b', 'about:blank', 'javascript:1', ''])('refuses to go to %s', (url) => {
    expect(decideNavigation(url)).toBe('refuse');
  });

  it('never opens a window, whatever it is asked for', () => {
    expect(decideWindowOpen()).toEqual({ action: 'deny' });
  });

  it('never grants a permission', () => {
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'fullscreen']) expect(decidePermission(permission)).toBe(false);
  });

  it('cancels every request that is not for the bundle', () => {
    expect(shouldCancelRequest('https://example.com/x.js')).toBe(true);
    expect(shouldCancelRequest('wss://example.com/')).toBe(true);
    expect(shouldCancelRequest('file:///etc/passwd')).toBe(true);
    expect(shouldCancelRequest(`${APP_ORIGIN}/assets/a.js`)).toBe(false);
  });
});
