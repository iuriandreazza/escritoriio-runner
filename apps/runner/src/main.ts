import { resolve } from 'node:path';
import { version } from '../package.json';
import type { RunEnd } from './application/connection-view.ts';
import type { LocalMcpClient } from './application/mcp-ports.ts';
import type { Question } from './application/mcp-servers.ts';
import { describeFolderChoice, SHARE_FOLDER_PROMPT } from './application/folders.ts';
import { describeDoctor } from './application/doctor.ts';
import { describeLocalPause } from './application/local-pause.ts';
import { describePairNotice, describePairQuestion } from './application/pair-machine.ts';
import type { OfficeProbe, Terminal } from './application/ports.ts';
import { describeStatus, describeTaskNote } from './application/status.ts';
import type { CodingAgents, Isolation } from './application/task-ports.ts';
import { createTerminalApprovals } from './application/terminal-approvals.ts';
import { isYes } from './domain/answer.ts';
import { plainText } from './domain/plain-text.ts';
import type { Command } from './infrastructure/command-line.ts';
import { parseCommandLine, USAGE } from './infrastructure/command-line.ts';
import type { Confirmations, Runner } from './runner.ts';
import { createRunner } from './runner.ts';

export interface CliEnvironment {
  readonly terminal: Terminal;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Where a path that is not a full one begins: the folder the command was run in. */
  readonly cwd?: string;
  /** What stands in for the coding agents and for git, for the tests of what runs a task. */
  readonly agents?: CodingAgents;
  readonly isolation?: Isolation;
  /** What stands in for the programs of the MCP servers, for the tests of what asks them for something. */
  readonly mcp?: LocalMcpClient;
  /** What stands in for the office when it is asked whether it is there, for the tests of `doctor`. */
  readonly office?: OfficeProbe;
}

const USAGE_ERROR = 2;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What is asked at the terminal: each question after showing what it is about, and anything but a yes is a no, or a person who pressed Enter would have agreed to what they did not read. `yes` is for a person who already said so. */
function terminalConfirmations(terminal: Terminal, yes: boolean): Confirmations {
  const asked = async (question: Question): Promise<boolean> => {
    for (const line of question.lines) terminal.out(line);
    terminal.out('');
    return yes || isYes(await terminal.ask(question.prompt));
  };
  return {
    pair: async (question) => {
      if (yes) {
        terminal.out(describePairNotice(question));
        return true;
      }
      return isYes(await terminal.ask(`${describePairQuestion(question)} [y/N] `));
    },
    shareFolder: (question) => asked({ lines: describeFolderChoice(question), prompt: SHARE_FOLDER_PROMPT }),
    setUpMcpServer: asked,
    approveMcpTool: asked,
  };
}

/** The command line of the runner, with its adapters put together: what it prints goes to the terminal, and the exit code is what it gives back. */
export async function runCli(argv: readonly string[], environment: CliEnvironment): Promise<number> {
  const { terminal, env } = environment;
  const parsed = parseCommandLine(argv);
  if (!parsed.ok) {
    terminal.err(`${parsed.error}\n\n${USAGE}`);
    return USAGE_ERROR;
  }
  const { command } = parsed;
  if (command.name === 'help') {
    terminal.out(USAGE);
    return 0;
  }
  if (command.name === 'version') {
    terminal.out(version);
    return 0;
  }

  let runner: Runner;
  try {
    runner = await createRunner({
      env,
      confirmations: terminalConfirmations(terminal, 'yes' in command && command.yes),
      approvals: createTerminalApprovals(terminal),
      agents: environment.agents,
      isolation: environment.isolation,
      mcp: environment.mcp,
      office: environment.office,
    });
  } catch (error) {
    terminal.err(messageOf(error));
    return 1;
  }

  runner.events.subscribe((event) => {
    if (event.kind === 'status') terminal.out(describeStatus(event.status));
    else if (event.kind === 'task') terminal.out(describeTaskNote(event.note));
    else if (event.kind === 'notice') terminal.out(event.message);
    else if (event.kind === 'problem') terminal.err(event.message);
    else terminal.out(`connecting to ${event.host} as "${event.deviceName}"`);
  });

  const cwd = environment.cwd ?? process.cwd();
  const lines = (said: readonly string[]): void => {
    for (const line of said) terminal.out(line);
  };

  /** The programs of the MCP servers answer to Ctrl-C like everything else the runner starts. */
  async function withInterrupt<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const stopping = new AbortController();
    const stopListening = terminal.onInterrupt(() => stopping.abort());
    try {
      return await work(stopping.signal);
    } finally {
      stopListening();
    }
  }

  async function pair(command: Extract<Command, { name: 'pair' }>): Promise<number> {
    const outcome = await runner.pairing.pair({ input: command.input, deviceName: command.deviceName });
    if (!outcome.paired) {
      terminal.err('Not paired.');
      return 1;
    }
    terminal.out(`Paired with ${outcome.agentName} of ${outcome.workspaceName} at ${outcome.host}. This machine is called "${outcome.deviceName}".`);
    terminal.out('Connect it with: escritoriio-runner start');
    return 0;
  }

  async function start(): Promise<number> {
    const stopListening = terminal.onInterrupt(() => {
      if (runner.tasks.runningTaskId) terminal.out('stopping: the task that runs is being stopped first');
      runner.connection.stop();
    });
    let end: RunEnd;
    try {
      end = await runner.connection.start();
    } finally {
      stopListening();
    }
    if (end.reason === 'stopped') {
      terminal.out('stopped');
      return 0;
    }
    terminal.err(end.reason === 'not-paired' ? 'This machine is not paired. Pair it with: escritoriio-runner pair <server> <code>' : end.message);
    return 1;
  }

  async function status(): Promise<number> {
    lines(await runner.describePairing());
    try {
      lines(await runner.describeMachine());
      return 0;
    } catch (error) {
      terminal.err(messageOf(error));
      return 1;
    }
  }

  async function doctor(): Promise<number> {
    const report = await runner.doctor();
    lines(describeDoctor(report));
    return report.healthy ? 0 : 1;
  }

  async function foldersAdd(command: Extract<Command, { name: 'folders-add' }>): Promise<number> {
    const { name: _name, yes: _yes, ...choice } = command;
    const outcome = await runner.folders.add({ ...choice, path: resolve(cwd, command.path) });
    if (!outcome.added) {
      terminal.err('Not shared.');
      return 1;
    }
    terminal.out(`Shared as "${outcome.folder.label}". A runner that is running takes it up at its next task.`);
    return 0;
  }

  async function foldersNew(command: Extract<Command, { name: 'folders-new' }>): Promise<number> {
    const outcome = await runner.folders.createWorkspace({ parent: resolve(cwd, command.parent), name: command.folderName, label: command.label, approval: command.approval, trusted: command.trusted, agent: command.agent });
    if (!outcome.added) {
      terminal.err('Not made.');
      return 1;
    }
    terminal.out(`Made the workspace "${outcome.folder.label}" and shared it. A runner that is running takes it up at its next task.`);
    return 0;
  }

  async function mcpAdd(command: Extract<Command, { name: 'mcp-add' }>): Promise<number> {
    const outcome = await runner.mcp.add(command);
    if (!outcome.added) {
      terminal.err('Not set up.');
      return 1;
    }
    terminal.out(`Set up as "${outcome.label}". Nothing of it is available to the office until you approve its tools: escritoriio-runner mcp approve ${outcome.label}`);
    terminal.out('A runner that is running tells the office of it when it connects again: stop it with Ctrl-C and start it again.');
    return 0;
  }

  async function mcpApprove(command: Extract<Command, { name: 'mcp-approve' }>): Promise<number> {
    const outcome = await withInterrupt((signal) => runner.mcp.approve(command.label, command.tools, signal));
    if (outcome.waiting === 0) terminal.out('Every tool of that server is approved already. Name the ones to ask about again, or: escritoriio-runner mcp tools <label>');
    else terminal.out(outcome.approved.length === 0 ? 'Nothing was approved.' : `Approved: ${outcome.approved.map((name) => plainText(name, 64)).join(', ')}. The office uses them as they are described, for as long as the server does not change them.`);
    return 0;
  }

  async function pauseOrResume(paused: boolean): Promise<number> {
    lines(describeLocalPause(paused, await runner.pause.set(paused)));
    return 0;
  }

  try {
    switch (command.name) {
      case 'status':
        return await status();
      case 'doctor':
        return await doctor();
      case 'pair':
        return await pair(command);
      case 'start':
        return await start();
      case 'folders-add':
        return await foldersAdd(command);
      case 'folders-new':
        return await foldersNew(command);
      case 'folders-list':
        lines(await runner.folders.describe());
        return 0;
      case 'folders-remove': {
        const removed = await runner.folders.remove(command.label);
        terminal.out(`Stopped sharing "${removed.label}". A task that is running in it is not stopped: pause the machine for that (escritoriio-runner pause).`);
        return 0;
      }
      case 'agents':
        lines(await runner.agents.describe());
        return 0;
      case 'agents-set-path': {
        const detection = await runner.agents.setPath(command.kind, command.path);
        terminal.out(`${command.kind} will be looked for at ${command.path}.${detection.loggedIn === false ? ' Nobody is logged in to it yet: log in to it, as you do when you use it yourself.' : ''}`);
        return 0;
      }
      case 'agents-clear-path':
        terminal.out((await runner.agents.clearPath(command.kind)) ? `${command.kind} will be found by itself again.` : `There was no path kept for ${command.kind}.`);
        return 0;
      case 'run':
        return await runner.runByHand(command, terminal);
      case 'mcp-add':
        return await mcpAdd(command);
      case 'mcp-list':
        lines(await runner.mcp.describe());
        return 0;
      case 'mcp-tools':
        lines(await withInterrupt((signal) => runner.mcp.describeTools(command.label, signal)));
        return 0;
      case 'mcp-approve':
        return await mcpApprove(command);
      case 'mcp-deny': {
        const denied = await runner.mcp.deny(command.label, command.tools);
        terminal.out(`The office cannot use ${denied.map((name) => plainText(name, 64)).join(', ')} any more, until you approve ${denied.length === 1 ? 'it' : 'them'} again.`);
        return 0;
      }
      case 'mcp-remove': {
        const removed = await runner.mcp.remove(command.label);
        terminal.out(`Stopped using "${removed.label}". A request that is running is not stopped: pause the machine for that (escritoriio-runner pause).`);
        return 0;
      }
      case 'pause':
        return await pauseOrResume(true);
      case 'resume':
        return await pauseOrResume(false);
    }
  } catch (error) {
    terminal.err(messageOf(error));
    return 1;
  }
}
