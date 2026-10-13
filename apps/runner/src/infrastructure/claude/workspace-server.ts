import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { WorkspaceReply, WorkspaceTools } from '../../application/workspace-ports.ts';
import type { ClaudeSdk } from './claude-code-agent.ts';
import { WORKSPACE_SERVER_NAME } from './tools.ts';

/** What one call may take: the owner is asked first (ten minutes at most), and then a clone takes as long as it may. The task's own ceiling is the one that ends it. */
const CALL_MS = 25 * 60_000;

const NEW_FOLDER = 'Makes a new folder in the workspace, made a git repository with an empty first commit on the branch main. No approval is needed. The name is one plain name, not a path.';
const CLONE =
  'Asks to clone a git repository into a new folder of the workspace. The owner of the machine is shown the exact address and the folder and approves each clone one by one, so this may take a while and may be refused. ' +
  'The address is https://host/path, git@host:path or ssh://git@host/path, with no user name, password or token in it. The folder is called after the repository unless a name is given.';

const answer = ({ ok, words }: WorkspaceReply): { readonly content: [{ readonly type: 'text'; readonly text: string }]; readonly isError: boolean } => ({ content: [{ type: 'text', text: words }], isError: !ok });

/** A call that went wrong in the runner is told to the agent in words that name nothing of the machine: the agent is not a person who can mend it. */
async function safely(call: () => Promise<WorkspaceReply>): Promise<ReturnType<typeof answer>> {
  try {
    return answer(await call());
  } catch {
    return answer({ ok: false, words: 'The runner could not do that.' });
  }
}

/**
 * The two tools of a workspace as an MCP server of this process, which is how an agent that is contained reaches the runner: its calls run
 * here, after the runner's own hook allowed them by name, and do what `tools` does, which is the runner's and not the agent's.
 */
export function createWorkspaceServer(sdk: Required<Pick<ClaudeSdk, 'createSdkMcpServer' | 'tool'>>, tools: WorkspaceTools): McpSdkServerConfigWithInstance {
  return sdk.createSdkMcpServer({
    name: WORKSPACE_SERVER_NAME,
    version: '1.0.0',
    timeout: CALL_MS,
    tools: [
      sdk.tool('workspace_new_folder', NEW_FOLDER, { name: z.string().max(200) }, ({ name }) => safely(() => tools.newFolder(name))),
      sdk.tool('workspace_clone', CLONE, { url: z.string().max(1024), name: z.string().max(200).optional() }, ({ url, name }) => safely(() => tools.clone(url, name))),
    ],
  });
}
