import type { McpAnsweredMessage, McpCallRequest, McpFailedMessage, McpFailure, McpListedMessage, McpListRequest } from '@escritoriio/runner-protocol';
import { MCP_LIMITS } from '@escritoriio/runner-protocol';
import type { Surroundings } from '../domain/folder-policy.ts';
import { fitAnswer } from '../domain/mcp-answer.ts';
import { offerTools } from '../domain/mcp-offer.ts';
import { scrubJson, scrubText, secretsOf } from '../domain/mcp-scrub.ts';
import type { LocalMcpServer } from '../domain/mcp-server.ts';
import { canonicalDefinition, standingOf } from '../domain/mcp-server.ts';
import { launchOf } from './mcp-launch.ts';
import type { LocalMcpClient, LocalMcpSession, McpServerStore } from './mcp-ports.ts';
import { LocalMcpError } from './mcp-ports.ts';
import type { Scheduler } from './ports.ts';
import type { FolderResolver, PolicyStore } from './task-ports.ts';

/** How many requests of the office are served at once: each is a program that is started and ended, and a machine is a person's computer. */
const MAX_AT_ONCE = 3;

export interface McpRequestsDeps {
  readonly store: Pick<McpServerStore, 'load'>;
  /** The folders the machine shares and whether it is paused on the machine itself: read at every request. */
  readonly policy: Pick<PolicyStore, 'load'>;
  readonly resolver: FolderResolver;
  readonly surroundings: Surroundings;
  readonly client: LocalMcpClient;
  readonly scheduler: Pick<Scheduler, 'after'>;
  /** The hash that a definition is approved by. */
  readonly hash: (text: string) => string;
  /** What the runner was started with: only what a program needs of it is passed on to a server. */
  readonly parentEnvironment: Readonly<Record<string, string | undefined>>;
  /** What was not foreseen, for the person at the machine. It never reaches the office. */
  readonly onError: (error: unknown) => void;
}

type Served<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: McpFailure };

/**
 * What a machine does when the office asks about its local MCP servers: which tools one has, and to call one. The office names a server by
 * its label and nothing else: what is run (the program, its arguments, its environment, where) is what the owner wrote on this machine, and
 * a request that says more is not read for it. Whatever the office says, this machine checks for every request that it is not paused, that the
 * server is one it has, that its folder is still shared and where it was, and that the tool is one its owner approved here and is still as it
 * was approved. A program lives as long as one request.
 */
export class McpRequests {
  private readonly deps: McpRequestsDeps;
  private pausedByOffice = false;
  private readonly running = new Set<AbortController>();

  constructor(deps: McpRequestsDeps) {
    this.deps = deps;
  }

  setPausedByOffice(paused: boolean): void {
    this.pausedByOffice = paused;
  }

  /** Ends every program that runs for a request: the runner is stopping, or its connection is gone. */
  stopAll(): void {
    for (const controller of this.running) controller.abort();
  }

  async list(request: McpListRequest): Promise<McpListedMessage | McpFailedMessage> {
    const served = await this.serve(request.server, MCP_LIMITS.callMs, async (session, server, secrets, signal) => {
      // The hash is of what the server said; what is sent has the secrets taken out first, so that the sizes counted are the sizes sent.
      const found = (await session.listTools(signal)).map((tool) => ({ tool: scrubJson(tool, secrets), hash: this.deps.hash(canonicalDefinition(tool)) }));
      const offer = offerTools(server, found);
      return { name: scrubText(session.serverName, secrets), tools: offer.tools, held: offer.held, omitted: offer.omitted };
    });
    if (!served.ok) return failed(request.id, served.failure);
    const { name, tools, held, omitted } = served.value;
    return { type: 'mcp.listed', id: request.id, server: { name }, tools: [...tools], held, omitted };
  }

  async call(request: McpCallRequest): Promise<McpAnsweredMessage | McpFailedMessage> {
    const served = await this.serve(request.server, request.timeoutMs, async (session, server, secrets, signal) => {
      // The definition the tool has now, and not what an earlier list said: a program that changes what a tool is between a list and a call is caught here.
      const live = (await session.listTools(signal)).find((tool) => tool.name === request.tool);
      if (!live || standingOf(server, live.name, this.deps.hash(canonicalDefinition(live))) !== 'approved') throw new LocalMcpError('not-approved');
      const answer = await session.callTool({ name: live.name, arguments: request.arguments, inputSchema: live.inputSchema, outputSchema: live.outputSchema }, signal);
      // Taken out before it is cut, so that a secret that the cut would have split is not left half of itself.
      return fitAnswer(request.id, scrubText(answer.text, secrets), answer.isError);
    });
    return served.ok ? served.value : failed(request.id, served.failure);
  }

  private async serve<T>(label: string, timeoutMs: number, work: (session: LocalMcpSession, server: LocalMcpServer, secrets: readonly string[], signal: AbortSignal) => Promise<T>): Promise<Served<T>> {
    const { deps } = this;
    if (this.running.size >= MAX_AT_ONCE) return { ok: false, failure: 'busy' };
    const controller = new AbortController();
    this.running.add(controller);
    const stopTimer = deps.scheduler.after(timeoutMs, () => controller.abort());
    let session: LocalMcpSession | undefined;
    try {
      if (this.pausedByOffice || (await deps.policy.load()).paused) return { ok: false, failure: 'paused' };
      // Asked by the exact label it was told: the office is not forgiven a capital that a person typing would be.
      const server = (await deps.store.load()).servers.find((candidate) => candidate.label === label);
      if (!server) return { ok: false, failure: 'no-server' };
      const launch = await launchOf(deps, server);
      if (launch === undefined) return { ok: false, failure: 'not-approved' };
      const opened = await deps.client.open(launch, controller.signal);
      session = opened;
      return { ok: true, value: await work(opened, server, secretsOf(server.env), controller.signal) };
    } catch (error) {
      return { ok: false, failure: this.failureOf(error, controller.signal) };
    } finally {
      stopTimer();
      await session?.close().catch((error: unknown) => deps.onError(error));
      this.running.delete(controller);
    }
  }

  private failureOf(error: unknown, signal: AbortSignal): McpFailure {
    if (error instanceof LocalMcpError) return error.failure;
    this.deps.onError(error);
    return signal.aborted ? 'timeout' : 'unreachable';
  }
}

const failed = (id: string, failure: McpFailure): McpFailedMessage => ({ type: 'mcp.failed', id, failure });
