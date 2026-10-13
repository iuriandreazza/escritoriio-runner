import { describe, expect, it } from 'vitest';
import { EMPTY_POLICY } from './task-ports.ts';
import type { McpServersDeps, NewMcpServer } from './mcp-servers.ts';
import { addMcpServer, approveMcpTools, denyMcpTools, describeMcpServers, inspectMcpServers, inspectMcpTools, listMcpTools, removeMcpServer } from './mcp-servers.ts';
import { LocalMcpError } from './mcp-ports.ts';
import { approving, FakeLocalMcp, FakeMcpStore, notes, remove, search, textHash } from './mcp-testing.ts';
import { FakePolicyStore, FakeResolver, site, surroundings } from './task-testing.ts';

const NEVER = new AbortController().signal;
const request: NewMcpServer = { label: 'files', command: 'npx', args: ['-y', 'some-server'], env: ['API_KEY=k-654321', 'REGION=eu'], folder: null };

function setup(servers = [notes]) {
  const store = new FakeMcpStore(servers);
  const client = new FakeLocalMcp();
  const deps: McpServersDeps = { store, client, hash: textHash, policy: new FakePolicyStore({ ...EMPTY_POLICY, folders: [site] }), resolver: new FakeResolver(), surroundings, parentEnvironment: { PATH: '/usr/bin' } };
  return { deps, store, client };
}

const yes = () => Promise.resolve(true);
const yesAll = () => Promise.resolve(true);
const no = () => Promise.resolve(false);

describe('setting up a local MCP server', () => {
  it('keeps what the person wrote, with nothing approved yet, once they have said yes', async () => {
    const { deps, store } = setup([]);
    const outcome = await addMcpServer(deps, request, yes);
    expect(outcome).toMatchObject({ added: true, server: { label: 'files' } });
    expect(store.servers.servers).toEqual([{ label: 'files', command: 'npx', args: ['-y', 'some-server'], env: { API_KEY: 'k-654321', REGION: 'eu' }, folder: null, approved: {} }]);
  });

  it('keeps nothing when the person says no', async () => {
    const { deps, store } = setup([]);
    expect(await addMcpServer(deps, request, no)).toEqual({ added: false });
    expect(store.servers.servers).toEqual([]);
  });

  it('shows what the choice means before it asks, with the names of the environment and never its values', async () => {
    const { deps } = setup([]);
    let shown: readonly string[] = [];
    await addMcpServer(deps, request, (question) => {
      shown = question.lines;
      return Promise.resolve(false);
    });
    const text = shown.join('\n');
    expect(text).toContain('MCP server "files"');
    expect(text).toContain('program:    "npx"');
    expect(text).toContain('argument 1: "-y"');
    expect(text).toContain('argument 2: "some-server"');
    expect(text).toContain('API_KEY, REGION');
    expect(text).not.toContain('k-654321');
    expect(text).toContain('does not contain it');
    expect(text).toContain('No tool is available to the office until you approve it');
  });

  const shownFor = async (bad: NewMcpServer): Promise<string> => {
    const { deps } = setup([]);
    let text = '';
    await addMcpServer(deps, bad, (question) => {
      text = question.lines.join('\n');
      return Promise.resolve(false);
    });
    return text;
  };

  it('shows every argument whole, one to a line, with its spaces and its line breaks visible, and never cut', async () => {
    const long = `--config=${'x'.repeat(500)}`;
    const text = await shownFor({ ...request, command: 'sh', args: ['-c', 'echo  two   spaces\nrm -rf ~', long, ''] });
    expect(text).toContain('argument 1: "-c"');
    expect(text).toContain('argument 2: "echo  two   spaces\\nrm -rf ~"');
    expect(text).toContain(`argument 3: "${long}"`);
    expect(text).toContain('argument 4: ""');
  });

  it('refuses, in words and before it asks, a command line over the total that can be shown whole, and what holds characters that cannot be seen', async () => {
    const { deps } = setup([]);
    const never = () => Promise.reject(new Error('it asked'));
    await expect(addMcpServer(deps, { ...request, args: ['a'.repeat(1_000), 'b'.repeat(1_000), 'c'] }, never)).rejects.toThrow(/more than 2000 characters/);
    await expect(addMcpServer(deps, { ...request, args: ['--name=ok\u202Eevil'] }, never)).rejects.toThrow(/characters that cannot be seen/);
    await expect(addMcpServer(deps, { ...request, command: `npx\u{E0041}` }, never)).rejects.toThrow(/characters that cannot be seen/);
  });

  it('names the environment variables that change how a program is loaded or that look like secrets, in words and without their values', async () => {
    const text = await shownFor({ ...request, env: ['NODE_OPTIONS=--require /tmp/x.js', 'PATH=/tmp/bin', 'LD_PRELOAD=/tmp/x.so', 'DYLD_INSERT_LIBRARIES=/tmp/x', 'PYTHONPATH=/tmp', 'GITHUB_TOKEN=ghp_value', 'MY_SECRET=s', 'API_KEY=k', 'REGION=eu'] });
    expect(text).toMatch(/Careful: NODE_OPTIONS, PATH, LD_PRELOAD, DYLD_INSERT_LIBRARIES, PYTHONPATH can change what the program loads or runs/);
    expect(text).toMatch(/GITHUB_TOKEN, MY_SECRET, API_KEY look like secrets/);
    expect(text).not.toMatch(/Careful:.*REGION/);
    for (const value of ['--require', '/tmp/bin', 'ghp_value', 'k-654321']) expect(text).not.toContain(value);
  });

  it('says nothing of danger for an environment that is ordinary', async () => {
    const text = await shownFor({ ...request, env: ['REGION=eu'] });
    expect(text).not.toContain('Careful');
  });

  it('runs in a shared folder when the person says which, and says where that is', async () => {
    const { deps, store } = setup([]);
    let shown = '';
    await addMcpServer(deps, { ...request, folder: 'site' }, (question) => {
      shown = question.lines.join('\n');
      return Promise.resolve(true);
    });
    expect(shown).toContain(site.realPath);
    expect(store.servers.servers[0]?.folder).toBe('site');
  });

  it.each([
    ['a label that is a path', { ...request, label: 'a/b' }, /label is a name and not a path/],
    ['no label', { ...request, label: '' }, /cannot be empty/],
    ['nothing to run', { ...request, command: '' }, /Say what to run/],
    ['an environment that is not NAME=value', { ...request, env: ['API_KEY'] }, /is not NAME=value/],
    ['the same variable twice', { ...request, env: ['A=1', 'A=2'] }, /A is given twice/],
    ['a folder that is not shared', { ...request, folder: 'nowhere' }, /There is no shared folder called "nowhere"/],
  ])('is refused, in words and before it asks, for %s', async (_what, bad, words) => {
    const { deps, store } = setup([]);
    let asked = false;
    await expect(
      addMcpServer(deps, bad, () => {
        asked = true;
        return Promise.resolve(true);
      }),
    ).rejects.toThrow(words);
    expect(asked).toBe(false);
    expect(store.servers.servers).toEqual([]);
  });

  it('is refused when a server has that label already, whatever the capitals, and when there are too many', async () => {
    const { deps } = setup();
    await expect(addMcpServer(deps, { ...request, label: 'NOTES' }, yes)).rejects.toThrow(/There is a server called "notes" already/);
    const many = Array.from({ length: 20 }, (_, index) => ({ ...notes, label: `s${index}` }));
    const full = setup(many);
    await expect(addMcpServer(full.deps, request, yes)).rejects.toThrow(/at most 20/);
  });

  it('is made on the servers as they are when it is kept: one that was added in another terminal while it asked stays', async () => {
    const { deps, store } = setup([]);
    await addMcpServer(deps, request, async () => {
      store.servers = { servers: [{ ...notes, label: 'other' }] };
      return true;
    });
    expect(store.servers.servers.map((server) => server.label)).toEqual(['other', 'files']);
  });
});

describe('taking a local MCP server away', () => {
  it('forgets it, by its label, with what it was approved for', async () => {
    const { deps, store } = setup();
    expect((await removeMcpServer(deps, 'notes')).label).toBe('notes');
    expect(store.servers.servers).toEqual([]);
  });

  it('understands the capitals of a person typing, and says when there is none', async () => {
    const { deps, store } = setup();
    expect((await removeMcpServer(deps, 'NOTES')).label).toBe('notes');
    expect(store.servers.servers).toEqual([]);
    await expect(removeMcpServer(deps, 'notes')).rejects.toThrow(/There is no MCP server called "notes"/);
  });
});

describe('what the servers are', () => {
  it('says there are none, and how to add one', async () => {
    expect(await describeMcpServers(setup([]).deps)).toEqual(['No MCP servers are set up. Set one up with: escritoriio-runner mcp add <label> -- <program> [arguments]']);
  });

  it('says what each runs, where, the names of its environment and how many tools were approved, and never a value', async () => {
    const { deps } = setup([notes, { ...notes, label: 'files', folder: 'site', env: {}, approved: {} }]);
    const text = (await describeMcpServers(deps)).join('\n');
    expect(text).toContain('notes: notes-server --stdio');
    expect(text).toContain('NOTES_API_KEY, REGION');
    expect(text).not.toContain('k-123456');
    expect(text).toContain('1 approved: search');
    expect(text).toContain('files: notes-server --stdio');
    expect(text).toContain(`the shared folder "site"`);
    expect(text).toContain('none approved yet: escritoriio-runner mcp approve files');
  });
});

describe('what a screen shows of the servers', () => {
  it('gives each server with where it runs, the names of its environment and the tools approved, and no value', async () => {
    const { deps } = setup([notes, { ...notes, label: 'files', folder: 'site', env: {}, approved: {} }]);
    const views = await inspectMcpServers(deps);
    expect(views).toEqual([
      { label: 'notes', commandLine: 'notes-server --stdio', folder: null, envNames: ['NOTES_API_KEY', 'REGION'], approvedTools: ['search'] },
      { label: 'files', commandLine: 'notes-server --stdio', folder: 'site', envNames: [], approvedTools: [] },
    ]);
    expect(JSON.stringify(views)).not.toContain('k-123456');
  });

  it('gives each tool a server lists with where it stands, and ends the server', async () => {
    const changed = { ...search, description: 'Looks a word up and more.\nSecond line.' };
    const { deps, client } = setup();
    client.tools = [changed, remove];
    expect(await inspectMcpTools(deps, 'notes', NEVER)).toEqual({
      label: 'notes',
      tools: [
        { name: 'search', standing: 'changed', summary: 'Looks a word up and more.', readOnly: true },
        { name: 'remove', standing: 'new', summary: 'Removes a note.', readOnly: false },
      ],
    });
    expect(client.closed).toBe(1);
  });
});

describe('looking at the tools of a server', () => {
  it('says which are approved, which are new and which have changed since', async () => {
    const changed = { ...search, description: 'Looks a word up and more.' };
    const { deps, client } = setup([{ ...notes, approved: { ...approving(search), remove: textHash('what remove was') } }]);
    client.tools = [changed, remove, { ...search, name: 'add', description: 'Adds a note.' }];
    const text = (await listMcpTools(deps, 'notes', NEVER)).join('\n');
    expect(text).toMatch(/search\s+changed since you approved it/);
    expect(text).toMatch(/remove\s+changed since you approved it/);
    expect(text).toMatch(/add\s+not approved/);
    expect(client.closed).toBe(1);
  });

  it('says it when the program does not start, with the words the adapter gave for the person at the machine', async () => {
    const { deps, client } = setup();
    client.openFails = new LocalMcpError('unreachable', 'The program could not be started. There is no such program.');
    await expect(listMcpTools(deps, 'notes', NEVER)).rejects.toThrow('The program could not be started. There is no such program.');
  });

  it('says there is no such server', async () => {
    await expect(listMcpTools(setup().deps, 'files', NEVER)).rejects.toThrow(/There is no MCP server called "files"/);
  });
});

describe('approving the tools of a server on this machine', () => {
  it('shows each tool that is new or has changed, and approves the ones the person says yes to, by the definition they were shown', async () => {
    const { deps, store } = setup();
    const shown: string[] = [];
    const outcome = await approveMcpTools(deps, 'notes', [], NEVER, (question) => {
      shown.push(question.lines.join('\n'));
      return Promise.resolve(question.lines.join('\n').includes('remove'));
    });
    expect(outcome.approved).toEqual(['remove']);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain('Removes a note.');
    expect(store.servers.servers[0]?.approved).toEqual(approving(search, remove));
  });

  it('asks about the tools it is told to, even those that are approved already', async () => {
    const { deps } = setup();
    let asked = 0;
    await approveMcpTools(deps, 'notes', ['search'], NEVER, () => {
      asked += 1;
      return Promise.resolve(false);
    });
    expect(asked).toBe(1);
  });

  it('says so, and keeps nothing, when there is nothing that waits for approval', async () => {
    const { deps, store } = setup([{ ...notes, approved: approving(search, remove) }]);
    const outcome = await approveMcpTools(deps, 'notes', [], NEVER, yes);
    expect(outcome).toEqual({ approved: [], waiting: 0 });
    expect(store.writes).toBe(0);
  });

  it('refuses a tool the server does not have, before asking about any', async () => {
    const { deps } = setup();
    let asked = false;
    await expect(
      approveMcpTools(deps, 'notes', ['search', 'missing'], NEVER, () => {
        asked = true;
        return Promise.resolve(true);
      }),
    ).rejects.toThrow(/does not list a tool called "missing"/);
    expect(asked).toBe(false);
  });

  it('shows the definition the person is approving whole enough to judge, without what makes a terminal do things', async () => {
    const { deps, client } = setup();
    client.tools = [{ ...remove, description: 'Removes\u001b[2J a note.\nThen it says so.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, force: { type: 'boolean' } } } }];
    let shown = '';
    await approveMcpTools(deps, 'notes', [], NEVER, (question) => {
      shown = question.lines.join('\n');
      return Promise.resolve(false);
    });
    expect(shown).not.toContain('\u001b');
    expect(shown).toContain('Then it says so.');
    expect(shown).toContain('id, force');
  });

  it('does not offer to approve a tool whose name cannot be kept, which would stop every approval of the server', async () => {
    const { deps, client, store } = setup();
    client.tools = [{ ...remove, name: 'x'.repeat(129) }, { ...remove, name: '__proto__' }, remove];
    const asked: string[] = [];
    const outcome = await approveMcpTools(deps, 'notes', [], NEVER, (question) => {
      asked.push(question.lines[0]!);
      return Promise.resolve(true);
    });
    expect(outcome.approved).toEqual(['remove']);
    expect(asked).toHaveLength(1);
    expect(store.servers.servers[0]?.approved).toEqual(approving(search, remove));
    await expect(approveMcpTools(deps, 'notes', ['__proto__'], NEVER, yesAll)).rejects.toThrow(/does not list a tool/);
  });

  it('keeps what was approved on the servers as they are then, and refuses when the server was taken away meanwhile', async () => {
    const { deps, store } = setup();
    await expect(
      approveMcpTools(deps, 'notes', [], NEVER, async () => {
        store.servers = { servers: [] };
        return true;
      }),
    ).rejects.toThrow(/was taken away/);
  });
});

describe('taking an approval back', () => {
  it('forgets the approval of the tools it is told to', async () => {
    const { deps, store } = setup([{ ...notes, approved: approving(search, remove) }]);
    expect(await denyMcpTools(deps, 'notes', ['search'])).toEqual(['search']);
    expect(store.servers.servers[0]?.approved).toEqual(approving(remove));
  });

  it('says which is not approved, and keeps nothing, when one of them is not', async () => {
    const { deps, store } = setup();
    await expect(denyMcpTools(deps, 'notes', ['search', 'remove'])).rejects.toThrow(/"remove" is not approved/);
    expect(store.servers.servers[0]?.approved).toEqual(approving(search));
  });
});
