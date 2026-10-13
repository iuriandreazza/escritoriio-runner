import { describe, expect, it } from 'vitest';
import { sandboxSupport } from './sandbox-support.ts';

const having = (...paths: string[]) => (path: string) => Promise.resolve(paths.includes(path));

describe('whether the system can confine the commands of Claude Code', () => {
  it('can on macOS, with nothing installed and whatever the PATH', async () => {
    expect(await sandboxSupport('darwin', undefined, having())).toEqual({ available: true });
  });

  it('cannot on Windows or on a system it has not been tried on, and says so without asking the file system', async () => {
    const never = () => Promise.reject(new Error('not asked'));
    expect(await sandboxSupport('win32', 'C:\\Windows', never)).toEqual({ available: false, why: expect.stringContaining('Windows') });
    expect(await sandboxSupport('freebsd', '/usr/bin', never)).toEqual({ available: false, why: expect.stringContaining('this system') });
  });

  it('can on Linux with bubblewrap and socat, found in the directories of the PATH it was given', async () => {
    expect(await sandboxSupport('linux', '/usr/local/bin:/usr/bin', having('/usr/bin/bwrap', '/usr/local/bin/socat'))).toEqual({ available: true });
  });

  it('cannot on Linux without one of them, and names the package to install', async () => {
    const withoutSocat = await sandboxSupport('linux', '/usr/bin', having('/usr/bin/bwrap'));
    expect(withoutSocat).toEqual({ available: false, why: expect.stringContaining('socat could not be found. Install it') });
    const withoutBoth = await sandboxSupport('linux', '/usr/bin', having());
    expect(withoutBoth).toEqual({ available: false, why: expect.stringContaining('bubblewrap and socat could not be found. Install them') });
  });

  it('does not take a relative or an empty directory of the PATH for a place to look in', async () => {
    const asked: string[] = [];
    await sandboxSupport('linux', ':bin:./tools:/usr/bin', (path) => (asked.push(path), Promise.resolve(false)));
    expect(asked).toEqual(['/usr/bin/bwrap', '/usr/bin/socat']);
  });

  it('takes a file system that cannot answer for a program that is not there', async () => {
    expect(await sandboxSupport('linux', '/usr/bin', () => Promise.reject(new Error('EACCES')))).toMatchObject({ available: false });
  });
});
