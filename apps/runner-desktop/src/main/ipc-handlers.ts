import type { Runner } from '@escritoriio/runner';
import { OwnerError } from '@escritoriio/runner';
import type { CodingAgentKind } from '@escritoriio/runner-protocol';
import type { ApprovalDesk } from './approval-desk.ts';
import type { Handlers } from './ipc-router.ts';
import type { PendingLink } from './pair-link.ts';
import type { UpdateService } from './update-service.ts';

/** The system's own dialogs for choosing what lives on this machine. The window never names a path: it asks for one to be chosen, here. */
export interface Pickers {
  /** `share` is a folder that is shared as it is; `parent` is the folder a new, empty working folder is made in. */
  folder(purpose: FolderPurpose): Promise<string | undefined>;
  program(kind: CodingAgentKind): Promise<string | undefined>;
}

export type FolderPurpose = 'share' | 'parent';

export interface HandlerDeps {
  readonly runner: Runner;
  readonly approvals: ApprovalDesk;
  readonly pendingLink: PendingLink;
  readonly pickers: Pickers;
  readonly updates: UpdateService;
  readonly launch: { readonly supported: boolean; get(): Promise<boolean>; set(enabled: boolean): Promise<boolean> };
  readonly info: { readonly appVersion: string; readonly platform: string; readonly updatesSupported: boolean };
  /** Connects in the background, and says whether it began. */
  startConnection(): { readonly started: boolean; readonly message?: string };
  /** Ends when the app quits: what waits on the owner or on a local server is not waited for after it. */
  readonly signal: AbortSignal;
}

const NO_FOLDER = 'No folder was chosen.';
const LINK_GONE = 'That link is not waiting any more. Open it again from the office.';

/**
 * What each channel does. Each is the owner's own action on this machine and nothing else: the runner asks the owner (through the native dialogs) before
 * it keeps anything that widens what the machine does, so no handler decides that on its own and none takes a path, a program or an answer from the window.
 */
export function createHandlers(deps: HandlerDeps): Handlers {
  const { runner, approvals, pendingLink, pickers, updates, launch, info, signal } = deps;

  return {
    'connection:get': () => Promise.resolve(runner.connection.current),
    'connection:start': () => Promise.resolve(deps.startConnection()),

    'tasks:get': () => Promise.resolve(runner.tasks.current),
    'tasks:cancel': ({ taskId }) => Promise.resolve({ cancelled: runner.tasks.cancel(taskId) }),

    'folders:list': () => runner.folders.list(),
    'folders:add': async ({ label, access, approval, isolation, trusted, agent }) => {
      const path = await pickers.folder('share');
      if (path === undefined) return { added: false, message: NO_FOLDER };
      const outcome = await runner.folders.add({ path, label, access, approval, isolation, trusted, agent });
      return outcome.added ? { added: true, label: outcome.folder.label } : { added: false };
    },
    'folders:new-workspace': async ({ name, label, approval, trusted, agent }) => {
      const parent = await pickers.folder('parent');
      if (parent === undefined) return { added: false, message: NO_FOLDER };
      const outcome = await runner.folders.createWorkspace({ parent, name, label, approval, trusted, agent });
      return outcome.added ? { added: true, label: outcome.folder.label } : { added: false };
    },
    'folders:update': async ({ label, changes }) => ({ updated: (await runner.folders.update(label, changes)).updated }),
    'folders:remove': async ({ label }) => ({ label: (await runner.folders.remove(label)).label }),

    'agents:inspect': () => runner.agents.inspect(),
    'agents:set-path': async ({ kind }) => {
      const path = await pickers.program(kind);
      if (path === undefined) return { picked: false };
      return { picked: true, detection: await runner.agents.setPath(kind, path) };
    },
    'agents:clear-path': async ({ kind }) => ({ cleared: await runner.agents.clearPath(kind) }),

    'pause:set': async ({ paused }) => ({ changed: await runner.pause.set(paused) }),

    'mcp:list': () => runner.mcp.list(),
    'mcp:add': (request) => runner.mcp.add(request),
    'mcp:remove': ({ label }) => runner.mcp.remove(label),
    'mcp:tools': ({ label }) => runner.mcp.tools(label, signal),
    'mcp:approve': ({ label, tools }) => runner.mcp.approve(label, tools, signal),
    'mcp:deny': async ({ label, tools }) => ({ denied: await runner.mcp.deny(label, tools) }),

    'pairing:current': () => runner.pairing.current(),
    'pairing:pending-link': () => Promise.resolve(pendingLink.current()),
    'pairing:pair': async (request) => {
      let input: readonly string[];
      let deviceName: string | undefined;
      if ('linkId' in request) {
        const link = pendingLink.peek(request.linkId);
        if (!link) throw new OwnerError(LINK_GONE);
        input = [link.server, link.code];
      } else {
        input = [request.server, request.code];
        deviceName = request.deviceName;
      }
      const outcome = await runner.pairing.pair(deviceName === undefined ? { input } : { input, deviceName });
      if (!outcome.paired) return { paired: false };
      if ('linkId' in request) pendingLink.take(request.linkId);
      deps.startConnection();
      return outcome;
    },

    'doctor:run': () => runner.doctor(),

    'approvals:list': () => Promise.resolve(approvals.current),
    'approvals:answer': ({ taskId, askId, answer }) => Promise.resolve({ answered: approvals.answer(taskId, askId, answer) }),

    'app:info': async () => ({
      appVersion: info.appVersion,
      runnerVersion: runner.version,
      platform: info.platform,
      launchAtLogin: await launch.get(),
      launchAtLoginSupported: launch.supported,
      updatesSupported: info.updatesSupported,
      stateDirectory: runner.stateDirectory,
    }),
    'app:set-launch-at-login': async ({ enabled }) => ({ launchAtLogin: await launch.set(enabled) }),
    'app:check-update': () => updates.check(),
    'app:accept-update': () => updates.accept(),
  };
}
