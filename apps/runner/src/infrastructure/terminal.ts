import { createInterface } from 'node:readline';
import type { Terminal } from '../application/ports.ts';

export function createTerminal(): Terminal {
  return {
    out: (line) => void process.stdout.write(`${line}\n`),
    err: (line) => void process.stderr.write(`${line}\n`),
    ask: (question, signal) =>
      new Promise((resolve) => {
        const lines = createInterface({ input: process.stdin, output: process.stdout });
        lines.once('close', () => {
          signal?.removeEventListener('abort', takeAway);
          resolve('');
        });
        // A question that can be taken away is one asked while the program runs for something else, so Ctrl-C at it is still Ctrl-C of the
        // program: the terminal hands it to the interface when it is waiting for a line, and the program would never hear it. It is told to the
        // listeners of the program and not sent as a signal to it, which on Windows ends a process whatever listens.
        if (signal) lines.once('SIGINT', () => {
          lines.close();
          process.emit('SIGINT');
        });
        function takeAway(): void {
          lines.close();
        }
        if (signal?.aborted) return lines.close();
        signal?.addEventListener('abort', takeAway, { once: true });
        lines.question(question, (answer) => {
          resolve(answer);
          lines.close();
        });
      }),
    onInterrupt(handler) {
      const onInterrupt = (): void => handler('SIGINT');
      const onTerminate = (): void => handler('SIGTERM');
      // Once: a second Ctrl-C, when stopping takes too long, ends the process as it would have without a handler.
      process.once('SIGINT', onInterrupt);
      process.once('SIGTERM', onTerminate);
      return () => {
        process.off('SIGINT', onInterrupt);
        process.off('SIGTERM', onTerminate);
      };
    },
  };
}
