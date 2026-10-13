/**
 * A failure whose words were written for the owner of this machine, on purpose, with no path and nothing of what a program or the office said in
 * them: a screen may show them as they are. Any other error is a mistake or a failure of the system, whose words may hold a path, and is not passed on.
 */
export class OwnerError extends Error {
  /** What a window shows when it is not the whole of `message`, which a terminal may show (what a program said of itself, say). */
  readonly windowWords: string;

  constructor(message: string, options?: { readonly cause?: unknown; readonly windowWords?: string }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OwnerError';
    this.windowWords = options?.windowWords ?? message;
  }
}
