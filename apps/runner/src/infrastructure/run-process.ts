import { spawn } from 'node:child_process';

export interface ProcessOptions {
  readonly cwd: string;
  /** The whole environment of the process: nothing is added from the runner's own. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** The program is stopped, with whatever it started, when this aborts. */
  readonly signal?: AbortSignal | undefined;
}

export interface ProcessResult {
  /** Null when the process did not end by itself: it was stopped, or a signal ended it. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the process was stopped here, and why. */
  readonly stopped: 'timeout' | 'too-much-output' | 'aborted' | undefined;
}

/**
 * Starts a program and waits for it. The answer is what it did, and a program that ends with an error is an answer, not a failure of
 * this function: it rejects only when the program could not be started at all (it is not installed, say), with the error of the
 * operating system. No shell is involved, so no argument is read as anything but itself, and the program has no input to wait for.
 */
export type RunProcess = (file: string, args: readonly string[], options: ProcessOptions) => Promise<ProcessResult>;

/** What a program may say, the two outputs together, before it is stopped: what is asked of the programs run here is a few lines. */
export const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

const onWindows = process.platform === 'win32';

export const runProcess: RunProcess = (file, args, options) =>
  new Promise((resolve, reject) => {
    const { signal } = options;
    if (signal?.aborted) return resolve({ exitCode: null, stdout: '', stderr: '', stopped: 'aborted' });
    // A program of its own group, so that what it starts goes with it: a script that was killed would otherwise leave its children holding the pipes, and the end of it would never be seen.
    const child = spawn(file, [...args], { cwd: options.cwd, env: { ...options.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: !onWindows });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let stopped: ProcessResult['stopped'];
    const kill = (): void => {
      try {
        if (child.pid !== undefined && !onWindows) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // It ended in the meantime, which is what was wanted.
      }
    };
    const stop = (why: NonNullable<ProcessResult['stopped']>): void => {
      stopped ??= why;
      kill();
    };
    const onAbort = (): void => stop('aborted');
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs);
    const finished = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const keep = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PROCESS_OUTPUT_BYTES) return stop('too-much-output');
      into.push(chunk);
    };
    child.stdout.on('data', keep(out));
    child.stderr.on('data', keep(err));
    child.once('error', (error) => {
      finished();
      reject(error);
    });
    child.once('close', (exitCode) => {
      finished();
      resolve({ exitCode: stopped ? null : exitCode, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), stopped });
    });
  });
