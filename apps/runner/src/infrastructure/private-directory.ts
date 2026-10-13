import { chmod, mkdir } from 'node:fs/promises';

/**
 * A folder that only the owner can enter, made if it is not there. The runner keeps what an agent must not touch in such places (its state
 * folder is hidden from the sandbox of a task), so a place made inside one is out of the agent's reach.
 */
export async function ensurePrivateDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  // `mkdir` leaves alone the mode of a folder that was there; the ones made here are the runner's.
  await chmod(path, 0o700).catch(() => undefined);
  return path;
}
