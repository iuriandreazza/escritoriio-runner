import type { McpCallRequest, McpListRequest } from '@escritoriio/runner-protocol';
import { describe, expect, it } from 'vitest';
import type { LocalMcpServer } from '../domain/mcp-server.ts';
import { EMPTY_POLICY } from './task-ports.ts';
import { McpRequests } from './mcp-requests.ts';
import type { McpRequestsDeps } from './mcp-requests.ts';
import { approving, FakeLocalMcp, FakeMcpStore, notes, remove, search, textHash } from './mcp-testing.ts';
import { LocalMcpError } from './mcp-ports.ts';
import { FakeScheduler, flush } from './testing.ts';
import { FakePolicyStore, FakeResolver, site, surroundings } from './task-testing.ts';

const list: McpListRequest = { type: 'mcp.list', id: 'r1', server: 'notes' };
const call: McpCallRequest = { type: 'mcp.call', id: 'r2', server: 'notes', tool: 'search', arguments: { q: 'milk' }, timeoutMs: 20_000 };

function setup(servers: readonly LocalMcpServer[] = [notes]) {
  const store = new FakeMcpStore(servers);
  const client = new FakeLocalMcp();
  const policy = new FakePolicyStore({ ...EMPTY_POLICY, folders: [site] });
  const resolver = new FakeResolver();
  const scheduler = new FakeScheduler();
  const errors: unknown[] = [];
  const deps: McpRequestsDeps = {
    store,
    policy,
    resolver,
    surroundings,
    client,
    scheduler,
    hash: textHash,
    parentEnvironment: { PATH: '/usr/bin', HOME: '/Users/ana', ANTHROPIC_API_KEY: 'the runner’s own', OPENAI_API_KEY: 'another' },
    onError: (error) => errors.push(error),
  };
  return { requests: new McpRequests(deps), store, client, policy, resolver, scheduler, errors };
}

describe('listing the tools of a local server', () => {
  it('tells the office of the tools its owner approved on this machine, what the server calls itself, and how many it holds back', async () => {
    const { requests, client } = setup();
    const answer = await requests.list(list);
    expect(answer).toMatchObject({ type: 'mcp.listed', id: 'r1', server: { name: 'Fake notes' }, held: 1, omitted: 0 });
    expect(answer.type === 'mcp.listed' && answer.tools.map((tool) => tool.name)).toEqual(['search']);
    expect(client.closed).toBe(1);
  });

  it('starts the program its owner wrote for it, with an environment made of what a program needs and what its owner typed, and nothing else of the runner’s', async () => {
    const { requests, client } = setup();
    await requests.list(list);
    expect(client.launches).toEqual([{ command: 'notes-server', args: ['--stdio'], env: { PATH: '/usr/bin', HOME: '/Users/ana', NOTES_API_KEY: 'k-123456', REGION: 'eu' }, cwd: undefined }]);
  });

  it('is not told by the office what to start: a command, arguments or an environment in the request are never read', async () => {
    const { requests, client } = setup();
    await requests.list({ ...list, command: 'rm', args: ['-rf', '/'], env: { PATH: '/tmp' } } as McpListRequest);
    expect(client.launches.map((launch) => launch.command)).toEqual(['notes-server']);
    expect(client.launches[0]?.env.PATH).toBe('/usr/bin');
  });

  it('takes what its owner typed for the environment out of what the server says of its tools', async () => {
    const described = { ...search, description: 'Uses the key k-123456 to look a word up.' };
    const { requests, client } = setup([{ ...notes, approved: approving(described) }]);
    client.tools = [described];
    const answer = await requests.list(list);
    expect(answer.type === 'mcp.listed' && answer.tools[0]?.description).toBe('Uses the key [removed] to look a word up.');
  });

  it('says that it has no such server, and starts nothing, for a label that is not one of its own', async () => {
    const { requests, client } = setup();
    expect(await requests.list({ ...list, server: 'files' })).toEqual({ type: 'mcp.failed', id: 'r1', failure: 'no-server' });
    // The office asks by the exact label it was told: a person's forgiving of capitals is not its.
    expect(await requests.list({ ...list, server: 'Notes' })).toMatchObject({ failure: 'no-server' });
    expect(client.launches).toEqual([]);
  });

  it('starts nothing while the machine is paused, on the machine or from the office, and works again when it is let to', async () => {
    const { requests, client, policy } = setup();
    policy.policy = { ...policy.policy, paused: true };
    expect(await requests.list(list)).toEqual({ type: 'mcp.failed', id: 'r1', failure: 'paused' });
    policy.policy = { ...policy.policy, paused: false };
    requests.setPausedByOffice(true);
    expect(await requests.list(list)).toEqual({ type: 'mcp.failed', id: 'r1', failure: 'paused' });
    expect(client.launches).toEqual([]);
    requests.setPausedByOffice(false);
    expect((await requests.list(list)).type).toBe('mcp.listed');
  });

  it.each(['unreachable', 'timeout', 'protocol'] as const)('says why it came to nothing, by a code, when the program %s', async (failure) => {
    const { requests, client } = setup();
    client.openFails = new LocalMcpError(failure, 'It said "my own key is k-123456" on its way out');
    expect(await requests.list(list)).toEqual({ type: 'mcp.failed', id: 'r1', failure });
  });

  it('reports what it did not foresee, and says only that the program did not answer', async () => {
    const { requests, client, errors } = setup();
    client.listFails = new Error('something that is not of the protocol');
    expect(await requests.list(list)).toEqual({ type: 'mcp.failed', id: 'r1', failure: 'unreachable' });
    expect(errors).toHaveLength(1);
    expect(client.closed).toBe(1);
  });

  it('gives up when the time it was given is over, and ends the program', async () => {
    const { requests, client, scheduler } = setup();
    client.hangOnOpen = true;
    const pending = requests.list(list);
    await scheduler.advance(30_000);
    expect(await pending).toEqual({ type: 'mcp.failed', id: 'r1', failure: 'timeout' });
  });

  it('is not given the settings it cannot read as an empty list', async () => {
    const { requests, store, errors } = setup();
    store.failToLoad = new Error('The settings cannot be read.');
    expect(await requests.list(list)).toEqual({ type: 'mcp.failed', id: 'r1', failure: 'unreachable' });
    expect(errors).toHaveLength(1);
  });
});

describe('a server that runs in a folder the machine shares', () => {
  const inSite = (): LocalMcpServer => ({ ...notes, folder: 'site' });

  it('runs in that folder, where the file system has it now', async () => {
    const { requests, client } = setup([inSite()]);
    await requests.list(list);
    expect(client.launches[0]?.cwd).toBe(site.realPath);
  });

  it('does not start when the folder is not shared any more', async () => {
    const { requests, client, policy } = setup([inSite()]);
    policy.policy = { ...EMPTY_POLICY, folders: [] };
    expect(await requests.list(list)).toEqual({ type: 'mcp.failed', id: 'r1', failure: 'not-approved' });
    expect(client.launches).toEqual([]);
  });

  it('does not start when the folder has moved, or is gone', async () => {
    const { requests, client, resolver } = setup([inSite()]);
    resolver.answers.set(site.path, '/Users/ana/elsewhere/site');
    expect(await requests.list(list)).toMatchObject({ failure: 'not-approved' });
    resolver.answers.set(site.path, null);
    expect(await requests.list(list)).toMatchObject({ failure: 'not-approved' });
    expect(client.launches).toEqual([]);
  });
});

describe('calling a tool of a local server', () => {
  it('calls a tool its owner approved, with what it was given, and gives back what it answered', async () => {
    const { requests, client } = setup();
    client.behaviour.set('search', { text: 'two notes about milk', isError: false });
    expect(await requests.call(call)).toEqual({ type: 'mcp.answered', id: 'r2', text: 'two notes about milk', isError: false });
    expect(client.calls).toEqual([{ name: 'search', arguments: { q: 'milk' }, inputSchema: search.inputSchema, outputSchema: null }]);
    expect(client.closed).toBe(1);
  });

  it('says that the tool failed when the server says so', async () => {
    const { requests, client } = setup();
    client.behaviour.set('search', { text: 'no such note', isError: true });
    expect(await requests.call(call)).toMatchObject({ type: 'mcp.answered', isError: true });
  });

  it.each([
    ['one its owner never approved on this machine', 'remove'],
    ['one the server does not have', 'missing'],
  ])('does not call %s, and does not even start it for that', async (_what, tool) => {
    const { requests, client } = setup();
    expect(await requests.call({ ...call, tool })).toEqual({ type: 'mcp.failed', id: 'r2', failure: 'not-approved' });
    expect(client.calls).toEqual([]);
    expect(client.closed).toBe(1);
  });

  it('does not call a tool whose definition is not any more the one that was approved', async () => {
    const { requests, client } = setup();
    client.tools = [{ ...search, description: 'Looks a word up, and then does something else.' }, remove];
    expect(await requests.call(call)).toEqual({ type: 'mcp.failed', id: 'r2', failure: 'not-approved' });
    expect(client.calls).toEqual([]);
  });

  it('does not call anything while the machine is paused', async () => {
    const { requests, client } = setup();
    requests.setPausedByOffice(true);
    expect(await requests.call(call)).toEqual({ type: 'mcp.failed', id: 'r2', failure: 'paused' });
    expect(client.launches).toEqual([]);
  });

  it('takes what its owner typed for the environment out of an answer', async () => {
    const { requests, client } = setup();
    client.behaviour.set('search', { text: 'the key is k-123456, and the region eu', isError: false });
    expect(await requests.call(call)).toMatchObject({ text: 'the key is [removed], and the region eu' });
  });

  it('says what went wrong by a code and ends the program, whatever it was', async () => {
    const { requests, client } = setup();
    for (const failure of ['bad-arguments', 'bad-answer', 'unreachable', 'protocol'] as const) {
      client.behaviour.set('search', new LocalMcpError(failure));
      expect(await requests.call(call)).toEqual({ type: 'mcp.failed', id: 'r2', failure });
    }
    expect(client.open_).toBe(0);
  });

  it('gives up when the time it was given is over', async () => {
    const { requests, client, scheduler } = setup();
    client.behaviour.set('search', 'hang');
    const pending = requests.call({ ...call, timeoutMs: 5_000 });
    await scheduler.advance(5_000);
    expect(await pending).toEqual({ type: 'mcp.failed', id: 'r2', failure: 'timeout' });
    expect(client.open_).toBe(0);
  });

  it('is cut to what a frame takes when the answer is larger', async () => {
    const { requests, client } = setup();
    client.behaviour.set('search', { text: 'x'.repeat(500_000), isError: false });
    const answer = await requests.call(call);
    expect(answer.type === 'mcp.answered' && answer.text.length).toBeLessThanOrEqual(64 * 1024);
    expect(answer.type === 'mcp.answered' && answer.text).toContain('cut');
  });
});

describe('what a machine does at once', () => {
  it('serves a few requests together, and says it is busy to one more', async () => {
    const { requests, client } = setup();
    client.behaviour.set('search', 'hang');
    const held = [1, 2, 3].map((n) => requests.call({ ...call, id: `r${n}` }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await requests.list(list)).toEqual({ type: 'mcp.failed', id: 'r1', failure: 'busy' });
    requests.stopAll();
    expect((await Promise.all(held)).every((answer) => answer.type === 'mcp.failed')).toBe(true);
    expect(client.open_).toBe(0);
  });

  it('stops a request when its own time is over, and not the ones that run beside it', async () => {
    const { requests, client, scheduler } = setup();
    client.behaviour.set('search', 'hang');
    const short = requests.call({ ...call, id: 'short', timeoutMs: 1_000 });
    const long = requests.call({ ...call, id: 'long', timeoutMs: 20_000 });
    await flush();
    await scheduler.advance(1_000);
    expect(await short).toEqual({ type: 'mcp.failed', id: 'short', failure: 'timeout' });
    let settled = false;
    void long.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    await scheduler.advance(19_000);
    expect(await long).toEqual({ type: 'mcp.failed', id: 'long', failure: 'timeout' });
  });

  it('is served again once what was running is over', async () => {
    const { requests, client } = setup();
    client.behaviour.set('search', 'hang');
    const held = [1, 2, 3].map((n) => requests.call({ ...call, id: `r${n}` }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    requests.stopAll();
    await Promise.all(held);
    expect((await requests.list(list)).type).toBe('mcp.listed');
  });
});
