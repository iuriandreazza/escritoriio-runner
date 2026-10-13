import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalLaunch } from '../application/mcp-ports.ts';
import { LocalMcpError } from '../application/mcp-ports.ts';
import { createStdioMcpClient } from './stdio-mcp-client.ts';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'testing', 'fake-mcp-server.ts');
const NEVER = new AbortController().signal;

let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'escritoriio-stdio-'));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const launch = (fake: object = {}, env: Record<string, string> = {}, cwd?: string): LocalLaunch => ({
  command: process.execPath,
  args: [SERVER],
  env: { PATH: process.env.PATH ?? '', FAKE_MCP: JSON.stringify(fake), FAKE_MCP_PIDS: join(scratch, 'pids'), ...env },
  cwd,
});

const client = createStdioMcpClient();

const pidsOf = async (): Promise<number[]> => (await readFile(join(scratch, 'pids'), 'utf8')).split('\n').filter(Boolean).map(Number);
const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('a local server over its standard input and output', () => {
  it('lists its tools as it describes them, and says what it calls itself', async () => {
    const session = await client.open(launch(), NEVER);
    try {
      expect(session.serverName).toBe('Fake notes');
      const tools = await session.listTools(NEVER);
      expect(tools.map((tool) => tool.name)).toEqual(['echo', 'environment', 'where', 'hang', 'flood', 'structured']);
      expect(tools[0]).toEqual({
        name: 'echo',
        title: null,
        description: 'Says back what it is given.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        outputSchema: null,
        hints: { readOnly: true },
      });
    } finally {
      await session.close();
    }
  });

  it('calls a tool with arguments that fit what the tool was approved to take, and gives back the words it answered', async () => {
    const session = await client.open(launch(), NEVER);
    try {
      const [echo] = await session.listTools(NEVER);
      const answer = await session.callTool({ name: 'echo', arguments: { text: 'hello' }, inputSchema: echo!.inputSchema, outputSchema: null }, NEVER);
      expect(answer).toEqual({ text: 'echo: hello', isError: false });
    } finally {
      await session.close();
    }
  });

  it('sends nothing when the arguments are not the ones the tool was approved to take', async () => {
    const session = await client.open(launch(), NEVER);
    try {
      const [echo] = await session.listTools(NEVER);
      const bad = [{ text: 5 }, {}, { text: 'x', more: true }];
      for (const args of bad) {
        await expect(session.callTool({ name: 'echo', arguments: args, inputSchema: echo!.inputSchema, outputSchema: null }, NEVER)).rejects.toMatchObject({ failure: 'bad-arguments' });
      }
    } finally {
      await session.close();
    }
  });

  it('does not believe an answer that is not the one the tool promised', async () => {
    const session = await client.open(launch(), NEVER);
    try {
      const tools = await session.listTools(NEVER);
      const structured = tools.find((tool) => tool.name === 'structured')!;
      const call = (args: Record<string, unknown>) => session.callTool({ name: 'structured', arguments: args, inputSchema: { type: 'object' }, outputSchema: structured.outputSchema }, NEVER);
      expect(await call({})).toEqual({ text: 'three', isError: false });
      await expect(call({ wrong: true })).rejects.toMatchObject({ failure: 'bad-answer' });
    } finally {
      await session.close();
    }
  });

  it('is given the environment that was written for it and nothing of the runner’s own', async () => {
    process.env.RUNNER_ONLY_SECRET = 'must-not-reach-the-server';
    try {
      const session = await client.open(launch({}, { OWNER_TYPED: 'typed-by-the-owner' }), NEVER);
      try {
        const call = (name: string) => session.callTool({ name: 'environment', arguments: { name }, inputSchema: { type: 'object' }, outputSchema: null }, NEVER);
        expect(await call('OWNER_TYPED')).toMatchObject({ text: 'typed-by-the-owner' });
        expect(await call('RUNNER_ONLY_SECRET')).toMatchObject({ text: '(not set)' });
      } finally {
        await session.close();
      }
    } finally {
      delete process.env.RUNNER_ONLY_SECRET;
    }
  });

  it('puts up with a program that writes what is not a message on its standard output', async () => {
    const session = await client.open(launch({ noise: 'Starting up... listening, not JSON at all' }), NEVER);
    try {
      expect((await session.listTools(NEVER)).length).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  it('says that a program that ends in the middle of a call did not answer', async () => {
    const session = await client.open(launch({ crashOn: 'echo' }), NEVER);
    try {
      const [echo] = await session.listTools(NEVER);
      await expect(session.callTool({ name: 'echo', arguments: { text: 'x' }, inputSchema: echo!.inputSchema, outputSchema: null }, NEVER)).rejects.toMatchObject({ failure: 'unreachable' });
    } finally {
      await session.close();
    }
  });

  it('gives up when the time is over, and leaves no program running', async () => {
    const session = await client.open(launch(), NEVER);
    const deadline = AbortSignal.timeout(300);
    await expect(session.callTool({ name: 'hang', arguments: {}, inputSchema: { type: 'object' }, outputSchema: null }, deadline)).rejects.toMatchObject({ failure: 'timeout' });
    await session.close();
    const [pid] = await pidsOf();
    expect(isRunning(pid!)).toBe(false);
  });

  it('leaves no program running when it is closed', async () => {
    const session = await client.open(launch(), NEVER);
    await session.listTools(NEVER);
    await session.close();
    const pids = await pidsOf();
    expect(pids).toHaveLength(1);
    expect(isRunning(pids[0]!)).toBe(false);
  });

  it('says that a program that cannot be started is not there, with words for the person at the machine', async () => {
    const error = await client.open({ command: join(scratch, 'no-such-program'), args: [], env: {}, cwd: undefined }, NEVER).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LocalMcpError);
    expect(error).toMatchObject({ failure: 'unreachable', detail: expect.stringContaining('could not be started') });
  });

  it('gives up on a program that does not answer when it is started', async () => {
    const hung: LocalLaunch = { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: { PATH: process.env.PATH ?? '' }, cwd: undefined };
    await expect(client.open(hung, AbortSignal.timeout(300))).rejects.toMatchObject({ failure: 'timeout' });
  });

  it('runs in a folder of its own that is empty and gone when the server is, unless it is given one', async () => {
    const session = await client.open(launch(), NEVER);
    const where = await session.callTool({ name: 'where', arguments: {}, inputSchema: { type: 'object' }, outputSchema: null }, NEVER);
    expect(existsSync(where.text)).toBe(true);
    expect(where.text.startsWith(await realTemp())).toBe(true);
    await session.close();
    expect(existsSync(where.text)).toBe(false);

    const given = await client.open(launch({}, {}, scratch), NEVER);
    const there = await given.callTool({ name: 'where', arguments: {}, inputSchema: { type: 'object' }, outputSchema: null }, NEVER);
    expect(await realpath(there.text)).toBe(await realpath(scratch));
    await given.close();
    expect(existsSync(scratch)).toBe(true);
  });
});

async function realpath(path: string): Promise<string> {
  const { realpath: resolve } = await import('node:fs/promises');
  return resolve(path);
}
const realTemp = (): Promise<string> => realpath(tmpdir());
