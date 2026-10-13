import type { CodingAgentKind, RunnerToServer, TaskDone, TaskEvent, TaskFailed, TaskFailure, TaskOffer, TaskRejection } from '@escritoriio/runner-protocol';
import { TASK_LIMITS, toOneLine } from '@escritoriio/runner-protocol';
import { childEnvironment } from '../domain/child-environment.ts';
import { DESCRIBE_FOLDER_PROBLEM, isConsistentWorkspace, isWorkspace, problemWithFolder } from '../domain/folder-policy.ts';
import { summarizeGitSettings } from '../domain/git-settings.ts';
import { redactUrls } from '../domain/redact-urls.ts';
import type { AllowedFolder, Surroundings } from '../domain/folder-policy.ts';
import { cleanText, hasHiddenCharacters } from '../domain/clean-text.ts';
import { placesOf, redactPaths } from '../domain/redact.ts';
import { effectiveCeilings, OutputBudget } from '../domain/task-limits.ts';
import type { ApprovalAnswer, ApprovalPort } from './approvals.ts';
import { APPROVAL_WAIT_MS } from './approvals.ts';
import { answerWithin, bounded } from './bounded.ts';
import type { Scheduler } from './ports.ts';
import type { TaskJournal } from './task-journal.ts';
import type { AgentDetection, AgentEvent, CodingAgent, CodingAgents, FolderResolver, GitSettingsBaseline, GitSettingsScan, IsolatedFolder, Isolation, PolicyStore, TaskLock } from './task-ports.ts';
import { IsolationError } from './task-ports.ts';
import type { WorkspaceOps, WorkspaceTools } from './workspace-ports.ts';
import { createWorkspaceTools } from './workspace-session.ts';

/** What the machine is asked to do, whoever asks: the office, or its owner at the terminal. */
export interface TaskRequest {
  readonly taskId: string;
  /** The label of one of the folders its owner allowed. */
  readonly folder: string;
  /** The coding agent asked for; null for the folder's own default. */
  readonly agent: CodingAgentKind | null;
  readonly instruction: string;
  readonly maxSeconds?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
}

/** Where what happens to a task is told: the office over its connection, or the owner's terminal. */
export interface TaskSink {
  accepted(): void;
  rejected(reason: TaskRejection, message: string): void;
  event(event: TaskEvent): void;
  done(done: Omit<TaskDone, 'taskId'>): void;
  failed(failed: Omit<TaskFailed, 'taskId'>): void;
}

/** What the runner writes down of its tasks for its owner to read: states and counts, never what was asked or what came of it. */
export type TaskNote =
  | { readonly kind: 'accepted'; readonly taskId: string }
  | { readonly kind: 'rejected'; readonly taskId: string; readonly reason: TaskRejection }
  | { readonly kind: 'waiting-for-approval'; readonly taskId: string }
  | { readonly kind: 'ended'; readonly taskId: string; readonly outcome: 'done' | TaskFailure; readonly durationMs: number };

/** What a screen that shows the tasks is told as they go. It hears what the office hears, and nothing is kept of it by the service. */
export interface TaskObserver {
  began(task: { readonly taskId: string; readonly folder: string; readonly startedAt: number }): void;
  said(taskId: string, event: TaskEvent): void;
  /** Whether the task waits for its owner to approve it. */
  approval(taskId: string, waiting: boolean): void;
  ended(taskId: string, ending: { readonly done: Omit<TaskDone, 'taskId'> } | { readonly failed: Omit<TaskFailed, 'taskId'> }): void;
}

export interface TaskServiceDeps {
  readonly policy: PolicyStore;
  readonly resolver: FolderResolver;
  readonly isolation: Isolation;
  /** One task at a time across the processes of the runner on this machine, which the check of this one is not enough for. */
  readonly lock: TaskLock;
  readonly agents: CodingAgents;
  readonly journal: TaskJournal;
  readonly scheduler: Scheduler;
  readonly surroundings: Surroundings;
  /** What the runner itself was started with: only what `childEnvironment` lets through reaches a coding agent. */
  readonly parentEnvironment: Readonly<Record<string, string | undefined>>;
  readonly report: (note: TaskNote) => void;
  /** Where a task of a folder that asks before each one is approved. Without it such a task is refused, since nobody can be asked. */
  readonly approvals?: ApprovalPort | undefined;
  readonly observer?: TaskObserver | undefined;
  /** What makes the folders and the clones that the agent of a workspace asks for. Without it an agent works in a workspace with no such tools. */
  readonly workspace?: WorkspaceOps | undefined;
  /** Looks, after a task that worked in place, for what it left in git repositories that would run programs. */
  readonly settingsScan?: GitSettingsScan | undefined;
}

/** How long the look at the repositories of a folder may take after a task: the task has ended, and its owner is waiting to be told. */
export const SCAN_MS = 60_000;

/** How long a coding agent has, once it was told to stop, to be gone: past this the task is given up on, and whatever it left is its adapter's to have cleaned. */
export const ABORT_GRACE_MS = 10_000;

/** How long making the copy of a folder may take, and how long keeping the work of a task may: each has a time of its own, apart from the ceiling of the task. */
export const PREPARE_COPY_MS = 5 * 60_000;
export const KEEP_WORK_MS = 2 * 60_000;

interface Running {
  readonly taskId: string;
  readonly controller: AbortController;
  /** When the office was told it was taken, which is before it began when its owner is asked first. */
  acceptedAt: number | undefined;
  /** Why it was told to stop, the first time it was. */
  why: TaskFailure | undefined;
  /** Gives up the lock of the machine's one task, once it was taken. */
  releaseLock: (() => Promise<void>) | undefined;
  stop(why: TaskFailure): void;
}

const HIDDEN_IN_INSTRUCTION = 'The instruction contains characters that cannot be seen, so the task was not taken.';
const NOT_ALLOWED_FOLDER = 'That folder is not one this machine shares.';
const EDIT_NEEDS_A_SANDBOX = 'A task in a folder that is edited runs commands, and commands run only inside the sandbox of this system, which has none for that coding agent: install what it needs (on Linux, bubblewrap and socat), or stop sharing the folder (folders remove) and share it again read-only.';
const BROKE = 'The runner broke while it ran this task.';
/** Said to the office while its owner is asked: fixed words, with nothing of what was asked in them, which the office has already. */
export const WAITING_FOR_APPROVAL = 'Waiting for its owner to approve this task on their machine.';
const NOT_APPROVED = 'Its owner did not approve this task on their machine, so it was not run.';
const NOT_APPROVED_IN_TIME = 'Its owner did not answer on their machine in time, so the task was not run.';
const FOLDER_CHANGED = 'The folder was changed while the owner was asked, so the task was not run. Ask again.';
const TIME_WENT_BY_WAITING = 'The time for this task went by while it waited to begin.';
const OTHER_PROCESS_RUNS_A_TASK = 'Another runner process on this machine is running a task. If none is, delete the file task.lock in the folder of the runner’s settings.';
const LOCK_UNAVAILABLE = 'This machine could not find out whether another runner process is running a task, so it did not take this one.';
const WORKSPACE_IN_PLACE = 'A workspace is edited in place and nothing else: its settings say otherwise, so it is not worked in. Share it again as a workspace.';
const NO_WORKSPACE_TOOLS = 'This coding agent cannot make folders or clone repositories by itself: it works in the workspace as it is.';
const UNREADABLE_SETTINGS = 'This machine could not read its own settings, so it takes no task until its owner mends them.';

/**
 * Runs the tasks the machine is given, one at a time, inside the rules its owner set. Whoever offers a task, and whatever the office
 * says, every rule is checked here on the machine, again at every task: the folder is on the list, is where it was, and is not home or
 * the runner's own settings; the coding agent is installed, supported and logged in, and can be contained, or the folder is one its
 * owner trusts; the work is done in a worktree unless the owner chose otherwise; and it ends by a ceiling of time and of output.
 */
export class TaskService {
  private readonly deps: TaskServiceDeps;
  private running: Running | undefined;
  private pausedByOffice = false;

  constructor(deps: TaskServiceDeps) {
    this.deps = deps;
  }

  /** The task that is running now, if one is. */
  get runningTask(): string | undefined {
    return this.running?.taskId;
  }

  /**
   * The office paused or resumed the machine. The owner's own pause is in the policy, which is read at every task; both stop what runs
   * now. `paused` is whether the machine is paused by either.
   */
  setPausedByOffice(paused: boolean): void {
    this.pausedByOffice = paused;
    if (paused) this.running?.stop('paused');
  }

  /** The owner paused the machine on the machine itself: what runs is stopped. */
  localPauseChanged(paused: boolean): void {
    if (paused) this.running?.stop('paused');
  }

  /** Cancels the task, if it is the one that is running: whoever asked, the machine stops it. */
  cancel(taskId: string): boolean {
    if (this.running?.taskId !== taskId) return false;
    this.running.stop('cancelled');
    return true;
  }

  /** Stops whatever runs: the runner is going away. */
  stopAll(): void {
    this.running?.stop('interrupted');
  }

  /** A task the office offered: it answers through `send`, and the answer is whatever the machine decides. The promise ends with the task. */
  offer(offer: TaskOffer, send: (message: RunnerToServer) => void): Promise<void> {
    const { taskId } = offer;
    let seq = 0;
    const sink: TaskSink = {
      accepted: () => {
        send({ type: 'task.accept', taskId });
        this.deps.report({ kind: 'accepted', taskId });
      },
      rejected: (reason, message) => {
        send({ type: 'task.reject', taskId, reason, message });
        this.deps.report({ kind: 'rejected', taskId, reason });
      },
      event: (event) => send({ type: 'task.event', taskId, seq: seq++, event }),
      done: (done) => send({ type: 'task.done', taskId, ...done }),
      failed: (failed) => send({ type: 'task.failed', taskId, ...failed }),
    };
    return this.execute({ taskId, folder: offer.folder, agent: offer.agent, instruction: offer.instruction, maxSeconds: offer.maxSeconds, maxOutputBytes: offer.maxOutputBytes }, sink, { fromOffice: true, approved: false });
  }

  /** A task its owner gave at the terminal: the same rules, with the answer given to them. A folder that asks before each task is asked about by the caller, who says so with `approved`. */
  runForOwner(request: TaskRequest, sink: TaskSink, approved: boolean): Promise<void> {
    return this.execute(request, sink, { fromOffice: false, approved });
  }

  private async execute(request: TaskRequest, told: TaskSink, how: { readonly fromOffice: boolean; readonly approved: boolean }): Promise<void> {
    // The place is taken before anything is waited for, so that two offers arriving together cannot both run.
    if (this.running) return told.rejected('busy', 'This machine is running another task.');
    const sink = this.observed(request, told);
    const controller = new AbortController();
    const running: Running = {
      taskId: request.taskId,
      controller,
      acceptedAt: undefined,
      why: undefined,
      releaseLock: undefined,
      stop: (why) => {
        running.why ??= why;
        controller.abort();
      },
    };
    this.running = running;
    let prepared: Prepared | undefined;
    try {
      prepared = await this.prepare(request, sink, how, running);
      if (!prepared) return;
      // It was paused while it was being got ready: nothing was begun, and nothing is.
      if (running.why === 'paused') {
        await prepared.isolated.discard().catch(() => undefined);
        await this.release(running);
        return await this.refuse(running, request, sink, how.fromOffice, 'paused', 'This machine is paused.');
      }
      await this.run(running, request, sink, how.fromOffice, prepared);
    } catch (error) {
      // Not a way a task ends: a mistake of this program. What was made for the task is not left behind for it.
      await prepared?.isolated.discard().catch(() => undefined);
      if (how.fromOffice) await this.deps.journal.failIfRunning({ taskId: request.taskId, reason: 'error', message: BROKE, durationMs: 0 });
      throw error;
    } finally {
      await this.release(running);
    }
  }

  /** The sink, told also to whoever watches the tasks. */
  private observed(request: TaskRequest, sink: TaskSink): TaskSink {
    const { observer } = this.deps;
    if (!observer) return sink;
    return {
      accepted: () => {
        sink.accepted();
        observer.began({ taskId: request.taskId, folder: request.folder, startedAt: this.deps.scheduler.now() });
      },
      rejected: (reason, message) => sink.rejected(reason, message),
      event: (event) => {
        sink.event(event);
        observer.said(request.taskId, event);
      },
      done: (done) => {
        sink.done(done);
        observer.ended(request.taskId, { done });
      },
      failed: (failed) => {
        sink.failed(failed);
        observer.ended(request.taskId, { failed });
      },
    };
  }

  /** Tells the office the task is taken, once. The journal knows it from here on, so that a connection that drops while the owner is asked can still say where it stands. */
  private async accept(running: Running, request: TaskRequest, sink: TaskSink, journaled: boolean): Promise<void> {
    if (running.acceptedAt !== undefined) return;
    running.acceptedAt = this.deps.scheduler.now();
    if (journaled) await this.deps.journal.started(request.taskId);
    sink.accepted();
  }

  /**
   * Ends a task that cannot begin. The office is told it was rejected, unless it was told it was taken: it settles a task that runs only by
   * its ending, and a rejection of one that runs is dropped, so the task would hang until the office gave up on the machine.
   */
  private async refuse(running: Running, request: TaskRequest, sink: TaskSink, journaled: boolean, reason: TaskRejection, message: string): Promise<void> {
    if (running.acceptedAt === undefined) return sink.rejected(reason, message);
    await this.endAfterAccept(running, request, sink, journaled, reason === 'paused' ? 'paused' : 'error', message, 0);
  }

  private async endAfterAccept(running: Running, request: TaskRequest, sink: TaskSink, journaled: boolean, reason: TaskFailure, message: string, durationMs: number): Promise<void> {
    const failed = { reason, message: message.slice(0, TASK_LIMITS.message), durationMs };
    if (journaled) await this.deps.journal.failed({ taskId: request.taskId, ...failed });
    await this.release(running);
    sink.failed(failed);
    this.deps.report({ kind: 'ended', taskId: request.taskId, outcome: reason, durationMs });
  }

  /** Every check of the rules that is made on the policy as it is now: the folder, the coding agent and what contains it. */
  private async checkRules(request: TaskRequest, approved: boolean, canAsk: boolean): Promise<Checked | { readonly rejection: TaskRejection; readonly message: string }> {
    const { policy, resolver, surroundings } = this.deps;
    // What cannot be read is not guessed at: an empty policy would say that the machine is not paused.
    const current = await policy.load().catch(() => undefined);
    if (!current) return { rejection: 'not-allowed', message: UNREADABLE_SETTINGS };
    if (this.pausedByOffice || current.paused) return { rejection: 'paused', message: 'This machine is paused.' };
    const folder = current.folders.find((candidate) => candidate.label === request.folder);
    if (!folder) return { rejection: 'not-allowed', message: NOT_ALLOWED_FOLDER };
    const needsApproval = folder.approval === 'ask' && !approved;
    if (needsApproval && !canAsk) return { rejection: 'needs-approval', message: 'This folder asks its owner to approve each task, on the machine.' };

    if (!isConsistentWorkspace(folder)) return { rejection: 'not-allowed', message: WORKSPACE_IN_PLACE };
    const problem = problemWithFolder(folder, await resolver.resolve(folder.path), surroundings);
    if (problem) return { rejection: 'not-allowed', message: DESCRIBE_FOLDER_PROBLEM[problem] };

    const chosen = await this.chooseAgent(request.agent ?? folder.agent, current.agentPaths);
    if ('rejection' in chosen) return chosen;
    const { agent, detection } = chosen;
    // Trusting a folder lifts the need for a sandbox where the system has none to offer (Windows), but a coding agent that has a sandbox and
    // cannot start it does not run commands without it, trusted or not.
    if (folder.access === 'edit' && detection.containment === 'none' && !surroundings.windows) return { rejection: 'not-contained', message: EDIT_NEEDS_A_SANDBOX };
    if (detection.containment === 'none' && !folder.trusted) {
      return { rejection: 'not-contained', message: 'This coding agent cannot be contained on this system, so it runs only in a folder its owner marked as trusted.' };
    }
    return { folder, agent, detection, needsApproval };
  }

  /** Every check that decides whether the task may begin. Tells the sink why not, and answers nothing, when it may not. */
  private async prepare(request: TaskRequest, sink: TaskSink, how: { readonly fromOffice: boolean; readonly approved: boolean }, running: Running): Promise<Prepared | undefined> {
    const { isolation, lock, surroundings, parentEnvironment } = this.deps;
    const refuse = async (rejection: TaskRejection, message: string): Promise<undefined> => {
      await this.refuse(running, request, sink, how.fromOffice, rejection, message);
      return undefined;
    };

    // What the owner reads before approving is what the coding agent is given, so it holds nothing that a person cannot read.
    if (hasHiddenCharacters(request.instruction)) return refuse('bad-offer', HIDDEN_IN_INSTRUCTION);

    const canAsk = how.fromOffice && this.deps.approvals !== undefined;
    let checked = await this.checkRules(request, how.approved, canAsk);
    if ('rejection' in checked) return refuse(checked.rejection, checked.message);

    // The cheap checks are done: from here the machine's one task is this one, in this process and in every other. It is taken before the
    // owner is asked and before the copy of the folder is made, and given up, wherever the task ends, by `release`.
    try {
      running.releaseLock = await lock.acquire();
    } catch {
      return refuse('busy', LOCK_UNAVAILABLE);
    }
    if (!running.releaseLock) return refuse('busy', OTHER_PROCESS_RUNS_A_TASK);

    if (checked.needsApproval) {
      if (!(await this.askOwner(running, request, sink, checked.folder))) return undefined;
      // The owner took their time, and may have changed the rules meanwhile: what was approved is a task in that folder as it was shown.
      const again = await this.checkRules(request, true, canAsk);
      if ('rejection' in again) return refuse(again.rejection, again.message);
      if (JSON.stringify(again.folder) !== JSON.stringify(checked.folder)) return refuse('not-allowed', FOLDER_CHANGED);
      checked = again;
    }
    const { folder, agent, detection } = checked;

    let isolated: IsolatedFolder;
    if (folder.isolation === 'worktree') {
      const copying = bounded(this.deps.scheduler, running.controller.signal, PREPARE_COPY_MS);
      try {
        isolated = await isolation.prepare(folder, request.taskId, copying.signal);
      } catch (error) {
        // Told to stop while the copy was made: whatever was made has been taken away, and the task ends as one told to stop before it began.
        if (running.controller.signal.aborted && !copying.timedOut()) {
          isolated = NOTHING_LEFT;
        } else {
          await this.release(running);
          return refuse('cannot-isolate', copying.timedOut() ? 'Making a copy of that folder took too long, so the task was not taken.' : error instanceof IsolationError ? error.message : 'A worktree for this task could not be made.');
        }
      } finally {
        copying.release();
      }
    } else {
      isolated = inPlace(folder);
    }
    return { folder, agent, executable: detection.path ?? '', isolated, environment: childEnvironment(parentEnvironment, surroundings.windows) };
  }

  /**
   * Asks the owner, after telling the office that the task is taken and that it waits for them: the office gives a machine a minute to answer
   * an offer and a ceiling to a task, so the question is asked inside a task and not before one. What ends the wait ends the task, with its
   * own words: a denial, a time that went by, a cancel or a pause. Says whether the owner approved it.
   */
  private async askOwner(running: Running, request: TaskRequest, sink: TaskSink, folder: AllowedFolder): Promise<boolean> {
    const { approvals, scheduler, observer, report } = this.deps;
    if (!approvals) throw new Error('A task that has to be approved was taken without a place to approve it.');
    await this.accept(running, request, sink, true);
    sink.event({ kind: 'text', text: WAITING_FOR_APPROVAL });
    report({ kind: 'waiting-for-approval', taskId: request.taskId });
    observer?.approval(request.taskId, true);

    const ceilingMs = effectiveCeilings(request).seconds * 1_000;
    let result: { readonly answer: ApprovalAnswer; readonly timedOut: boolean };
    try {
      result = await answerWithin(scheduler, running.controller.signal, Math.min(APPROVAL_WAIT_MS, ceilingMs), (signal) => approvals.ask({ taskId: request.taskId, folder: folder.label, access: folder.access, instruction: request.instruction }, signal), 'denied');
    } finally {
      observer?.approval(request.taskId, false);
    }
    const { answer, timedOut } = result;

    const waitedMs = scheduler.now() - (running.acceptedAt ?? scheduler.now());
    const end = async (reason: TaskFailure, message: string): Promise<false> => {
      await this.endAfterAccept(running, request, sink, true, reason, message, waitedMs);
      return false;
    };
    if (running.why) return end(running.why, STOPPED_BECAUSE[running.why]);
    if (timedOut) return end(waitedMs >= ceilingMs ? 'timeout' : 'cancelled', waitedMs >= ceilingMs ? TIME_WENT_BY_WAITING : NOT_APPROVED_IN_TIME);
    if (answer !== 'approved') return end('cancelled', NOT_APPROVED);
    return true;
  }

  private async chooseAgent(
    kind: CodingAgentKind | null,
    paths: Readonly<Partial<Record<CodingAgentKind, string>>>,
  ): Promise<{ readonly agent: CodingAgent; readonly detection: AgentDetection } | { readonly rejection: TaskRejection; readonly message: string }> {
    const { agents } = this.deps;
    const candidates = kind ? [agents[kind]].filter((agent): agent is CodingAgent => agent !== undefined) : Object.values(agents);
    if (candidates.length === 0) return { rejection: 'agent-missing', message: kind ? 'This runner cannot drive that coding agent.' : 'This runner has no coding agent to drive.' };
    let problem: { rejection: TaskRejection; message: string } | undefined;
    for (const agent of candidates) {
      const detection = await agent.detect(paths[agent.kind]);
      if (!detection.installed || !detection.supported || detection.path === undefined) {
        problem ??= { rejection: 'agent-missing', message: detection.problem ?? 'That coding agent is not installed on this machine.' };
        continue;
      }
      if (detection.loggedIn === false) {
        problem ??= { rejection: 'not-logged-in', message: 'That coding agent is installed, but nobody is logged in to it on this machine.' };
        continue;
      }
      return { agent, detection };
    }
    return problem ?? { rejection: 'agent-missing', message: 'That coding agent is not installed on this machine.' };
  }

  /**
   * The machine is free for the next task, in this process and in the others, before anybody is told that this one is over: whoever hears
   * it may offer another at once, and must not be told that the machine is busy. Said twice, it does no harm.
   */
  private async release(running: Running): Promise<void> {
    if (this.running === running) this.running = undefined;
    const giveUp = running.releaseLock;
    running.releaseLock = undefined;
    // A lock that cannot be given up is not a reason to fail a task that is over: the next one that finds it held by nobody alive takes it over.
    await giveUp?.().catch(() => undefined);
  }

  /** The tools of a workspace for this task, when the folder is one and the coding agent and the machine can give them. */
  private workspaceToolsFor(running: Running, request: TaskRequest, folder: AllowedFolder, agent: CodingAgent, say: (text: string) => void): WorkspaceTools | undefined {
    const { workspace, approvals, scheduler, observer, report } = this.deps;
    if (!isWorkspace(folder) || agent.workspaceTools !== true || !workspace) return undefined;
    return createWorkspaceTools({
      workspace: folder.realPath,
      label: folder.label,
      taskId: request.taskId,
      ops: workspace,
      approvals,
      scheduler,
      signal: running.controller.signal,
      say,
      waiting: (waiting) => {
        observer?.approval(request.taskId, waiting);
        if (waiting) report({ kind: 'waiting-for-approval', taskId: request.taskId });
      },
    });
  }

  /** Records the hooks and settings of the git repositories under a folder, with a time of its own. Nothing when it could not be done: the check after the task then removes nothing, and says so. */
  private async recordGitSettings(root: string): Promise<GitSettingsBaseline | undefined> {
    const { settingsScan, scheduler } = this.deps;
    if (!settingsScan) return undefined;
    const controller = new AbortController();
    const cancel = scheduler.after(SCAN_MS, () => controller.abort());
    try {
      return await settingsScan.snapshot(root, controller.signal);
    } catch {
      return undefined;
    } finally {
      cancel();
    }
  }

  /**
   * Takes away what the task added to the repositories under the folder that would run programs, with a time of its own (the task may have ended by
   * being stopped). Says what, in words, and says what could not be checked: a check that failed is told, never taken for one that found nothing.
   */
  private async removeRunningSettings(root: string, baseline: GitSettingsBaseline | undefined): Promise<string | undefined> {
    const { settingsScan, scheduler } = this.deps;
    if (!settingsScan) return undefined;
    const controller = new AbortController();
    const cancel = scheduler.after(SCAN_MS, () => controller.abort());
    try {
      return summarizeGitSettings(await settingsScan.scan(root, controller.signal, baseline));
    } catch {
      return summarizeGitSettings({ findings: [], incomplete: ['unreadable'] });
    } finally {
      cancel();
    }
  }

  private async run(running: Running, request: TaskRequest, sink: TaskSink, journaled: boolean, prepared: Prepared): Promise<void> {
    const { scheduler, surroundings, report, journal } = this.deps;
    const { folder, agent, isolated } = prepared;
    const startedAt = scheduler.now();
    const ceilings = effectiveCeilings(request);
    const budget = new OutputBudget(ceilings.outputBytes);
    const places = placesOf(surroundings, prepared.environment, { workFolder: isolated.folder, allowedFolder: folder.realPath });
    // What is told of a task keeps the lines of what was said (a one-line name is made with `toOneLine`), with no path of this machine in it.
    // An address says nothing of its user or its query: the owner's credentials are never in what the office hears, whoever repeated them.
    const say = (text: string): string => redactUrls(redactPaths(cleanText(text), places));
    const sayInOneLine = (text: string): string => redactUrls(redactPaths(toOneLine(text), places));

    await this.accept(running, request, sink, journaled);
    // What is in the git repositories of a folder worked in place is recorded before the agent touches it: only what the task adds is taken away after it.
    const baseline = folder.isolation === 'in-place' ? await this.recordGitSettings(isolated.folder) : undefined;
    // What the office gives a task runs from the moment it was told the task was taken, and a task whose owner was asked first, or whose copy
    // took a while to make, has spent some of it: what is left is what it has.
    const leftMs = ceilings.seconds * 1_000 - Math.max(0, startedAt - (running.acceptedAt ?? startedAt));

    let giveUp: (() => void) | undefined;
    const gaveUp = new Promise<'gave-up'>((resolve) => {
      giveUp = () => resolve('gave-up');
    });
    // Nothing is left: it is stopped before it begins, and ends as a task that ran out of time.
    if (leftMs <= 0) running.stop('timeout');
    const cancelTimeout = scheduler.after(Math.max(0, leftMs), () => running.stop('timeout'));
    let cancelGrace: (() => void) | undefined;
    const startGrace = (): void => {
      cancelGrace = scheduler.after(ABORT_GRACE_MS, () => giveUp?.());
    };
    running.controller.signal.addEventListener('abort', startGrace, { once: true });

    const tools = this.workspaceToolsFor(running, request, folder, agent, (text) => tell(sink, budget, { say, sayInOneLine }, { kind: 'text', text }));
    if (isWorkspace(folder) && !tools) tell(sink, budget, { say, sayInOneLine }, { kind: 'text', text: NO_WORKSPACE_TOOLS });

    let result: { readonly text: string } | { readonly error: string } | undefined;
    try {
      // Told to stop before it began: it does not.
      if (running.controller.signal.aborted) throw new Stopped();
      const run = agent.run({ folder: isolated.folder, instruction: request.instruction, access: folder.access, executable: prepared.executable, environment: prepared.environment, surroundings, workspace: tools }, running.controller.signal);
      const events = run[Symbol.asyncIterator]();
      for (;;) {
        const step = await Promise.race([events.next(), gaveUp]);
        if (step === 'gave-up') {
          // Whatever the adapter does when it is cut short, it is not for this to stop for.
          void Promise.resolve(events.return?.()).catch(() => undefined);
          break;
        }
        if (step.done) break;
        const event = step.value;
        if (event.kind === 'result') {
          result = { text: event.text };
          break;
        }
        if (event.kind === 'error') {
          result = { error: event.message };
          break;
        }
        tell(sink, budget, { say, sayInOneLine }, event);
      }
    } catch (error) {
      if (!(error instanceof Stopped)) result = { error: error instanceof Error ? error.message : String(error) };
    } finally {
      cancelTimeout();
      // Told to stop while the work is kept, which is after this: nothing is waiting for the agent to be gone any more.
      running.controller.signal.removeEventListener('abort', startGrace);
      cancelGrace?.();
    }

    // Whatever way the task ended, the agent may have written something into a repository that would run when its owner uses it.
    const settingsNote = folder.isolation === 'in-place' ? await this.removeRunningSettings(isolated.folder, baseline) : undefined;
    const toldAsOne = settingsNote === undefined ? undefined : sayInOneLine(settingsNote);

    const fail = async (reason: TaskFailure, message: string): Promise<void> => {
      await isolated.discard().catch(() => undefined);
      const failed = { reason, message: (toldAsOne === undefined ? message : `${message.slice(0, 200)} ${toldAsOne}`).slice(0, TASK_LIMITS.message), durationMs: scheduler.now() - startedAt };
      if (journaled) await journal.failed({ taskId: request.taskId, ...failed });
      await this.release(running);
      sink.failed(failed);
      report({ kind: 'ended', taskId: request.taskId, outcome: reason, durationMs: failed.durationMs });
    };

    if (running.why) return fail(running.why, STOPPED_BECAUSE[running.why]);
    if (!result || 'error' in result) return fail('error', sayInOneLine(result && 'error' in result ? result.error : 'The coding agent ended without an answer.'));

    let kept: { readonly branch: string | null; readonly diffStat: string | null };
    const keeping = bounded(scheduler, running.controller.signal, KEEP_WORK_MS);
    try {
      kept = await isolated.finish(keeping.signal);
    } catch (error) {
      // Told to stop while the work was kept: what was kept is given up, and the task ends as it would have if it had been told to stop before.
      if (running.why) return fail(running.why, STOPPED_BECAUSE[running.why]);
      if (keeping.timedOut()) return fail('timeout', 'Keeping the work took too long, so it was given up.');
      return fail('error', sayInOneLine(error instanceof Error ? error.message : 'The work could not be kept.'));
    } finally {
      keeping.release();
    }
    const durationMs = scheduler.now() - startedAt;
    // What was removed comes first, so that a long answer cannot push it out of what is kept.
    const text = settingsNote === undefined ? say(result.text) : `${say(settingsNote)}\n\n${say(result.text)}`;
    const done = {
      text: text.slice(0, TASK_LIMITS.finalText),
      branch: kept.branch,
      diffStat: kept.diffStat === null ? null : redactPaths(kept.diffStat, places).slice(0, TASK_LIMITS.diffStat),
      durationMs,
      truncated: budget.truncated || text.length > TASK_LIMITS.finalText,
    };
    if (journaled) await journal.done({ taskId: request.taskId, ...done });
    await this.release(running);
    sink.done(done);
    report({ kind: 'ended', taskId: request.taskId, outcome: 'done', durationMs });
  }
}

const STOPPED_BECAUSE: Readonly<Record<TaskFailure, string>> = {
  error: 'The coding agent failed.',
  timeout: 'The task ran for too long and was stopped.',
  cancelled: 'The task was cancelled.',
  paused: 'The machine was paused, so the task was stopped.',
  interrupted: 'The runner stopped while the task was running.',
};

interface Checked {
  readonly folder: AllowedFolder;
  readonly agent: CodingAgent;
  readonly detection: AgentDetection;
  /** The folder asks before each task and its owner has not approved this one. */
  readonly needsApproval: boolean;
}

interface Prepared {
  readonly folder: AllowedFolder;
  readonly agent: CodingAgent;
  readonly executable: string;
  readonly isolated: IsolatedFolder;
  readonly environment: Record<string, string>;
}

/** A folder worked on as it is: nothing to make, and nothing to keep apart. */
function inPlace(folder: AllowedFolder): IsolatedFolder {
  return { folder: folder.realPath, finish: () => Promise.resolve({ branch: null, diffStat: null }), discard: () => Promise.resolve() };
}

/**
 * What is left of a copy that was being made when the task was told to stop: nothing is, and the task ends as it does when it is told to
 * stop before its first step. It has no folder, so that an agent could not be started in it: the one thing this must never be is the folder itself.
 */
const NOTHING_LEFT: IsolatedFolder = { folder: '', finish: () => Promise.reject(new Error('There is nothing to keep.')), discard: () => Promise.resolve() };

/** Raised inside `run` when the task was told to stop before it began: the same ending as one told to stop after. */
class Stopped extends Error {}

/** Passes on what the coding agent did, within the budget, and with no path of this machine in it. */
function tell(sink: TaskSink, budget: OutputBudget, words: { readonly say: (text: string) => string; readonly sayInOneLine: (text: string) => string }, event: Exclude<AgentEvent, { kind: 'result' | 'error' }>): void {
  if (event.kind === 'usage') return sink.event(event);
  if (event.kind === 'tool') {
    const name = words.sayInOneLine(event.name).slice(0, TASK_LIMITS.toolName);
    const summary = words.sayInOneLine(event.summary).slice(0, TASK_LIMITS.toolSummary);
    if (budget.take(`${name}${summary}`) === `${name}${summary}`) sink.event({ kind: 'tool', name, summary, denied: event.denied });
    return;
  }
  // Said in pieces the size of one event, so that a long answer is a few of them, and what runs out of budget stops at a piece.
  const text = words.say(event.text);
  for (let at = 0; at < text.length; at += TASK_LIMITS.eventText) {
    const piece = budget.take(text.slice(at, at + TASK_LIMITS.eventText));
    if (piece === '') return;
    sink.event({ kind: 'text', text: piece });
  }
}
