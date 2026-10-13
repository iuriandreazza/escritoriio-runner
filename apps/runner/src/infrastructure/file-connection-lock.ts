import type { ConnectionLock } from '../application/ports.ts';
import type { FileLockOptions } from './file-lock.ts';
import { createFileLock } from './file-lock.ts';

export const CONNECTION_LOCK_FILE_NAME = 'connection.lock';

/**
 * The lock of the machine's one connection to the office, as a file in the state directory (see `createFileLock`): held by the process that
 * is connected for as long as it is, so that the command line and the app, which share the pairing, do not take the connection from each
 * other: the office gives a device one connection and replaces the older with the newer.
 */
export function createFileConnectionLock(directory: string, options: FileLockOptions = {}): ConnectionLock {
  return createFileLock(directory, CONNECTION_LOCK_FILE_NAME, options);
}
