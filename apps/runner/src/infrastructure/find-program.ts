import { access, constants, stat } from 'node:fs/promises';
import { programCandidates } from '../domain/program-path.ts';

async function isRunnable(path: string, windows: boolean): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    if (!windows) await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The full path of a program, from the PATH the runner was started with. The program is started by that path and never by its name, so
 * that what is started is what was found here, whatever folder it is started from (see `programCandidates`).
 */
export async function findProgram(name: string, environment: Readonly<Record<string, string | undefined>>, windows: boolean): Promise<string | undefined> {
  // Windows writes the name of a variable in any case.
  const variable = windows ? Object.keys(environment).find((key) => key.toUpperCase() === 'PATH') : 'PATH';
  for (const candidate of programCandidates(name, variable === undefined ? undefined : environment[variable], windows)) {
    if (await isRunnable(candidate, windows)) return candidate;
  }
  return undefined;
}
