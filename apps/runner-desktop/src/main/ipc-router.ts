import { OwnerError } from '@escritoriio/runner';
import { z } from 'zod';
import type { Answer, ChannelName, Request, RunnerEvent } from '../shared/channels.ts';
import { CHANNELS, eventSchema, isChannelName, REFUSED } from '../shared/channels.ts';
import { isOwnUrl } from './app-url.ts';

/** Who is calling, as the main process saw it at the wire: the page's own claims are never part of this. */
export interface Sender {
  /** The window of the app, and not another page that has the same preload. */
  readonly fromOurWindow: boolean;
  /** The top frame: a frame inside the page is not the page. */
  readonly isMainFrame: boolean;
  /** Where the frame that called was loaded from. Nothing when the frame is gone. */
  readonly frameUrl: string | undefined;
}

/** What each channel does. Each is given a request that was validated against the table and gives something that is validated against it again. */
export type Handlers = { readonly [C in ChannelName]: (request: Request<C>) => Promise<unknown> };

export interface Router {
  handle(sender: Sender, wire: unknown): Promise<Answer<unknown>>;
}

const wireSchema = z.strictObject({ channel: z.string(), payload: z.unknown() });

const NOT_READABLE = 'The app could not read its own answer.';
const UNKNOWN_FAILURE = 'Something went wrong.';
const MAX_WORDS = 1_000;

/**
 * Only what was thrown on purpose, with words for the owner (an `OwnerError`), is said to the window. Any other error is a mistake or a failure of the
 * system, whose words may hold a path or what a program said, and the window is told only that something went wrong.
 */
const wordsOf = (error: unknown): string => (error instanceof OwnerError && error.windowWords !== '' ? error.windowWords.slice(0, MAX_WORDS) : UNKNOWN_FAILURE);

/**
 * The one place a call from the window is let in or not. It checks, in this order: that the caller is the top frame of our window, loaded from the
 * bundle; that the call has the shape of one; that the channel is in the table; that the request is what the channel takes. Whatever fails is
 * refused with the same words, and logged by channel and by the path of the field, never by what was sent: a payload may hold a code or a token.
 */
export function createRouter({ handlers, log }: { readonly handlers: Handlers; readonly log: (line: string) => void }): Router {
  const refuse = (why: string): Answer<never> => {
    log(`Refused a call: ${why}.`);
    return { ok: false, error: REFUSED };
  };

  return {
    async handle(sender, wire) {
      if (!sender.fromOurWindow || !sender.isMainFrame || !isOwnUrl(sender.frameUrl)) return refuse('the caller is not the window of the app');
      const call = wireSchema.safeParse(wire);
      if (!call.success) return refuse('it is not shaped as a call');
      const { channel, payload } = call.data;
      if (!isChannelName(channel)) return refuse('no such channel');

      const request = CHANNELS[channel].request.safeParse(payload);
      if (!request.success) return refuse(`the request for ${channel} is not what it takes (${request.error.issues.map((issue) => issue.path.join('.') || 'it').join(', ')})`);

      let value: unknown;
      try {
        value = await (handlers[channel] as (request: unknown) => Promise<unknown>)(request.data);
      } catch (error) {
        return { ok: false, error: wordsOf(error) };
      }

      const reply = CHANNELS[channel].reply.safeParse(value);
      if (!reply.success) {
        log(`The answer of ${channel} is not what the channel promises (${reply.error.issues.map((issue) => issue.path.join('.') || 'it').join(', ')}).`);
        return { ok: false, error: NOT_READABLE };
      }
      return { ok: true, value: reply.data };
    },
  };
}

/** What the main process tells the window: checked against the same table of events as the window reads, so that what is sent is what it expects. */
export function createEventPusher(send: (event: RunnerEvent) => void, log: (line: string) => void): { push(event: unknown): void } {
  return {
    push(event) {
      const checked = eventSchema.safeParse(event);
      if (!checked.success) {
        log(`An event for the window was not what the window expects: ${checked.error.issues.map((issue) => issue.path.join('.') || 'it').join(', ')}.`);
        return;
      }
      send(checked.data);
    },
  };
}
