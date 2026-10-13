import { readdirSync, readFileSync } from 'node:fs';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../application/task-ports.ts';
import { createClaudeCodeAgent } from './claude-code-agent.ts';
import type { ClaudeQuery, ClaudeSdk } from './claude-code-agent.ts';
import { claudeQueryOptions } from './options.ts';
import { agentRequest, assistantFailed, assistantSays, initialized, resultOf, succeeded, text, toolAnswers, toolUse } from './testing.ts';
import type { TaskProcesses, TaskScope } from './task-processes.ts';

/** A run of Claude Code that says what a test says it says, and is ended, as the real one is, by being closed. */
class FakeQuery implements ClaudeQuery {
  closed = 0;
  private readonly messages: AsyncGenerator<SDKMessage>;
  private onClose: (() => void) | undefined;

  constructor(script: (query: FakeQuery) => AsyncGenerator<SDKMessage>) {
    this.messages = script(this);
  }

  /** Waits until it is closed: the way a run that is waiting for the model ends. */
  untilClosed(): Promise<void> {
    return new Promise((resolve) => {
      this.onClose = resolve;
      if (this.closed > 0) resolve();
    });
  }

  close(): void {
    this.closed++;
    this.onClose?.();
  }

  [Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
    return this.messages;
  }
}

function fakeSdk(script: (query: FakeQuery, options: Options) => AsyncGenerator<SDKMessage>) {
  const calls: { readonly prompt: string; readonly options: Options }[] = [];
  const queries: FakeQuery[] = [];
  const sdk: ClaudeSdk = {
    query(request) {
      calls.push(request);
      const query = new FakeQuery((self) => script(self, request.options));
      queries.push(query);
      return query;
    },
  };
  return { sdk, calls, queries };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const told: AgentEvent[] = [];
  for await (const event of events) told.push(event);
  return told;
}

/** What starts the process of a task and ends what it left, as a test says it does: it counts the clean ups, and can hold one until the test lets it end. */
function fakeProcesses() {
  const scopes: TaskScope[] = [];
  let cleanUps = 0;
  let held: Promise<void> | undefined;
  let letGo: (() => void) | undefined;
  const spawn: TaskProcesses['spawn'] = () => {
    throw new Error('A fake SDK starts no process.');
  };
  return {
    startProcesses: (scope: TaskScope): TaskProcesses => {
      scopes.push(scope);
      return { spawn, cleanUp: () => (cleanUps++, held ?? Promise.resolve()) };
    },
    spawn,
    scopes,
    cleanUps: () => cleanUps,
    /** The clean ups that begin from now on do not end until `letGo`. */
    hold: (): (() => void) => {
      held = new Promise((resolve) => {
        letGo = resolve;
      });
      return () => letGo?.();
    },
  };
}

const settlesWithin = async (promise: Promise<unknown>, ms = 20): Promise<boolean> => {
  let settled = false;
  void promise.then(() => (settled = true));
  await new Promise((resolve) => setTimeout(resolve, ms));
  return settled;
};

const hookInput = (name: string, input: object, id: string) => ({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: id, session_id: 's', transcript_path: '', cwd: '/' }) as never;

describe('Claude Code as a coding agent', () => {
  it('is Claude Code', () => {
    expect(createClaudeCodeAgent().kind).toBe('claude-code');
  });

  it('tells what Claude Code did, and ends with its result', async () => {
    const { sdk, calls } = fakeSdk(async function* () {
      yield initialized;
      yield assistantSays(text('Looking.'), toolUse('t1', 'Read', { file_path: '/Users/ana/work/site/README.md' }));
      yield toolAnswers('t1', 'file contents');
      yield assistantSays(toolUse('t2', 'Edit', { file_path: '/Users/ana/work/site/README.md' }));
      yield toolAnswers('t2');
      yield succeeded('Fixed the typo.');
    });
    const request = agentRequest();
    const events = await collect(createClaudeCodeAgent({ loadSdk: () => Promise.resolve(sdk) }).run(request, new AbortController().signal));
    expect(events).toEqual([
      { kind: 'text', text: 'Looking.' },
      { kind: 'tool', name: 'Read', summary: '/Users/ana/work/site/README.md', denied: false },
      { kind: 'tool', name: 'Edit', summary: '/Users/ana/work/site/README.md', denied: false },
      { kind: 'usage', inputTokens: 115, outputTokens: 20 },
      { kind: 'result', text: 'Fixed the typo.' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe(request.instruction);
  });

  it('starts Claude Code with exactly the options that were built for the task, hook included', async () => {
    const { sdk, calls } = fakeSdk(async function* () {
      yield succeeded('Done.');
    });
    const request = agentRequest({ access: 'read-only' });
    const processes = fakeProcesses();
    await collect(createClaudeCodeAgent({ loadSdk: () => Promise.resolve(sdk), startProcesses: processes.startProcesses }).run(request, new AbortController().signal));
    const options = calls[0]?.options;
    const hook = options?.hooks?.PreToolUse?.[0]?.hooks[0];
    expect(hook).toBeTypeOf('function');
    expect(options?.abortController).toBeInstanceOf(AbortController);
    expect(options?.spawnClaudeCodeProcess).toBe(processes.spawn);
    expect(options).toEqual(claudeQueryOptions(request, { abortController: options?.abortController as AbortController, preToolUse: hook as never, spawnProcess: processes.spawn }));
  });

  describe('the hook it gives Claude Code', () => {
    it('refuses what is outside the folder of the task, and the task tells of it as refused', async () => {
      const { sdk } = fakeSdk(async function* (_query, options) {
        const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
        const signal = new AbortController().signal;
        yield assistantSays(toolUse('t1', 'Read', { file_path: '/Users/ana/.ssh/id_ed25519' }), toolUse('t2', 'Read', { file_path: '/Users/ana/work/site/README.md' }));
        const refused = await hook?.(hookInput('Read', { file_path: '/Users/ana/.ssh/id_ed25519' }, 't1'), 't1', { signal });
        const allowed = await hook?.(hookInput('Read', { file_path: '/Users/ana/work/site/README.md' }, 't2'), 't2', { signal });
        expect(refused).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
        expect(allowed).toEqual({});
        yield toolAnswers('t1', 'That path is outside the folder this task works in.', true);
        yield toolAnswers('t2');
        yield succeeded('Could not read the key.');
      });
      const events = await collect(createClaudeCodeAgent({ loadSdk: () => Promise.resolve(sdk), resolveReal: (path) => Promise.resolve(path) }).run(agentRequest(), new AbortController().signal));
      expect(events.filter((event) => event.kind === 'tool')).toEqual([
        { kind: 'tool', name: 'Read', summary: '/Users/ana/.ssh/id_ed25519', denied: false },
        { kind: 'tool', name: 'Read', summary: '/Users/ana/work/site/README.md', denied: false },
        { kind: 'tool', name: 'Read', summary: '/Users/ana/.ssh/id_ed25519', denied: true },
      ]);
      expect(events.at(-1)).toEqual({ kind: 'result', text: 'Could not read the key.' });
    });

    it('asks the file system where a path really is, through the one it was given', async () => {
      const asked: string[] = [];
      const { sdk } = fakeSdk(async function* (_query, options) {
        const decision = await options.hooks?.PreToolUse?.[0]?.hooks[0]?.(hookInput('Write', { file_path: 'docs/new.md', content: 'x' }, 't1'), 't1', { signal: new AbortController().signal });
        expect(decision).toEqual({});
        yield succeeded('ok');
      });
      await collect(createClaudeCodeAgent({ loadSdk: () => Promise.resolve(sdk), resolveReal: (path) => (asked.push(path), Promise.resolve(path)) }).run(agentRequest(), new AbortController().signal));
      expect(asked).toEqual(['/Users/ana/work/site', '/Users/ana/work/site/docs/new.md']);
    });
  });

  describe('how it ends', () => {
    it('is an error, in words, when Claude Code says it failed, and nothing is told after it, though Claude Code then throws as it does', async () => {
      const { sdk } = fakeSdk(async function* () {
        yield assistantFailed('authentication_failed', 'Failed to authenticate: sk-ant-SECRET');
        yield resultOf('success', true, 'Failed to authenticate: sk-ant-SECRET');
        throw new Error('Claude Code returned an error result: Failed to authenticate: sk-ant-SECRET');
      });
      const events = await collect(createClaudeCodeAgent({ loadSdk: () => Promise.resolve(sdk) }).run(agentRequest(), new AbortController().signal));
      expect(events.map((event) => event.kind)).toEqual(['usage', 'error']);
      expect(events.at(-1)).toEqual({ kind: 'error', message: expect.stringContaining('logged in') });
      expect(JSON.stringify(events)).not.toContain('SECRET');
    });

    it('is one error, and not an exception, when Claude Code stops with no result', async () => {
      const { sdk, queries } = fakeSdk(async function* () {
        yield assistantSays(text('Starting.'));
        throw new Error('Claude Code process exited with code 1: unknown option --secret-flag-sk-ant-SECRET');
      });
      const events = await collect(createClaudeCodeAgent({ loadSdk: () => Promise.resolve(sdk) }).run(agentRequest(), new AbortController().signal));
      expect(events).toEqual([{ kind: 'text', text: 'Starting.' }, { kind: 'error', message: expect.any(String) }]);
      expect(JSON.stringify(events)).not.toContain('SECRET');
      expect(queries[0]?.closed).toBeGreaterThan(0);
    });

    it('is an error when Claude Code ends without a result', async () => {
      const { sdk } = fakeSdk(async function* () {
        yield initialized;
      });
      const events = await collect(createClaudeCodeAgent({ loadSdk: () => Promise.resolve(sdk) }).run(agentRequest(), new AbortController().signal));
      expect(events).toEqual([{ kind: 'error', message: expect.stringContaining('without an answer') }]);
    });

    it('is one error when the SDK cannot be loaded, with no word of why: the program that is not there is a matter for the person', async () => {
      const agent = createClaudeCodeAgent({ loadSdk: () => Promise.reject(new Error("Cannot find package '@anthropic-ai/claude-agent-sdk' imported from /Users/ana/runner/dist/cli.js")) });
      const events = await collect(agent.run(agentRequest(), new AbortController().signal));
      expect(events).toEqual([{ kind: 'error', message: expect.any(String) }]);
      expect(JSON.stringify(events)).not.toContain('/Users/ana');
    });

    it('stops reading after the result, and closes the run, even when nobody asks for more', async () => {
      const { sdk, queries } = fakeSdk(async function* () {
        yield succeeded('Done.');
        yield assistantSays(text('never read'));
      });
      const iterator = createClaudeCodeAgent({ loadSdk: () => Promise.resolve(sdk) }).run(agentRequest(), new AbortController().signal)[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ kind: 'usage' });
      expect((await iterator.next()).value).toMatchObject({ kind: 'result' });
      // A reader that has what it wanted never comes back for the end of the stream.
      expect(queries[0]?.closed).toBeGreaterThan(0);
      expect((await iterator.next()).done).toBe(true);
    });

    it('closes the run when the reader stops reading before the end', async () => {
      const { sdk, queries } = fakeSdk(async function* () {
        yield assistantSays(text('One.'));
        yield assistantSays(text('Two.'));
        yield succeeded('Three.');
      });
      const iterator = createClaudeCodeAgent({ loadSdk: () => Promise.resolve(sdk) }).run(agentRequest(), new AbortController().signal)[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.return?.();
      expect(queries[0]?.closed).toBeGreaterThan(0);
    });
  });

  describe('being told to stop', () => {
    it('ends at once when told to stop while it waits for Claude Code, with its process closed and nothing more told', async () => {
      const { sdk, queries, calls } = fakeSdk(async function* (query) {
        yield assistantSays(toolUse('t1', 'Bash', { command: 'sleep 300' }));
        await query.untilClosed();
      });
      const controller = new AbortController();
      const told: AgentEvent[] = [];
      const run = (async () => {
        for await (const event of createClaudeCodeAgent({ loadSdk: () => Promise.resolve(sdk) }).run(agentRequest(), controller.signal)) {
          told.push(event);
          if (event.kind === 'tool') controller.abort();
        }
      })();
      await run;
      expect(told).toEqual([{ kind: 'tool', name: 'Bash', summary: 'sleep 300', denied: false }]);
      expect(queries[0]?.closed).toBeGreaterThan(0);
      expect(calls[0]?.options.abortController?.signal.aborted).toBe(true);
    });

    it('does not wait for the reader to give up: the stop closes the run by itself, while a message is awaited', async () => {
      const { sdk, queries } = fakeSdk(async function* (query) {
        yield initialized;
        await query.untilClosed();
      });
      const controller = new AbortController();
      const iterator = createClaudeCodeAgent({ loadSdk: () => Promise.resolve(sdk) }).run(agentRequest(), controller.signal)[Symbol.asyncIterator]();
      const next = iterator.next();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(queries[0]?.closed).toBe(0);
      controller.abort();
      expect(queries[0]?.closed).toBeGreaterThan(0);
      expect((await next).done).toBe(true);
    });

    it('says nothing of an error when closing the run makes it throw, as it does', async () => {
      const { sdk } = fakeSdk(async function* (query) {
        yield initialized;
        await query.untilClosed();
        throw new Error('Claude Code process aborted by user');
      });
      const controller = new AbortController();
      const run = collect(createClaudeCodeAgent({ loadSdk: () => Promise.resolve(sdk) }).run(agentRequest(), controller.signal));
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();
      expect(await run).toEqual([]);
    });

    it('survives a run that cannot be closed', async () => {
      const { sdk, queries } = fakeSdk(async function* (query) {
        yield initialized;
        await query.untilClosed();
      });
      const controller = new AbortController();
      const run = collect(createClaudeCodeAgent({ loadSdk: () => Promise.resolve(sdk) }).run(agentRequest(), controller.signal));
      await new Promise((resolve) => setTimeout(resolve, 10));
      const query = queries[0];
      const close = query?.close.bind(query);
      if (query) query.close = () => {
        close?.();
        throw new Error('already closed');
      };
      expect(() => controller.abort()).not.toThrow();
      expect(await run).toEqual([]);
    });

    it('does not begin when it was told to stop before, and does not even load the SDK', async () => {
      let loaded = 0;
      const controller = new AbortController();
      controller.abort();
      const agent = createClaudeCodeAgent({ loadSdk: () => (loaded++, Promise.reject(new Error('never'))) });
      expect(await collect(agent.run(agentRequest(), controller.signal))).toEqual([]);
      expect(loaded).toBe(0);
    });

    it('does not begin when it was told to stop while the SDK was being loaded', async () => {
      const { sdk, calls } = fakeSdk(async function* () {
        yield succeeded('never');
      });
      const controller = new AbortController();
      const agent = createClaudeCodeAgent({ loadSdk: () => new Promise((resolve) => setTimeout(() => resolve(sdk), 20)) });
      const run = collect(agent.run(agentRequest(), controller.signal));
      controller.abort();
      expect(await run).toEqual([]);
      expect(calls).toHaveLength(0);
    });
  });

  describe('the processes of the task', () => {
    const agentWith = (sdk: ClaudeSdk, processes: ReturnType<typeof fakeProcesses>, more: Parameters<typeof createClaudeCodeAgent>[0] = {}) =>
      createClaudeCodeAgent({ loadSdk: () => Promise.resolve(sdk), startProcesses: processes.startProcesses, ...more });

    it('starts Claude Code through them, and ends what it left once, whichever way the task ends', async () => {
      const endings: [string, () => AsyncGenerator<SDKMessage>][] = [
        ['a result', async function* () { yield succeeded('Done.'); }],
        ['no answer', async function* () { yield initialized; }],
        ['an exception', async function* () { yield initialized; throw new Error('Claude Code process exited with code 1'); }],
        ['an error result', async function* () { yield resultOf('error_during_execution', true); }],
      ];
      for (const [, script] of endings) {
        const processes = fakeProcesses();
        const { sdk } = fakeSdk(script);
        await collect(agentWith(sdk, processes).run(agentRequest(), new AbortController().signal));
        expect(processes.cleanUps()).toBe(1);
      }
    });

    it('is not asked to end anything when it never got to start Claude Code', async () => {
      const processes = fakeProcesses();
      const agent = createClaudeCodeAgent({ loadSdk: () => Promise.reject(new Error('no')), startProcesses: processes.startProcesses });
      expect(await collect(agent.run(agentRequest(), new AbortController().signal))).toEqual([{ kind: 'error', message: expect.any(String) }]);
      expect(processes.scopes).toEqual([]);
      expect(processes.cleanUps()).toBe(0);
    });

    it('tells the last thing only when everything the task left has ended, so that whoever hears it can take what was done', async () => {
      const processes = fakeProcesses();
      const release = processes.hold();
      const { sdk } = fakeSdk(async function* () {
        yield succeeded('Done.');
      });
      const iterator = agentWith(sdk, processes).run(agentRequest(), new AbortController().signal)[Symbol.asyncIterator]();
      const first = iterator.next();
      expect(await settlesWithin(first)).toBe(false);
      expect(processes.cleanUps()).toBe(1);
      release();
      expect((await first).value).toMatchObject({ kind: 'usage' });
      expect((await iterator.next()).value).toMatchObject({ kind: 'result' });
    });

    it.each([
      ['Claude Code stops with an exception', async function* (): AsyncGenerator<SDKMessage> { yield initialized; throw new Error('exited'); }],
      ['Claude Code ends with no answer', async function* (): AsyncGenerator<SDKMessage> { yield initialized; }],
    ])('tells that the task failed only when everything it left has ended: %s', async (_when, script) => {
      const processes = fakeProcesses();
      const release = processes.hold();
      const { sdk } = fakeSdk(script);
      const run = collect(agentWith(sdk, processes).run(agentRequest(), new AbortController().signal));
      expect(await settlesWithin(run)).toBe(false);
      release();
      expect(await run).toEqual([{ kind: 'error', message: expect.any(String) }]);
    });

    it('is ended by the stop itself, with nobody asking the run for more, and the run is over only when that is', async () => {
      const processes = fakeProcesses();
      const release = processes.hold();
      const { sdk, queries } = fakeSdk(async function* (query) {
        yield initialized;
        await query.untilClosed();
      });
      const controller = new AbortController();
      const iterator = agentWith(sdk, processes).run(agentRequest(), controller.signal)[Symbol.asyncIterator]();
      const next = iterator.next();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(processes.cleanUps()).toBe(0);
      controller.abort();
      expect(queries[0]?.closed).toBeGreaterThan(0);
      expect(processes.cleanUps()).toBe(1);
      expect(await settlesWithin(next)).toBe(false);
      release();
      expect((await next).done).toBe(true);
      expect(processes.cleanUps()).toBe(1);
    });

    it('is ended once when the reader stops before the end, and once when it is told to stop while it reads', async () => {
      const early = fakeProcesses();
      const { sdk } = fakeSdk(async function* () {
        yield assistantSays(text('One.'));
        yield succeeded('Two.');
      });
      const iterator = agentWith(sdk, early).run(agentRequest(), new AbortController().signal)[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.return?.();
      expect(early.cleanUps()).toBe(1);

      const stopped = fakeProcesses();
      const controller = new AbortController();
      const waiting = fakeSdk(async function* (query) {
        yield initialized;
        await query.untilClosed();
      });
      const run = collect(agentWith(waiting.sdk, stopped).run(agentRequest(), controller.signal));
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();
      await run;
      expect(stopped.cleanUps()).toBe(1);
    });

    it('is told whether the task can run commands, and whether its folder is one that the runner made for it alone', async () => {
      const inCopies = '/Users/ana/Library/Caches/escritoriio-runner/worktrees';
      const run = async (request: ReturnType<typeof agentRequest>, resolveReal: (path: string) => Promise<string> = (path) => Promise.resolve(path)) => {
        const processes = fakeProcesses();
        const { sdk } = fakeSdk(async function* () {
          yield succeeded('Done.');
        });
        await collect(agentWith(sdk, processes, { resolveReal }).run(request, new AbortController().signal));
        return processes.scopes[0];
      };
      expect(await run(agentRequest({ access: 'edit' }))).toEqual({ commands: true, ownFolder: undefined });
      expect(await run(agentRequest({ access: 'read-only', folder: `${inCopies}/task-1` }), (path) => Promise.resolve(path.replace('/Users/ana/Library', '/private/Library')))).toEqual({ commands: false, ownFolder: '/private/Library/Caches/escritoriio-runner/worktrees/task-1' });
      expect(await run(agentRequest({ access: 'edit', folder: inCopies }))).toEqual({ commands: true, ownFolder: undefined });
      expect(await run(agentRequest({ access: 'edit', folder: `${inCopies}-other/task-1` }))).toEqual({ commands: true, ownFolder: undefined });
      expect(await run(agentRequest({ access: 'edit', folder: `${inCopies}/task-1` }), () => Promise.reject(new Error('EIO')))).toEqual({ commands: true, ownFolder: undefined });
    });
  });

  describe('the SDK', () => {
    it('is not loaded when the agent is made, nor when it is asked about Claude Code: only when a task runs', async () => {
      let loaded = 0;
      const agent = createClaudeCodeAgent({
        loadSdk: () => (loaded++, Promise.reject(new Error('no'))),
        exec: () => Promise.resolve({ stdout: '', exitCode: null }),
        isExecutable: () => Promise.resolve(false),
        home: '/Users/ana',
        platform: 'linux',
        shell: undefined,
      });
      await agent.detect(undefined);
      await agent.detect('/opt/claude');
      expect(loaded).toBe(0);
      await collect(agent.run(agentRequest(), new AbortController().signal));
      expect(loaded).toBe(1);
    });

    it('is not imported by any file of the adapter but by a dynamic import inside what runs a task, so that the runner is made without it', () => {
      const folder = new URL('.', import.meta.url);
      const sources = readdirSync(folder).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
      expect(sources.length).toBeGreaterThan(5);
      for (const name of sources) {
        const source = readFileSync(new URL(name, folder), 'utf8');
        expect(source, name).not.toMatch(/^import (?!type\b)[^;]*from '@anthropic-ai\/claude-agent-sdk'/m);
        expect(source, name).not.toMatch(/^export [^;]*from '@anthropic-ai\/claude-agent-sdk'/m);
      }
    });
  });

  describe('looking for Claude Code', () => {
    it('is asked of the detection that was given, with the path the owner chose', async () => {
      const asked: string[] = [];
      const agent = createClaudeCodeAgent({
        exec: (file, args) => {
          asked.push([file, ...args].join(' '));
          return Promise.resolve(args[0] === '--version' ? { stdout: '2.1.250 (Claude Code)', exitCode: 0 } : { stdout: '{"loggedIn":true}', exitCode: 0 });
        },
        isExecutable: () => Promise.resolve(true),
        platform: 'darwin',
        home: '/Users/ana',
      });
      expect(await agent.detect('/opt/tools/claude')).toMatchObject({ installed: true, path: '/opt/tools/claude', version: '2.1.250', loggedIn: true, supported: true, containment: 'sandbox' });
      expect(asked).toEqual(['/opt/tools/claude --version', '/opt/tools/claude auth status']);
    });
  });
});

describe('Claude Code in a workspace', () => {
  const workspaceTools = { newFolder: () => Promise.resolve({ ok: true, words: 'Made.' }), clone: () => Promise.resolve({ ok: true, words: 'Cloned.' }) };
  const server = { type: 'sdk', name: 'escritoriio', instance: {} };

  function sdkWithServer(script: Parameters<typeof fakeSdk>[0]) {
    const made: { readonly name: string; readonly tools: unknown[] }[] = [];
    const { sdk, calls, queries } = fakeSdk(script);
    const withServer: ClaudeSdk = {
      ...sdk,
      query: (request) => sdk.query(request),
      tool: ((name: string, description: string, inputSchema: object, handler: unknown) => ({ name, description, inputSchema, handler })) as never,
      createSdkMcpServer: ((options: { name: string; tools: unknown[] }) => (made.push(options), server)) as never,
    };
    return { sdk: withServer, calls, queries, made };
  }

  it('is a coding agent that takes the tools of a workspace', () => {
    expect(createClaudeCodeAgent().workspaceTools).toBe(true);
  });

  it('is given the runner’s own server, and approves its two tools, only when the task has a workspace', async () => {
    const { sdk, calls, made } = sdkWithServer(async function* () {
      yield succeeded('Done.');
    });
    const agent = createClaudeCodeAgent({ loadSdk: () => Promise.resolve(sdk), startProcesses: fakeProcesses().startProcesses });
    await collect(agent.run(agentRequest({ workspace: workspaceTools }), new AbortController().signal));
    expect(made.map((one) => one.name)).toEqual(['escritoriio']);
    expect(made[0]?.tools).toHaveLength(2);
    expect(calls[0]?.options.mcpServers).toEqual({ escritoriio: server });
    expect(calls[0]?.options.allowedTools).toEqual(expect.arrayContaining(['mcp__escritoriio__workspace_new_folder', 'mcp__escritoriio__workspace_clone']));

    await collect(agent.run(agentRequest(), new AbortController().signal));
    expect(made).toHaveLength(1);
    expect(calls[1]?.options).not.toHaveProperty('mcpServers');
  });

  it('judges the calls of its two tools by the runner’s hook: they are allowed here, and no other MCP tool is', async () => {
    const { sdk } = sdkWithServer(async function* (_query, options) {
      const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
      const signal = new AbortController().signal;
      yield assistantSays(toolUse('t1', 'mcp__escritoriio__workspace_new_folder', { name: 'hello' }), toolUse('t2', 'mcp__other__delete', {}));
      expect(await hook?.(hookInput('mcp__escritoriio__workspace_new_folder', { name: 'hello' }, 't1'), 't1', { signal })).toEqual({});
      expect(await hook?.(hookInput('mcp__other__delete', {}, 't2'), 't2', { signal })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
      yield toolAnswers('t1', 'Made.');
      yield toolAnswers('t2', 'That tool is not available in this task.', true);
      yield succeeded('Done.');
    });
    const events = await collect(createClaudeCodeAgent({ loadSdk: () => Promise.resolve(sdk), startProcesses: fakeProcesses().startProcesses }).run(agentRequest({ workspace: workspaceTools }), new AbortController().signal));
    expect(events.filter((event) => event.kind === 'tool')).toEqual([
      { kind: 'tool', name: 'mcp__escritoriio__workspace_new_folder', summary: 'hello', denied: false },
      { kind: 'tool', name: 'mcp__other__delete', summary: '', denied: true },
    ]);
  });

  it('cannot start a task of a workspace with an SDK that cannot make the server, and says so', async () => {
    const { sdk, calls } = fakeSdk(async function* () {
      yield succeeded('Done.');
    });
    const events = await collect(createClaudeCodeAgent({ loadSdk: () => Promise.resolve(sdk), startProcesses: fakeProcesses().startProcesses }).run(agentRequest({ workspace: workspaceTools }), new AbortController().signal));
    expect(events).toEqual([{ kind: 'error', message: expect.stringContaining('could not load') }]);
    expect(calls).toEqual([]);
  });
});
