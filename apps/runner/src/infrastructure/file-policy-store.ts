import { CODING_AGENT_KINDS, RUNNER_LIMITS } from '@escritoriio/runner-protocol';
import { z } from 'zod';
import type { PolicyStore, RunnerPolicy } from '../application/task-ports.ts';
import { EMPTY_POLICY } from '../application/task-ports.ts';
import { problemWithLabel, sameLabel } from '../domain/folder-label.ts';
import { isConsistentWorkspace } from '../domain/folder-policy.ts';
import { createLockedJsonStore } from './locked-json-store.ts';

export const POLICY_FILE_NAME = 'policy.json';
export const POLICY_LOCK_FILE_NAME = 'policy.lock';

const FORMAT_VERSION = 1;

const allowedFolderSchema = z
  .strictObject({
    // Read back through the same rule it was written by: the file may have been edited by hand, and what the office is told must not be anything else.
    label: z.string().refine((label) => problemWithLabel(label) === undefined, 'not a label'),
    path: z.string().min(1),
    realPath: z.string().min(1),
    access: z.enum(['read-only', 'edit']),
    approval: z.enum(['auto', 'ask']),
    isolation: z.enum(['worktree', 'in-place']),
    trusted: z.boolean(),
    agent: z.enum(CODING_AGENT_KINDS).nullable(),
    // Absent in what was written before workspaces, which is a plain folder.
    kind: z.enum(['plain', 'workspace']).optional(),
  })
  // A workspace is where the agent builds, edited in place: a file that says otherwise was changed by hand, and is not read as something narrower or wider.
  .refine(isConsistentWorkspace, 'a workspace is edited in place');

// Strict, so that a file with something this runner does not know, written by a newer one, is not read as if it said less than it does:
// a setting that narrows what is allowed would be lost without a word.
const policyFileSchema = z
  .strictObject({
    version: z.literal(FORMAT_VERSION),
    folders: z.array(allowedFolderSchema).max(RUNNER_LIMITS.folders),
    agentPaths: z.partialRecord(z.enum(CODING_AGENT_KINDS), z.string().min(1)),
    paused: z.boolean(),
  })
  .refine(({ folders }) => folders.every((folder, index) => folders.slice(0, index).every((earlier) => !sameLabel(earlier.label, folder.label))), 'labels are repeated');

export interface FilePolicyStoreOptions {
  readonly lockWaitMs?: number;
}

/**
 * The owner's decisions in `policy.json`, in the folder where the runner keeps its state, private to its owner like the pairing. Only the
 * owner's own commands write it: nothing that comes from the office does, and the runner reads it again at every task.
 */
export function createFilePolicyStore(directory: string, options: FilePolicyStoreOptions = {}): PolicyStore {
  const store = createLockedJsonStore<RunnerPolicy>({
    directory,
    fileName: POLICY_FILE_NAME,
    lockName: POLICY_LOCK_FILE_NAME,
    lockWaitMs: options.lockWaitMs,
    noun: 'settings',
    whenDamaged: 'Until then nothing is shared and no task is run.',
    empty: EMPTY_POLICY,
    read(json) {
      const parsed = policyFileSchema.safeParse(json);
      if (!parsed.success) return undefined;
      const { version: _version, ...policy } = parsed.data;
      return policy;
    },
    // Asked of what is about to be written, so that a mistake of this program is never found by reading it back.
    write: (policy) => policyFileSchema.parse({ version: FORMAT_VERSION, folders: policy.folders, agentPaths: policy.agentPaths, paused: policy.paused }),
  });
  return {
    load: store.load,
    update: (change) =>
      store.update((current) => {
        const { policy, result } = change(current);
        return { value: policy, result };
      }),
  };
}
