import { childEnvironment } from '../domain/child-environment.ts';
import { problemWithFolder } from '../domain/folder-policy.ts';
import type { Surroundings } from '../domain/folder-policy.ts';
import type { LocalMcpServer } from '../domain/mcp-server.ts';
import type { LocalLaunch } from './mcp-ports.ts';
import type { FolderResolver, PolicyStore } from './task-ports.ts';

export interface LaunchDeps {
  /** The folders the machine shares: read when a server that runs in one is started. */
  readonly policy: Pick<PolicyStore, 'load'>;
  readonly resolver: FolderResolver;
  readonly surroundings: Surroundings;
  /** What the runner was started with: only what a program needs of it is passed on to a server. */
  readonly parentEnvironment: Readonly<Record<string, string | undefined>>;
}

/**
 * What starts a local server, as its owner wrote it: the program, its arguments, an environment built from nothing and not from what the runner
 * was started with (the runner may hold keys of its own, and a program given one would use it) with what the owner typed on top, and where it
 * runs. Nothing when the folder it is to run in is not one the machine shares any more, or is not where it was: that is judged again at every start,
 * whatever was true when the server was set up.
 */
export async function launchOf(deps: LaunchDeps, server: LocalMcpServer): Promise<LocalLaunch | undefined> {
  let cwd: string | undefined;
  if (server.folder !== null) {
    const folder = (await deps.policy.load()).folders.find((candidate) => candidate.label === server.folder);
    if (!folder) return undefined;
    if (problemWithFolder(folder, await deps.resolver.resolve(folder.path), deps.surroundings) !== undefined) return undefined;
    cwd = folder.realPath;
  }
  return { command: server.command, args: server.args, env: { ...childEnvironment(deps.parentEnvironment, deps.surroundings.windows), ...server.env }, cwd };
}
