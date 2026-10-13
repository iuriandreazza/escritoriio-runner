import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundleFile, contentTypeOf, electronDataDirectory, windowIconFile } from './app-paths.ts';

describe('where Electron keeps its own data', () => {
  it('is beside the state directory of the runner and never inside it, so that the runner’s settings are not where a browser engine writes', () => {
    expect(electronDataDirectory(join('/home', 'me', '.config', 'escritoriio-runner'))).toBe(join('/home', 'me', '.config', 'escritoriio-runner-electron'));
  });

  it('follows a state directory that was named, which keeps a trial run apart from the installed app', () => {
    expect(electronDataDirectory(join('/tmp', 'scratch', 'state'))).toBe(join('/tmp', 'scratch', 'state-electron'));
  });
});

describe('the icon of the window', () => {
  it('is the picture the packaging puts beside the bundle, in the folder of the app, where the sources have it too', () => {
    expect(windowIconFile('/opt/app/dist/main', 'win32')).toBe(join('/opt/app', 'build', 'icon.png'));
    expect(windowIconFile('/opt/app/dist/main', 'linux')).toBe(join('/opt/app', 'build', 'icon.png'));
  });

  it('is none on macOS, where the icon of the bundle is the one the Dock and the window show', () => {
    expect(windowIconFile('/opt/app/dist/main', 'darwin')).toBeUndefined();
  });
});

describe('the files of the bundle', () => {
  it('are the preload and the renderer beside the main process, in the folders the build makes', () => {
    expect(bundleFile('/opt/app/dist/main', 'preload')).toBe(join('/opt/app/dist', 'preload', 'index.cjs'));
    expect(bundleFile('/opt/app/dist/main', 'renderer')).toBe(join('/opt/app/dist', 'renderer'));
  });

  it('are served with the type of what they are, and an unknown type is not guessed at', () => {
    expect(contentTypeOf('/x/index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeOf('/x/a.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeOf('/x/a.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeOf('/x/a.svg')).toBe('image/svg+xml');
    expect(contentTypeOf('/x/a.png')).toBe('image/png');
    expect(contentTypeOf('/x/a.exe')).toBe('application/octet-stream');
  });
});
