import { z } from 'zod';
import { privateFile } from './private-file.ts';

/** The branch the work of a task is left on. The id is checked against `TASK_ID_PATTERN`, so the name is a valid branch name and one no other task has. */
export const taskBranch = (taskId: string): string => `escritoriio/${taskId}`;

/**
 * What the runner writes down about a copy before it makes it, beside the copy and not in it: the repository it is a copy of, the branch
 * it is on, and the commit it began from. A runner that is killed in the middle of a task leaves the copy behind, and this is how a
 * later run knows what is its own to clean up, without asking the copy, which a coding agent could write anything in.
 */
export interface WorktreeRecord {
  readonly repository: string;
  readonly branch: string;
  readonly base: string;
}

const recordSchema = z.object({
  version: z.literal(1),
  repository: z.string().min(1),
  branch: z.string(),
  base: z.string().regex(/^[0-9a-f]{40,64}$/),
});

const fileOf = (worktrees: string, taskId: string) => privateFile(worktrees, `${taskId}.json`);

export async function writeWorktreeRecord(worktrees: string, taskId: string, record: WorktreeRecord): Promise<void> {
  await fileOf(worktrees, taskId).write(`${JSON.stringify({ version: 1, ...record }, null, 2)}\n`);
}

/** Whether a record is there, valid or not. */
export async function hasWorktreeRecord(worktrees: string, taskId: string): Promise<boolean> {
  return (await fileOf(worktrees, taskId).read().catch(() => undefined)) !== undefined;
}

/** The record of a task, or nothing when there is none, or when what is there is not what this runner writes: the branch must be the one this task's id gives. */
export async function readWorktreeRecord(worktrees: string, taskId: string): Promise<WorktreeRecord | undefined> {
  const text = await fileOf(worktrees, taskId).read().catch(() => undefined);
  if (text === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = recordSchema.safeParse(json);
  if (!parsed.success || parsed.data.branch !== taskBranch(taskId)) return undefined;
  return { repository: parsed.data.repository, branch: parsed.data.branch, base: parsed.data.base };
}

export async function removeWorktreeRecord(worktrees: string, taskId: string): Promise<void> {
  await fileOf(worktrees, taskId).remove().catch(() => undefined);
}
