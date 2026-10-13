import type { Surroundings } from './folder-policy.ts';

/** Where on this machine a task worked, and the places a path in what the coding agent says would give away. */
export interface Places {
  /** The folder the task worked in (the worktree, or the folder itself). */
  readonly workFolder: string;
  /** The folder its owner allowed, which a worktree is a copy of. */
  readonly allowedFolder: string;
  readonly home: string;
  /** Other ways home is written: the coding agent is told where home is by the environment, and that may be a link to the folder the file system names. */
  readonly otherHomes?: readonly string[];
  readonly stateDirectory: string;
  readonly worktreesDirectory: string;
}

/** The homes an environment names, which is where a coding agent that was given it finds its own. */
export function homesIn(environment: Readonly<Record<string, string | undefined>>): string[] {
  return [environment.HOME, environment.USERPROFILE].filter((home): home is string => home !== undefined && home !== '');
}

/** The places that a task worked in and on, with the places of the machine around them. `environment` is what the coding agent was given. */
export function placesOf(surroundings: Surroundings, environment: Readonly<Record<string, string | undefined>>, work: Pick<Places, 'workFolder' | 'allowedFolder'>): Places {
  const { home, stateDirectory, worktreesDirectory } = surroundings;
  return { ...work, home, otherHomes: homesIn(environment), stateDirectory, worktreesDirectory };
}

const escapeForPattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A slash as it is, as a backslash, as JSON writes it (`\/`, and `\\` for a backslash), and as a URL does (`%2F`, `%5C`).
const SEPARATOR = String.raw`(?:\\\\|\\/|[\\/]|%2F|%5C)`;

/** A character as it is written in a text, or percent-encoded in a URL. */
function characterPattern(character: string): string {
  const plain = escapeForPattern(character);
  try {
    const encoded = encodeURIComponent(character);
    return encoded === character ? plain : `(?:${plain}|${escapeForPattern(encoded)})`;
  } catch {
    // A half of a pair of surrogates is no character to encode.
    return plain;
  }
}

// Written whichever way the text has the slashes, and the characters of a name whichever way a URL has them. The short names that
// Windows keeps for a long one (`PROGRA~1`) are another way to write the same place, and are not looked for.
const patternOf = (path: string): string => [...path].map((character) => (/[\\/]/.test(character) ? SEPARATOR : characterPattern(character))).join('');

/**
 * What the office is told of a task may name nothing of this machine's own layout: the folders its owner shares are known to the office
 * by a label and not by a path. A coding agent says paths all the time (`Edit /Users/ana/work/site/README.md`), so the places it worked
 * in are written as they are in the folder (`./README.md`), and the rest of the person's home as `~`.
 */
export function redactPaths(text: string, places: Places): string {
  const replacements: [string, string][] = [
    [places.workFolder, '.'],
    [places.allowedFolder, '.'],
    [places.stateDirectory, '<runner>'],
    [places.worktreesDirectory, '<runner>'],
    [places.home, '~'],
    ...(places.otherHomes ?? []).map((home): [string, string] => [home, '~']),
  ];
  let redacted = text;
  // The longest first: the folder is under home, and must not be turned into `~/...` before it is turned into `.`.
  for (const [path, stand] of replacements.filter(([path]) => path.length > 1).sort(([a], [b]) => b.length - a.length)) {
    // Only where the path ends (not at a name that goes on, nor at a dot that starts an extension): `/work/site` is not the start of `/work/site-two`, nor of `/work/site.bak`.
    redacted = redacted.replace(new RegExp(`${patternOf(path)}(?![\\w-]|\\.\\w)`, 'gi'), stand);
  }
  return redacted;
}
