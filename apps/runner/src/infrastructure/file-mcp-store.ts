import { MCP_LIMITS } from '@escritoriio/runner-protocol';
import { z } from 'zod';
import type { McpServerStore, McpServers } from '../application/mcp-ports.ts';
import { NO_MCP_SERVERS } from '../application/mcp-ports.ts';
import { problemWithLabel, sameLabel } from '../domain/folder-label.ts';
import { parseEnvAssignment, problemWithLaunch } from '../domain/mcp-server.ts';
import { createLockedJsonStore } from './locked-json-store.ts';

export const MCP_FILE_NAME = 'mcp-servers.json';
export const MCP_LOCK_FILE_NAME = 'mcp-servers.lock';

const FORMAT_VERSION = 1;

const serverSchema = z
  .strictObject({
    // Read back through the same rules it was written by: the file may have been edited by hand, and what the office is told must not be anything else.
    label: z.string().refine((label) => problemWithLabel(label) === undefined, 'not a label'),
    command: z.string(),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()),
    folder: z.string().nullable(),
    /** Each tool its owner approved here, by name, with the hash of the definition they saw. */
    approved: z.record(z.string().min(1).max(MCP_LIMITS.toolName), z.string().regex(/^[a-f0-9]{64}$/)),
  })
  .refine((server) => problemWithLaunch(server.command, server.args) === undefined, 'not something to run')
  .refine((server) => Object.entries(server.env).every(([name, value]) => parseEnvAssignment(`${name}=${value}`).ok), 'an environment that is not one');

// Strict, so that a file with something this runner does not know, written by a newer one, is not read as if it said less than it does: an
// approval that was narrowed, or a folder a server is kept in, would be lost without a word.
const fileSchema = z
  .strictObject({ version: z.literal(FORMAT_VERSION), servers: z.array(serverSchema).max(MCP_LIMITS.servers) })
  .refine(({ servers }) => servers.every((server, index) => servers.slice(0, index).every((earlier) => !sameLabel(earlier.label, server.label))), 'labels are repeated');

export interface FileMcpStoreOptions {
  readonly lockWaitMs?: number;
}

/**
 * The MCP servers its owner set up, in `mcp-servers.json` in the folder where the runner keeps its state, private to its owner like the pairing:
 * what they run, with which environment (which holds secrets), and which of their tools the owner approved here. It is apart from the
 * folder settings so that a secret is in no file a task reads. Only the owner's own commands write it: nothing that comes from the office does.
 */
export function createFileMcpStore(directory: string, options: FileMcpStoreOptions = {}): McpServerStore {
  const store = createLockedJsonStore<McpServers>({
    directory,
    fileName: MCP_FILE_NAME,
    lockName: MCP_LOCK_FILE_NAME,
    lockWaitMs: options.lockWaitMs,
    noun: 'MCP servers',
    whenDamaged: 'Until then no MCP server is used.',
    empty: NO_MCP_SERVERS,
    read(json) {
      const parsed = fileSchema.safeParse(json);
      return parsed.success ? { servers: parsed.data.servers } : undefined;
    },
    write: ({ servers }) => fileSchema.parse({ version: FORMAT_VERSION, servers }),
  });
  return {
    load: store.load,
    update: (change) =>
      store.update((current) => {
        const { servers, result } = change(current);
        return { value: servers, result };
      }),
  };
}
