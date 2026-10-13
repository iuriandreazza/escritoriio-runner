import type { TaskLock } from '../application/task-ports.ts';
import type { FileLockOptions } from './file-lock.ts';
import { createFileLock } from './file-lock.ts';

export const TASK_LOCK_FILE_NAME = 'task.lock';

export type FileTaskLockOptions = FileLockOptions;

/**
 * The lock of the machine's one task, as a file in the state directory (see `createFileLock`): held by the process that runs a task for as
 * long as it runs, so that another process of the runner on the machine is refused one while it does.
 */
export function createFileTaskLock(directory: string, options: FileTaskLockOptions = {}): TaskLock {
  return createFileLock(directory, TASK_LOCK_FILE_NAME, options);
}
