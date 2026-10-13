import type { CodingAgentKind, JournalEntry } from '@escritoriio/runner-protocol';
import type { AllowedFolder, Surroundings } from '../domain/folder-policy.ts';
import type { ApprovalAnswer, ApprovalPort, ApprovalRequest, CloneApprovalRequest } from './approvals.ts';
import type { GitSettingsReport } from '../domain/git-settings.ts';
import type { TaskSink } from './task-service.ts';
import type { AgentDetection, AgentEvent, AgentRequest, CodingAgent, FolderResolver, GitSettingsScan, IsolatedFolder, Isolation, JournalRecord, JournalStore, PolicyEdit, PolicyStore, RunnerPolicy, SweepReport, TaskLock } from './task-ports.ts';
import { EMPTY_POLICY, IsolationError } from './task-ports.ts';

export const surroundings: Surroundings = {
  home: '/Users/ana',
  stateDirectory: '/Users/ana/Library/Application Support/escritoriio-runner',
  worktreesDirectory: '/Users/ana/Library/Caches/escritoriio-runner/worktrees',
  windows: false,
};

export const site: AllowedFolder = {
  label: 'site',
  path: '/Users/ana/work/site',
  realPath: '/Users/ana/work/site',
  access: 'edit',
  approval: 'auto',
  isolation: 'worktree',
  trusted: false,
  agent: null,
};

/** A folder the owner made empty for the agent to build in. */
export const build: AllowedFolder = {
  label: 'build',
  path: '/Users/ana/work/build',
  realPath: '/Users/ana/work/build',
  access: 'edit',
  approval: 'auto',
  isolation: 'in-place',
  trusted: false,
  agent: null,
  kind: 'workspace',
};

export class FakePolicyStore implements PolicyStore {
  policy: RunnerPolicy;
  /** How many times a change kept something. */
  writes = 0;

  constructor(policy: RunnerPolicy = { ...EMPTY_POLICY, folders: [site] }) {
    this.policy = policy;
  }

  load(): Promise<RunnerPolicy> {
    return Promise.resolve(this.policy);
  }

  update<T>(change: (current: RunnerPolicy) => PolicyEdit<T>): Promise<T> {
    try {
      const { policy, result } = change(this.policy);
      if (policy !== this.policy) this.writes += 1;
      this.policy = policy;
      return Promise.resolve(result);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/** The file system, which answers for each path where it really is: itself, unless a test says a link or a move put it elsewhere. */
export class FakeResolver implements FolderResolver {
  readonly answers = new Map<string, string | null>();

  resolve(path: string): Promise<string | undefined> {
    const answer = this.answers.get(path);
    return Promise.resolve(answer === null ? undefined : (answer ?? path));
  }
}

export interface MadeIsolation {
  readonly folder: AllowedFolder;
  readonly taskId: string;
  finished: boolean;
  discarded: boolean;
}

export class FakeIsolation implements Isolation {
  readonly made: MadeIsolation[] = [];
  /** The folders it was asked about, and what it says of them: nothing when a copy of them can be made. */
  readonly checked: AllowedFolder[] = [];
  checkResult: string | undefined;
  /** Making the copy, or keeping the work, goes on until it is told to stop, as a git command that does not end would. */
  prepareHangs = false;
  finishHangs = false;
  /** How many times it was asked to clean up, and what that is said to have come to. */
  sweeps = 0;
  sweepResult: SweepReport = { copies: 0, branches: 0 };
  refuseWith: Error | undefined;
  /** What `finish` says the work came to. */
  result: { readonly branch: string | null; readonly diffStat: string | null } = { branch: 'escritoriio/task', diffStat: ' README.md | 2 +-' };
  finishFails: Error | undefined;

  sweep(): Promise<SweepReport> {
    this.sweeps += 1;
    return Promise.resolve(this.sweepResult);
  }

  check(folder: AllowedFolder): Promise<string | undefined> {
    this.checked.push(folder);
    return Promise.resolve(this.checkResult);
  }

  prepare(folder: AllowedFolder, taskId: string, signal: AbortSignal): Promise<IsolatedFolder> {
    if (this.refuseWith) return Promise.reject(this.refuseWith);
    const made: MadeIsolation = { folder, taskId, finished: false, discarded: false };
    this.made.push(made);
    const isolated: IsolatedFolder = {
      folder: `${surroundings.worktreesDirectory}/${taskId}`,
      finish: (finishSignal) => {
        if (this.finishHangs) return untilStopped(finishSignal, 'The work could not be kept (git was stopped).');
        made.finished = true;
        return this.finishFails ? Promise.reject(this.finishFails) : Promise.resolve(this.result);
      },
      discard: () => {
        made.discarded = true;
        return Promise.resolve();
      },
    };
    return this.prepareHangs ? untilStopped(signal, 'A copy of that folder for this task could not be made (git was stopped).') : Promise.resolve(isolated);
  }
}

/** Waits until the signal aborts, and then fails as an isolation does when git is stopped. */
function untilStopped<T>(signal: AbortSignal, message: string): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    const stop = (): void => reject(new IsolationError(message));
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
}

export class MemoryJournalStore implements JournalStore {
  records: readonly JournalRecord[] = [];
  failToSave: Error | undefined;

  load(): Promise<readonly JournalRecord[]> {
    return Promise.resolve(this.records);
  }

  save(records: readonly JournalRecord[]): Promise<void> {
    if (this.failToSave) return Promise.reject(this.failToSave);
    this.records = records;
    return Promise.resolve();
  }

  get entries(): JournalEntry[] {
    return this.records.map((record) => record.entry);
  }
}

export const detected: AgentDetection = { installed: true, path: '/usr/local/bin/claude', version: '2.1.250', loggedIn: true, supported: true, problem: undefined, containment: 'sandbox' };

/** A coding agent that does what a test says it does, and remembers what it was asked. */
export class FakeAgent implements CodingAgent {
  readonly kind: CodingAgentKind;
  /** Whether it takes the tools of a workspace. */
  workspaceTools = false;
  detection: AgentDetection = detected;
  readonly requests: AgentRequest[] = [];
  readonly detects: (string | undefined)[] = [];
  /** What it says and does: given the request and the signal, the events in order. */
  script: (request: AgentRequest, signal: AbortSignal) => AsyncIterable<AgentEvent> = async function* () {
    yield { kind: 'result', text: 'Done.' };
  };

  constructor(kind: CodingAgentKind = 'claude-code') {
    this.kind = kind;
  }

  detect(executable: string | undefined): Promise<AgentDetection> {
    this.detects.push(executable);
    return Promise.resolve(this.detection);
  }

  run(request: AgentRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.requests.push(request);
    return this.script(request, signal);
  }
}

/** A sink that writes down what happened to a task, in order. */
export class RecordingSink implements TaskSink {
  readonly told: { readonly what: string; readonly value?: unknown }[] = [];

  accepted(): void {
    this.told.push({ what: 'accepted' });
  }

  rejected(reason: string, message: string): void {
    this.told.push({ what: 'rejected', value: { reason, message } });
  }

  event(event: unknown): void {
    this.told.push({ what: 'event', value: event });
  }

  done(done: unknown): void {
    this.told.push({ what: 'done', value: done });
  }

  failed(failed: unknown): void {
    this.told.push({ what: 'failed', value: failed });
  }

  get kinds(): string[] {
    return this.told.map((entry) => entry.what);
  }

  of(what: string): unknown[] {
    return this.told.filter((entry) => entry.what === what).map((entry) => entry.value);
  }
}

/** The lock of the machine's one task, in memory: held by this test, by another process (`heldElsewhere`), or unable to be asked (`failWith`). */
export class FakeTaskLock implements TaskLock {
  heldElsewhere = false;
  failWith: Error | undefined;
  acquired = 0;
  released = 0;

  /** Whether this lock was taken and not given back. */
  get held(): boolean {
    return this.acquired > this.released;
  }

  acquire(): Promise<(() => Promise<void>) | undefined> {
    if (this.failWith) return Promise.reject(this.failWith);
    if (this.heldElsewhere || this.held) return Promise.resolve(undefined);
    this.acquired += 1;
    return Promise.resolve(() => {
      this.released += 1;
      return Promise.resolve();
    });
  }
}

/** The owner of the machine, played by a test: it sees what it is asked, and answers when the test says, or is told to stop. */
export class FakeApprovals implements ApprovalPort {
  readonly requests: ApprovalRequest[] = [];
  /** How many of the questions were taken away because the task ended. */
  taken = 0;
  private answer: ((answer: ApprovalAnswer) => void) | undefined;

  ask(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer> {
    this.requests.push(request);
    return new Promise((resolve) => {
      this.answer = resolve;
      signal.addEventListener('abort', () => {
        this.taken += 1;
        resolve('denied');
      }, { once: true });
    });
  }

  answerWith(answer: ApprovalAnswer): void {
    this.answer?.(answer);
  }

  readonly cloneRequests: CloneApprovalRequest[] = [];
  private cloneAnswer: ((answer: ApprovalAnswer) => void) | undefined;
  clonesTaken = 0;

  askToClone(request: CloneApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer> {
    this.cloneRequests.push(request);
    return new Promise((resolve) => {
      this.cloneAnswer = resolve;
      signal.addEventListener('abort', () => {
        this.clonesTaken += 1;
        resolve('denied');
      }, { once: true });
    });
  }

  answerCloneWith(answer: ApprovalAnswer): void {
    this.cloneAnswer?.(answer);
  }

  get waiting(): boolean {
    return this.requests.length > this.taken && this.answer !== undefined;
  }
}

/** What a scan of the repositories of a folder says it took away. */
export class FakeGitSettingsScan implements GitSettingsScan {
  report: GitSettingsReport = { findings: [], incomplete: [] };
  /** What the record of before comes to: nothing, for a scan that cannot make one. */
  baseline: object | undefined = { recorded: true };
  readonly recorded: string[] = [];
  readonly scanned: string[] = [];
  readonly signals: AbortSignal[] = [];
  readonly baselines: (object | undefined)[] = [];
  /** The order things happened in, with the agent's run. */
  readonly order: string[] = [];

  snapshot(root: string): Promise<object | undefined> {
    this.recorded.push(root);
    this.order.push('snapshot');
    return Promise.resolve(this.baseline);
  }

  scan(root: string, signal: AbortSignal, baseline: object | undefined): Promise<GitSettingsReport> {
    this.scanned.push(root);
    this.signals.push(signal);
    this.baselines.push(baseline);
    this.order.push('scan');
    return Promise.resolve(this.report);
  }
}
