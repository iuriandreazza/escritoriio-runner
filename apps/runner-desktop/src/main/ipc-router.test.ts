import { OwnerError } from '@escritoriio/runner';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelName } from '../shared/channels.ts';
import { CHANNEL_NAMES, REFUSED } from '../shared/channels.ts';
import { APP_ENTRY_URL } from './app-url.ts';
import type { Handlers, Sender } from './ipc-router.ts';
import { createEventPusher, createRouter } from './ipc-router.ts';

const ours: Sender = { fromOurWindow: true, isMainFrame: true, frameUrl: APP_ENTRY_URL };

function routerWith(overrides: Partial<Handlers> = {}) {
  const log = vi.fn<(line: string) => void>();
  const handlers = Object.fromEntries(CHANNEL_NAMES.map((name) => [name, vi.fn(() => Promise.resolve({}))])) as unknown as Handlers;
  Object.assign(handlers, overrides);
  return { router: createRouter({ handlers, log }), handlers: handlers as unknown as Record<ChannelName, ReturnType<typeof vi.fn>>, log };
}

describe('a call from the window', () => {
  it('is validated, given to the handler, and its answer validated again', async () => {
    const { router, handlers } = routerWith({ 'pause:set': vi.fn(() => Promise.resolve({ changed: true, extra: 'dropped' })) });
    expect(await router.handle(ours, { channel: 'pause:set', payload: { paused: true } })).toEqual({ ok: true, value: { changed: true } });
    expect(handlers['pause:set']).toHaveBeenCalledWith({ paused: true });
  });

  it('is refused when it does not come from our window, from its main frame, or from the bundle', async () => {
    const { router, handlers } = routerWith();
    const call = { channel: 'pause:set', payload: { paused: true } };
    for (const sender of [
      { ...ours, fromOurWindow: false },
      { ...ours, isMainFrame: false },
      { ...ours, frameUrl: 'https://example.com/' },
      { ...ours, frameUrl: undefined },
      { ...ours, frameUrl: 'file:///tmp/index.html' },
    ]) {
      expect(await router.handle(sender, call)).toEqual({ ok: false, error: REFUSED });
    }
    expect(handlers['pause:set']).not.toHaveBeenCalled();
  });

  it('is refused with the same words for an unknown channel, a name that an object inherits and a malformed envelope', async () => {
    const { router } = routerWith();
    const refused = { ok: false, error: REFUSED };
    expect(await router.handle(ours, { channel: 'shell:exec', payload: {} })).toEqual(refused);
    expect(await router.handle(ours, { channel: 'constructor', payload: {} })).toEqual(refused);
    expect(await router.handle(ours, { channel: '__proto__', payload: {} })).toEqual(refused);
    expect(await router.handle(ours, 'pause:set')).toEqual(refused);
    expect(await router.handle(ours, null)).toEqual(refused);
    expect(await router.handle(ours, { channel: 'pause:set', payload: { paused: true }, more: 1 })).toEqual(refused);
    expect(await router.handle(ours, {})).toEqual(refused);
  });

  it('is refused when the payload is not what the channel takes, and the handler is not reached', async () => {
    const { router, handlers } = routerWith();
    const hostile: [ChannelName, unknown][] = [
      ['pause:set', { paused: 'yes' }],
      ['pause:set', {}],
      ['pause:set', null],
      ['pause:set', { paused: true, path: '/' }],
      ['pause:set', JSON.parse('{"paused": true, "__proto__": {"polluted": true}}')],
      ['tasks:cancel', { taskId: 'x'.repeat(65) }],
      ['folders:add', { access: 'edit', approval: 'auto', isolation: 'in-place', trusted: true, agent: null, path: '/Users/someone' }],
      ['folders:update', { label: 'site', changes: { realPath: '/' } }],
      ['agents:set-path', { kind: 'claude-code', path: '/tmp/evil' }],
      ['agents:set-path', { kind: 'not-an-agent' }],
      ['mcp:add', { label: 'x', command: 'sh', args: Array.from({ length: 51 }, () => 'a'), env: [], folder: null }],
      ['pairing:pair', { linkId: 'a', server: 'https://x', code: 'ABCDEFGH' }],
      ['pairing:pair', { server: 'https://x'.repeat(1_000), code: 'ABCDEFGH' }],
      ['approvals:answer', { taskId: 't', askId: 'a', answer: 'maybe' }],
      ['approvals:answer', { taskId: 't', answer: 'approved' }],
      ['app:set-launch-at-login', { enabled: 1 }],
      ['connection:get', { anything: true }],
    ];
    for (const [channel, payload] of hostile) {
      expect(await router.handle(ours, { channel, payload }), `${channel} ${JSON.stringify(payload)}`).toEqual({ ok: false, error: REFUSED });
    }
    for (const name of CHANNEL_NAMES) expect(handlers[name]).not.toHaveBeenCalled();
  });

  it('says what a handler says when it fails on purpose with words for the owner, and nothing of what is not that', async () => {
    const { router } = routerWith({
      'pause:set': () => Promise.reject(new OwnerError('The settings cannot be read.')),
      'tasks:cancel': () => Promise.reject({ secret: 'token' }),
      'doctor:run': () => Promise.reject(new Error("EACCES: permission denied, open '/Users/ana/.config/escritoriio/policy.json'")),
      'folders:list': () => Promise.reject(new OwnerError('A program said this.', { windowWords: 'It did not start.' })),
    });
    expect(await router.handle(ours, { channel: 'pause:set', payload: { paused: true } })).toEqual({ ok: false, error: 'The settings cannot be read.' });
    expect(await router.handle(ours, { channel: 'tasks:cancel', payload: { taskId: 't' } })).toEqual({ ok: false, error: 'Something went wrong.' });
    const withPath = await router.handle(ours, { channel: 'doctor:run', payload: {} });
    expect(withPath).toEqual({ ok: false, error: 'Something went wrong.' });
    expect(JSON.stringify(withPath)).not.toContain('/Users/ana');
    expect(await router.handle(ours, { channel: 'folders:list', payload: {} })).toEqual({ ok: false, error: 'It did not start.' });
  });

  it('is not fooled by an error that only looks like one for the owner', async () => {
    const lookalike = Object.assign(new Error('/Users/ana/secret'), { name: 'OwnerError', windowWords: '/Users/ana/secret' });
    const { router } = routerWith({ 'pause:set': () => Promise.reject(lookalike) });
    expect(await router.handle(ours, { channel: 'pause:set', payload: { paused: true } })).toEqual({ ok: false, error: 'Something went wrong.' });
  });

  it('does not pass on an answer that is not the one the channel promised, and never says what was in it', async () => {
    const { router, log } = routerWith({ 'pause:set': () => Promise.resolve({ changed: 'maybe', token: 'secret-token' }) });
    const answer = await router.handle(ours, { channel: 'pause:set', payload: { paused: true } });
    expect(answer.ok).toBe(false);
    expect(JSON.stringify(answer)).not.toContain('secret-token');
    expect(log.mock.calls.flat().join(' ')).not.toContain('secret-token');
  });

  it('logs a refusal without the payload', async () => {
    const { router, log } = routerWith();
    await router.handle(ours, { channel: 'pairing:pair', payload: { server: 'https://x', code: 'ZZZZZZZZ', extra: 1 } });
    expect(log).toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).not.toContain('ZZZZZZZZ');
  });
});

describe('what the main process pushes to the window', () => {
  it('is validated before it is sent', () => {
    const send = vi.fn();
    const log = vi.fn();
    const pusher = createEventPusher(send, log);
    pusher.push({ kind: 'notice', message: 'ok' });
    pusher.push({ kind: 'exec', command: 'rm -rf /' });
    pusher.push({ kind: 'notice', message: 'x'.repeat(5_000) });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toEqual({ kind: 'notice', message: 'ok' });
    expect((send.mock.calls[1]?.[0] as { message: string }).message.length).toBeLessThanOrEqual(1_000);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
