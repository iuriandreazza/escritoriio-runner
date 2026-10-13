import { readFile } from 'node:fs/promises';
import { protocol, session } from 'electron';
import { APP_SCHEME, fileForAppUrl } from '../app-url.ts';
import { contentTypeOf } from '../app-paths.ts';
import { CONTENT_SECURITY_POLICY, decidePermission, shouldCancelRequest } from '../window-policy.ts';

/** Before the app is ready: the scheme of the bundle is a standard, secure one, so that the page has an origin of its own and its scripts load as they do from a server. */
export function registerBundleScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

const SECURITY_HEADERS = { 'Content-Security-Policy': CONTENT_SECURITY_POLICY, 'X-Content-Type-Options': 'nosniff' } as const;

/** Serves the files of the renderer folder under the scheme, and nothing else: an address outside it is a 404, never a file of the disk. */
export function serveBundle(rendererDirectory: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = fileForAppUrl(rendererDirectory, request.url);
    if (!file) return new Response('Not found', { status: 404, headers: SECURITY_HEADERS });
    try {
      return new Response(new Uint8Array(await readFile(file)), { headers: { ...SECURITY_HEADERS, 'Content-Type': contentTypeOf(file) } });
    } catch {
      return new Response('Not found', { status: 404, headers: SECURITY_HEADERS });
    }
  });
}

/** What the page is never given, and what is stopped on its way out: every permission is refused, and any request that is not for the bundle is cancelled. */
export function hardenSession(): void {
  const { defaultSession } = session;
  defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(decidePermission(permission)));
  defaultSession.setPermissionCheckHandler((_contents, permission) => decidePermission(permission));
  defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*', 'file://*/*'] }, (details, callback) => callback({ cancel: shouldCancelRequest(details.url) }));
}
