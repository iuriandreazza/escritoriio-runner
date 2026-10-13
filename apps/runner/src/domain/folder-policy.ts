import type { CodingAgentKind } from '@escritoriio/runner-protocol';
import { credentialPaths } from './credential-places.ts';
import { isAbsolutePath, isInside, isRootPath, isSamePath, withoutDataVolumePrefix } from './paths.ts';

export type FolderAccess = 'read-only' | 'edit';
/** `auto` runs what the owner asks without asking each time; `ask` holds a task until the owner approves its exact text. */
export type FolderApproval = 'auto' | 'ask';
/** `worktree` works on a copy of the files on a branch of its own and leaves the checked-out files alone; `in-place` works on the folder itself. */
export type FolderIsolation = 'worktree' | 'in-place';

/**
 * What a shared folder is. A `workspace` is a folder the owner made empty for the agent to build in: always edited in place, with the agent
 * allowed to make folders in it and to ask to clone repositories into it. What the agent makes there is plain directories, never an entry
 * of the policy: the policy changes only by the owner's own action.
 */
export type FolderKind = 'plain' | 'workspace';

/** A folder its owner allowed, as the runner keeps it. Only the owner's own screens or commands write it: never the office, never a message. */
export interface AllowedFolder {
  /** What the office is told and asks for: a name the owner chose, never a path. */
  readonly label: string;
  /** The folder as the owner gave it. */
  readonly path: string;
  /** Where the file system said it really was when it was put on the list, links followed. */
  readonly realPath: string;
  /** `read-only` gives the coding agent the tools that look; `edit` also gives it the file tools and a shell. */
  readonly access: FolderAccess;
  readonly approval: FolderApproval;
  readonly isolation: FolderIsolation;
  /** Its owner vouches for it: a coding agent that cannot be contained here may run in it. */
  readonly trusted: boolean;
  /** The coding agent used when a task does not ask for one. */
  readonly agent: CodingAgentKind | null;
  /** Absent means `plain`, so that a policy written before workspaces is read as it always was. */
  readonly kind?: FolderKind;
}

export const isWorkspace = (folder: Pick<AllowedFolder, 'kind'>): boolean => folder.kind === 'workspace';

/** A workspace is edited, in place: it is not a repository, so there is no copy to make, and it is where the agent builds. Anything else in a file that says it is a workspace is a mistake. */
export const isConsistentWorkspace = (folder: Pick<AllowedFolder, 'kind' | 'access' | 'isolation'>): boolean => !isWorkspace(folder) || (folder.access === 'edit' && folder.isolation === 'in-place');

/** What a folder must keep clear of: the machine's own pieces that no coding agent has any business touching. All of them as the file system names them. */
export interface Surroundings {
  readonly home: string;
  /** Where the runner keeps its token and its settings. */
  readonly stateDirectory: string;
  /** Where the runner makes the copies of folders that tasks work in. It is not inside the state directory, so that a task never has the token a `..` away. */
  readonly worktreesDirectory: string;
  /** Where the coding agent keeps its login when it is not under home (`CLAUDE_CONFIG_DIR`). */
  readonly claudeConfigDirectory?: string | undefined;
  readonly windows: boolean;
}

export type FolderProblem =
  | 'not-absolute'
  | 'is-root'
  | 'is-home'
  | 'holds-home'
  | 'holds-state'
  | 'inside-state'
  | 'holds-worktrees'
  | 'inside-worktrees'
  | 'holds-credentials'
  | 'inside-credentials'
  | 'gone'
  | 'moved';

export const DESCRIBE_FOLDER_PROBLEM: Readonly<Record<FolderProblem, string>> = {
  'not-absolute': 'That is not the full path of a folder.',
  'is-root': 'A whole disk is not a folder to give to a coding agent.',
  'is-home': 'Your home folder holds everything of yours: choose a folder inside it.',
  'holds-home': 'That folder holds your home folder: choose a folder inside it.',
  'holds-state': 'That folder holds the runner’s own settings and token: choose another.',
  'inside-state': 'That folder is inside the runner’s own settings: choose another.',
  'holds-worktrees': 'That folder holds the place where the runner makes its copies of folders: choose another.',
  'inside-worktrees': 'That folder is inside the place where the runner makes its copies of folders: choose another.',
  'holds-credentials': 'That folder holds a place where credentials are kept (such as ~/.ssh or ~/.aws): choose a folder that holds none.',
  'inside-credentials': 'That folder is, or is inside, a place where credentials are kept (such as ~/.ssh or ~/.aws): choose another.',
  gone: 'The folder is not there any more.',
  moved: 'The folder is not where it was when it was allowed: it was moved, or a link now leads elsewhere. Allow it again to confirm it is the one you mean.',
};

/**
 * Whether a folder may be put on the list. `realPath` is where the file system says the folder really is, links followed: a folder named by
 * a link out of somewhere safe is judged by where the link leads, never by what it is called. macOS reaches its user folders by a second
 * name, through its data volume, which the file system does not fold into the first: every place is judged by the name without it.
 */
export function problemWithNewFolder(realPath: string, surroundings: Surroundings): FolderProblem | undefined {
  const { windows } = surroundings;
  if (!isAbsolutePath(realPath, windows)) return 'not-absolute';
  const folder = withoutDataVolumePrefix(realPath);
  const home = withoutDataVolumePrefix(surroundings.home);
  const state = withoutDataVolumePrefix(surroundings.stateDirectory);
  const copies = withoutDataVolumePrefix(surroundings.worktreesDirectory);
  if (isRootPath(folder, windows)) return 'is-root';
  if (isSamePath(folder, home, windows)) return 'is-home';
  if (isInside(folder, home, windows)) return 'holds-home';
  if (isInside(folder, state, windows)) return 'holds-state';
  if (isInside(state, folder, windows)) return 'inside-state';
  if (isInside(folder, copies, windows)) return 'holds-worktrees';
  if (isInside(copies, folder, windows)) return 'inside-worktrees';
  // What a command or a file tool can read of the machine is most of it, but what the sandbox hides is the credentials, and a folder shared from among them would be opened again.
  for (const place of credentialPaths(home, surroundings.claudeConfigDirectory).map(withoutDataVolumePrefix)) {
    if (isInside(place, folder, windows)) return 'inside-credentials';
    if (isInside(folder, place, windows)) return 'holds-credentials';
  }
  return undefined;
}

/**
 * Whether a folder on the list may be worked in now, checked again at every task whatever the office offers. `now` is where the folder
 * resolves at this moment (undefined when it is not there): it must be where it was when the owner allowed it.
 */
export function problemWithFolder(folder: Pick<AllowedFolder, 'realPath'>, now: string | undefined, surroundings: Surroundings): FolderProblem | undefined {
  if (now === undefined) return 'gone';
  if (!isSamePath(folder.realPath, now, surroundings.windows)) return 'moved';
  // What was fine when it was allowed may not be now: home or the settings may have moved to meet it.
  return problemWithNewFolder(now, surroundings);
}
