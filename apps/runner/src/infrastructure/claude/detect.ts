import { posix, win32 } from 'node:path';
import type { AgentDetection } from '../../application/task-ports.ts';
import { sandboxSupport } from './sandbox-support.ts';
import type { SandboxSupport } from './sandbox-support.ts';
import type { Exec } from './system.ts';

/** The first version of Claude Code that stops reading `@file` and `/command` out of the instruction of a task: older ones ignore the option that asks for it. */
export const MINIMUM_VERSION = [2, 1, 248] as const;

const LOOKUP_TIMEOUT_MS = 5_000;
const VERSION_TIMEOUT_MS = 10_000;
const LOGIN_TIMEOUT_MS = 20_000;

export interface DetectDeps {
  readonly exec: Exec;
  readonly isExecutable: (path: string) => Promise<boolean>;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** The login shell of the person: where their `PATH` is made. */
  readonly shell: string | undefined;
  /** The `PATH` that Claude Code is started with, where the programs of its sandbox are looked for. */
  readonly searchPath: string | undefined;
}

/** The numbers of a version, as `claude --version` prints them (`2.1.250 (Claude Code)`). */
export function parseVersion(text: string): readonly [number, number, number] | undefined {
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return found ? [Number(found[1]), Number(found[2]), Number(found[3])] : undefined;
}

/** Numbers compared as numbers: 2.1.25 is older than 2.1.248. */
export function isAtLeast(version: readonly number[], minimum: readonly number[]): boolean {
  for (const [index, wanted] of minimum.entries()) {
    const have = version[index] ?? 0;
    if (have !== wanted) return have > wanted;
  }
  return true;
}

const containmentOf = (support: SandboxSupport): AgentDetection['containment'] => (support.available ? 'sandbox' : 'none');

function notInstalled(support: SandboxSupport, problem: string): AgentDetection {
  return { installed: false, path: undefined, version: undefined, loggedIn: null, supported: false, problem, containment: containmentOf(support) };
}

const NOT_FOUND = 'Claude Code was not found on this machine. Install it, or choose where it is.';
const NOT_FOUND_ON_WINDOWS = `${NOT_FOUND} The runner needs claude.exe, not a script that starts it.`;

/**
 * Where Claude Code is, as far as the person's own shell says. A desktop program started from the Dock or the Start menu is not given the
 * `PATH` that a terminal has, so the shell is asked, as a login shell (the files that make `PATH` are read) and not an interactive one.
 * What it prints can have more in it than the answer: what a profile says as it starts, so the last line that is a path is the answer.
 */
async function fromTheirShell({ exec, platform, shell }: DetectDeps): Promise<string[]> {
  if (platform === 'win32') {
    const { stdout } = await exec('where', ['claude'], LOOKUP_TIMEOUT_MS);
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => /\.exe$/i.test(line) && win32.isAbsolute(line));
  }
  const { stdout } = await exec(shell ?? '/bin/sh', ['-lc', 'command -v claude'], LOOKUP_TIMEOUT_MS);
  const paths = stdout.split('\n').map((line) => line.trim()).filter((line) => posix.isAbsolute(line));
  const last = paths.at(-1);
  return last === undefined ? [] : [last];
}

/** The places the installers of Claude Code put it. */
function usualPlaces({ platform, home }: DetectDeps): string[] {
  if (platform === 'win32') return [win32.join(home, '.local', 'bin', 'claude.exe')];
  return [posix.join(home, '.local', 'bin', 'claude'), posix.join(home, '.claude', 'local', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'];
}

async function versionAt(path: string, { exec }: DetectDeps): Promise<readonly [number, number, number] | undefined> {
  const { stdout } = await exec(path, ['--version'], VERSION_TIMEOUT_MS);
  return parseVersion(stdout);
}

/** Whether somebody is logged in, which Claude Code says as JSON whatever its exit code: null when it says anything else. */
async function loggedIn(path: string, { exec }: DetectDeps): Promise<boolean | null> {
  const { stdout } = await exec(path, ['auth', 'status'], LOGIN_TIMEOUT_MS);
  try {
    const status: unknown = JSON.parse(stdout);
    const answer = typeof status === 'object' && status !== null ? (status as { loggedIn?: unknown }).loggedIn : undefined;
    return typeof answer === 'boolean' ? answer : null;
  } catch {
    return null;
  }
}

async function look(owner: string | undefined, deps: DetectDeps): Promise<{ readonly path: string; readonly version: readonly [number, number, number] } | undefined> {
  // A program that the person chose is the only one asked: another one found in its place would be one they did not mean.
  const candidates = owner !== undefined ? [owner] : [...new Set([...(await fromTheirShell(deps)), ...usualPlaces(deps)])];
  for (const path of candidates) {
    if (!(await deps.isExecutable(path))) continue;
    const version = await versionAt(path, deps);
    if (version) return { path, version };
  }
  return undefined;
}

/** Whether Claude Code is here, which version it is, and whether somebody is logged in to it. It does not throw: what cannot be found out is said in words. */
export async function detectClaudeCode(owner: string | undefined, deps: DetectDeps): Promise<AgentDetection> {
  const support = await sandboxSupport(deps.platform, deps.searchPath, deps.isExecutable);
  try {
    const found = await look(owner, deps);
    if (!found) {
      if (owner !== undefined) return notInstalled(support, 'The program you chose is not Claude Code, or cannot be run.');
      return notInstalled(support, deps.platform === 'win32' ? NOT_FOUND_ON_WINDOWS : NOT_FOUND);
    }
    const version = found.version.join('.');
    const supported = isAtLeast(found.version, MINIMUM_VERSION);
    const problems = [supported ? undefined : `Claude Code ${version} is too old for this runner. Update it (claude update) to version ${MINIMUM_VERSION.join('.')} or newer.`, support.available ? undefined : support.why];
    return {
      installed: true,
      path: found.path,
      version,
      loggedIn: await loggedIn(found.path, deps),
      supported,
      problem: problems.filter((problem) => problem !== undefined).join(' ') || undefined,
      containment: containmentOf(support),
    };
  } catch {
    return notInstalled(support, 'Claude Code could not be checked on this machine.');
  }
}
