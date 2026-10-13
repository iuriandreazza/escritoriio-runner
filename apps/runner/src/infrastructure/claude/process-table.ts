import { spawn } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { isInside } from '../../domain/paths.ts';

/**
 * What the system says of the processes that are running on it. Each answer is only as much as the system lets this process see, and
 * never includes this process itself: an empty answer is not proof that nothing is there.
 */
export interface ProcessTable {
  /** The processes whose environment holds `entry` (`NAME=value`), which every process that Claude Code started has inherited. */
  withEnvironmentEntry(entry: string): Promise<readonly number[]>;
  /**
   * The processes whose current folder is `folder` or lies inside it and whose parent is gone, so that the first process of the system
   * has them. Those that still have a parent are somebody's, a shell that a person opened in the folder to look at it, for instance;
   * and what a process left that is still the child of a process that is itself left, is orphaned when that one is ended.
   */
  orphansWorkingIn(folder: string): Promise<readonly number[]>;
}

/** Runs a program and gives the lines of what it printed that `keep` accepts. It never rejects: a program that cannot be run printed nothing. */
export type Listing = (file: string, args: readonly string[], keep: (line: string) => boolean) => Promise<string[]>;

/** The files with which Linux tells of its processes. */
export interface ProcFiles {
  /** What is in `/proc`: the numbers among the names are the processes. */
  names(): Promise<readonly string[]>;
  environment(pid: number): Promise<string>;
  folder(pid: number): Promise<string>;
  parent(pid: number): Promise<number>;
}

const LISTING_TIMEOUT_MS = 2_000;

// Where these programs are on the systems that have them, so that a `PATH` with a program of the same name in it is not what answers.
const PS = '/bin/ps';
const LSOF = '/usr/sbin/lsof';

/**
 * The process ids in a listing made with the environment after each command (`pid command NAME=value ...`) whose environment holds `entry`.
 * The entry has to be a word of the line, so that a longer name or value that ends the same way is not taken for it.
 */
export function pidsCarrying(lines: readonly string[], entry: string): number[] {
  const pids: number[] = [];
  for (const line of lines) {
    const found = /^\s*(\d+)\s(.*)$/s.exec(line);
    if (found && (found[2] ?? '').split(' ').includes(entry)) pids.push(Number(found[1]));
  }
  return pids;
}

/** Whether the environment of a process, as Linux gives it (the entries are separated by NUL), holds the entry. */
export const environmentHolds = (environment: string, entry: string): boolean => environment.split('\0').includes(entry);

/** The processes, their parents and the folders they work in, from what `lsof -FpRn` prints: a `p` line for each process, then its `R` line, then an `n` line for each place of it. */
export function parseWorkingFolders(output: readonly string[]): { readonly pid: number; readonly parent: number; readonly folder: string }[] {
  const found: { pid: number; parent: number; folder: string }[] = [];
  let pid: number | undefined;
  let parent: number | undefined;
  for (const line of output) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
      parent = undefined;
    } else if (line.startsWith('R')) parent = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== undefined && parent !== undefined && Number.isInteger(pid) && Number.isInteger(parent)) found.push({ pid, parent, folder: line.slice(1) });
  }
  return found;
}

/** The parent of a process, from what `/proc/<pid>/stat` says: after the name, which is in parentheses and may have anything in it, come the state and the parent. */
export function parentFromStat(stat: string): number {
  return Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(' ')[1]);
}

const FIRST_PROCESS = 1;

const withoutThisProcess = (pids: readonly number[]): number[] => pids.filter((pid) => pid > 1 && pid !== process.pid);

/** Runs `file`, and keeps the lines of its output that `keep` accepts as they come, since a listing of every process with its environment is long. */
export const readLines: Listing = (file, args, keep) =>
  new Promise((resolve) => {
    const lines: string[] = [];
    try {
      const child = spawn(file, [...args], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      const timer = setTimeout(() => child.kill('SIGKILL'), LISTING_TIMEOUT_MS);
      const done = (): void => {
        clearTimeout(timer);
        resolve(lines);
      };
      createInterface({ input: child.stdout }).on('line', (line) => {
        if (keep(line)) lines.push(line);
      }).once('close', done);
      child.once('error', done);
    } catch {
      resolve(lines);
    }
  });

const realProcFiles: ProcFiles = {
  names: () => readdir('/proc'),
  environment: (pid) => readFile(`/proc/${pid}/environ`, 'utf8'),
  folder: (pid) => readlink(`/proc/${pid}/cwd`),
  parent: async (pid) => parentFromStat(await readFile(`/proc/${pid}/stat`, 'utf8')),
};

const everything = (): boolean => true;

// macOS and the BSDs print the environment after the command with `ps e`, and the current folders with `lsof`. macOS keeps the
// environment of the programs that Apple ships (`sleep`, `sh`, `python3` from /usr/bin) from every process but their own, so a command
// that started one of those and left it running is not found by its environment, and only by the folder it works in.
function tableOfUnix(listing: Listing): ProcessTable {
  return {
    async withEnvironmentEntry(entry) {
      return withoutThisProcess(pidsCarrying(await listing(PS, ['eww', '-axo', 'pid=,command='], (line) => line.includes(entry)), entry));
    },
    async orphansWorkingIn(folder) {
      const places = parseWorkingFolders(await listing(LSOF, ['-a', '-d', 'cwd', '-FpRn'], everything));
      return withoutThisProcess(places.filter((place) => place.parent === FIRST_PROCESS && isInside(folder, place.folder, false)).map((place) => place.pid));
    },
  };
}

async function eachProcess(files: ProcFiles, keep: (pid: number) => Promise<boolean>): Promise<number[]> {
  const pids = (await files.names().catch((): readonly string[] => [])).filter((name) => /^\d+$/.test(name)).map(Number);
  const kept = await Promise.all(pids.map((pid) => keep(pid).catch(() => false)));
  return withoutThisProcess(pids.filter((_, index) => kept[index]));
}

// Linux says of a folder that was taken away while a process works in it that it is `(deleted)`, and a process of a task that ended is where
// that is likely to be found.
const withoutDeleted = (folder: string): string => folder.replace(/ \(deleted\)$/, '');

// Linux tells the environment and the folder of every process of the same person, whatever the program is.
function tableOfLinux(files: ProcFiles): ProcessTable {
  return {
    withEnvironmentEntry: (entry) => eachProcess(files, async (pid) => environmentHolds(await files.environment(pid), entry)),
    orphansWorkingIn: (folder) => eachProcess(files, async (pid) => isInside(folder, withoutDeleted(await files.folder(pid)), false) && (await files.parent(pid)) === FIRST_PROCESS),
  };
}

// Windows does not tell the environment or the folder of the processes of another, and a tree that is ended while its parent is there needs no search.
const tableOfWindows: ProcessTable = { withEnvironmentEntry: () => Promise.resolve([]), orphansWorkingIn: () => Promise.resolve([]) };

export function createProcessTable(platform: NodeJS.Platform, io: { readonly listing?: Listing; readonly files?: ProcFiles } = {}): ProcessTable {
  if (platform === 'win32') return tableOfWindows;
  return platform === 'linux' ? tableOfLinux(io.files ?? realProcFiles) : tableOfUnix(io.listing ?? readLines);
}
