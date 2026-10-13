/** An absolute path split into where it starts and the names under it, with `.` and `..` taken out; undefined for a path that is not absolute. */
interface Parsed {
  readonly root: string;
  readonly parts: readonly string[];
}

// A path of Windows is told by its drive or its share, and compared without regard to case. The other systems' paths are compared as they
// are: what the folder policy compares is what the file system itself answered for the folder, which already has the case it really has.
function parse(path: string, windows: boolean): Parsed | undefined {
  let text = path;
  let root: string;
  if (windows) {
    text = text.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').toLowerCase();
    const drive = /^([a-z]):(\/|$)/.exec(text);
    const share = /^\/\/([^/]+)\/([^/]+)(\/|$)/.exec(text);
    if (drive) {
      root = `${drive[1]}:`;
      text = text.slice(2);
    } else if (share) {
      root = `//${share[1]}/${share[2]}`;
      text = text.slice(root.length);
    } else return undefined;
  } else {
    if (!text.startsWith('/')) return undefined;
    root = '/';
  }
  const parts: string[] = [];
  for (const name of text.split('/')) {
    if (name === '' || name === '.') continue;
    // Above the root there is nothing: `/..` is `/`.
    if (name === '..') parts.pop();
    else parts.push(name);
  }
  return { root, parts };
}

export const isAbsolutePath = (path: string, windows: boolean): boolean => parse(path, windows) !== undefined;

/** Whether the path is the top of a file system: `/`, `C:\` or a share. */
export function isRootPath(path: string, windows: boolean): boolean {
  return parse(path, windows)?.parts.length === 0;
}

/** Whether `child` is `parent` or lies under it. Both must be absolute; anything else is not inside anything. */
export function isInside(parent: string, child: string, windows: boolean): boolean {
  const a = parse(parent, windows);
  const b = parse(child, windows);
  if (!a || !b || a.root !== b.root || b.parts.length < a.parts.length) return false;
  return a.parts.every((name, index) => name === b.parts[index]);
}

export const isSamePath = (a: string, b: string, windows: boolean): boolean => isInside(a, b, windows) && isInside(b, a, windows);

/** The path made absolute against `base`, with its `..` taken out lexically; links are for the file system to answer, and are not followed here. */
export function resolveAgainst(base: string, path: string, windows: boolean): string | undefined {
  if (isAbsolutePath(path, windows)) return normalizePath(path, windows);
  return normalizePath(`${base.replace(/[\\/]+$/, '')}${windows ? '\\' : '/'}${path}`, windows);
}

function normalizePath(path: string, windows: boolean): string | undefined {
  const parsed = parse(path, windows);
  if (!parsed) return undefined;
  return windows ? `${parsed.root}\\${parsed.parts.join('\\')}` : `/${parsed.parts.join('/')}`;
}

/**
 * The path with the name macOS gives the same folders on its data volume taken off: `/Users/ana` is also `/System/Volumes/Data/Users/ana`,
 * the real path of a folder is not made one by the other, and a place that was refused by one name must be by the other. The top of the
 * data volume is the top of the disk. Written on any system, since a path of that kind means nothing else anywhere.
 */
export function withoutDataVolumePrefix(path: string): string {
  const match = /^\/System\/Volumes\/Data(?=\/|$)/i.exec(path);
  return match ? path.slice(match[0].length) || '/' : path;
}

/** The name of the folder a path ends in, as it is written there: what it is called when it has not been given another name. Empty for the top of a disk. */
export function folderName(path: string): string {
  return path.split(/[\\/]/).filter((name) => name !== '').at(-1) ?? '';
}
