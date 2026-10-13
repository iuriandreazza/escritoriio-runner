import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import type { ChannelName, Reply, Request, RunnerApi, RunnerEvent } from '../shared/channels.ts';
import { CHANNELS, eventSchema } from '../shared/channels.ts';
import type { z } from 'zod';
import { RunnerProvider } from './runner-state.tsx';

/** A fixture may be written `as const`: what a screen is given is read-only to it in any case. */
type Loose<T> = T extends readonly (infer U)[] ? readonly Loose<U>[] : T extends object ? { readonly [K in keyof T]: Loose<T[K]> } : T;
type ReplyInput<C extends ChannelName> = Loose<z.input<(typeof CHANNELS)[C]['reply']>>;
type Answer<C extends ChannelName> = ReplyInput<C> | ((request: Request<C>) => ReplyInput<C> | Promise<ReplyInput<C>>);
type Answers = { [C in ChannelName]?: Answer<C> };

/** The deviceName and the rest of a connected machine, as the main process would tell it. */
export const device = { host: 'office.example', deviceName: 'Work laptop', agentName: 'Robby', workspaceName: 'Acme' } as const;

export const connected = { state: 'connected', device, paused: false, pausedByOffice: false, pausedHere: false, retryInMs: null, slowRetry: false, lastError: null } as const;

const defaults: Answers = {
  'connection:get': connected,
  'tasks:get': { running: [], recent: [] },
  'approvals:list': [],
  'pairing:pending-link': null,
  'pairing:current': device,
  'folders:list': [],
  'agents:inspect': [],
  'mcp:list': [],
  'app:info': { appVersion: '1.2.3', runnerVersion: '0.2.0', platform: 'darwin', launchAtLogin: false, launchAtLoginSupported: true, updatesSupported: true, stateDirectory: '/home/me/.escritoriio-runner' },
  'app:check-update': { state: 'none' },
};

export interface FakeApi extends RunnerApi {
  /** What was asked of a channel, in order. */
  requests(channel: ChannelName): readonly unknown[];
  /** The main process pushes an event (checked against the real schema, as the preload does). */
  emit(event: z.input<typeof eventSchema>): void;
  /** Changes the answer of a channel from now on. */
  answer<C extends ChannelName>(channel: C, answer: Answer<C>): void;
}

/**
 * A stand-in for the preload: every answer goes through the real schema of its channel and every event through the real event schema, so that a
 * screen is tried against exactly the shapes the main process can send, with the same cuts to a length. A channel nobody answered refuses, with words.
 */
export function fakeApi(answers: Answers = {}): FakeApi {
  const table: Record<string, unknown> = { ...defaults, ...answers };
  const log = new Map<string, unknown[]>();
  const listeners = new Set<(event: RunnerEvent) => void>();

  async function call<C extends ChannelName>(channel: C, request: Request<C>): Promise<Reply<C>> {
    log.set(channel, [...(log.get(channel) ?? []), request]);
    CHANNELS[channel].request.parse(request);
    const answer = table[channel];
    if (answer === undefined) throw new Error(`The test gave no answer for ${channel}.`);
    const value = typeof answer === 'function' ? await (answer as (request: unknown) => unknown)(request) : answer;
    return CHANNELS[channel].reply.parse(value) as Reply<C>;
  }

  return {
    call: vi.fn(call) as RunnerApi['call'],
    onEvent(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    requests: (channel) => log.get(channel) ?? [],
    emit(event) {
      const parsed = eventSchema.parse(event);
      for (const listener of [...listeners]) listener(parsed);
    },
    answer(channel, answer) {
      table[channel] = answer;
    },
  };
}

/** A screen, drawn with the runner around it, as the page does. */
export function renderWithRunner(screen: ReactElement, api: FakeApi = fakeApi()) {
  return { api, ...render(<RunnerProvider api={api}>{screen}</RunnerProvider>) };
}

/** The text of a hostile office: markup that would run, a link that would open something, a right-to-left override, and a very long line. */
export const HOSTILE = {
  markup: '<img src=x onerror="document.title=1"> <script>alert(1)</script>',
  link: '[click](javascript:alert(1)) https://evil.example/ javascript:alert(1)',
  rtl: 'safe \u202Eevil\u202C text',
  long: 'x'.repeat(10_000),
} as const;
