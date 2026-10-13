import { describe, expect, it, vi } from 'vitest';
import type { UpdaterPort } from './update-service.ts';
import { createUpdateService } from './update-service.ts';

function setUp(port: Partial<UpdaterPort> | undefined, answers: boolean[] = [true, true]) {
  const asked: string[] = [];
  const dialog = {
    confirm: vi.fn((request: { title: string }) => {
      asked.push(request.title);
      return Promise.resolve(answers.shift() ?? false);
    }),
  };
  const full: UpdaterPort | undefined = port && {
    check: () => Promise.resolve(undefined),
    download: () => Promise.resolve(),
    installAndRestart: () => undefined,
    ...port,
  };
  return { service: createUpdateService({ port: full, dialog, log: () => undefined }), dialog, asked };
}

describe('looking for an update', () => {
  it('says that there is none, or which version is there, and downloads nothing', async () => {
    const download = vi.fn(() => Promise.resolve());
    const none = setUp({ download });
    expect(await none.service.check()).toEqual({ state: 'none' });
    const some = setUp({ check: () => Promise.resolve({ version: '1.2.3' }), download });
    expect(await some.service.check()).toEqual({ state: 'available', version: '1.2.3' });
    expect(download).not.toHaveBeenCalled();
    expect(some.dialog.confirm).not.toHaveBeenCalled();
  });

  it('says in words that it cannot look when the app is not an installed one', async () => {
    const { service } = setUp(undefined);
    expect(await service.check()).toMatchObject({ state: 'unavailable' });
    expect(await service.accept()).toMatchObject({ state: 'unavailable' });
  });

  it('says what went wrong, without stopping anything', async () => {
    const { service } = setUp({ check: () => Promise.reject(new Error('offline')) });
    expect(await service.check()).toEqual({ state: 'error', message: expect.stringContaining('offline') });
  });

  it('tells whoever listens', async () => {
    const { service } = setUp({ check: () => Promise.resolve({ version: '2.0.0' }) });
    const heard: string[] = [];
    service.subscribe((update) => heard.push(update.state));
    await service.check();
    expect(heard).toEqual(['checking', 'available']);
  });
});

describe('accepting an update', () => {
  it('downloads only after a yes, and installs only after a second yes', async () => {
    const download = vi.fn(() => Promise.resolve());
    const installAndRestart = vi.fn();
    const { service, asked } = setUp({ check: () => Promise.resolve({ version: '1.2.3' }), download, installAndRestart }, [true, true]);
    await service.check();
    expect(await service.accept()).toEqual({ state: 'downloaded', version: '1.2.3' });
    expect(download).toHaveBeenCalledTimes(1);
    expect(installAndRestart).toHaveBeenCalledTimes(1);
    expect(asked).toHaveLength(2);
  });

  it('downloads nothing on a no, and the update stays on offer', async () => {
    const download = vi.fn(() => Promise.resolve());
    const { service } = setUp({ check: () => Promise.resolve({ version: '1.2.3' }), download }, [false]);
    await service.check();
    expect(await service.accept()).toEqual({ state: 'available', version: '1.2.3' });
    expect(download).not.toHaveBeenCalled();
  });

  it('installs nothing on a no to the restart, and the download is kept for later', async () => {
    const installAndRestart = vi.fn();
    const { service } = setUp({ check: () => Promise.resolve({ version: '1.2.3' }), installAndRestart }, [true, false]);
    await service.check();
    expect(await service.accept()).toEqual({ state: 'downloaded', version: '1.2.3' });
    expect(installAndRestart).not.toHaveBeenCalled();
  });

  it('starts one dialog and one download, however many times it is asked at once', async () => {
    const download = vi.fn(() => Promise.resolve());
    const installAndRestart = vi.fn();
    const { service, asked } = setUp({ check: () => Promise.resolve({ version: '1.2.3' }), download, installAndRestart }, [true, true]);
    await service.check();
    const together = await Promise.all([service.accept(), service.accept(), service.accept()]);
    expect(together.every((state) => state.state === 'downloaded')).toBe(true);
    expect(download).toHaveBeenCalledTimes(1);
    expect(installAndRestart).toHaveBeenCalledTimes(1);
    expect(asked).toHaveLength(2);
  });

  it('can be accepted again once the earlier acceptance ended', async () => {
    const { service, asked } = setUp({ check: () => Promise.resolve({ version: '1.2.3' }) }, [false, false]);
    await service.check();
    await service.accept();
    await service.accept();
    expect(asked).toHaveLength(2);
  });

  it('has nothing to accept when no update was found', async () => {
    const { service, dialog } = setUp({});
    expect(await service.accept()).toEqual({ state: 'idle' });
    expect(dialog.confirm).not.toHaveBeenCalled();
  });

  it('says what went wrong when the download fails', async () => {
    const { service } = setUp({ check: () => Promise.resolve({ version: '1.2.3' }), download: () => Promise.reject(new Error('signature does not match')) });
    await service.check();
    expect(await service.accept()).toEqual({ state: 'error', version: '1.2.3', message: expect.stringContaining('signature') });
  });
});
