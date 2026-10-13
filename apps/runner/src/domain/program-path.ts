import { isAbsolutePath } from './paths.ts';

/**
 * Where a program may be, in the order a shell looks: each folder of the PATH, as a full path. A folder that is not a full one is left
 * out. An empty entry, which a shell reads as "here", and a relative one lead to the folder the program is started from, and on Windows
 * that folder is searched before the PATH itself: a coding agent could have put a program of that name in the folder it worked in.
 * On Windows only `.exe` is tried, since a program of any other kind cannot be started without a shell.
 */
export function programCandidates(name: string, pathVariable: string | undefined, windows: boolean): string[] {
  const separator = windows ? '\\' : '/';
  const file = windows ? `${name}.exe` : name;
  return (pathVariable ?? '')
    // A folder with a semicolon in its name is written in quotes on Windows, and the semicolons inside the quotes are not the ones that separate.
    .split(windows ? /;(?=(?:[^"]*"[^"]*")*[^"]*$)/ : ':')
    .map((entry) => (windows ? entry.replaceAll('"', '') : entry))
    .filter((entry) => isAbsolutePath(entry, windows))
    .map((entry) => `${entry.replace(/[\\/]+$/, '')}${separator}${file}`);
}
