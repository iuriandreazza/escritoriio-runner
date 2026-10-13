import type { CodingAgentKind } from '@escritoriio/runner-protocol';
import { CODING_AGENT_KINDS, MAX_TASK_SECONDS, RUNNER_LIMITS } from '@escritoriio/runner-protocol';
import { defaultLabel, DESCRIBE_LABEL_PROBLEM, findByLabel, problemWithLabel, sameLabel } from '../domain/folder-label.ts';
import type { AllowedFolder, FolderAccess, FolderApproval, FolderIsolation, Surroundings } from '../domain/folder-policy.ts';
import { DESCRIBE_FOLDER_PROBLEM, isWorkspace, problemWithFolder, problemWithNewFolder } from '../domain/folder-policy.ts';
import { folderName, isSamePath, resolveAgainst } from '../domain/paths.ts';
import { plainText } from '../domain/plain-text.ts';
import { WORKSPACE_LIMITS } from '../domain/workspace-limits.ts';
import { DESCRIBE_WORKSPACE_NAME_PROBLEM, problemWithWorkspaceName } from '../domain/workspace-names.ts';
import type { CodingAgents, FolderResolver, Isolation, PolicyStore, RunnerPolicy } from './task-ports.ts';
import { OwnerError } from './owner-error.ts';
import type { WorkspaceOps } from './workspace-ports.ts';

export interface FoldersDeps {
  readonly policy: PolicyStore;
  readonly resolver: FolderResolver;
  readonly surroundings: Surroundings;
  /** Asked whether a folder can be copied, for one that is shared to be worked in a copy. */
  readonly isolation: Pick<Isolation, 'check'>;
  /** What this runner can drive: a folder is not shared with a coding agent that it cannot. */
  readonly agents: CodingAgents;
}

export interface NewFolder {
  /** The full path of the folder. */
  readonly path: string;
  /** What it is called to the office; the name of the folder when there is none. */
  readonly label: string | undefined;
  readonly access: FolderAccess;
  readonly approval: FolderApproval;
  readonly isolation: FolderIsolation;
  readonly trusted: boolean;
  readonly agent: CodingAgentKind | null;
}

/** What the person is asked about before a folder is shared: the folder as it would be kept, and the AI member whose requests it is about. */
export interface FolderQuestion {
  readonly folder: AllowedFolder;
  readonly aiMember: string;
}

export type AddFolderOutcome = { readonly added: false } | { readonly added: true; readonly folder: AllowedFolder };

/** Said where a folder is worked in place: the one thing a task can leave behind that runs later, with the owner's rights. */
export const SETTINGS_REMOVED_LINE = '- Git hooks and settings that a task adds and that would run programs are removed after it; the ones you already had are left as they are.';

const FALLBACK_AI_MEMBER = 'your AI member';
const MINUTES = MAX_TASK_SECONDS / 60;

/**
 * What a choice of how to share a folder means, in plain words, since the person who makes it may never have read what a coding agent
 * can do. It says what the choice allows, what stays out of reach, and how to take it back.
 */
export function describeFolderChoice({ folder, aiMember }: FolderQuestion): readonly string[] {
  const where = folder.realPath;
  const who = `Requests from you to ${aiMember}`;
  const approval = folder.approval === 'auto' ? 'without asking each time' : 'only after you approve each one on this machine, with the exact text in front of you';
  const edits = folder.access === 'edit';
  const place = {
    worktree: edits ? 'in a copy of the files on a branch of its own, so the files you have in the folder are not touched' : 'on a copy of the files as of the last commit',
    'in-place': edits
      ? 'on the files in the folder themselves, with no copy and no branch: what it changes is in your files at once, mixed with whatever you had not committed'
      : 'on the files in the folder as they are, what you have not committed included',
  }[folder.isolation];
  const workspace = isWorkspace(folder);
  const lines = [
    `${workspace ? 'Workspace' : 'Folder'} "${folder.label}": ${folder.path}${folder.path === where ? '' : ` (really ${where})`}`,
    `  access:     ${folder.access}`,
    `  approval:   ${folder.approval}`,
    `  isolation:  ${folder.isolation}${workspace ? ' (always, for a workspace)' : ''}`,
    `  trusted:    ${folder.trusted ? 'yes' : 'no'}`,
    `  agent:      ${folder.agent ?? 'the first one that can run'}`,
    '',
    'What this means:',
  ];
  if (workspace) {
    lines.push(
      `- ${who} will have a coding agent build in this workspace, an empty folder made for it, ${approval}, for at most ${MINUTES} minutes each. It is not a git repository: the agent works IN PLACE, on the files in the folder themselves, with no copy and no branch, so what it does is in the folder at once.`,
      `- It is given file tools and a shell, which runs inside the sandbox of your operating system where it has one: it writes only in the workspace and in a temporary folder of its own, has no network and cannot read the places where credentials are kept (such as ~/.ssh), but it can read the rest of this machine. Windows has no such sandbox: nothing contains the commands there, and a workspace is edited only if you trust it.`,
      `- It may create folders inside the workspace without asking you (at most ${WORKSPACE_LIMITS.foldersPerTask} a task and ${WORKSPACE_LIMITS.foldersPerWorkspace} in all), each a git repository with an empty first commit made by this runner.`,
      `- It may ask to clone git repositories into the workspace, and you approve each clone one by one on this machine, with the exact address and the folder in front of you (at most ${WORKSPACE_LIMITS.clonesPerTask} requests a task and ${WORKSPACE_LIMITS.clonesPerWorkspace} clones in all). The clone is made by this runner and not by the agent, over https or ssh only, with your own git credentials and ssh keys, which no coding agent ever sees. It runs nothing that the repository carries: no hook, no filter, no submodule.`,
      '- After each task this runner removes the hooks and settings that run programs that the task added to the git repositories in the workspace (all of them in a repository the task made or cloned), and tells you what it removed.',
      '- What the agent makes or clones in the workspace is plain folders in it: they are never shared separately, and only you change what is shared. Nothing is pushed.',
    );
  } else if (!edits) {
    lines.push(`- ${who} will have a coding agent read the files in ${where} ${approval}, ${place}, for at most ${MINUTES} minutes each. It is not allowed to change any, and it runs nothing.`);
  } else {
    lines.push(
      `- ${who} will have a coding agent read and change the files in ${where} ${approval}, ${place}, for at most ${MINUTES} minutes each. It is given file tools and a shell, so it can run commands as well.`,
      '- The shell runs inside the sandbox of your operating system where it has one (macOS, and Linux with bubblewrap and socat): it writes only in the work folder and in a temporary folder of its own, has no network and cannot read the places where credentials are kept (such as ~/.ssh), but it can read the rest of this machine. Windows has no such sandbox: nothing contains the commands there, and a folder is edited only if you trusted it.',
      '- The file tools are not inside that sandbox. Each of their paths is checked when the call is made, and a command can swap a link inside the folder before the tool uses the path, so a file tool may, in some cases the check cannot catch, read or write a file outside the folder.',
    );
  }
  if (!workspace && folder.isolation === 'in-place') lines.push(SETTINGS_REMOVED_LINE);
  if (!workspace && edits && folder.isolation === 'worktree') {
    lines.push('- Nothing is pushed: what it did is left on a branch of that folder’s repository, for you to look at and merge yourself.');
  }
  if (folder.isolation === 'worktree') lines.push('- The folder must be inside a git repository that has a commit: the copy is made from the last one.');
  lines.push(
    folder.trusted
      ? '- It is trusted: a coding agent that cannot be contained on this system (one with no sandbox of its own here) may still run in it, with everything your user account can reach.'
      : '- It is not trusted: a coding agent that cannot be contained on this system is not run in it.',
    '- Each runner that is running does one task at a time.',
    '- The office decides whose request becomes a task, and this machine cannot tell who wrote it: what you allow here holds for every task the office sends for this folder.',
    `- Whatever the office says, this machine checks for every task that the folder is still shared and where it was, how it is shared (access, approval, isolation), that the coding agent is installed, logged in and contained or the folder trusted, and that the machine is not paused. You can pause it (escritoriio-runner pause) or stop sharing the folder (escritoriio-runner folders remove "${folder.label}") whenever you like.`,
  );
  return lines;
}

/** The question the person answers, after what the choice means. */
export const SHARE_FOLDER_PROMPT = 'Share this folder? [y/N] ';

const NOT_COPYABLE_CHOICE = 'To share it anyway, work on the folder itself: --isolation in-place.';

/** What is wrong with how the folder is asked to be shared, whatever the folder is. */
function problemWithChoice(request: Pick<NewFolder, 'agent'>, agents: CodingAgents): string | undefined {
  if (request.agent !== null && agents[request.agent] === undefined) {
    return `This runner cannot drive ${request.agent} yet. It can drive: ${CODING_AGENT_KINDS.filter((kind) => agents[kind] !== undefined).join(', ')}.`;
  }
  return undefined;
}

/** What stands in the way of putting a folder among those that are shared, in words; nothing when nothing does. */
function problemWithAdding(current: RunnerPolicy, folder: AllowedFolder, windows: boolean): string | undefined {
  const same = current.folders.find((candidate) => isSamePath(candidate.realPath, folder.realPath, windows));
  if (same) return `That folder is already shared as "${same.label}". To share it another way, stop sharing it first: escritoriio-runner folders remove "${same.label}".`;
  if (current.folders.length >= RUNNER_LIMITS.folders) return `A machine shares at most ${RUNNER_LIMITS.folders} folders.`;
  if (current.folders.some((taken) => sameLabel(taken.label, folder.label))) return `There is a folder called "${folder.label}" already. Choose another label with --label.`;
  return undefined;
}

/**
 * Puts a folder on the list of those the machine shares. The path is turned into where the file system really has the folder, links
 * followed, and refused when that is a place no coding agent should have (home itself, a whole disk, the runner's own settings, where
 * credentials are kept), or when a copy cannot be made of it for the way it is to be worked in. The person is asked, with what their
 * choice means, before anything is kept, and it is kept on the settings as they are then, not as they were when the question began: what
 * the person changed in another terminal meanwhile stays. Throws, with words for the person, when the folder cannot be shared.
 */
export async function addFolder(deps: FoldersDeps, request: NewFolder, aiMember: string | undefined, confirm: (question: FolderQuestion) => Promise<boolean>): Promise<AddFolderOutcome> {
  const choiceProblem = problemWithChoice(request, deps.agents);
  if (choiceProblem) throw new OwnerError(choiceProblem);
  const realPath = await deps.resolver.resolve(request.path);
  if (realPath === undefined) throw new OwnerError('There is no folder at that path.');
  const problem = problemWithNewFolder(realPath, deps.surroundings);
  if (problem) throw new OwnerError(DESCRIBE_FOLDER_PROBLEM[problem]);

  const current = await deps.policy.load();
  const label = request.label ?? defaultLabel(folderName(realPath), current.folders.map((folder) => folder.label));
  const labelProblem = problemWithLabel(label);
  if (labelProblem) throw new OwnerError(DESCRIBE_LABEL_PROBLEM[labelProblem]);

  const folder: AllowedFolder = {
    label,
    path: request.path,
    realPath,
    access: request.access,
    approval: request.approval,
    isolation: request.isolation,
    trusted: request.trusted,
    agent: request.agent,
  };
  const { windows } = deps.surroundings;
  // Said before the person is asked: nobody is asked about what cannot be done.
  const refusal = problemWithAdding(current, folder, windows);
  if (refusal) throw new OwnerError(refusal);
  const cannotCopy = folder.isolation === 'worktree' ? await deps.isolation.check(folder) : undefined;
  if (cannotCopy !== undefined) throw new OwnerError(`${cannotCopy} ${NOT_COPYABLE_CHOICE}`);

  if (!(await confirm({ folder, aiMember: aiMember ?? FALLBACK_AI_MEMBER }))) return { added: false };
  await deps.policy.update((latest) => {
    // The same questions again, of what is kept now: another command may have shared a folder, or taken the label, while the person thought.
    const late = problemWithAdding(latest, folder, windows);
    if (late) throw new OwnerError(late);
    return { policy: { ...latest, folders: [...latest.folders, folder] }, result: undefined };
  });
  return { added: true, folder };
}

export interface NewWorkspace {
  /** The full path of the folder the workspace is made in, which is chosen by the owner and must be there. */
  readonly parent: string;
  /** The name of the new, empty folder: one name, which must not be there yet. */
  readonly name: string;
  /** What it is called to the office; the name of the folder when there is none. */
  readonly label: string | undefined;
  readonly approval: FolderApproval;
  readonly trusted: boolean;
  readonly agent: CodingAgentKind | null;
}

export interface WorkspaceFoldersDeps extends FoldersDeps {
  /** What makes the empty folder, and takes it away again when it cannot be shared. */
  readonly workspace: Pick<WorkspaceOps, 'makeFolder' | 'discardFolder'>;
}

const WORKSPACE_EXISTS = 'There is a folder or a file with that name there already: choose another name, or another folder to make it in.';
const PARENT_MOVED = 'The folder to make the workspace in is not where it was a moment ago, so nothing was made.';

/**
 * Makes an empty folder for an agent to build in, and shares it as a workspace: edited in place, since it is no repository, and with the
 * agent allowed to make folders in it and to ask to clone repositories (which the owner approves one by one). The same checks as for any shared
 * folder apply to where it would be (never home, a disk, the runner's own places, the places of credentials), the same question is asked first,
 * with what a workspace means, and nothing is made until the person says yes. What is made is taken away again when it cannot be kept. The
 * folders that an agent makes inside it afterwards are never entries of the policy: only the owner, here, changes what is shared.
 */
export async function createWorkspace(deps: WorkspaceFoldersDeps, request: NewWorkspace, aiMember: string | undefined, confirm: (question: FolderQuestion) => Promise<boolean>): Promise<AddFolderOutcome> {
  const choiceProblem = problemWithChoice(request, deps.agents);
  if (choiceProblem) throw new OwnerError(choiceProblem);
  const nameProblem = problemWithWorkspaceName(request.name);
  if (nameProblem) throw new OwnerError(DESCRIBE_WORKSPACE_NAME_PROBLEM[nameProblem]);
  const parent = await deps.resolver.resolve(request.parent);
  if (parent === undefined) throw new OwnerError('There is no folder at that path to make the workspace in.');
  const { windows } = deps.surroundings;
  const target = resolveAgainst(parent, request.name, windows);
  if (target === undefined) throw new OwnerError(DESCRIBE_FOLDER_PROBLEM['not-absolute']);
  // The folder is not there yet, so it is judged by where it would be: in a place that is refused, a workspace is refused as well.
  const problem = problemWithNewFolder(target, deps.surroundings);
  if (problem) throw new OwnerError(DESCRIBE_FOLDER_PROBLEM[problem]);
  if ((await deps.resolver.resolve(target)) !== undefined) throw new OwnerError(WORKSPACE_EXISTS);

  const current = await deps.policy.load();
  const label = request.label ?? defaultLabel(request.name, current.folders.map((folder) => folder.label));
  const labelProblem = problemWithLabel(label);
  if (labelProblem) throw new OwnerError(DESCRIBE_LABEL_PROBLEM[labelProblem]);
  const folder: AllowedFolder = { label, path: target, realPath: target, access: 'edit', approval: request.approval, isolation: 'in-place', trusted: request.trusted, agent: request.agent, kind: 'workspace' };
  const refusal = problemWithAdding(current, folder, windows);
  if (refusal) throw new OwnerError(refusal);

  if (!(await confirm({ folder, aiMember: aiMember ?? FALLBACK_AI_MEMBER }))) return { added: false };
  const made = await deps.workspace.makeFolder(parent, request.name);
  if (made === 'moved') throw new OwnerError(PARENT_MOVED);
  if (made === 'exists') throw new OwnerError(WORKSPACE_EXISTS);
  try {
    await deps.policy.update((latest) => {
      const late = problemWithAdding(latest, folder, windows);
      if (late) throw new OwnerError(late);
      return { policy: { ...latest, folders: [...latest.folders, folder] }, result: undefined };
    });
  } catch (error) {
    await deps.workspace.discardFolder(parent, request.name);
    throw error;
  }
  return { added: true, folder };
}

/** The words for a label that names no folder: which there are, so that the person can say it again. */
function noFolderCalled(current: RunnerPolicy, label: string): OwnerError {
  const labels = current.folders.map((candidate) => `"${candidate.label}"`).join(', ');
  return new OwnerError(`No folder is shared as "${plainText(label, RUNNER_LIMITS.folderLabel)}".${labels === '' ? ' None is shared yet.' : ` Shared: ${labels}.`}`);
}

/** Stops sharing a folder, by the label it is shared under (a label that differs only in case will do). Throws, with the labels there are, when there is none. */
export function removeFolder(deps: Pick<FoldersDeps, 'policy'>, label: string): Promise<AllowedFolder> {
  return deps.policy.update((current) => {
    const folder = findByLabel(current.folders, label);
    if (!folder) throw noFolderCalled(current, label);
    return { policy: { ...current, folders: current.folders.filter((candidate) => candidate !== folder) }, result: folder };
  });
}

/** What of a shared folder its owner may change after it was shared. Where it is and what it is called stay: the office knows it by its label. */
export type FolderChanges = Partial<Pick<AllowedFolder, 'access' | 'approval' | 'isolation' | 'trusted' | 'agent'>>;

export type UpdateFolderOutcome = { readonly updated: false } | { readonly updated: true; readonly folder: AllowedFolder };

const changed = (folder: AllowedFolder, changes: FolderChanges): boolean => (Object.keys(changes) as (keyof FolderChanges)[]).some((key) => changes[key] !== undefined && changes[key] !== folder[key]);
const withChanges = (folder: AllowedFolder, changes: FolderChanges): AllowedFolder => ({ ...folder, ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) });

/**
 * Changes how a folder that is shared is shared, with the same questions as sharing it: the choice must be one this runner can honor, the
 * folder must still be where it was and be copyable when it is to be worked in a copy, and the person is asked, with what the new choice
 * means, before anything is kept. It is kept on the settings as they are then. Throws, with words for the person, when it cannot be changed.
 */
export async function updateFolder(deps: FoldersDeps, label: string, changes: FolderChanges, aiMember: string | undefined, confirm: (question: FolderQuestion) => Promise<boolean>): Promise<UpdateFolderOutcome> {
  const current = await deps.policy.load();
  const present = findByLabel(current.folders, label);
  if (!present) throw noFolderCalled(current, label);
  if (isWorkspace(present) && (changes.access === 'read-only' || changes.isolation === 'worktree')) throw new OwnerError('A workspace is always edited in place: its access and its isolation cannot be changed.');
  if (!changed(present, changes)) throw new OwnerError(`"${present.label}" is shared that way already.`);
  const folder = withChanges(present, changes);

  const choiceProblem = problemWithChoice(folder, deps.agents);
  if (choiceProblem) throw new OwnerError(choiceProblem);
  const problem = problemWithFolder(folder, await deps.resolver.resolve(folder.path), deps.surroundings);
  if (problem) throw new OwnerError(DESCRIBE_FOLDER_PROBLEM[problem]);
  const cannotCopy = folder.isolation === 'worktree' && present.isolation !== 'worktree' ? await deps.isolation.check(folder) : undefined;
  if (cannotCopy !== undefined) throw new OwnerError(`${cannotCopy} ${NOT_COPYABLE_CHOICE}`);

  if (!(await confirm({ folder, aiMember: aiMember ?? FALLBACK_AI_MEMBER }))) return { updated: false };
  const kept = await deps.policy.update((latest) => {
    // The same folder, if it is still shared: another command may have taken it away while the person thought.
    const still = findByLabel(latest.folders, label);
    if (!still) throw noFolderCalled(latest, label);
    const next = withChanges(still, changes);
    return { policy: { ...latest, folders: latest.folders.map((candidate) => (candidate === still ? next : candidate)) }, result: next };
  });
  return { updated: true, folder: kept };
}

/** A folder that is shared, with whether it is still where it was when it was shared: what a screen shows. */
export interface FolderView {
  readonly folder: AllowedFolder;
  /** In words, what is wrong with it now; nothing when it is as it was. */
  readonly problem: string | undefined;
}

export async function inspectFolders(deps: Pick<FoldersDeps, 'policy' | 'resolver' | 'surroundings'>): Promise<readonly FolderView[]> {
  const { folders } = await deps.policy.load();
  return Promise.all(
    folders.map(async (folder) => {
      const problem = problemWithFolder(folder, await deps.resolver.resolve(folder.path), deps.surroundings);
      return { folder, problem: problem ? DESCRIBE_FOLDER_PROBLEM[problem] : undefined };
    }),
  );
}

/** The folders that are shared, one after the other, each with whether it is still where it was when it was shared. */
export async function describeFolders(deps: Pick<FoldersDeps, 'policy' | 'resolver' | 'surroundings'>): Promise<readonly string[]> {
  const views = await inspectFolders(deps);
  if (views.length === 0) return ['No folder is shared yet. Share one with: escritoriio-runner folders add <path>'];
  return views.flatMap(({ folder, problem }) => [
    `${folder.label}: ${folder.path}${isWorkspace(folder) ? ' (workspace)' : ''}`,
    `  access: ${folder.access}, approval: ${folder.approval}, isolation: ${folder.isolation}, trusted: ${folder.trusted ? 'yes' : 'no'}, agent: ${folder.agent ?? 'any'}`,
    `  ${problem ?? 'It is where it was when it was shared.'}`,
  ]);
}
