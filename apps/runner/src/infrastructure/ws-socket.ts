import { MAX_RUNNER_MESSAGE_BYTES } from '@escritoriio/runner-protocol';
import type { RawData } from 'ws';
import { WebSocket } from 'ws';
import type { SocketFactory } from '../application/ports.ts';
import type { ConnectionEnd } from '../domain/connection-end.ts';
import { describeNetworkError } from './network-error.ts';

// Closing a connection waits for the other side to answer, and a link that is dead never does.
const CLOSE_GRACE_MS = 1_000;

/**
 * The runner socket over `ws`. The token goes in the `Authorization` header, as the office reads it, and no `Origin` is sent: a runner
 * is not a page, and the office has no use for one. Frames are small and few, so they are not compressed.
 */
export const webSocketFactory: SocketFactory = {
  open(address, token, handlers) {
    const socket = new WebSocket(address, { headers: { Authorization: `Bearer ${token}` }, maxPayload: MAX_RUNNER_MESSAGE_BYTES, perMessageDeflate: false });
    // Once the end was told, or the runner hung up, nothing more is: the one that listens has gone on to another connection.
    let over = false;
    const end = (how: ConnectionEnd) => {
      if (over) return;
      over = true;
      handlers.onEnd(how);
    };

    socket.on('open', () => {
      if (!over) handlers.onOpen();
    });
    socket.on('message', (data: RawData, isBinary: boolean) => {
      // The runner protocol is text.
      if (!over && !isBinary) handlers.onMessage(data.toString());
    });
    // The office answered the request to open with a status instead of opening. Listening for that is what stops the library from
    // aborting the request itself, so the request is ended here, once the status is told.
    socket.on('unexpected-response', (_request, response) => {
      end({ kind: 'refused', status: response.statusCode ?? 0 });
      socket.terminate();
    });
    socket.on('error', (error) => end({ kind: 'failed', reason: `the connection failed: ${describeNetworkError(error)}` }));
    // The words that come with a close frame are not passed on: nothing the office writes there is shown.
    socket.on('close', (code) => end({ kind: 'closed', code }));

    return {
      send(message) {
        if (!over && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      },
      close() {
        over = true;
        socket.close(1000, 'The runner stopped');
        const grace = setTimeout(() => socket.terminate(), CLOSE_GRACE_MS);
        grace.unref();
        socket.once('close', () => clearTimeout(grace));
      },
    };
  },
};
