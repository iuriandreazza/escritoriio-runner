import { z } from 'zod';
import { RUNNER_LIMITS } from './protocol.ts';

const VERSION = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:[-+].*)?$/;

/**
 * Compares two versions written as major.minor.patch (anything after a hyphen or a plus, a pre-release or a build, is not looked at).
 * Undefined when either is not written that way: whoever asks decides what an unknown version is taken for.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | undefined {
  const left = VERSION.exec(a);
  const right = VERSION.exec(b);
  if (!left || !right) return undefined;
  for (let part = 1; part <= 3; part++) {
    const difference = Number(left[part]) - Number(right[part]);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/** Whether `version` is older than `minimum`. A version that cannot be read is not: nobody is turned away for a way of writing it. */
export function isOlderThan(version: string, minimum: string): boolean {
  return compareVersions(version, minimum) === -1;
}

/** What the office answers at `RUNNER_REACH_PATH`, as far as a runner reads it: the oldest runner the office lets in. What else it says is not looked at. */
export const officeReachSchema = z.object({ minRunnerVersion: z.string().max(RUNNER_LIMITS.runnerVersion).optional() });
