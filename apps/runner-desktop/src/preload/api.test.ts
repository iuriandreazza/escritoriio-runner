import { describe, expect, it, vi } from 'vitest';
import { REFUSED, WIRE } from '../shared/channels.ts';
import type { IpcPort } from './api.ts';
import { createApi } from './api.ts';

function ipcAnswering(answer: unknown) {
  const listeners = new Set<(payload: unknown) => void>();
  const ipc: IpcPort = {
    invoke: vi.fn(() => Promise.resolve(answer)),
    listen: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return { ipc, deliver: (payload: unknown) => listeners.forEach((listener) => listener(payload)), listeners };
}

describe('a call through the preload', () => {
  it('goes over the one wire, as a channel and a request, and gives the value of the answer', async () => {
    const { ipc } = ipcAnswering({ ok: true, value: { changed: true } });
    expect(await createApi(ipc).call('pause:set', { paused: true })).toEqual({ changed: true });
    expect(ipc.invoke).toHaveBeenCalledWith(WIRE.call, { channel: 'pause:set', payload: { paused: true } });
  });

  it('is refused before it leaves when the channel is not one the app has', async () => {
    const { ipc } = ipcAnswering({ ok: true, value: {} });
    const api = createApi(ipc);
    await expect(api.call('shell:exec' as never, {} as never)).rejects.toThrow(REFUSED);
    await expect(api.call('constructor' as never, {} as never)).rejects.toThrow(REFUSED);
    expect(ipc.invoke).not.toHaveBeenCalled();
  });

  it('is refused before it leaves when the request is not what the channel takes', async () => {
    const { ipc } = ipcAnswering({ ok: true, value: {} });
    const api = createApi(ipc);
    await expect(api.call('pause:set', { paused: 'yes' } as never)).rejects.toThrow(REFUSED);
    await expect(api.call('folders:add', { access: 'edit', approval: 'auto', isolation: 'in-place', trusted: true, agent: null, path: '/' } as never)).rejects.toThrow(REFUSED);
    expect(ipc.invoke).not.toHaveBeenCalled();
  });

  it('fails with the words the main process gave, and with nothing else', async () => {
    await expect(createApi(ipcAnswering({ ok: false, error: 'The settings cannot be read.' }).ipc).call('connection:get', {})).rejects.toThrow('The settings cannot be read.');
  });

  it('fails with the fixed words when what came back is not an answer', async () => {
    for (const nonsense of [undefined, null, 'ok', { ok: 'yes' }, { value: 1 }, { ok: false }]) {
      await expect(createApi(ipcAnswering(nonsense).ipc).call('connection:get', {})).rejects.toThrow(REFUSED);
    }
  });
});

describe('what the main process pushes', () => {
  it('reaches a listener when it is an event of a kind the app has, and not when it is anything else', () => {
    const { ipc, deliver } = ipcAnswering(undefined);
    const heard: unknown[] = [];
    createApi(ipc).onEvent((event) => heard.push(event));
    deliver({ kind: 'notice', message: 'hello' });
    deliver({ kind: 'exec', command: 'rm' });
    deliver('hello');
    deliver(undefined);
    expect(heard).toEqual([{ kind: 'notice', message: 'hello' }]);
  });

  it('stops when told to', () => {
    const { ipc, deliver, listeners } = ipcAnswering(undefined);
    const heard: unknown[] = [];
    const stop = createApi(ipc).onEvent((event) => heard.push(event));
    stop();
    deliver({ kind: 'notice', message: 'late' });
    expect(heard).toEqual([]);
    expect(listeners.size).toBe(0);
  });

  it('is not harmed by a listener that throws', () => {
    const { ipc, deliver } = ipcAnswering(undefined);
    const heard: unknown[] = [];
    const api = createApi(ipc);
    api.onEvent(() => {
      throw new Error('a screen failed');
    });
    api.onEvent((event) => heard.push(event));
    expect(() => deliver({ kind: 'notice', message: 'x' })).not.toThrow();
    expect(heard).toHaveLength(1);
  });
});

describe('what the preload gives the page', () => {
  it('is the two calls of the API and nothing else', () => {
    expect(Object.keys(createApi(ipcAnswering(undefined).ipc)).sort()).toEqual(['call', 'onEvent']);
  });
});
