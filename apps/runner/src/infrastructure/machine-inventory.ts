import type { CodingAgentFound } from '@escritoriio/runner-protocol';
import { MCP_LIMITS, RUNNER_LIMITS, toOneLine } from '@escritoriio/runner-protocol';
import type { McpServerStore } from '../application/mcp-ports.ts';
import type { Inventory } from '../application/ports.ts';
import type { CodingAgent, CodingAgents, PolicyStore } from '../application/task-ports.ts';

export interface MachineInventoryDeps {
  readonly policy: PolicyStore;
  readonly mcp: Pick<McpServerStore, 'load'>;
  readonly agents: CodingAgents;
}

/** What the tool says of itself is cut to what the office takes: a version that is too long is refused by it, and with it all of `hello`. */
const cappedVersion = (version: string | undefined): string | null => (version === undefined ? null : toOneLine(version).slice(0, RUNNER_LIMITS.agentVersion) || null);

async function look(agent: CodingAgent, path: string | undefined): Promise<CodingAgentFound | undefined> {
  try {
    const detection = await agent.detect(path);
    // One the runner cannot drive is not one the machine has, as far as the office is concerned: it would offer tasks that are then refused.
    return detection.installed && detection.supported ? { kind: agent.kind, version: cappedVersion(detection.version), loggedIn: detection.loggedIn } : undefined;
  } catch {
    // A tool that cannot be looked at is not one that can be used.
    return undefined;
  }
}

/**
 * What the office is told of this machine when it connects: the coding agents that are installed and that this runner can drive (where its
 * owner said one is, when they did), the labels of the folders they share, never a path, the labels of their MCP servers, never how one is run, and whether they paused it. It is read again at every connection, so that
 * what changed in between is what the office hears. Settings that cannot be read are an error: nothing is told in their place.
 */
export function createMachineInventory({ policy, mcp, agents }: MachineInventoryDeps): Inventory {
  return {
    async read() {
      const current = await policy.load();
      // A file of MCP servers that cannot be read says none, and costs the machine nothing else: `mcp list` says why, and the folders and coding agents still work.
      const servers = await mcp.load().catch(() => ({ servers: [] }));
      const looked = await Promise.all(Object.values(agents).map((agent) => (agent ? look(agent, current.agentPaths[agent.kind]) : undefined)));
      return {
        agents: looked.filter((found): found is CodingAgentFound => found !== undefined).slice(0, RUNNER_LIMITS.agents),
        folders: current.folders.map((folder) => folder.label).slice(0, RUNNER_LIMITS.folders),
        mcpServers: servers.servers.map((server) => server.label).slice(0, MCP_LIMITS.servers),
        paused: current.paused,
      };
    },
  };
}
