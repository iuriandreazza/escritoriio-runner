import { basename, dirname, extname, join } from 'node:path';

/**
 * Where Electron keeps what it writes for itself (caches, the lock of the single instance): a folder beside the state directory of the runner, not inside it,
 * which is for the settings and the token alone. It follows that directory, so a run with a state directory of its own is a run apart.
 */
export const electronDataDirectory = (stateDirectory: string): string => join(dirname(stateDirectory), `${basename(stateDirectory)}-electron`);

/** A file of the built app, from the folder of the main process (`dist/main`): the build puts each process in a folder of its own beside it. */
export const bundleFile = (mainDirectory: string, part: 'preload' | 'renderer'): string => (part === 'preload' ? join(dirname(mainDirectory), 'preload', 'index.cjs') : join(dirname(mainDirectory), 'renderer'));

/** The picture a window shows on Windows and Linux, which the packaging keeps in `build` of the app, as the sources do. macOS takes it from the bundle, so it has none. */
export const windowIconFile = (mainDirectory: string, platform: NodeJS.Platform): string | undefined => (platform === 'darwin' ? undefined : join(dirname(dirname(mainDirectory)), 'build', 'icon.png'));

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

export const contentTypeOf = (file: string): string => TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
