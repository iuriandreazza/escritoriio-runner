import { parseRunnerMessage, RUNNER_LIMITS, RUNNER_PROTOCOL_VERSION } from '@escritoriio/runner-protocol';
import { describe, expect, it } from 'vitest';
import { EMPTY_POLICY } from '../application/task-ports.ts';
import { FakeMcpStore, notes } from '../application/mcp-testing.ts';
import { detected, FakeAgent, FakePolicyStore, site } from '../application/task-testing.ts';
import { createMachineInventory } from './machine-inventory.ts';

function setup() {
  const policy = new FakePolicyStore();
  const claude = new FakeAgent('claude-code');
  const codex = new FakeAgent('codex');
  codex.detection = { ...detected, installed: false, path: undefined, version: undefined, loggedIn: null };
  const mcp = new FakeMcpStore([]);
  const inventory = createMachineInventory({ policy, mcp, agents: { 'claude-code': claude, codex } });
  return { policy, mcp, claude, codex, inventory };
}

describe('what is told of the machine', () => {
  it('is the coding agents that are installed, the labels of the folders and of the MCP servers, and whether it is paused', async () => {
    const { policy, mcp, inventory } = setup();
    policy.policy = { ...EMPTY_POLICY, folders: [site, { ...site, label: 'api', path: '/x/api', realPath: '/x/api' }], paused: true };
    mcp.servers = { servers: [notes, { ...notes, label: 'files' }] };
    expect(await inventory.read()).toEqual({ agents: [{ kind: 'claude-code', version: '2.1.250', loggedIn: true }], folders: ['site', 'api'], mcpServers: ['notes', 'files'], paused: true });
  });

  it('tells nothing of how an MCP server is run: not its program, its arguments or its environment', async () => {
    const { mcp, inventory } = setup();
    mcp.servers = { servers: [notes] };
    const told = JSON.stringify(await inventory.read());
    for (const private_ of ['notes-server', '--stdio', 'NOTES_API_KEY', 'k-123456']) expect(told).not.toContain(private_);
  });

  it('says nothing of a coding agent that is not installed', async () => {
    const { claude, codex, inventory } = setup();
    claude.detection = { ...detected, installed: false, path: undefined, version: undefined, loggedIn: null };
    codex.detection = { ...detected, installed: false };
    expect((await inventory.read()).agents).toEqual([]);
  });

  it('says nothing of a coding agent that is installed in a version this runner cannot drive: the office would offer tasks that are then refused', async () => {
    const { claude, inventory } = setup();
    claude.detection = { ...detected, supported: false, problem: 'This version is too old: 1.0.0.' };
    expect((await inventory.read()).agents).toEqual([]);
  });

  it('says that it does not know, rather than guessing, of what a tool does not tell', async () => {
    const { claude, inventory } = setup();
    claude.detection = { ...detected, version: undefined, loggedIn: null };
    expect((await inventory.read()).agents).toEqual([{ kind: 'claude-code', version: null, loggedIn: null }]);
  });

  it('says that nobody is logged in when that is what the tool says', async () => {
    const { claude, inventory } = setup();
    claude.detection = { ...detected, loggedIn: false };
    expect((await inventory.read()).agents[0]).toMatchObject({ loggedIn: false });
  });

  it('looks for a tool where its owner said it is, and where it finds it otherwise', async () => {
    const { policy, claude, codex, inventory } = setup();
    policy.policy = { ...EMPTY_POLICY, agentPaths: { 'claude-code': '/opt/claude' } };
    await inventory.read();
    expect(claude.detects).toEqual(['/opt/claude']);
    expect(codex.detects).toEqual([undefined]);
  });

  it('tells nothing of the path of a folder, only its label', async () => {
    const { policy, inventory } = setup();
    policy.policy = { ...EMPTY_POLICY, folders: [site] };
    expect(JSON.stringify(await inventory.read())).not.toContain('/Users/ana');
  });

  it('is cut to what the office takes, so that one odd answer does not make it refuse all of it', async () => {
    const { policy, claude, inventory } = setup();
    claude.detection = { ...detected, version: `2.1.0\n${'x'.repeat(500)}\u001b[2J` };
    policy.policy = { ...EMPTY_POLICY, folders: Array.from({ length: 150 }, (_, index) => ({ ...site, label: `folder-${index}` })) };
    const told = await inventory.read();
    expect(told.agents[0]?.version?.length).toBeLessThanOrEqual(RUNNER_LIMITS.agentVersion);
    expect(told.agents[0]?.version).not.toMatch(/\p{Cc}/u);
    expect(told.folders).toHaveLength(RUNNER_LIMITS.folders);
    const hello = JSON.stringify({ type: 'hello', protocol: RUNNER_PROTOCOL_VERSION, runnerVersion: '0.1.0', os: 'darwin', ...told, tasks: [] });
    expect(parseRunnerMessage(hello)).toMatchObject({ ok: true });
  });

  it('tells none of the MCP servers when their file cannot be read, and goes on with the rest', async () => {
    const { mcp, inventory } = setup();
    mcp.failToLoad = new Error('The MCP servers cannot be read.');
    expect(await inventory.read()).toMatchObject({ mcpServers: [], folders: ['site'] });
  });

  it('is not made to fail by a tool that cannot be looked at: that tool is left out', async () => {
    const { codex, inventory } = setup();
    codex.detect = () => Promise.reject(new Error('it crashed'));
    expect((await inventory.read()).agents.map((agent) => agent.kind)).toEqual(['claude-code']);
  });

  it('is an error when the settings cannot be read, and tells nothing in their place', async () => {
    const { policy, inventory } = setup();
    policy.load = () => Promise.reject(new Error('The settings cannot be read.'));
    await expect(inventory.read()).rejects.toThrow('cannot be read');
  });
});
