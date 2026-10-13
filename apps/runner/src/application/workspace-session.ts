import { DESCRIBE_CLONE_URL_PROBLEM, parseCloneUrl } from '../domain/clone-url.ts';
import { DESCRIBE_WORKSPACE_NAME_PROBLEM, problemWithWorkspaceName } from '../domain/workspace-names.ts';
import { WORKSPACE_LIMITS } from '../domain/workspace-limits.ts';
import type { ApprovalPort } from './approvals.ts';
import { APPROVAL_WAIT_MS } from './approvals.ts';
import { answerWithin } from './bounded.ts';
import type { Scheduler } from './ports.ts';
import type { PlacedFolder, WorkspaceOps, WorkspaceReply, WorkspaceTools } from './workspace-ports.ts';

/** Said to the office while the owner is asked about a clone: fixed words, with nothing of the address in them. */
export const WAITING_FOR_CLONE_APPROVAL = 'Waiting for its owner to approve cloning a repository on their machine.';

const STOPPED = 'The task was stopped, so nothing was done.';
const NO_PLACE_TO_APPROVE = 'This machine has no place to approve cloning a repository, so nothing was cloned.';
const NOT_APPROVED = 'Its owner did not approve cloning this repository, so nothing was cloned. Do not ask again for the same one.';
const NOT_APPROVED_IN_TIME = 'Its owner did not answer in time, so nothing was cloned.';
const noteOf = (placed: PlacedFolder): string => (placed.outcome === 'made' && placed.note !== undefined ? ` ${placed.note}` : '');
const WORKSPACE_MOVED = 'The workspace is not where it was when it was shared, so nothing was done.';

const fail = (words: string): WorkspaceReply => ({ ok: false, words });
const succeed = (words: string): WorkspaceReply => ({ ok: true, words });
const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export interface WorkspaceSessionDeps {
  /** Where the workspace really was when its owner shared it. */
  readonly workspace: string;
  /** What its owner calls it: shown to them when they are asked. */
  readonly label: string;
  readonly taskId: string;
  readonly ops: WorkspaceOps;
  /** Without a place that can ask about a clone, nothing is cloned. */
  readonly approvals: ApprovalPort | undefined;
  readonly scheduler: Scheduler;
  /** The task's own: what ends the task ends what the agent asked for, and the question to the owner. */
  readonly signal: AbortSignal;
  /** Tells the office something, as the words of the task. */
  readonly say: (words: string) => void;
  /** Whether the task waits for its owner now. */
  readonly waiting: (waiting: boolean) => void;
}

/**
 * What the agent of a workspace may ask for, for one task. A folder is made at once, since it is nothing that reaches outside the workspace.
 * A clone is made only after the owner of the machine approved that address and that folder, and never by the agent. Each has its ceiling
 * for the task (counted when it is asked, so that an agent cannot ask the owner without end) and for the workspace.
 */
export function createWorkspaceTools(deps: WorkspaceSessionDeps): WorkspaceTools {
  const { workspace, ops, signal } = deps;
  let foldersMade = 0;
  let clonesAsked = 0;

  /** Why a folder cannot be added to the workspace now, in words, or nothing. */
  async function problemWithRoom(name: string): Promise<string | undefined> {
    const names = await ops.folderNames(workspace);
    if (names.length >= WORKSPACE_LIMITS.foldersPerWorkspace) return `A workspace holds at most ${WORKSPACE_LIMITS.foldersPerWorkspace} folders at its top, and this one holds that many already.`;
    if (names.some((existing) => sameName(existing, name))) return `There is a folder called "${name}" already: choose another name.`;
    return undefined;
  }

  /** Words for a folder that could not be put in the workspace, or nothing when it was. */
  function problemWithPlacing(placed: PlacedFolder, name: string, what: string): string | undefined {
    if (placed.outcome === 'moved') return WORKSPACE_MOVED;
    if (placed.outcome === 'exists') return `There is a folder or a file called "${name}" already: choose another name.`;
    if (placed.outcome === 'failed') return `${what}: ${placed.words}`;
    return undefined;
  }

  async function newFolderNow(name: string): Promise<WorkspaceReply> {
    if (signal.aborted) return fail(STOPPED);
    const nameProblem = problemWithWorkspaceName(name);
    if (nameProblem) return fail(DESCRIBE_WORKSPACE_NAME_PROBLEM[nameProblem]);
    if (foldersMade >= WORKSPACE_LIMITS.foldersPerTask) return fail(`A task makes at most ${WORKSPACE_LIMITS.foldersPerTask} folders.`);
    const noRoom = await problemWithRoom(name);
    if (noRoom) return fail(noRoom);
    const placed = await ops.newRepository(workspace, name, signal);
    const refused = problemWithPlacing(placed, name, `The folder "${name}" could not be made`);
    if (refused) return fail(refused);
    foldersMade += 1;
    return succeed(`Made the folder "${name}" in the workspace, which is your working directory: ./${name}, a git repository on the branch main with an empty first commit.${noteOf(placed)}`);
  }

  async function cloneNow(url: string, name: string | undefined): Promise<WorkspaceReply> {
    if (signal.aborted) return fail(STOPPED);
    const address = parseCloneUrl(url);
    if (!address.ok) return fail(DESCRIBE_CLONE_URL_PROBLEM[address.problem]);
    const folder = name ?? address.repository;
    const nameProblem = problemWithWorkspaceName(folder);
    if (nameProblem) return fail(name === undefined ? `${DESCRIBE_WORKSPACE_NAME_PROBLEM[nameProblem]} The repository's own name cannot be used: give a name.` : DESCRIBE_WORKSPACE_NAME_PROBLEM[nameProblem]);
    if (clonesAsked >= WORKSPACE_LIMITS.clonesPerTask) return fail(`A task asks to clone at most ${WORKSPACE_LIMITS.clonesPerTask} repositories.`);
    const noRoom = await problemWithRoom(folder);
    if (noRoom) return fail(noRoom);
    if ((await ops.countClones(workspace)) >= WORKSPACE_LIMITS.clonesPerWorkspace) return fail(`A workspace holds at most ${WORKSPACE_LIMITS.clonesPerWorkspace} clones, and this one holds that many already.`);
    const askToClone = deps.approvals?.askToClone?.bind(deps.approvals);
    if (!askToClone) return fail(NO_PLACE_TO_APPROVE);
    // The address that the owner approves is the host that is contacted: asked before the owner is, so that nobody is shown what would not be done.
    const rewritten = await ops.addressProblem(address.url, signal);
    if (rewritten !== undefined) return fail(rewritten);

    clonesAsked += 1;
    deps.say(WAITING_FOR_CLONE_APPROVAL);
    deps.waiting(true);
    let outcome;
    try {
      outcome = await answerWithin(deps.scheduler, signal, APPROVAL_WAIT_MS, (waiting) => askToClone({ kind: 'clone', taskId: deps.taskId, workspace: deps.label, url: address.url, folder }, waiting), 'denied' as const);
    } finally {
      deps.waiting(false);
    }
    if (signal.aborted) return fail(STOPPED);
    if (outcome.timedOut) return fail(NOT_APPROVED_IN_TIME);
    if (outcome.answer !== 'approved') return fail(NOT_APPROVED);

    const placed = await ops.cloneRepository(workspace, folder, address.url, signal);
    const refused = problemWithPlacing(placed, folder, 'Nothing was cloned');
    if (refused) return fail(refused);
    return succeed(`Cloned the repository into the folder "${folder}" of the workspace, which is your working directory: ./${folder}. Nothing was pushed, and nothing it carried was run.${noteOf(placed)}`);
  }

  // One call at a time: the agent may make several in one turn, and the ceilings are counted, and the room in the workspace looked at, between them and not beside them.
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const done = queue.then(work, work);
    queue = done.catch(() => undefined);
    return done;
  };

  const newFolder = (name: string): Promise<WorkspaceReply> => serially(() => newFolderNow(name));
  const clone = (url: string, name: string | undefined): Promise<WorkspaceReply> => serially(() => cloneNow(url, name));

  return { newFolder, clone };
}
