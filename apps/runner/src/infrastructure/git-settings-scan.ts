import { createHash } from 'node:crypto';
import { chmod, lstat, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { GitSettingsBaseline, GitSettingsScan } from '../application/task-ports.ts';
import type { GitDirState, GitSettingsFinding, IncompleteReason } from '../domain/git-settings.ts';
import { planGitDir, settingId } from '../domain/git-settings.ts';
import type { HardenedGit } from './hardened-git.ts';
import { createHardenedGit } from './hardened-git.ts';
import { ensurePrivateDirectory } from './private-directory.ts';
import type { RunProcess } from './run-process.ts';

/** How deep under the folder a repository is looked for, and how many folders one look takes in: past either, the report says so. */
export const MAX_SCAN_DEPTH = 6;
export const MAX_SCAN_DIRECTORIES = 20_000;
/** How deep a `node_modules` folder is looked into, below itself: a package is one level and a scoped one two, and a vendored repository sits at those. Deeper is not looked at, and not reported. */
const NODE_MODULES_DEPTH = 3;
/** A settings file larger than this is not what git writes: it is not trusted, and not read. */
export const MAX_SETTINGS_BYTES = 64 * 1024;
/** A hook is kept in memory to be put back when a task changes it, up to this. */
const MAX_HOOK_BYTES = 256 * 1024;
const SETTINGS_FILES = ['config', 'config.worktree'] as const;

export interface GitSettingsScanOptions {
  readonly exec: RunProcess;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly windows: boolean;
  readonly maxDirectories?: number;
  /** Where git is run for the settings files: a folder of the runner's own, empty, since the places an agent can write may hold a repository. */
  readonly neutralDirectory?: string;
}

/** A place git keeps its own files in, found under the folder. */
interface GitDir {
  readonly label: string;
  readonly path: string;
  readonly hooks: boolean;
  readonly files: readonly string[];
}

interface Held {
  readonly state: GitDirState;
  readonly contents: ReadonlyMap<string, { readonly content: Buffer; readonly mode: number }>;
  /** What the check could not settle, as words. */
  readonly notes: readonly string[];
  readonly unreadable: boolean;
  /** A rebase that is waiting to run commands: the digest of its list, when it has an `exec` line. */
  readonly rebase: string | undefined;
}

interface Walk {
  readonly dirs: readonly GitDir[];
  /** What stands where a `.git` should be, by repository, when it is not a folder: a link or a file. */
  readonly entries: ReadonlyMap<string, { readonly kind: 'link' | 'pointer'; readonly describe: string; readonly path: string }>;
  readonly incomplete: ReadonlySet<IncompleteReason>;
}

interface Baseline {
  readonly held: ReadonlyMap<string, Held>;
  readonly entries: Walk['entries'];
  readonly incomplete: ReadonlySet<IncompleteReason>;
}

const digest = (content: Buffer | string): string => createHash('sha256').update(content).digest('hex');

/**
 * Looks, around a task that worked in place, at every git repository under the folder for what makes git run a program on the owner's machine
 * the next time they use it: hooks that are not samples, and settings that name a program. What was there before the task is kept, and only the
 * difference is taken away (a hook or a setting the task added, or changed back to what it was); in a repository that the task made or cloned
 * everything that git itself does not write goes. Nothing is run that a repository holds: settings are read and written with `git config --file`
 * under the same hardening as every command, and links are never followed. Whatever could not be looked at is reported, never passed over.
 */
export function createGitSettingsScan(options: GitSettingsScanOptions): GitSettingsScan {
  const git = createHardenedGit({ exec: options.exec, environment: options.environment, windows: options.windows });
  const maxDirectories = options.maxDirectories ?? MAX_SCAN_DIRECTORIES;
  const neutral = async (): Promise<string> => (options.neutralDirectory === undefined ? tmpdir() : ensurePrivateDirectory(options.neutralDirectory));

  const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');

  /** The git directories that sit inside a repository's own: those of its submodules, and those of its linked worktrees. */
  async function innerDirs(label: string, gitDirectory: string, incomplete: Set<IncompleteReason>): Promise<GitDir[]> {
    const found: GitDir[] = [];
    const modules = join(gitDirectory, 'modules');
    const pending = [{ path: modules, depth: 0, name: '' }];
    while (pending.length > 0) {
      const { path, depth, name } = pending.pop() as { path: string; depth: number; name: string };
      const entries = await readdir(path, { withFileTypes: true }).catch((error: unknown) => {
        if (!isMissing(error)) incomplete.add('unreadable');
        return [];
      });
      if (name !== '' && entries.some((entry) => entry.name === 'HEAD')) found.push({ label: `${label} (module ${name})`, path, hooks: true, files: SETTINGS_FILES });
      if (depth >= 5) continue;
      for (const entry of entries) if (entry.isDirectory()) pending.push({ path: join(path, entry.name), depth: depth + 1, name: name === '' ? entry.name : `${name}/${entry.name}` });
    }
    const worktrees = join(gitDirectory, 'worktrees');
    for (const entry of await readdir(worktrees, { withFileTypes: true }).catch((error: unknown) => {
      if (!isMissing(error)) incomplete.add('unreadable');
      return [];
    })) {
      if (entry.isDirectory()) found.push({ label: `${label} (worktree ${entry.name})`, path: join(worktrees, entry.name), hooks: false, files: ['config.worktree'] });
    }
    return found;
  }

  async function walk(root: string, signal: AbortSignal): Promise<Walk> {
    const dirs: GitDir[] = [];
    const entries = new Map<string, Walk['entries'] extends ReadonlyMap<string, infer V> ? V : never>();
    const incomplete = new Set<IncompleteReason>();
    const pending: { directory: string; depth: number; nodeModules: number }[] = [{ directory: root, depth: 0, nodeModules: 0 }];
    let looked = 0;
    while (pending.length > 0) {
      if (signal.aborted) {
        incomplete.add('aborted');
        break;
      }
      if (looked >= maxDirectories) {
        incomplete.add('budget');
        break;
      }
      const { directory, depth, nodeModules } = pending.shift() as (typeof pending)[number];
      looked += 1;
      const label = relative(root, directory).split('\\').join('/') || '.';
      const listed = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
        if (!isMissing(error)) incomplete.add('unreadable');
        return undefined;
      });
      if (!listed) continue;
      const names = new Set(listed.map((entry) => entry.name));

      if (names.has('.git')) {
        const gitEntry = join(directory, '.git');
        const found = await lstat(gitEntry).catch(() => undefined);
        if (found?.isSymbolicLink()) {
          entries.set(label, { kind: 'link', describe: `link:${await readlink(gitEntry).catch(() => '?')}`, path: gitEntry });
        } else if (found?.isFile()) {
          const text = (await readFile(gitEntry, 'utf8').catch(() => '')).slice(0, 4096);
          if (text.trimStart().startsWith('gitdir:')) entries.set(label, { kind: 'pointer', describe: `pointer:${text.trim()}`, path: gitEntry });
        } else if (found?.isDirectory()) {
          dirs.push({ label, path: gitEntry, hooks: true, files: SETTINGS_FILES });
          dirs.push(...(await innerDirs(label, gitEntry, incomplete)));
        }
      } else if (names.has('HEAD') && names.has('objects') && names.has('refs')) {
        // A git directory with no `.git` around it: git reads it as a repository when it is the place it is run in.
        dirs.push({ label: `${label} (bare)`, path: directory, hooks: true, files: SETTINGS_FILES });
      }

      const children = listed.filter((entry) => entry.isDirectory() && entry.name !== '.git');
      if (children.length === 0) continue;
      const inNodeModules = nodeModules > 0 || directory.endsWith(`${'/'}node_modules`) || directory.endsWith('\\node_modules');
      const nextNodeModules = inNodeModules ? nodeModules + 1 : 0;
      if (inNodeModules && nextNodeModules > NODE_MODULES_DEPTH) continue;
      if (depth >= MAX_SCAN_DEPTH) {
        incomplete.add('depth');
        continue;
      }
      for (const child of children) pending.push({ directory: join(directory, child.name), depth: depth + 1, nodeModules: nextNodeModules });
    }
    return { dirs, entries, incomplete };
  }

  /** Reads what a git directory holds. Reads settings with git and hooks as files, never running either. */
  async function hold(hardened: HardenedGit, dir: GitDir, cwd: string): Promise<Held> {
    const hooks: Record<string, string> = {};
    const settings: Record<string, string[]> = {};
    const contents = new Map<string, { content: Buffer; mode: number }>();
    const notes: string[] = [];
    let unreadable = false;

    if (dir.hooks) {
      const folder = join(dir.path, 'hooks');
      const found = await lstat(folder).catch(() => undefined);
      if (found?.isSymbolicLink()) {
        hooks['@hooks'] = `link:${await readlink(folder).catch(() => '?')}`;
      } else if (found?.isDirectory()) {
        const names = await readdir(folder).catch(() => {
          unreadable = true;
          return [] as string[];
        });
        for (const name of names) {
          const file = join(folder, name);
          const info = await lstat(file).catch(() => undefined);
          if (!info) continue;
          if (info.isSymbolicLink()) hooks[name] = `link:${await readlink(file).catch(() => '?')}`;
          else if (info.isFile() && info.size <= MAX_HOOK_BYTES) {
            const content = await readFile(file).catch(() => undefined);
            if (content === undefined) unreadable = true;
            else {
              hooks[name] = digest(content);
              contents.set(name, { content, mode: info.mode & 0o7777 });
            }
          } else hooks[name] = info.isFile() ? `large:${info.size}` : 'folder';
        }
      }
    }

    for (const name of dir.files) {
      const file = join(dir.path, name);
      const found = await lstat(file).catch(() => undefined);
      if (!found) continue;
      if (found.isSymbolicLink()) {
        // Written through, a link would change whatever it leads to.
        hooks[`@${name}`] = `link:${await readlink(file).catch(() => '?')}`;
        continue;
      }
      if (!found.isFile()) continue;
      if (found.size > MAX_SETTINGS_BYTES) {
        notes.push(`its settings file ${name} is larger than git writes (${Math.round(found.size / 1024)} KiB), so it was not read and cannot be trusted`);
        unreadable = true;
        continue;
      }
      const listed = await hardened.run({ cwd }, [], ['config', '--file', file, '--list', '-z']);
      if (listed.exitCode !== 0 || listed.stopped) {
        notes.push(`its settings file ${name} could not be read, so it was not checked`);
        unreadable = true;
        continue;
      }
      for (const entry of listed.stdout.split('\0')) {
        if (entry === '') continue;
        const [key = '', ...value] = entry.split('\n');
        (settings[settingId(name, key)] ??= []).push(value.join('\n'));
      }
    }

    let rebase: string | undefined;
    const todo = await readFile(join(dir.path, 'rebase-merge', 'git-rebase-todo'), 'utf8').catch(() => undefined);
    if (todo !== undefined && todo.length <= MAX_SETTINGS_BYTES && /^(?:exec|x)\s/m.test(todo)) rebase = digest(todo);
    return { state: { hooks, settings }, contents, notes, unreadable, rebase };
  }

  async function holdAll(hardened: HardenedGit, dirs: readonly GitDir[], cwd: string): Promise<Map<string, Held>> {
    const held = new Map<string, Held>();
    for (const dir of dirs) held.set(dir.label, await hold(hardened, dir, cwd));
    return held;
  }

  async function snapshot(root: string, signal: AbortSignal): Promise<GitSettingsBaseline | undefined> {
    try {
      const hardened = git.scoped({ signal, timeoutMs: 30_000 });
      const found = await walk(root, signal);
      const held = await holdAll(hardened, found.dirs, await neutral());
      const incomplete = new Set(found.incomplete);
      if ([...held.values()].some((one) => one.unreadable)) incomplete.add('unreadable');
      if (signal.aborted) incomplete.add('aborted');
      const baseline: Baseline = { held, entries: found.entries, incomplete };
      return baseline;
    } catch {
      return undefined;
    }
  }

  /** Takes away, or puts back, what a plan says in one git directory. Words for what could not be done. */
  async function apply(hardened: HardenedGit, dir: GitDir, before: Held | undefined, after: Held, cwd: string): Promise<{ hooks: string[]; settings: string[]; restored: string[]; notes: string[] }> {
    const plan = planGitDir(before?.state, after.state);
    const result = { hooks: [] as string[], settings: [] as string[], restored: [] as string[], notes: [] as string[] };
    const where = (name: string): string => (name.startsWith('@') ? join(dir.path, name.slice(1)) : join(dir.path, 'hooks', name));
    const shown = (name: string): string => (name.startsWith('@') ? `${name.slice(1)} (a link)` : name);

    for (const name of [...plan.removeHooks, ...plan.changedHooks.filter((changed) => !before?.contents.has(changed))]) {
      await rm(where(name), { recursive: true, force: true }).catch(() => result.notes.push(`${shown(name)} could not be removed`));
      result.hooks.push(shown(name));
    }
    for (const name of plan.changedHooks) {
      const kept = before?.contents.get(name);
      if (!kept) continue;
      try {
        await rm(where(name), { force: true });
        await writeFile(where(name), kept.content, { mode: kept.mode });
        await chmod(where(name), kept.mode);
        result.restored.push(name);
      } catch {
        result.notes.push(`the hook ${name} was changed and could not be put back`);
      }
    }
    const fileOf = (id: string): string => id.slice(0, id.indexOf('\n'));
    const keyOf = (id: string): string => id.slice(id.indexOf('\n') + 1);
    for (const id of plan.unset) {
      const file = join(dir.path, fileOf(id));
      const unset = await hardened.run({ cwd }, [], ['config', '--file', file, '--unset-all', keyOf(id)]);
      if (unset.exitCode !== 0) result.notes.push(`the setting ${keyOf(id)} could not be removed`);
      else result.settings.push(keyOf(id));
    }
    for (const { id, values } of plan.restore) {
      const file = join(dir.path, fileOf(id));
      let ok = true;
      for (const value of values) ok = (await hardened.run({ cwd }, [], ['config', '--file', file, '--add', keyOf(id), value])).exitCode === 0 && ok;
      if (ok) result.restored.push(keyOf(id));
      else result.notes.push(`the setting ${keyOf(id)} was changed and could not be put back`);
    }
    // A setting that was taken away and put back as it was is told as put back, not as removed.
    return { ...result, settings: result.settings.filter((key) => !result.restored.includes(key)) };
  }

  async function scan(root: string, signal: AbortSignal, given: GitSettingsBaseline | undefined) {
    const baseline = given as Baseline | undefined;
    const findings: GitSettingsFinding[] = [];
    const incomplete = new Set<IncompleteReason>();
    try {
      const hardened = git.scoped({ signal, timeoutMs: 30_000 });
      const cwd = await neutral();
      const found = await walk(root, signal);
      for (const reason of found.incomplete) incomplete.add(reason);
      for (const reason of baseline?.incomplete ?? ['no-baseline' as const]) incomplete.add(reason);
      // Without a record of before, a repository that is not in it cannot be told from one the task made: nothing is removed.
      const removing = baseline !== undefined;
      const unknownIsNew = baseline !== undefined && !baseline.incomplete.has('budget') && !baseline.incomplete.has('aborted');

      for (const [label, entry] of found.entries) {
        if (baseline?.entries.get(label)?.describe === entry.describe) continue;
        const notes: string[] = [];
        if (entry.kind === 'link') {
          if (removing) {
            await rm(entry.path, { force: true }).catch(() => undefined);
            notes.push('its .git was a link, which was removed');
          } else notes.push('its .git is a link, left as it is');
        } else notes.push('its .git is a file that points to another place: it was left as it is, and what it points to was not checked');
        findings.push({ repository: label, hooks: [], settings: [], restored: [], notes });
      }

      const held = await holdAll(hardened, found.dirs, cwd);
      for (const dir of found.dirs) {
        const after = held.get(dir.label) as Held;
        const before = baseline?.held.get(dir.label);
        const notes = [...after.notes];
        if (after.unreadable) incomplete.add('unreadable');
        if (after.rebase !== undefined && before?.rebase !== after.rebase) notes.push('a rebase waiting there runs commands (an exec line): look at it before you continue it');
        let done = { hooks: [] as string[], settings: [] as string[], restored: [] as string[], notes: [] as string[] };
        if (removing && (before !== undefined || unknownIsNew)) done = await apply(hardened, dir, before, after, cwd);
        const all = [...notes, ...done.notes];
        if (done.hooks.length + done.settings.length + done.restored.length + all.length > 0) findings.push({ repository: dir.label, hooks: done.hooks, settings: done.settings, restored: done.restored, notes: all });
      }
      if (signal.aborted) incomplete.add('aborted');
    } catch {
      incomplete.add('unreadable');
    }
    return { findings, incomplete: [...incomplete] };
  }

  return { snapshot, scan };
}
