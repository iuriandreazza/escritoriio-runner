import { z } from 'zod';
import type { ChannelName, Reply, Request, RunnerApi } from '../shared/channels.ts';
import { CHANNELS, eventSchema, isChannelName, REFUSED, WIRE } from '../shared/channels.ts';

/** What the preload uses of Electron's renderer side, so that its rules can be tried without Electron. */
export interface IpcPort {
  invoke(wire: string, message: unknown): Promise<unknown>;
  /** Listens to what the main process pushes. Gives what stops it. */
  listen(listener: (payload: unknown) => void): () => void;
}

const answerSchema = z.union([z.object({ ok: z.literal(true), value: z.unknown() }), z.object({ ok: z.literal(false), error: z.string().min(1).max(2_000) })]);

/**
 * The API the page is given: one call and one listener, both checked. A call is refused here when the channel is not in the table or the request is not
 * what it takes (the main process checks it again and is the one that decides); what comes back is an answer or a refusal with words, never a thrown
 * object of the main process. What the main process pushes reaches a listener only as an event of a kind the app has.
 */
export function createApi(ipc: IpcPort): RunnerApi {
  return {
    async call<C extends ChannelName>(channel: C, request: Request<C>): Promise<Reply<C>> {
      if (!isChannelName(channel) || !CHANNELS[channel].request.safeParse(request).success) throw new Error(REFUSED);
      const answer = answerSchema.safeParse(await ipc.invoke(WIRE.call, { channel, payload: request }));
      if (!answer.success) throw new Error(REFUSED);
      if (!answer.data.ok) throw new Error(answer.data.error);
      return answer.data.value as Reply<C>;
    },

    onEvent(listener) {
      return ipc.listen((payload) => {
        const event = eventSchema.safeParse(payload);
        if (!event.success) return;
        try {
          listener(event.data);
        } catch {
          // A screen that fails is its own: it does not stop the next one from hearing.
        }
      });
    },
  };
}
