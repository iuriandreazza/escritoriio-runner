import type { CodingAgentKind, JournalEntry } from '@escritoriio/runner-protocol';
import type { AllowedFolder, FolderAccess, Surroundings } from '../domain/folder-policy.ts';
import type { GitSettingsReport } from '../domain/git-settings.ts';
import type { WorkspaceTools } from './workspace-ports.ts';

/** What the machine's owner has decided: the folders, where each coding agent is, and whether the machine is paused. Only the owner's own screens or commands write it. */
export interface RunnerPolicy {
  readonly folders: readonly AllowedFolder[];
  /** The path of a coding agent the owner picked by hand, for the ones that are not found by themselves. */
  readonly agentPaths: Readonly<Partial<Record<CodingAgentKind, string>>>;
  /** The owner paused the machine on the machine itself. */
  readonly paused: boolean;
}

export const EMPTY_POLICY: RunnerPolicy = { folders: [], agentPaths: {}, paused: false };

/** What a change of the policy comes to: the policy to keep, and whatever the one who changed it has to know of what it did. */
export interface PolicyEdit<T> {
  /** The policy to keep. The one that was given, as it is, keeps nothing and writes nothing. */
  readonly policy: RunnerPolicy;
  readonly result: T;
}

/** Where the policy is kept. It is read again at every task, so that what the owner changes is what holds. */
export interface PolicyStore {
  load(): Promise<RunnerPolicy>;
  /**
   * Changes the policy as one step: it is read as it is now, `change` makes what is kept from it, and nothing else writes in between. A
   * change must be made on the policy as it is when it is kept, never on one read before the owner was asked something: a pause that was
   * set in another terminal meanwhile would be undone. What `change` throws is thrown, and nothing is kept.
   */
  update<T>(change: (current: RunnerPolicy) => PolicyEdit<T>): Promise<T>;
}

/** Where the file system says a folder really is, links followed; undefined when there is no folder there. */
export interface FolderResolver {
  resolve(path: string): Promise<string | undefined>;
}

/** The place a task works in, and what is left of it when it ends. */
export interface IsolatedFolder {
  /** Where the coding agent works: the worktree, or the folder itself when it is worked on in place. */
  readonly folder: string;
  /**
   * Ends the work: what was done is left on a branch (nothing is pushed), and the worktree is gone. Null for a task that changed nothing, or
   * one worked in place. Stops, and throws, when `signal` aborts before the work is kept.
   */
  finish(signal: AbortSignal): Promise<{ readonly branch: string | null; readonly diffStat: string | null }>;
  /** Gives it up: the worktree and the branch go, as if nothing had been begun. It does not stop for a signal: what was told to stop is what it cleans up after. */
  discard(): Promise<void>;
}

/** Why a folder cannot be worked in the way its owner chose, in words for the person. */
export class IsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IsolationError';
  }
}

/** What a clean-up of the copies a runner that was stopped abruptly left behind put right. */
export interface SweepReport {
  /** The copies of folders that were taken away, and what was written down about copies that were already gone. */
  readonly copies: number;
  /** The branches that were deleted, which held nothing that was not there before the task began. */
  readonly branches: number;
}

export interface Isolation {
  /** Why a copy of a folder could not be made, in words for the person, or nothing when it can: it is asked before the folder is shared, and nothing is made. */
  check(folder: AllowedFolder): Promise<string | undefined>;
  /**
   * Makes the place for a task. Throws `IsolationError` when the folder holds no repository, or the worktree could not be made, and when
   * `signal` aborts first: nothing of it is left then.
   */
  prepare(folder: AllowedFolder, taskId: string, signal: AbortSignal): Promise<IsolatedFolder>;
  /**
   * Takes away what a task left when the runner was killed in the middle of it: its copy, and its branch when there is nothing on it but
   * what it began from. A branch with work on it is never touched. Only to be asked while no task runs anywhere: every copy it finds is
   * taken for one that nothing owns. Never throws.
   */
  sweep(): Promise<SweepReport>;
}

/**
 * One task at a time on a machine, across every process of the runner on it: `start` may be running a task when somebody gives the
 * machine another with `run`. A lock that is held by nobody alive is taken over.
 */
export interface TaskLock {
  /** Takes the lock. What comes back gives it up, and only if it is still this one's. Nothing comes back when another process holds it. */
  acquire(): Promise<(() => Promise<void>) | undefined>;
}

/** One task in the journal, and when it last changed. */
export interface JournalRecord {
  readonly entry: JournalEntry;
  readonly at: number;
}

/** What the runner keeps of its tasks, so that a connection that dropped, or a runner that stopped, can still say how they ended. */
export interface JournalStore {
  load(): Promise<readonly JournalRecord[]>;
  save(records: readonly JournalRecord[]): Promise<void>;
}

/** What was in the git repositories under a folder before a task, kept for the check after it. What is in it is the scan's own. */
export type GitSettingsBaseline = object;

/**
 * What a task that worked in place may have left in the git repositories under the folder, which would make git run a program the next time
 * its owner uses it. What was there before the task is recorded first (`snapshot`), and only what the task added or changed is taken away after it
 * (`scan`): the hooks and settings the owner had are theirs. A check that could not look at everything says so in its report, and one with no
 * record of before removes nothing. Neither ever throws.
 */
export interface GitSettingsScan {
  /** Undefined when nothing could be recorded. */
  snapshot(root: string, signal: AbortSignal): Promise<GitSettingsBaseline | undefined>;
  scan(root: string, signal: AbortSignal, baseline: GitSettingsBaseline | undefined): Promise<GitSettingsReport>;
}

/** What a coding agent says it is, on this machine. */
export interface AgentDetection {
  readonly installed: boolean;
  readonly path: string | undefined;
  readonly version: string | undefined;
  /** Null when the tool cannot tell. */
  readonly loggedIn: boolean | null;
  /** The runner can drive this version. When it cannot, `problem` says what to do. */
  readonly supported: boolean;
  readonly problem: string | undefined;
  /** What contains it here: its own sandbox, or nothing. Nothing means it runs only in a folder its owner trusts. */
  readonly containment: 'sandbox' | 'none';
}

/** One task for a coding agent. The adapter never decides what may be touched: it is told where, and the policy has already decided that. */
export interface AgentRequest {
  /** Where it works: the worktree, or the folder itself. */
  readonly folder: string;
  readonly instruction: string;
  readonly access: FolderAccess;
  /** The program to start. */
  readonly executable: string;
  /** What the tool is started with, built from nothing (see `childEnvironment`). */
  readonly environment: Readonly<Record<string, string>>;
  readonly surroundings: Surroundings;
  /** What the agent may ask the runner to do in a workspace. Present only when the folder is one, and only for an agent that has the tools. */
  readonly workspace?: WorkspaceTools | undefined;
}

/** What a coding agent did, as every tool tells it. The last is `result` or `error`, and nothing follows it. */
export type AgentEvent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool'; readonly name: string; readonly summary: string; readonly denied: boolean }
  | { readonly kind: 'usage'; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly kind: 'result'; readonly text: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * A coding agent, as the runner drives it: one adapter for each tool, behind this one contract. The adapter starts the tool with the
 * narrowest permissions it has for `access`, never asks it to skip its own safety, and leaves no process behind when it stops.
 */
export interface CodingAgent {
  readonly kind: CodingAgentKind;
  /**
   * Whether it can be given `AgentRequest.workspace` as tools of its own. One that cannot works in the workspace as it is, and the task
   * says so in words: it cannot make folders or clone repositories by itself.
   */
  readonly workspaceTools?: boolean;
  /** Whether it is here, which version, whether its person is logged in. `executable` is a path the owner picked, when there is one. */
  detect(executable: string | undefined): Promise<AgentDetection>;
  /** Runs one task. Ends when the tool is done, or promptly after `signal` aborts, with its process and everything it started gone. */
  run(request: AgentRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
}

export type CodingAgents = Readonly<Partial<Record<CodingAgentKind, CodingAgent>>>;
