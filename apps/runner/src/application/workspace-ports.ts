/** What the agent of a workspace is told of what it asked for, in plain words: a refusal says why and what to do, and nothing in it is a path of this machine. */
export interface WorkspaceReply {
  readonly ok: boolean;
  readonly words: string;
}

/**
 * What a coding agent may ask the runner to do in a workspace, since the agent itself cannot do it: it has no network, and it is not trusted
 * to make a repository from somebody else's address. The runner does both, in its own process, after its own checks. The agent never gets
 * a path, a shell or a credential out of either.
 */
export interface WorkspaceTools {
  /** Makes an empty folder in the workspace and a git repository in it, with an empty first commit. */
  newFolder(name: string): Promise<WorkspaceReply>;
  /** Asks the owner of the machine to approve cloning `url`, and clones it into a new folder when they do. Without a name the folder is called as the repository is. */
  clone(url: string, name?: string): Promise<WorkspaceReply>;
}

export type MadeFolder = 'made' | 'exists' | 'moved';

/** How a folder that is built apart and then put in the workspace ended: put there, or why not. */
export type PlacedFolder =
  | { readonly outcome: 'made'; /** Something the person who reads should know of how it was put there. */ readonly note?: string }
  | { readonly outcome: 'exists' | 'moved' }
  | { readonly outcome: 'failed'; readonly words: string };

/**
 * What is done to the files of a workspace, which the agent can change under the runner's feet (it has a shell in the workspace): every
 * operation names the workspace by where it really was when it was shared, and refuses when it is not there any more. Nothing here follows a link.
 * A folder that is made for the agent is built apart, where the agent cannot reach, and put in the workspace whole, never over what is there.
 */
export interface WorkspaceOps {
  /** The names of the folders at the top of the workspace. Links are not folders, nor are the places where tools keep their own files. */
  folderNames(workspace: string): Promise<readonly string[]>;
  /** How many of those folders are clones of a repository. */
  countClones(workspace: string): Promise<number>;
  /** Makes an empty folder, and fails when anything is there already (a link included), or when the workspace is not where it was. For the owner's own workspace, not for the agent. */
  makeFolder(workspace: string, name: string): Promise<MadeFolder>;
  /** Takes away a folder that was made and could not be kept. Never throws. */
  discardFolder(workspace: string, name: string): Promise<void>;
  /** Words when the address would reach a different host than the one shown (the owner's own settings rewrite it), or cannot be asked about; nothing when it is as it was written. */
  addressProblem(url: string, signal: AbortSignal): Promise<string | undefined>;
  /** Makes a git repository with an empty first commit, and puts it in the workspace as `name`. */
  newRepository(workspace: string, name: string, signal: AbortSignal): Promise<PlacedFolder>;
  /** Clones `url` and puts the clone in the workspace as `name`, never running anything the repository carries. */
  cloneRepository(workspace: string, name: string, url: string, signal: AbortSignal): Promise<PlacedFolder>;
}
