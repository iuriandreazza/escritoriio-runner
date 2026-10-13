import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCP_LIMITS, toOneLine } from '@escritoriio/runner-protocol';
import { Client, ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import type { LocalAnswer, LocalCall, LocalLaunch, LocalMcpClient, LocalMcpSession } from '../application/mcp-ports.ts';
import { LocalMcpError } from '../application/mcp-ports.ts';
import type { LocalTool } from '../domain/mcp-server.ts';

/** How many pages of a list the client follows: a server whose list never ends is not one to keep following. */
const LIST_MAX_PAGES = 10;
/** How long one request of a session may take; the deadline of the request is what usually ends it sooner. */
const REQUEST_TIMEOUT_MS = MCP_LIMITS.callMs;
/** What a program said last on its standard error, kept for the person at the machine when it does not start. */
const LAST_WORDS_CHARS = 300;

/** What the runner says it is to every server. It offers no capability, so a server has nothing it may ask of it. */
const CLIENT_INFO = { name: 'escritoriio-runner', version: '1.0.0' } as const;

/**
 * Gives up on `work` when the deadline passes, whether or not the SDK honours the signal at that point: the caller is told it timed out
 * and `abandon` lets go of what was in flight, which is a program that must not be left running.
 */
async function before<T>(signal: AbortSignal, work: Promise<T>, abandon: () => Promise<void>): Promise<T> {
  let onAbort: (() => void) | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      void abandon();
      reject(new LocalMcpError('timeout'));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    // What the work that lost the race says is of no interest any more.
    work.catch(() => undefined);
  }
}

/** The code of a system error somewhere in what the SDK threw: a program that is not there, or that may not be run, is told by the system and not by the protocol. */
function systemCodeOf(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 6; current = current.cause, depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return code;
  }
  return undefined;
}

const START_WORDS: Readonly<Record<string, string>> = {
  ENOENT: 'There is no such program: check the name, and that it is where this machine looks for programs',
  EACCES: 'This user may not run that program',
  ENOTDIR: 'The folder it was asked to run in is not a folder',
};

/** What kind of failure an error was, in the runner's terms, and for the person at the machine a few words of why. What is not one of these is returned as it is: it is a bug. */
function failureOf(error: unknown, signal: AbortSignal, lastWords: () => string): LocalMcpError | unknown {
  if (error instanceof LocalMcpError) return error;
  if (signal.aborted || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))) return new LocalMcpError('timeout');
  const code = systemCodeOf(error);
  if (code !== undefined && START_WORDS[code] !== undefined) return new LocalMcpError('unreachable', `The program could not be started. ${START_WORDS[code]}.`);
  if (error instanceof SdkError) {
    if (error.code === SdkErrorCode.RequestTimeout) return new LocalMcpError('timeout');
    if (error.code === SdkErrorCode.ConnectionClosed || error.code === SdkErrorCode.SendFailed) {
      const said = lastWords();
      return new LocalMcpError('unreachable', `The program ended before it answered.${said === '' ? '' : ` It said on its standard error: ${said}`}`);
    }
    return new LocalMcpError('protocol');
  }
  if (error instanceof ProtocolError) return new LocalMcpError('protocol');
  return error;
}

/**
 * Whether a value fits a schema. A schema that cannot be compiled (a keyword nobody knows how to check, a reference that leads nowhere) fits
 * nothing: what cannot be checked is not sent, and not believed. A validator for each check, since the one the SDK offers keeps every schema it has seen for ever.
 */
function fits(schema: Readonly<Record<string, unknown>>, value: unknown): boolean {
  try {
    return new AjvJsonSchemaValidator().getValidator(schema)(value).valid;
  } catch {
    return false;
  }
}

function toLocalTool(tool: Awaited<ReturnType<Client['listTools']>>['tools'][number]): LocalTool {
  const annotations = tool.annotations;
  return {
    name: tool.name,
    title: tool.title ?? annotations?.title ?? null,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema as Record<string, unknown>,
    outputSchema: (tool.outputSchema as Record<string, unknown> | undefined) ?? null,
    hints: {
      ...(annotations?.readOnlyHint === undefined ? {} : { readOnly: annotations.readOnlyHint }),
      ...(annotations?.destructiveHint === undefined ? {} : { destructive: annotations.destructiveHint }),
      ...(annotations?.idempotentHint === undefined ? {} : { idempotent: annotations.idempotentHint }),
      ...(annotations?.openWorldHint === undefined ? {} : { openWorld: annotations.openWorldHint }),
    },
  };
}

type ToolResult = Awaited<ReturnType<Client['callTool']>>;

/** What the tool said, as the text the model will be shown: its words, and a note for what a model is not given (pictures, sound, files). */
function textOf(result: ToolResult): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const words = blocks.map((block) => {
    switch (block.type) {
      case 'text':
        return block.text;
      case 'resource':
        return 'text' in block.resource ? block.resource.text : '[a binary resource was left out]';
      case 'image':
        return '[an image was left out]';
      case 'audio':
        return '[a sound was left out]';
      case 'resource_link':
        return '[a link to a resource was left out]';
      default:
        return '[content this client does not read was left out]';
    }
  });
  // A tool that gives structured content is to give it as text as well; one that does not has it written out.
  if (!blocks.some((block) => block.type === 'text') && result.structuredContent !== undefined) words.push(JSON.stringify(result.structuredContent));
  return words.join('\n');
}

/**
 * Starts local MCP servers and speaks to them with the official SDK (`@modelcontextprotocol/client`), over their standard input and output.
 * Each session is one program, started for it and ended with it: nothing is kept running between requests, so nothing a program leaves
 * behind can be of one request's to the next, and a program that is stuck costs one request and no more.
 *
 * It speaks the 2025 handshake (the SDK's default). The negotiation that also reaches servers of the 2026 revision starts the program a
 * second time, to probe it, which a program with side effects at start should not be asked to bear; what a runner needs of a server (its
 * tools, and calling one) is the same in both.
 */
export function createStdioMcpClient(): LocalMcpClient {
  return {
    async open(launch: LocalLaunch, signal: AbortSignal): Promise<LocalMcpSession> {
      const ownFolder = launch.cwd === undefined;
      const cwd = launch.cwd ?? (await mkdtemp(join(tmpdir(), 'escritoriio-mcp-')));
      const transport = new StdioClientTransport({ command: launch.command, args: [...launch.args], env: { ...launch.env }, cwd, stderr: 'pipe' });
      // Nobody reads what a program writes on its standard error, and one that fills its pipe stops: it is read, and the end of it kept.
      let said = '';
      transport.stderr?.on('data', (chunk: Buffer) => {
        said = `${said}${chunk.toString('utf8')}`.slice(-LAST_WORDS_CHARS * 4);
      });
      const lastWords = (): string => toOneLine(said).slice(-LAST_WORDS_CHARS);
      const client = new Client(CLIENT_INFO, { listMaxPages: LIST_MAX_PAGES });

      let ended: Promise<void> | undefined;
      const close = (): Promise<void> =>
        (ended ??= (async () => {
          await client.close().catch(() => undefined);
          if (ownFolder) await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
        })());

      try {
        await before(signal, client.connect(transport, { signal, timeout: REQUEST_TIMEOUT_MS }), close);
      } catch (error) {
        await close();
        throw failureOf(error, signal, lastWords);
      }

      return {
        serverName: (client.getServerVersion()?.name ?? '').slice(0, MCP_LIMITS.serverName),
        async listTools(listSignal) {
          try {
            const { tools } = await before(listSignal, client.listTools(undefined, { signal: listSignal, timeout: REQUEST_TIMEOUT_MS }), close);
            return tools.map(toLocalTool);
          } catch (error) {
            throw failureOf(error, listSignal, lastWords);
          }
        },
        async callTool(call: LocalCall, callSignal): Promise<LocalAnswer> {
          // The arguments are what a model made of a person's words and of whatever it read: they leave only if they are what the tool was approved to take.
          if (!fits(call.inputSchema, call.arguments)) throw new LocalMcpError('bad-arguments');
          let result: ToolResult;
          try {
            // The definition handed over is the approved one, not whatever the session cached, so that what the answer is checked against is what its owner saw.
            result = await before(
              callSignal,
              client.callTool({ name: call.name, arguments: call.arguments as Record<string, unknown> }, { signal: callSignal, timeout: REQUEST_TIMEOUT_MS, toolDefinition: { name: call.name, inputSchema: call.inputSchema as { type: 'object' } } }),
              close,
            );
          } catch (error) {
            throw failureOf(error, callSignal, lastWords);
          }
          const isError = result.isError === true;
          if (!isError && call.outputSchema !== null && (result.structuredContent === undefined || !fits(call.outputSchema, result.structuredContent))) throw new LocalMcpError('bad-answer');
          return { text: textOf(result), isError };
        },
        close,
      };
    },
  };
}
