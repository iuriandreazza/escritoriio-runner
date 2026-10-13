import { MAX_RUNNER_MESSAGE_BYTES, TASK_ID_PATTERN } from '@escritoriio/runner-protocol';

/**
 * The id of a task that was offered and could not be read: a field that is too long, a coding agent this runner does not know. The office
 * waits for an answer to an offer, and the id is all that is needed to give it one. Nothing for what is not an offer, or whose id cannot be
 * trusted to be one (it names a branch and a folder, and is told back to the office as it is).
 */
export function idOfUnreadableOffer(raw: string): string | undefined {
  if (raw.length > MAX_RUNNER_MESSAGE_BYTES) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof json !== 'object' || json === null) return undefined;
  const { type, taskId } = json as { readonly type?: unknown; readonly taskId?: unknown };
  return type === 'task.offer' && typeof taskId === 'string' && TASK_ID_PATTERN.test(taskId) ? taskId : undefined;
}
