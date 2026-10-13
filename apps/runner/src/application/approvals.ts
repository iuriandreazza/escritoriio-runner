import type { FolderAccess } from '../domain/folder-policy.ts';

/** What the owner of the machine is asked to approve: the exact text the coding agent would be given, and where it would work. */
export interface ApprovalRequest {
  readonly taskId: string;
  /** The label of the folder, as its owner chose it. */
  readonly folder: string;
  readonly access: FolderAccess;
  /** As the office offered it: it is what the owner approves, so it is shown whole. */
  readonly instruction: string;
}

/**
 * What the owner is asked to approve when the agent of a workspace asks to clone a repository into it: the exact address (it holds no
 * credentials and no query, so it is shown whole), the name of the folder it would go into, and the workspace. Nothing is cloned unless the owner says yes.
 */
export interface CloneApprovalRequest {
  readonly kind: 'clone';
  readonly taskId: string;
  /** The label of the workspace, as its owner chose it. */
  readonly workspace: string;
  readonly url: string;
  /** The folder of the workspace that the repository would be cloned into. */
  readonly folder: string;
}

export type ApprovalAnswer = 'approved' | 'denied';

/**
 * Where the owner approves a task of a folder that asks before each one. An embedder supplies it: the terminal of `start`, or the windows
 * of the app. `ask` shows the request and gives the answer. When `signal` aborts (the task was cancelled, the machine paused or stopped, or
 * nobody answered in time) whatever was shown is taken away and the answer is `denied`: the runner does not wait for a port that ignores it.
 */
export interface ApprovalPort {
  ask(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer>;
  /**
   * Asks the owner whether a repository may be cloned into a workspace, with the same rules for `signal` as `ask`. A place that cannot ask
   * about a clone does not have it, and then nothing is cloned.
   */
  askToClone?(request: CloneApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer>;
}

/** How long the owner has to answer, which leaves most of the time the office gives a task to the task. */
export const APPROVAL_WAIT_MS = 10 * 60_000;
