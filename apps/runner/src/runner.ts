import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { CodingAgentKind } from '@escritoriio/runner-protocol';
import { version } from '../package.json';
import type { AgentView } from './application/agents.ts';
import { clearAgentPath, describeAgents, inspectAgents, setAgentPath } from './application/agents.ts';
import type { ApprovalPort } from './application/approvals.ts';
import type { ConnectionView, RunEnd } from './application/connection-view.ts';
import { deviceView, initialConnectionView, nextConnectionView, sameConnectionView } from './application/connection-view.ts';
import type { DoctorReport } from './application/doctor.ts';
import { runDoctor } from './application/doctor.ts';
import type { Followable, Subscribable } from './application/feed.ts';
import { Emitter, Feed } from './application/feed.ts';
import type { AddFolderOutcome, FolderChanges, FolderQuestion, FolderView, NewFolder, NewWorkspace, UpdateFolderOutcome } from './application/folders.ts';
import { addFolder, createWorkspace, describeFolders, inspectFolders, removeFolder, updateFolder } from './application/folders.ts';
import { setLocalPause } from './application/local-pause.ts';
import { McpRequests } from './application/mcp-requests.ts';
import type { LocalMcpClient, McpServerStore } from './application/mcp-ports.ts';
import type { ApproveOutcome, McpServersDeps, McpServerView, McpToolView, NewMcpServer, Question } from './application/mcp-servers.ts';
import { addMcpServer, approveMcpTools, denyMcpTools, describeMcpServers, inspectMcpServers, inspectMcpTools, listMcpTools, removeMcpServer } from './application/mcp-servers.ts';
import type { OwnerTask } from './application/owner-run.ts';
import { runByHand } from './application/owner-run.ts';
import type { PairOutcome, PairQuestion } from './application/pair-machine.ts';
import { pairMachine } from './application/pair-machine.ts';
import { PauseWatcher } from './application/pause-watcher.ts';
import type { ConnectionLock, DeviceStore, OfficeProbe, SystemInfo, Terminal } from './application/ports.ts';
import { RunnerConnection } from './application/runner-connection.ts';
import type { RunnerStatus } from './application/status.ts';
import { describeMachine, describePairing } from './application/status.ts';
import { describeSweep, sweepWhatWasLeft } from './application/sweep.ts';
import { TaskBoard } from './application/task-board.ts';
import type { TasksView } from './application/task-board.ts';
import { TaskJournal } from './application/task-journal.ts';
import type { AgentDetection, CodingAgents, FolderResolver, GitSettingsScan, Isolation, JournalStore, PolicyStore, TaskLock } from './application/task-ports.ts';
import { EMPTY_POLICY } from './application/task-ports.ts';
import type { WorkspaceOps } from './application/workspace-ports.ts';
import type { TaskNote } from './application/task-service.ts';
import { TaskService } from './application/task-service.ts';
import type { AllowedFolder, Surroundings } from './domain/folder-policy.ts';
import { serverHost } from './domain/paired-device.ts';
import { plainText } from './domain/plain-text.ts';
import { createCodingAgents } from './infrastructure/coding-agents.ts';
import { createFileConnectionLock } from './infrastructure/file-connection-lock.ts';
import { createFileDeviceStore, stateDirectory, worktreesDirectory } from './infrastructure/file-device-store.ts';
import { createFileJournalStore } from './infrastructure/file-journal-store.ts';
import { createFileMcpStore } from './infrastructure/file-mcp-store.ts';
import { createFilePolicyStore } from './infrastructure/file-policy-store.ts';
import { createFileTaskLock } from './infrastructure/file-task-lock.ts';
import { createGitIsolation } from './infrastructure/git-isolation.ts';
import { createGitSettingsScan } from './infrastructure/git-settings-scan.ts';
import { createHttpOfficeProbe } from './infrastructure/http-office-probe.ts';
import { createHttpPairingApi } from './infrastructure/http-pairing-api.ts';
import { createMachineInventory } from './infrastructure/machine-inventory.ts';
import { realPathOfNearest, realPathResolver } from './infrastructure/real-path-resolver.ts';
import { runProcess } from './infrastructure/run-process.ts';
import { sha256 } from './infrastructure/sha256.ts';
import { createStdioMcpClient } from './infrastructure/stdio-mcp-client.ts';
import { createWorkspaceOps } from './infrastructure/workspace-files.ts';
import { OwnerError } from './application/owner-error.ts';
import { createSystemInfo } from './infrastructure/system-info.ts';
import { createSystemScheduler } from './infrastructure/system-scheduler.ts';
import { webSocketFactory } from './infrastructure/ws-socket.ts';

export const RUNNER_VERSION: string = version;

type Environment = Readonly<Record<string, string | undefined>>;

/** What the owner is asked before something is kept: each is shown what the choice means and answers yes or no. A no keeps nothing. */
export interface Confirmations {
  /** Before a pairing code is used up: who the machine would work for, from the office's own words. */
  pair(question: PairQuestion): Promise<boolean>;
  shareFolder(question: FolderQuestion): Promise<boolean>;
  setUpMcpServer(question: Question): Promise<boolean>;
  approveMcpTool(question: Question): Promise<boolean>;
}

/** What each of the places that embed the runner supplies: the command line, and the app. */
export interface RunnerOptions {
  /** What the runner was started with: it decides where the settings are kept, and only what a program needs of it reaches a coding agent. */
  readonly env: Environment;
  readonly confirmations: Confirmations;
  /** Where a task of a folder that asks before each task is approved. Without it such a task is refused. */
  readonly approvals?: ApprovalPort;
  /** Where the token is kept. The file in the state directory when there is none: an app keeps it in the keychain of the system. */
  readonly devices?: DeviceStore;
  /** What stands in for the coding agents, for git, for the programs of MCP servers and for the office, for the tests of what uses them. */
  readonly agents?: CodingAgents;
  readonly isolation?: Isolation;
  readonly workspace?: WorkspaceOps;
  readonly settingsScan?: GitSettingsScan;
  readonly mcp?: LocalMcpClient;
  readonly office?: OfficeProbe;
}

/** What happens that the one who embeds the runner may want to show, apart from the state it can read. */
export type RunnerEvent =
  /** The connection is being made, to this office, as this device. */
  | { readonly kind: 'connecting'; readonly host: string; readonly deviceName: string }
  | { readonly kind: 'status'; readonly status: RunnerStatus }
  | { readonly kind: 'task'; readonly note: TaskNote }
  /** Something the runner did for the owner that they may like to know. */
  | { readonly kind: 'notice'; readonly message: string }
  /** Something went wrong that is not the end of a task, in words. */
  | { readonly kind: 'problem'; readonly message: string };

export interface ConnectionControl extends Followable<ConnectionView> {
  /**
   * Connects and stays connected, until it is stopped or the office says to stop. Gives how it ended. Only one runner of this machine is connected at
   * a time: when another process (the command line, or the app) is, this gives `already-running` and does not take the connection from it.
   * Throws, with words, when the settings of the machine cannot be read.
   */
  start(): Promise<RunEnd>;
  /** Stops what runs, hangs up, and lets `start` end with `stopped`. */
  stop(): void;
}

export interface TasksControl extends Followable<TasksView> {
  /** Cancels the task that runs, if it is that one. */
  cancel(taskId: string): boolean;
  /** The task this process is working on, from the moment it takes it. */
  readonly runningTaskId: string | undefined;
}

export interface FoldersControl {
  list(): Promise<readonly FolderView[]>;
  describe(): Promise<readonly string[]>;
  /** The path must be a full one. The owner is asked, with what the choice means, before anything is kept. */
  add(request: NewFolder): Promise<AddFolderOutcome>;
  /**
   * Makes an empty folder, `name`, inside `parent` (a full path the owner chose, which must be there) and shares it as a workspace: edited in place,
   * where the agent makes folders without asking and asks to clone repositories that the owner approves one by one. The owner is asked, with what
   * that means, before anything is made. Throws, with words, when the name or the place is refused or the folder is there already.
   */
  createWorkspace(request: NewWorkspace): Promise<AddFolderOutcome>;
  remove(label: string): Promise<AllowedFolder>;
  /** Changes how a folder is shared, with the same checks and the same question as sharing it. */
  update(label: string, changes: FolderChanges): Promise<UpdateFolderOutcome>;
}

export interface AgentsControl {
  inspect(): Promise<readonly AgentView[]>;
  describe(): Promise<readonly string[]>;
  setPath(kind: CodingAgentKind, path: string): Promise<AgentDetection>;
  /** False when there was no path kept. */
  clearPath(kind: CodingAgentKind): Promise<boolean>;
}

export interface PauseControl {
  /** Pauses or resumes the machine on the machine itself. False when it was so already. A runner that is connected hears it at once. */
  set(paused: boolean): Promise<boolean>;
}

export interface McpControl {
  list(): Promise<readonly McpServerView[]>;
  describe(): Promise<readonly string[]>;
  add(request: NewMcpServer): Promise<{ readonly added: false } | { readonly added: true; readonly label: string }>;
  /** Gives the label it had. */
  remove(label: string): Promise<{ readonly label: string }>;
  /** Starts the server, asks it for its tools and ends it: each with where it stands against what the owner approved. */
  tools(label: string, signal: AbortSignal): Promise<{ readonly label: string; readonly tools: readonly McpToolView[] }>;
  describeTools(label: string, signal: AbortSignal): Promise<readonly string[]>;
  /** The owner approves the tools named, or those that are new or changed when none is named, each after being shown it. */
  approve(label: string, tools: readonly string[], signal: AbortSignal): Promise<ApproveOutcome>;
  deny(label: string, tools: readonly string[]): Promise<readonly string[]>;
}

export interface PairingControl {
  /** Who the machine is paired with, or nothing. Never the token. */
  current(): Promise<ConnectionView['device']>;
  /**
   * Pairs with the AI member a code was made for: asks the office who the code is for, asks the owner (`confirmations.pair`) and only on a yes
   * uses the code up. Not while connected. Throws, with words, when the input is not a pairing, or the office refuses or cannot be reached.
   */
  pair(request: { readonly input: readonly string[]; readonly deviceName?: string }): Promise<PairOutcome>;
}

/** The runner of this machine, as whoever embeds it holds it: state to read and follow, and the owner's own actions. */
export interface Runner {
  readonly version: string;
  /** Where the settings are kept. */
  readonly stateDirectory: string;
  readonly events: Subscribable<RunnerEvent>;
  readonly connection: ConnectionControl;
  readonly tasks: TasksControl;
  readonly folders: FoldersControl;
  readonly agents: AgentsControl;
  readonly pause: PauseControl;
  readonly mcp: McpControl;
  readonly pairing: PairingControl;
  /** Everything a person would otherwise look at one by one, said in words and scrubbed of what looks like a secret. */
  doctor(): Promise<DoctorReport>;
  /** The lines of `status` about the pairing, and about the machine (which throws, with words, when its settings cannot be read). */
  describePairing(): Promise<readonly string[]>;
  describeMachine(): Promise<readonly string[]>;
  /** A task given at a terminal, by hand and without the office: the same rules as one the office offers. Gives an exit code. */
  runByHand(task: OwnerTask, terminal: Terminal): Promise<number>;
}

interface Machine {
  readonly system: SystemInfo;
  readonly devices: DeviceStore;
  readonly policy: PolicyStore;
  readonly mcpStore: McpServerStore;
  readonly mcp: LocalMcpClient;
  readonly journalStore: JournalStore;
  readonly resolver: FolderResolver;
  readonly surroundings: Surroundings;
  readonly agents: CodingAgents;
  readonly isolation: Isolation;
  readonly workspace: WorkspaceOps;
  readonly settingsScan: GitSettingsScan;
  readonly taskLock: TaskLock;
  readonly connectionLock: ConnectionLock;
  readonly stateDirectory: string;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const NOT_PAIRED = 'This machine is not paired with an AI member yet.';
const CONNECTED_ELSEWHERE = 'Another runner of this machine is connected to the office already (the app, or the command line). Only one connects at a time: stop that one first.';
const CONNECTING_HERE = 'This runner is connecting already.';

/** The places of this machine the runner keeps away from folders that are shared, as the file system names them (links followed, so that a folder is judged against what it really is). */
async function placesOf(env: Environment): Promise<Surroundings> {
  const platform = process.platform;
  try {
    const home = await realPathOfNearest(homedir());
    const state = await realPathOfNearest(resolve(stateDirectory({ platform, env, home })));
    const copies = await realPathOfNearest(resolve(worktreesDirectory({ platform, env, home, state })));
    // Where the coding agent keeps its login when that is not under home: a folder shared from there would hand it over.
    const claudeConfig = env.CLAUDE_CONFIG_DIR;
    const claudeConfigDirectory = claudeConfig && isAbsolute(claudeConfig) ? await realPathOfNearest(claudeConfig).catch(() => undefined) : undefined;
    return { home, stateDirectory: state, worktreesDirectory: copies, claudeConfigDirectory, windows: platform === 'win32' };
  } catch (error) {
    throw new Error(`The runner’s own folders cannot be set up: ${messageOf(error)}`, { cause: error });
  }
}

/**
 * Where the runner keeps its settings, for `env`, as the file system names it. An app that keeps the token somewhere of its own needs it
 * to open that place before the runner is made, and it is the same one the runner then uses.
 */
export async function resolveStateDirectory(env: Environment): Promise<string> {
  return (await placesOf(env)).stateDirectory;
}

/** The adapters of this machine, put together. */
async function assemble({ env, devices, agents, isolation, workspace, settingsScan, mcp }: RunnerOptions): Promise<Machine> {
  const surroundings = await placesOf(env);
  const state = surroundings.stateDirectory;
  return {
    system: createSystemInfo(),
    devices: devices ?? createFileDeviceStore(state),
    policy: createFilePolicyStore(state),
    mcpStore: createFileMcpStore(state),
    mcp: mcp ?? createStdioMcpClient(),
    journalStore: createFileJournalStore(state),
    resolver: realPathResolver,
    surroundings,
    agents: agents ?? createCodingAgents(),
    isolation: isolation ?? createGitIsolation({ surroundings, exec: runProcess, environment: env }),
    workspace: workspace ?? createWorkspaceOps({ surroundings, exec: runProcess, environment: env }),
    settingsScan: settingsScan ?? createGitSettingsScan({ exec: runProcess, environment: env, windows: surroundings.windows, neutralDirectory: join(state, 'neutral') }),
    taskLock: createFileTaskLock(state),
    connectionLock: createFileConnectionLock(state),
    stateDirectory: state,
  };
}

/**
 * Puts the runner together for this machine: the command line and the app both begin here, and differ only in what they supply (where the
 * token is kept, where the owner is asked, where a task is approved) and in how they show what the runner says. The settings are the ones
 * of the machine, in one state directory, so that whoever embeds the runner works under the same folders, the same pause and the same
 * one task at a time.
 */
export async function createRunner(options: RunnerOptions): Promise<Runner> {
  const machine = await assemble(options);
  const { system, devices, policy, mcpStore, mcp, journalStore, resolver, surroundings, agents, isolation, workspace, settingsScan, taskLock, connectionLock } = machine;
  const { env, confirmations, approvals } = options;
  const scheduler = createSystemScheduler();
  const officeProbe = options.office ?? createHttpOfficeProbe();
  const inventory = createMachineInventory({ policy, mcp: mcpStore, agents });

  // What draws a window must never be what stops a task. A listener of the events that throws is ignored, since telling it as a problem would be
  // telling that same listener; one of the views is told as a problem, which the events carry.
  const events = new Emitter<RunnerEvent>();
  const notice = (message: string): void => events.emit({ kind: 'notice', message });
  const problem = (message: string): void => events.emit({ kind: 'problem', message });
  const onListenerError = (error: unknown): void => problem(`A screen of the runner failed: ${plainText(messageOf(error))}`);

  const initialDevice = await devices.load().catch(() => undefined);
  const initialPolicy = await policy.load().catch(() => EMPTY_POLICY);
  const view = new Feed<ConnectionView>(initialConnectionView(initialDevice ? deviceView(initialDevice) : null, initialPolicy.paused), onListenerError);
  const happened = (event: Parameters<typeof nextConnectionView>[1]): void => {
    const next = nextConnectionView(view.current, event);
    if (!sameConnectionView(view.current, next)) view.set(next);
  };

  const board = new TaskBoard(onListenerError);
  board.remember((await journalStore.load().catch(() => [])).map((record) => record.entry));

  const journalFor = (): TaskJournal => new TaskJournal(journalStore, scheduler.now, (error) => problem(`What the runner remembers of its tasks could not be kept: ${plainText(messageOf(error))}`));

  /** Housekeeping before a task is run by this process: not a reason for one not to be, so a clean-up that fails is said and gone on from. */
  async function sweep(): Promise<void> {
    try {
      const report = await sweepWhatWasLeft({ lock: taskLock, isolation });
      const said = report && describeSweep(report);
      if (said) notice(said);
    } catch (error) {
      problem(`Cleaning up what an earlier run left behind failed: ${plainText(messageOf(error))}`);
    }
  }

  /** Looks for the owner's own pause, which may be set from another process, while tasks may be running. */
  function watchPause(onChange: (paused: boolean) => void): PauseWatcher {
    return new PauseWatcher({
      policy,
      scheduler,
      onChange: (paused) => {
        happened({ kind: 'paused-here', paused });
        onChange(paused);
      },
      onError: (error) => problem(`${messageOf(error)} Until it is mended, the machine keeps the pause it had, and no task is taken.`),
    });
  }

  const mcpServers: McpServersDeps = { store: mcpStore, client: mcp, hash: sha256, policy, resolver, surroundings, parentEnvironment: env };

  const aiMember = async (): Promise<string | undefined> => (await devices.load().catch(() => undefined))?.agentName;

  // --- the connection -------------------------------------------------------------------------------------------

  interface Active {
    readonly connection: RunnerConnection;
    readonly tasks: TaskService;
    readonly watcher: PauseWatcher | undefined;
  }
  let active: Active | undefined;
  let starting = false;
  /** A stop asked for while the connection was being got ready, which there is nothing to stop yet: it is looked for after each step. */
  let stopRequested = false;

  async function start(): Promise<RunEnd> {
    if (starting || active) return { reason: 'already-running', message: CONNECTING_HERE };
    starting = true;
    stopRequested = false;
    let release: (() => Promise<void>) | undefined;
    let watcher: PauseWatcher | undefined;
    const stoppedBeforeItBegan = (): RunEnd | undefined => {
      if (!stopRequested) return undefined;
      const end: RunEnd = { reason: 'stopped' };
      happened({ kind: 'ended', end });
      return end;
    };
    try {
      const device = await devices.load();
      if (!device) {
        const end: RunEnd = { reason: 'not-paired', message: NOT_PAIRED };
        happened({ kind: 'ended', end });
        return end;
      }
      happened({ kind: 'pairing', device: deviceView(device) });
      release = await connectionLock.acquire();
      if (!release) {
        const end: RunEnd = { reason: 'already-running', message: CONNECTED_ELSEWHERE };
        happened({ kind: 'ended', end });
        return end;
      }
      happened({ kind: 'starting' });
      const stoppedEarly = stoppedBeforeItBegan();
      if (stoppedEarly) return stoppedEarly;
      // Settings that cannot be read are found out here, with their own words, and not by a connection that is cut again and again.
      const settings = await policy.load();
      const journal = journalFor();
      await journal.open();
      board.remember(journal.entries());
      if (stopRequested) return stoppedBeforeItBegan()!;
      await sweep();
      if (stopRequested) return stoppedBeforeItBegan()!;
      const tasks = new TaskService({
        policy,
        resolver,
        isolation,
        lock: taskLock,
        agents,
        journal,
        scheduler,
        surroundings,
        parentEnvironment: env,
        report: (note) => events.emit({ kind: 'task', note }),
        approvals,
        observer: board,
        workspace,
        settingsScan,
      });
      const connection = new RunnerConnection({
        device,
        runnerVersion: version,
        os: system.os(),
        sockets: webSocketFactory,
        scheduler,
        inventory,
        tasks,
        mcp: new McpRequests({
          store: mcpStore,
          policy,
          resolver,
          surroundings,
          client: mcp,
          scheduler,
          hash: sha256,
          parentEnvironment: env,
          onError: (error) => problem(`a request for an MCP server met a mistake of the runner: ${plainText(messageOf(error))}`),
        }),
        journal,
        report: (status) => {
          happened({ kind: 'status', status });
          events.emit({ kind: 'status', status });
        },
      });
      watcher = watchPause((paused) => connection.localPauseChanged(paused));
      active = { connection, tasks, watcher };
      events.emit({ kind: 'connecting', host: serverHost(device.server), deviceName: device.deviceName });
      watcher.start(settings.paused);
      const end = await connection.start();
      happened({ kind: 'ended', end });
      return end;
    } finally {
      watcher?.stop();
      active = undefined;
      starting = false;
      await release?.().catch(() => undefined);
    }
  }

  const connection: ConnectionControl = {
    get current() {
      return view.current;
    },
    subscribe: (listener) => view.subscribe(listener),
    start,
    stop: () => {
      if (active) active.connection.stop();
      else if (starting) stopRequested = true;
    },
  };

  const tasks: TasksControl = {
    get current() {
      return board.current;
    },
    subscribe: (listener) => board.subscribe(listener),
    cancel: (taskId) => active?.tasks.cancel(taskId) ?? false,
    get runningTaskId() {
      return active?.tasks.runningTask;
    },
  };

  // --- what the owner decides on the machine --------------------------------------------------------------------

  const foldersDeps = { policy, resolver, surroundings, isolation, agents };
  const folders: FoldersControl = {
    list: () => inspectFolders(foldersDeps),
    describe: () => describeFolders(foldersDeps),
    add: async (request) => addFolder(foldersDeps, request, await aiMember(), confirmations.shareFolder),
    createWorkspace: async (request) => createWorkspace({ ...foldersDeps, workspace }, request, await aiMember(), confirmations.shareFolder),
    remove: (label) => removeFolder(foldersDeps, label),
    update: async (label, changes) => updateFolder(foldersDeps, label, changes, await aiMember(), confirmations.shareFolder),
  };

  const agentsDeps = { policy, agents, windows: surroundings.windows };
  const agentsControl: AgentsControl = {
    inspect: () => inspectAgents(agentsDeps),
    describe: () => describeAgents(agentsDeps),
    setPath: (kind, path) => setAgentPath(agentsDeps, kind, path),
    clearPath: (kind) => clearAgentPath(agentsDeps, kind),
  };

  const pause: PauseControl = {
    async set(paused) {
      const changed = await setLocalPause(policy, paused);
      happened({ kind: 'paused-here', paused });
      await active?.watcher?.checkNow();
      return changed;
    },
  };

  const mcpControl: McpControl = {
    list: () => inspectMcpServers(mcpServers),
    describe: () => describeMcpServers(mcpServers),
    add: async (request) => {
      const outcome = await addMcpServer(mcpServers, request, confirmations.setUpMcpServer);
      return outcome.added ? { added: true, label: outcome.server.label } : { added: false };
    },
    remove: async (label) => ({ label: (await removeMcpServer(mcpServers, label)).label }),
    tools: (label, signal) => inspectMcpTools(mcpServers, label, signal),
    describeTools: (label, signal) => listMcpTools(mcpServers, label, signal),
    approve: (label, named, signal) => approveMcpTools(mcpServers, label, named, signal, confirmations.approveMcpTool),
    deny: (label, named) => denyMcpTools(mcpServers, label, named),
  };

  const pairing: PairingControl = {
    async current() {
      const device = await devices.load().catch(() => undefined);
      return device ? deviceView(device) : null;
    },
    async pair(request) {
      if (active || starting) throw new OwnerError('Stop the connection before this machine is paired again.');
      const outcome = await pairMachine({ pairing: createHttpPairingApi(), devices, system, runnerVersion: version }, { ...request, confirm: confirmations.pair });
      if (outcome.paired) happened({ kind: 'pairing', device: { host: outcome.host, deviceName: outcome.deviceName, agentName: outcome.agentName, workspaceName: outcome.workspaceName } });
      return outcome;
    },
  };

  return {
    version,
    stateDirectory: machine.stateDirectory,
    events,
    connection,
    tasks,
    folders,
    agents: agentsControl,
    pause,
    mcp: mcpControl,
    pairing,
    doctor: () => runDoctor({ policy, resolver, surroundings, agents, devices, probe: officeProbe, runnerVersion: version, os: system.os() }),
    describePairing: async () => describePairing(await devices.load()),
    describeMachine: async () => describeMachine(await inventory.read()),
    async runByHand(task, terminal) {
      await sweep();
      // Notes of the tasks are for a runner that is connected: one given by hand is told at the terminal, as it goes.
      // A clone that the agent of a workspace asks for is approved at the same terminal, whoever began the task.
      const service = new TaskService({ policy, resolver, isolation, lock: taskLock, agents, journal: journalFor(), scheduler, surroundings, parentEnvironment: env, report: () => undefined, approvals, workspace, settingsScan });
      // A pause that the owner sets from another process stops this task, as it stops one that the office gave.
      const watcher = watchPause((paused) => service.localPauseChanged(paused));
      watcher.start((await policy.load()).paused);
      try {
        return await runByHand({ service, policy, terminal, newTaskId: () => `local-${randomUUID()}` }, task);
      } finally {
        watcher.stop();
      }
    },
  };
}
