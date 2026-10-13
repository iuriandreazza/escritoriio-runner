import { z } from 'zod';
import { CODING_AGENT_KINDS, RUNNER_LIMITS } from './protocol.ts';
import { oneLine } from './text.ts';

/** The ceilings on what a task says and what comes back of it. Everything a runner sends is capped: the code is public, so anybody may write one. */
export const TASK_LIMITS = {
  taskId: 64,
  instruction: 8_000,
  /** One piece of what the coding agent said. */
  eventText: 2_000,
  toolName: 64,
  toolSummary: 300,
  /** What the coding agent said at the end. */
  finalText: 8_000,
  branch: 200,
  diffStat: 2_000,
  message: 300,
  /** How many finished tasks a runner remembers, and tells of when it connects. */
  journal: 20,
} as const;

/** A task that runs longer than this is stopped; the office may ask for less, never for more. */
export const MAX_TASK_SECONDS = 30 * 60;
/** What the server keeps of the output of a task: the rest is dropped on the machine, and the task says so. */
export const MAX_TASK_OUTPUT_BYTES = 64 * 1024;

/** What a task id is made of. The machine names a branch and a folder with it, so anything else is not read as an id at all. */
export const TASK_ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{1,${TASK_LIMITS.taskId}}$`);

const taskId = z.string().regex(TASK_ID_PATTERN);

/** Why a machine did not take a task. The words are the machine's own; the code is for the office to act on. */
export const TASK_REJECTIONS = [
  /** The folder is not on the list its owner made, or is not as it was when it was put there. */
  'not-allowed',
  /** The machine is paused. */
  'paused',
  /** The machine, or the folder, is running a task already. */
  'busy',
  /** The coding agent is not installed, or this version of it is not supported. */
  'agent-missing',
  /** The coding agent is installed and its person is not logged in to it. */
  'not-logged-in',
  /** The folder holds no git repository and is meant to be worked on in a worktree, or the worktree could not be made. */
  'cannot-isolate',
  /** The folder asks to be asked before each task: it waits for its owner on the machine. */
  'needs-approval',
  /** The coding agent cannot be contained here and the folder is not one its owner trusts. */
  'not-contained',
  /** The offer could not be read at all (a field of a newer office, or one that is too long): the machine answers it, so the office is not left waiting. */
  'bad-offer',
] as const;
export type TaskRejection = (typeof TASK_REJECTIONS)[number];

/** Why a task that was begun did not end well. */
export const TASK_FAILURES = ['error', 'timeout', 'cancelled', 'paused', 'interrupted'] as const;
export type TaskFailure = (typeof TASK_FAILURES)[number];

/** One thing a coding agent did or said, as every tool tells it. */
export const taskEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().max(TASK_LIMITS.eventText) }),
  /** It used a tool: which one and in a few words what on. `denied` when the machine did not let it. */
  z.object({ kind: z.literal('tool'), name: oneLine(TASK_LIMITS.toolName), summary: z.string().max(TASK_LIMITS.toolSummary), denied: z.boolean() }),
  z.object({ kind: z.literal('usage'), inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0) }),
]);
export type TaskEvent = z.infer<typeof taskEventSchema>;

/** How a task ended well: what the coding agent said at the end, and where the work is. */
export const taskDoneSchema = z.object({
  taskId,
  text: z.string().max(TASK_LIMITS.finalText),
  /** The branch the work was left on, when it was done in a worktree. */
  branch: z.string().max(TASK_LIMITS.branch).nullable(),
  /** `git diff --stat` of the work against where it began, when it was done in a worktree. */
  diffStat: z.string().max(TASK_LIMITS.diffStat).nullable(),
  durationMs: z.number().int().min(0),
  /** Some of what the coding agent said was dropped to keep within the ceiling. */
  truncated: z.boolean(),
});
export type TaskDone = z.infer<typeof taskDoneSchema>;

export const taskFailedSchema = z.object({
  taskId,
  reason: z.enum(TASK_FAILURES),
  message: z.string().max(TASK_LIMITS.message),
  durationMs: z.number().int().min(0),
});
export type TaskFailed = z.infer<typeof taskFailedSchema>;

/** What a runner remembers of a task, to tell the office when it connects again: still running, or how it ended. */
export const journalEntrySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('running'), taskId }),
  z.object({ state: z.literal('done'), ...taskDoneSchema.shape }),
  z.object({ state: z.literal('failed'), ...taskFailedSchema.shape }),
]);
export type JournalEntry = z.infer<typeof journalEntrySchema>;

/** What the server asks of a runner: a task, in a folder it shares by its label. */
export const taskOfferSchema = z.object({
  type: z.literal('task.offer'),
  taskId,
  folder: oneLine(RUNNER_LIMITS.folderLabel),
  /** The coding agent asked for; null for the folder's own default. */
  agent: z.enum(CODING_AGENT_KINDS).nullable(),
  instruction: z.string().min(1).max(TASK_LIMITS.instruction),
  /** How long it may run at most; the machine uses the lesser of this and its own ceiling. */
  // Asking for more than the machine allows is asking for what it allows: the ceilings are the machine's, so the offer is read, not refused.
  maxSeconds: z.number().int().min(1).transform((seconds) => Math.min(seconds, MAX_TASK_SECONDS)).optional(),
  maxOutputBytes: z.number().int().min(1).transform((bytes) => Math.min(bytes, MAX_TASK_OUTPUT_BYTES)).optional(),
});
export type TaskOffer = z.infer<typeof taskOfferSchema>;

export const taskCancelSchema = z.object({ type: z.literal('task.cancel'), taskId });
