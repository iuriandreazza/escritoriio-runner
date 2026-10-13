import { parseArgs } from 'node:util';
import type { CodingAgentKind } from '@escritoriio/runner-protocol';
import { CODING_AGENT_KINDS } from '@escritoriio/runner-protocol';
import type { FolderAccess, FolderApproval, FolderIsolation } from '../domain/folder-policy.ts';

export type Command =
  | { readonly name: 'help' }
  | { readonly name: 'version' }
  | { readonly name: 'status' }
  | { readonly name: 'doctor' }
  | { readonly name: 'start' }
  | { readonly name: 'pair'; readonly input: readonly string[]; readonly deviceName: string | undefined; readonly yes: boolean }
  | {
      readonly name: 'folders-add';
      readonly path: string;
      readonly label: string | undefined;
      readonly access: FolderAccess;
      readonly approval: FolderApproval;
      readonly isolation: FolderIsolation;
      readonly trusted: boolean;
      readonly agent: CodingAgentKind | null;
      readonly yes: boolean;
    }
  | {
      readonly name: 'folders-new';
      readonly parent: string;
      readonly folderName: string;
      readonly label: string | undefined;
      readonly approval: FolderApproval;
      readonly trusted: boolean;
      readonly agent: CodingAgentKind | null;
      readonly yes: boolean;
    }
  | { readonly name: 'folders-list' }
  | { readonly name: 'folders-remove'; readonly label: string }
  | { readonly name: 'agents' }
  | { readonly name: 'agents-set-path'; readonly kind: CodingAgentKind; readonly path: string }
  | { readonly name: 'agents-clear-path'; readonly kind: CodingAgentKind }
  | { readonly name: 'run'; readonly folder: string; readonly instruction: string; readonly agent: CodingAgentKind | null; readonly approve: boolean }
  | { readonly name: 'mcp-add'; readonly label: string; readonly command: string; readonly args: readonly string[]; readonly env: readonly string[]; readonly folder: string | null; readonly yes: boolean }
  | { readonly name: 'mcp-list' }
  | { readonly name: 'mcp-tools'; readonly label: string }
  | { readonly name: 'mcp-approve'; readonly label: string; readonly tools: readonly string[]; readonly yes: boolean }
  | { readonly name: 'mcp-deny'; readonly label: string; readonly tools: readonly string[] }
  | { readonly name: 'mcp-remove'; readonly label: string }
  | { readonly name: 'pause' }
  | { readonly name: 'resume' };

export type CommandLine = { readonly ok: true; readonly command: Command } | { readonly ok: false; readonly error: string };

export const USAGE = `Usage:
  escritoriio-runner pair <server> <code> [--name <device name>] [--yes]
  escritoriio-runner pair <pairing link> [--name <device name>] [--yes]
  escritoriio-runner start
  escritoriio-runner status
  escritoriio-runner doctor
  escritoriio-runner folders add <path> [--label <name>] [--access read-only|edit] [--approval auto|ask]
                                        [--isolation worktree|in-place] [--trusted] [--agent <kind>] [--yes]
  escritoriio-runner folders new <parent folder> <name> [--label <name>] [--approval auto|ask] [--trusted]
                                        [--agent <kind>] [--yes]
  escritoriio-runner folders list
  escritoriio-runner folders remove <label>
  escritoriio-runner agents
  escritoriio-runner agents set-path <kind> <path>
  escritoriio-runner agents clear-path <kind>
  escritoriio-runner run <folder label> [--agent <kind>] [--approve] [--] <instruction>
  escritoriio-runner mcp add <label> [--env NAME=value]... [--folder <label>] [--yes] -- <program> [arguments]
  escritoriio-runner mcp list
  escritoriio-runner mcp tools <label>
  escritoriio-runner mcp approve <label> [<tool>...] [--yes]
  escritoriio-runner mcp deny <label> <tool>...
  escritoriio-runner mcp remove <label>
  escritoriio-runner pause
  escritoriio-runner resume
  escritoriio-runner --help | --version

Commands:
  pair               Pair this machine with an AI member of an office. The office shows the code and
                     the link under My machines. It asks before it uses the code.
  start              Connect to the office and stay connected, until stopped with Ctrl-C. Tasks from
                     the office run on this machine, in the folders you share, under your rules.
  status             Show who this machine is paired with, whether it is paused, the folders it
                     shares and the coding agents it found.
  doctor             Check everything this machine needs: the coding agents (found, logged in, contained),
                     whether the office can be reached, the folders, the clock and the version. It says in
                     words what is wrong, leaves out anything that looks like a key or a token, and ends
                     with 1 if something fails.
  folders add        Share a folder with the office. It says what your choices mean and asks before
                     it keeps them. Nothing is shared until you do this.
  folders new        Make a new, empty folder called <name> inside <parent folder> and share it as a workspace,
                     where the agent builds: it works in place, may make folders there without asking, and may
                     ask to clone git repositories, each of which you approve on this machine. It says what that
                     means and asks before it makes anything.
  folders list       Show the folders that are shared, how each is shared, and whether it is where
                     it was.
  folders remove     Stop sharing a folder, by its label.
  agents             Show the coding agents: whether each is installed and logged in, and what
                     contains it.
  agents set-path    Tell the runner where a coding agent is, when it does not find it by itself.
  agents clear-path  Go back to finding the coding agent by itself.
  run                Run one task by hand, with no office, in a folder you share. The rules are the
                     same as for a task from the office. Ctrl-C stops it. Ends with 0 only if the
                     work was done.
  mcp add            Set up an MCP server that runs on this machine, for your AI member to use. What it runs, its
                     arguments and its environment are written here and are never told to the office: it is
                     told the label, and the tools you approve. It shows what this means and asks before it
                     keeps anything. Nothing is available to the office until you approve its tools.
  mcp list           Show the MCP servers that are set up, what each runs and which of its tools are approved.
  mcp tools          Start a server and show which tools it lists, and which of them are approved.
  mcp approve        Show each tool of a server that is new or has changed, as the server describes it, and
                     ask whether the office may use it. Name tools to be asked about those. A tool that
                     changes after you approved it is not used until you approve it again.
  mcp deny           Take the approval of tools back.
  mcp remove         Stop using a server, by its label.
  pause              Pause this machine: it takes no task, and a task that runs is stopped.
  resume             Lift the pause you set on this machine.

Options of pair:
  --name <name>   What the office calls this machine. The name of the machine by default.
  --yes, -y       Do not ask for a confirmation.

Options of mcp add (the program goes after two dashes, so that its own options are its own):
  --env NAME=value  An environment variable for the program, as many as you like. The values stay on this machine,
                    and are taken out of what the program says before it is sent to the office. A program is given
                    nothing else of this runner's environment but what it needs to find its files. Keys go here and
                    not in the arguments: only these values are taken out.
  --folder <label>  Run it in one of the folders you share (escritoriio-runner folders list), as long as it is where it was.
                    By default it runs in a folder of its own that is empty. The program is not contained either way: it
                    runs as your user.
  --yes, -y         Do not ask for a confirmation. What the choice means is still shown.

Options of mcp approve:
  --yes, -y         Do not ask about each tool. Each one is still shown, as the server describes it.

Options of folders add (nothing is shared more than you choose: the defaults are the narrowest):
  --label <name>  What the office calls the folder: a name, not a path. The name of the folder by default.
  --access        read-only (the default) lets a coding agent read the folder, and run nothing; edit lets it read
                  and change files, and run commands in a shell, inside the sandbox of your operating system (no
                  network, the places where credentials are kept are hidden, but it can read most of the rest of
                  this machine).
  --approval      auto (the default) runs your requests without asking each time; ask holds each task
                  until you approve its exact text on this machine.
  --isolation     worktree (the default) works on a copy of the files on a branch of its own, and needs a
                  git repository; in-place works on the files in the folder themselves.
  --trusted       A coding agent that cannot be contained on this system may run in this folder.
  --agent <kind>  The coding agent to use when a task does not ask for one (claude-code).
  --yes, -y       Do not ask for a confirmation. What the choices mean is still shown.

Options of run (they go before the instruction):
  --agent <kind>  The coding agent to use, instead of the folder's own.
  --approve       You approve this task already, for a folder that asks before each one.
  The instruction begins at its first word, and everything from there on is the instruction, words that
  begin with a dash included: run site explain the -v flag. Put -- before an instruction that begins with a dash.

The settings are kept in a folder of this program in the settings of your user. Set
ESCRITORIIO_RUNNER_HOME to keep them in another folder.`;

const OPTIONS_OF: Readonly<Record<string, readonly string[]>> = {
  pair: ['name', 'yes'],
  'folders add': ['label', 'access', 'approval', 'isolation', 'trusted', 'agent', 'yes'],
  'folders new': ['label', 'approval', 'trusted', 'agent', 'yes'],
  run: ['agent', 'approve'],
  'mcp add': ['env', 'folder', 'yes'],
  'mcp approve': ['yes'],
};

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

function oneOf<T extends string>(option: string, value: string | undefined, allowed: readonly T[], fallback: T): Parsed<T> {
  if (value === undefined) return { ok: true, value: fallback };
  const found = allowed.find((candidate) => candidate === value);
  return found === undefined ? { ok: false, error: `--${option} is one of: ${allowed.join(', ')}` } : { ok: true, value: found };
}

const agentKind = (option: string, value: string | undefined): Parsed<CodingAgentKind | null> => (value === undefined ? { ok: true, value: null } : oneOf<CodingAgentKind>(option, value, CODING_AGENT_KINDS, 'claude-code'));

const failure = (error: string): CommandLine => ({ ok: false, error });
const command = (value: Command): CommandLine => ({ ok: true, command: value });

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  name: { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  label: { type: 'string' },
  access: { type: 'string' },
  approval: { type: 'string' },
  isolation: { type: 'string' },
  trusted: { type: 'boolean' },
  agent: { type: 'string' },
  approve: { type: 'boolean' },
  env: { type: 'string', multiple: true },
  folder: { type: 'string' },
} as const;

/**
 * Where the instruction of `run` begins: at the first word after the label of the folder. What it says is what the person typed, and a
 * word that looks like an option (`-v`, `-h`, `--approve`) is part of it, as it is in `run site explain the -v flag`. The options of
 * `run` are for before it. Everything from there is given back as it was typed, and the rest is what is read as options.
 */
function splitInstruction(argv: readonly string[]): { readonly options: readonly string[]; readonly instruction: readonly string[] } {
  // Read loosely, only to find where the third word is (the command, the label, the first word of the instruction): a word that is not an option of any command is a mistake for the second reading to say.
  const { tokens } = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: false, tokens: true });
  const words = tokens.filter((token) => token.kind === 'positional');
  const first = words[2];
  if (words[0]?.value !== 'run' || first === undefined) return { options: argv, instruction: [] };
  return { options: argv.slice(0, first.index), instruction: argv.slice(first.index) };
}

/**
 * Where the program of `mcp add` begins: after the first two dashes. What it says is what the person typed, and a word that looks like an option
 * (`-y`, `--stdio`, `--yes`) is the program's own. Without the two dashes there is no telling an option of this command from an argument of the
 * program, so they are asked for. What comes before them is read as options.
 */
function splitProgram(argv: readonly string[]): { readonly options: readonly string[]; readonly program: readonly string[] | undefined } {
  const { tokens } = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: false, tokens: true });
  const words = tokens.filter((token) => token.kind === 'positional');
  const end = tokens.find((token) => token.kind === 'option-terminator');
  if (words[0]?.value !== 'mcp' || words[1]?.value !== 'add' || !end) return { options: argv, program: undefined };
  return { options: argv.slice(0, end.index), program: argv.slice(end.index + 1) };
}

export function parseCommandLine(argv: readonly string[]): CommandLine {
  const { options: untilProgram, program } = splitProgram(argv);
  const { options, instruction: instructionWords } = splitInstruction(untilProgram);
  let parsed;
  try {
    parsed = parseArgs({ args: [...options], allowPositionals: true, options: OPTIONS });
  } catch (error) {
    return failure(error instanceof Error ? error.message : 'The command line could not be read');
  }

  const { values, positionals } = parsed;
  if (values.help) return command({ name: 'help' });
  if (values.version) return command({ name: 'version' });
  const [first, ...rest] = positionals;
  if (first === undefined) return command({ name: 'help' });

  const [second, ...afterSecond] = rest;
  const subcommand = ['folders', 'agents', 'mcp'].includes(first) && second !== undefined ? `${first} ${second}` : first;
  const given = Object.keys(values).filter((option) => values[option as keyof typeof values] !== undefined);
  const refused = given.find((option) => !(OPTIONS_OF[subcommand] ?? []).includes(option));
  if (refused !== undefined) {
    const owners = Object.entries(OPTIONS_OF).filter(([, options]) => options.includes(refused)).map(([owner]) => owner);
    return failure(`--${refused} is ${owners.length === 0 ? 'not an option of any command' : `an option of ${owners.join(' and ')}`}, not of ${subcommand}`);
  }

  const nothingMore = (extra: readonly string[]): CommandLine | undefined => (extra.length > 0 ? failure(`${subcommand} takes nothing more`) : undefined);
  const needs = (what: string): CommandLine => failure(`${subcommand} needs ${what}`);

  switch (subcommand) {
    case 'pair':
      return command({ name: 'pair', input: rest, deviceName: values.name, yes: values.yes ?? false });
    case 'start':
    case 'status':
    case 'doctor':
    case 'agents':
    case 'pause':
    case 'resume':
      return nothingMore(rest) ?? command({ name: subcommand });
    case 'folders list':
      return nothingMore(afterSecond) ?? command({ name: 'folders-list' });
    case 'folders remove': {
      const [label, ...extra] = afterSecond;
      return label === undefined ? needs('the label of the folder') : (nothingMore(extra) ?? command({ name: 'folders-remove', label }));
    }
    case 'folders add': {
      const [path, ...extra] = afterSecond;
      if (path === undefined) return needs('the path of the folder');
      const access = oneOf<FolderAccess>('access', values.access, ['read-only', 'edit'], 'read-only');
      const approval = oneOf<FolderApproval>('approval', values.approval, ['auto', 'ask'], 'auto');
      const isolation = oneOf<FolderIsolation>('isolation', values.isolation, ['worktree', 'in-place'], 'worktree');
      const agent = agentKind('agent', values.agent);
      if (!access.ok) return failure(access.error);
      if (!approval.ok) return failure(approval.error);
      if (!isolation.ok) return failure(isolation.error);
      if (!agent.ok) return failure(agent.error);
      return (
        nothingMore(extra) ??
        command({ name: 'folders-add', path, label: values.label, access: access.value, approval: approval.value, isolation: isolation.value, trusted: values.trusted ?? false, agent: agent.value, yes: values.yes ?? false })
      );
    }
    case 'folders new': {
      const [parent, folderName, ...extra] = afterSecond;
      if (parent === undefined || folderName === undefined) return needs('the folder to make it in and the name of the new folder: folders new <parent folder> <name>');
      const approval = oneOf<FolderApproval>('approval', values.approval, ['auto', 'ask'], 'auto');
      const agent = agentKind('agent', values.agent);
      if (!approval.ok) return failure(approval.error);
      if (!agent.ok) return failure(agent.error);
      return nothingMore(extra) ?? command({ name: 'folders-new', parent, folderName, label: values.label, approval: approval.value, trusted: values.trusted ?? false, agent: agent.value, yes: values.yes ?? false });
    }
    case 'mcp add': {
      const [label, ...extra] = afterSecond;
      if (label === undefined) return needs('a label, and what to run after two dashes: mcp add <label> -- <program> [arguments]');
      if (extra.length > 0) return failure('mcp add takes one label before the two dashes');
      const [executable, ...args] = program ?? [];
      if (program === undefined) return failure('mcp add needs two dashes before the program to run: mcp add <label> -- <program> [arguments]');
      if (executable === undefined) return needs('what to run after the two dashes: mcp add <label> -- <program> [arguments]');
      return command({ name: 'mcp-add', label, command: executable, args, env: values.env ?? [], folder: values.folder ?? null, yes: values.yes ?? false });
    }
    case 'mcp list':
      return nothingMore(afterSecond) ?? command({ name: 'mcp-list' });
    case 'mcp tools':
    case 'mcp remove': {
      const [label, ...extra] = afterSecond;
      if (label === undefined) return needs('the label of the server');
      return nothingMore(extra) ?? command({ name: subcommand === 'mcp tools' ? 'mcp-tools' : 'mcp-remove', label });
    }
    case 'mcp approve': {
      const [label, ...tools] = afterSecond;
      return label === undefined ? needs('the label of the server') : command({ name: 'mcp-approve', label, tools, yes: values.yes ?? false });
    }
    case 'mcp deny': {
      const [label, ...tools] = afterSecond;
      if (label === undefined) return needs('the label of the server and the tools to take the approval back of');
      return tools.length === 0 ? needs('the tools to take the approval back of') : command({ name: 'mcp-deny', label, tools });
    }
    case 'agents set-path':
    case 'agents clear-path': {
      const [named, ...more] = afterSecond;
      if (named === undefined) return needs(`the coding agent: ${CODING_AGENT_KINDS.join(', ')}`);
      const kind = CODING_AGENT_KINDS.find((candidate) => candidate === named);
      if (kind === undefined) return failure(`${subcommand} takes one of: ${CODING_AGENT_KINDS.join(', ')}`);
      if (subcommand === 'agents clear-path') return nothingMore(more) ?? command({ name: 'agents-clear-path', kind });
      const [path, ...extra] = more;
      return path === undefined ? needs('the full path of the program') : (nothingMore(extra) ?? command({ name: 'agents-set-path', kind, path }));
    }
    case 'run': {
      const [folder, ...more] = rest;
      // Said without quotes, an instruction is still one: its words are put back together as they were typed.
      const instruction = [...more, ...instructionWords].join(' ').trim();
      if (folder === undefined || instruction === '') return needs('the label of a folder and an instruction: run <folder label> "<instruction>"');
      const agent = agentKind('agent', values.agent);
      return agent.ok ? command({ name: 'run', folder, instruction, agent: agent.value, approve: values.approve ?? false }) : failure(agent.error);
    }
    default:
      if (first === 'folders') return failure('folders takes add, new, list or remove');
      if (first === 'agents') return failure('agents takes nothing, or set-path or clear-path');
      if (first === 'mcp') return failure('mcp takes add, list, tools, approve, deny or remove');
      return failure(`"${first}" is not a command of the runner`);
  }
}
