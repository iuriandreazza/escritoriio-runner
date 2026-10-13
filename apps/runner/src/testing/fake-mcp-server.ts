import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * A local MCP server for the tests of the runner, written by hand so that it needs nothing installed beside it: it speaks the plain
 * JSON-RPC of the 2025 revision on its standard input and output, one message to a line, and does the awkward things real ones do.
 * What it is made to do is in FAKE_MCP, a JSON text:
 *   noise     text it writes to its standard output, which is not a message, before it answers anything
 *   tools     the tools to list instead of the usual ones (name, description, inputSchema, outputSchema)
 *   answers   what a tool answers instead of what it does, by the name of the tool
 *   crashOn   the name of a tool that ends the program instead of answering
 * and in FAKE_MCP_PIDS, a file it writes its process number to, so that a test can tell whether it was left running.
 */
const config = JSON.parse(process.env.FAKE_MCP ?? '{}') as { noise?: string; tools?: unknown[]; answers?: Record<string, string>; crashOn?: string };
if (process.env.FAKE_MCP_PIDS) appendFileSync(process.env.FAKE_MCP_PIDS, `${process.pid}\n`);
if (config.noise) process.stdout.write(`${config.noise}\n`);

const USUAL_TOOLS = [
  { name: 'echo', description: 'Says back what it is given.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'environment', description: 'Says the value of one variable of its environment.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'where', description: 'Says the folder it runs in.', inputSchema: { type: 'object' } },
  { name: 'hang', description: 'Never answers.', inputSchema: { type: 'object' } },
  { name: 'flood', description: 'Answers with far more than a result may be.', inputSchema: { type: 'object' } },
  { name: 'structured', description: 'Answers with a number.', inputSchema: { type: 'object' }, outputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } },
];
const tools = config.tools ?? USUAL_TOOLS;

const send = (message: object): void => void process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id: unknown, result: object): void => send({ jsonrpc: '2.0', id, result });
const text = (words: string, extra: object = {}): object => ({ content: [{ type: 'text', text: words }], ...extra });

function call(name: string, args: Record<string, unknown>): object | undefined {
  if (name === config.crashOn) process.exit(3);
  const fixed = config.answers?.[name];
  if (fixed !== undefined) return text(fixed);
  switch (name) {
    case 'echo':
      return text(`echo: ${String(args.text)}`);
    case 'environment':
      return text(String(process.env[String(args.name)] ?? '(not set)'));
    case 'where':
      return text(process.cwd());
    case 'hang':
      return undefined;
    case 'flood':
      return text('x'.repeat(200_000));
    case 'structured':
      return text('three', { structuredContent: args.wrong === true ? { n: 'three' } : { n: 3 } });
    default:
      return text(`did ${name}`);
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message: { id?: unknown; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> } };
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  switch (message.method) {
    case 'initialize':
      return reply(message.id, { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'Fake notes', version: '1.0.0' } });
    case 'tools/list':
      return reply(message.id, { tools });
    case 'tools/call': {
      const answer = call(String(message.params?.name), message.params?.arguments ?? {});
      return answer === undefined ? undefined : reply(message.id, answer);
    }
    default:
      return send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
