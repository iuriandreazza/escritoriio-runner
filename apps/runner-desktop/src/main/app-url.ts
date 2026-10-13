import { join, resolve, sep } from 'node:path';

/**
 * The app loads only its own bundle, under a scheme of its own: never a web address and never a file address, so that nothing a page
 * does can reach the network or the disk through it, and what is "our own" has one exact meaning.
 */
export const APP_SCHEME = 'escritoriio-app';
export const APP_HOST = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_ENTRY_URL = `${APP_ORIGIN}/index.html`;

/** Whether an address is one of the bundle: its scheme and host exactly, with no user, no password and no port. */
export function isOwnUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === `${APP_SCHEME}:` && parsed.hostname === APP_HOST && parsed.username === '' && parsed.password === '' && parsed.port === '';
  } catch {
    return false;
  }
}

/**
 * The file of the renderer folder that an address of the bundle stands for, or nothing for an address that is not one or that tries to leave the
 * folder. The path is read as it was written, before the address is normalized, so that `..` is seen however it is spelled (plain, encoded,
 * with a backslash) and not resolved away into something that looks harmless.
 */
export function fileForAppUrl(root: string, url: string): string | undefined {
  if (!isOwnUrl(url) || !url.startsWith(`${APP_ORIGIN}/`)) return undefined;
  const written = url.slice(APP_ORIGIN.length).split(/[?#]/, 1)[0] ?? '';
  const segments = written === '/' ? ['index.html'] : written.slice(1).split('/');
  const decoded: string[] = [];
  for (const segment of segments) {
    let name: string;
    try {
      name = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    if (name === '' || name === '.' || name === '..' || /[/\\\0]/.test(name)) return undefined;
    decoded.push(name);
  }
  const file = resolve(join(root, ...decoded));
  return file.startsWith(resolve(root) + sep) ? file : undefined;
}
