import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import type { WorkspaceReply, WorkspaceTools } from '../../application/workspace-ports.ts';
import { createWorkspaceServer } from './workspace-server.ts';

/** The two functions of the SDK, as a test sees them: what they were given. */
function recordingSdk() {
  const definitions: SdkMcpToolDefinition[] = [];
  const servers: Record<string, unknown>[] = [];
  const sdk = {
    tool: (name: string, description: string, inputSchema: object, handler: unknown) => {
      const definition = { name, description, inputSchema, handler } as unknown as SdkMcpToolDefinition;
      definitions.push(definition);
      return definition;
    },
    createSdkMcpServer: (options: Record<string, unknown>) => {
      servers.push(options);
      return { type: 'sdk', name: options.name, instance: {} } as unknown as McpSdkServerConfigWithInstance;
    },
  };
  return { sdk: sdk as never, definitions, servers };
}

function tools(replies: { newFolder?: WorkspaceReply | Error; clone?: WorkspaceReply | Error } = {}) {
  const calls: unknown[][] = [];
  const answer = (reply: WorkspaceReply | Error | undefined): Promise<WorkspaceReply> => (reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply ?? { ok: true, words: 'Done.' }));
  const given: WorkspaceTools = {
    newFolder: (name) => (calls.push(['newFolder', name]), answer(replies.newFolder)),
    clone: (url, name) => (calls.push(['clone', url, name]), answer(replies.clone)),
  };
  return { given, calls };
}

describe('the server of the tools of a workspace', () => {
  it('is one server of its own, with exactly two tools, and nothing else', () => {
    const { sdk, definitions, servers } = recordingSdk();
    createWorkspaceServer(sdk, tools().given);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: 'escritoriio' });
    expect(definitions.map((definition) => definition.name)).toEqual(['workspace_new_folder', 'workspace_clone']);
  });

  it('is given a time for a call that is longer than the owner has to answer, so that waiting for them does not end the call', () => {
    const { sdk, servers } = recordingSdk();
    createWorkspaceServer(sdk, tools().given);
    expect(servers[0]?.timeout).toBeGreaterThan(10 * 60_000);
  });

  it('tells the agent what each tool does, and that a clone needs the owner', () => {
    const { sdk, definitions } = recordingSdk();
    createWorkspaceServer(sdk, tools().given);
    expect(definitions[0]?.description).toMatch(/No approval is needed/);
    expect(definitions[1]?.description).toMatch(/owner .* approves each clone/);
  });

  describe('a call', () => {
    const call = async (index: number, input: Record<string, unknown>, replies?: Parameters<typeof tools>[0]) => {
      const { sdk, definitions } = recordingSdk();
      const { given, calls } = tools(replies);
      createWorkspaceServer(sdk, given);
      const result = await (definitions[index]?.handler as (args: unknown, extra: unknown) => Promise<unknown>)(input, {});
      return { result, calls };
    };

    it('makes a folder through the tools of the task, and tells what was done as text', async () => {
      const { result, calls } = await call(0, { name: 'hello' }, { newFolder: { ok: true, words: 'Made the folder "hello".' } });
      expect(calls).toEqual([['newFolder', 'hello']]);
      expect(result).toEqual({ content: [{ type: 'text', text: 'Made the folder "hello".' }], isError: false });
    });

    it('asks for a clone through the tools of the task, with or without a name', async () => {
      const first = await call(1, { url: 'https://github.com/a/b.git' });
      expect(first.calls).toEqual([['clone', 'https://github.com/a/b.git', undefined]]);
      const second = await call(1, { url: 'https://github.com/a/b.git', name: 'copy' });
      expect(second.calls).toEqual([['clone', 'https://github.com/a/b.git', 'copy']]);
    });

    it('tells a refusal as an error, in its words', async () => {
      const { result } = await call(1, { url: 'file:///x' }, { clone: { ok: false, words: 'A repository address needs a host.' } });
      expect(result).toEqual({ content: [{ type: 'text', text: 'A repository address needs a host.' }], isError: true });
    });

    it('does not let what went wrong in the runner reach the agent, which has no use for it', async () => {
      const { result } = await call(0, { name: 'x' }, { newFolder: new Error('ENOSPC: /Users/ana/secret/place') });
      expect(result).toEqual({ content: [{ type: 'text', text: 'The runner could not do that.' }], isError: true });
    });
  });

  it('accepts only text of a size a name or an address can be', () => {
    const { sdk, definitions } = recordingSdk();
    createWorkspaceServer(sdk, tools().given);
    const shape = (index: number) => definitions[index]?.inputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    expect(shape(0).name?.safeParse('x'.repeat(200)).success).toBe(true);
    expect(shape(0).name?.safeParse('x'.repeat(201)).success).toBe(false);
    expect(shape(0).name?.safeParse(5).success).toBe(false);
    expect(shape(1).url?.safeParse('x'.repeat(1025)).success).toBe(false);
    expect(shape(1).name?.safeParse(undefined).success).toBe(true);
  });
});
