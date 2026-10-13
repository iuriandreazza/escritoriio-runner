/** One repository of a folder and what a task left in it that runs programs, as the check found and removed it. */
export interface GitSettingsFinding {
  /** Where it is in the folder that was checked, as a relative path; `.` for the folder itself. */
  readonly repository: string;
  /** The hooks that were taken away, or that were changed and could not be put back. */
  readonly hooks: readonly string[];
  /** The settings that were removed, by key. */
  readonly settings: readonly string[];
  /** What was put back as it was before the task: hooks and settings the task had changed. */
  readonly restored: readonly string[];
  /** What the check could not settle in this repository, or left alone, in words: it is shown whole, as a warning. */
  readonly notes: readonly string[];
}

/** Why a check did not look at everything. Each has fixed words: what a task can make is not a reason for the owner not to be told. */
export type IncompleteReason = 'budget' | 'depth' | 'aborted' | 'unreadable' | 'no-baseline';

export const INCOMPLETE_WORDS: Readonly<Record<IncompleteReason, string>> = {
  budget: 'The check of git repositories stopped before it looked at every folder, so some could not be checked.',
  depth: 'Some folders are nested deeper than the check looks, so they could not be checked.',
  aborted: 'The check of git repositories ran out of time, so some could not be checked.',
  unreadable: 'Some folders or files could not be read, so they could not be checked.',
  'no-baseline': 'What git hooks and settings were there before the task could not be recorded, so none was removed. Look at them yourself.',
};

export interface GitSettingsReport {
  readonly findings: readonly GitSettingsFinding[];
  readonly incomplete: readonly IncompleteReason[];
}

/** What a git directory holds that matters here: its hooks (by name, with a digest) and every setting of its files, by file and key. */
export interface GitDirState {
  readonly hooks: Readonly<Record<string, string>>;
  readonly settings: Readonly<Record<string, readonly string[]>>;
}

export interface GitDirPlan {
  /** Hooks that were not there before the task. */
  readonly removeHooks: readonly string[];
  /** Hooks that were there and are not as they were. */
  readonly changedHooks: readonly string[];
  /** Settings to take away, by id. */
  readonly unset: readonly string[];
  /** Settings the task changed that were there before: they are put back after being taken away. */
  readonly restore: readonly { readonly id: string; readonly values: readonly string[] }[];
}

export const settingId = (file: string, key: string): string => `${file}\n${key}`;
const keyOf = (id: string): string => id.slice(id.indexOf('\n') + 1);

const SAMPLE = /^[^/\\]+\.sample$/;

/** Git writes its samples as `name.sample` and does not run them. */
export const isSampleHook = (name: string): boolean => SAMPLE.test(name) && !name.endsWith('.sample.sh');

// Keys that name a program git runs, or a file that can hold keys of that kind. Section and name are written in lower case by git; the part
// between them (a remote, a filter, a driver) is whatever the repository says, and may hold dots.
const PROGRAM_KEYS = new Set(['core.hookspath', 'core.fsmonitor', 'core.sshcommand', 'core.pager', 'core.editor', 'core.askpass', 'core.gitproxy', 'core.alternaterefscommand', 'core.worktree', 'credential.helper', 'diff.external', 'gpg.program', 'gpg.ssh.defaultkeycommand', 'sequence.editor', 'interactive.difffilter', 'include.path']);

const PROGRAM_PATTERNS: readonly RegExp[] = [
  /^credential\..+\.helper$/,
  /^filter\..+\.[^.]+$/,
  /^url\..+\.(?:pushinsteadof|insteadof)$/,
  /^diff\..+\.(?:textconv|command)$/,
  /^merge\..+\.driver$/,
  /^gpg\..+\.program$/,
  /^includeif\..+\.path$/,
  /^pager\..+$/,
  /^remote\..+\.(?:uploadpack|receivepack|vcs)$/,
  /^(?:mergetool|difftool)\..+\.(?:cmd|path)$/,
  /^trailer\..+\.(?:cmd|command)$/,
  /^(?:browser|man)\..+\.(?:cmd|path)$/,
  /^instaweb\..+$/,
];

/**
 * Whether a setting makes git, or a tool of the person's around it, run a program or read settings from somewhere else. A repository made
 * by an agent that has a shell can hold any of them (the sandbox lets it write in the folder), and the person runs git in it later with their own rights.
 * An alias is one only when it begins with `!`, which hands it to a shell, and so is a submodule's `update`; an address for sending mail is when it is a path.
 */
export function isRunningSetting(key: string, value: string): boolean {
  const lowered = key.toLowerCase();
  if (PROGRAM_KEYS.has(lowered) || PROGRAM_PATTERNS.some((pattern) => pattern.test(lowered))) return true;
  if ((lowered.startsWith('alias.') || /^submodule\..+\.update$/.test(lowered)) && value.startsWith('!')) return true;
  return lowered === 'sendemail.smtpserver' && /^[/.~]/.test(value);
}

const BENIGN: readonly RegExp[] = [
  /^core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)$/,
  /^remote\.[^.]+\.(?:url|fetch|tagopt)$/,
  /^branch\..+\.(?:remote|merge|rebase|description)$/,
  /^user\.(?:name|email)$/,
  /^gc\.auto$/,
  /^pack\.threads$/,
];

/** What a repository that a task made or cloned may hold: a short list that git itself writes, and a person sets. Anything else in it is the task's own and goes. */
export const isBenignSetting = (key: string): boolean => BENIGN.some((pattern) => pattern.test(key.toLowerCase()));

const sameValues = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * What to do about a git directory after a task, given what it held before. Only what the task added or changed is touched: a hook or a setting
 * that the owner had is theirs, and stays as it was. With nothing from before (a repository the task made or cloned) everything that is not on the short
 * list of what git itself writes goes, and so does every hook that is not a sample.
 */
export function planGitDir(before: GitDirState | undefined, after: GitDirState): GitDirPlan {
  const removeHooks: string[] = [];
  const changedHooks: string[] = [];
  for (const [name, digest] of Object.entries(after.hooks)) {
    if (isSampleHook(name)) continue;
    const was = before?.hooks[name];
    if (was === undefined) removeHooks.push(name);
    else if (was !== digest) changedHooks.push(name);
  }
  const unset: string[] = [];
  const restore: { id: string; values: readonly string[] }[] = [];
  for (const [id, values] of Object.entries(after.settings)) {
    const key = keyOf(id);
    const risky = before === undefined ? !isBenignSetting(key) : values.some((value) => isRunningSetting(key, value));
    if (!risky) continue;
    const prior = before?.settings[id];
    if (prior !== undefined && sameValues(prior, values)) continue;
    unset.push(id);
    if (prior !== undefined) restore.push({ id, values: prior });
  }
  return { removeHooks, changedHooks, unset, restore };
}

const MAX_REMOVED_WORDS = 700;

/**
 * What the owner is told when a task left such things behind, or when the check could not look at everything. Warnings come first and are never
 * cut; the list of what was removed is, with the number of repositories left out of it. Nothing when all is as it was.
 */
export function summarizeGitSettings(report: GitSettingsReport): string | undefined {
  const warnings = [
    ...report.findings.flatMap(({ repository, notes }) => notes.map((note) => `${repository}: ${note}.`)),
    ...report.incomplete.map((reason) => INCOMPLETE_WORDS[reason]),
  ];
  const parts: string[] = warnings.length > 0 ? [`WARNING: ${warnings.join(' ')}`] : [];

  const removed = report.findings.filter((finding) => finding.hooks.length > 0 || finding.settings.length > 0);
  if (removed.length > 0) {
    const where = removed.map(({ repository, hooks, settings }) => {
      const what = [hooks.length > 0 ? `hooks ${hooks.join(', ')}` : '', settings.length > 0 ? `settings ${settings.join(', ')}` : ''].filter((part) => part !== '');
      return `${repository} (${what.join('; ')})`;
    });
    parts.push(`The task changed git settings that run programs; they were removed: ${listWithin(where)}.`);
  }
  const restored = report.findings.filter((finding) => finding.restored.length > 0);
  if (restored.length > 0) parts.push(`Put back as they were before the task: ${listWithin(restored.map(({ repository, restored: names }) => `${repository} (${names.join(', ')})`))}.`);
  return parts.length === 0 ? undefined : parts.join(' ');
}

/** A list cut to a length, saying how many it left out. */
function listWithin(items: readonly string[]): string {
  let used = 0;
  const shown: string[] = [];
  for (const item of items) {
    if (used + item.length > MAX_REMOVED_WORDS && shown.length > 0) break;
    shown.push(item);
    used += item.length + 2;
  }
  const rest = items.length - shown.length;
  return rest === 0 ? shown.join('; ') : `${shown.join('; ')}; and ${rest} more repositories`;
}
