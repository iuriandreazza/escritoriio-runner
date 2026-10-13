/**
 * How much an agent may build in a workspace without its owner: what a loop or a mistaken instruction can make is bounded, since none of it
 * asks for a click (a folder) or asks for too many (a clone is approved one by one, and the owner is not to be asked without end).
 */
export const WORKSPACE_LIMITS = {
  /** Folders the agent may make in one task. */
  foldersPerTask: 5,
  /** Folders at the top of a workspace, whoever made them. */
  foldersPerWorkspace: 50,
  /** Clones the agent may ask for in one task, whether or not they were approved. */
  clonesPerTask: 3,
  /** Clones at the top of a workspace. */
  clonesPerWorkspace: 20,
} as const;
