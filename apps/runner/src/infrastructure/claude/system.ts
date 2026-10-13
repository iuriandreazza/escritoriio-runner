import { execFile } from 'node:child_process';
import { access, constants, stat } from 'node:fs/promises';
import { childEnvironment } from '../../domain/child-environment.ts';

/** What a program printed, and how it ended: the exit code, or null when it was stopped or could not be started. */
export interface ExecResult {
  readonly stdout: string;
  readonly exitCode: number | null;
}

/** Runs a program with nothing typed to it, and gives up on it after `timeoutMs`. It never rejects: a program that cannot be run is an exit code of null. */
export type Exec = (file: string, args: readonly string[], timeoutMs: number) => Promise<ExecResult>;

const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Runs programs with the environment a coding agent gets, and not with that of the runner: what is asked of them (their version, whether
 * somebody is logged in) is what they would answer when a task starts them. The arguments are given as they are, with no shell between.
 */
export function createSystemExec(environment: Readonly<Record<string, string | undefined>> = process.env): Exec {
  const env = childEnvironment(environment, process.platform === 'win32');
  return (file, args, timeoutMs) =>
    new Promise((resolve) => {
      const child = execFile(file, [...args], { env, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
        resolve({ stdout, exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : null });
      });
      child.stdin?.end();
    });
}

/** Whether the path is a file that can be run: for a program a person chose by hand, and for the places one is usually found in. */
export async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
