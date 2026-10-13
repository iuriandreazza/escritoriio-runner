import type { CodingAgentKind, TaskDone, TaskEvent, TaskFailed, TaskRejection } from '@escritoriio/runner-protocol';
import { TASK_LIMITS } from '@escritoriio/runner-protocol';
import { isYes } from '../domain/answer.ts';
import { describeSeconds } from '../domain/describe-seconds.ts';
import { findByLabel } from '../domain/folder-label.ts';
import type { AllowedFolder } from '../domain/folder-policy.ts';
import type { InterruptSignal, Terminal } from './ports.ts';
import type { TaskSink, TaskService } from './task-service.ts';
import type { PolicyStore } from './task-ports.ts';

/** What a shell says for a program that a signal ended: 128 and the number of the signal. */
export const EXIT_AFTER_SIGNAL: Readonly<Record<InterruptSignal, number>> = { SIGINT: 130, SIGTERM: 143 };

export interface OwnerRunDeps {
  readonly service: Pick<TaskService, 'runForOwner' | 'cancel'>;
  readonly policy: Pick<PolicyStore, 'load'>;
  readonly terminal: Terminal;
  readonly newTaskId: () => string;
}

/** A task that its owner gives at the terminal. */
export interface OwnerTask {
  /** The label of one of the folders that are shared. */
  readonly folder: string;
  readonly instruction: string;
  readonly agent: CodingAgentKind | null;
  /** The owner already approved it, for a folder that asks before each task. */
  readonly approve: boolean;
}

/** Shows a task to the person who gave it, as it goes and as it ends, and remembers how it ended for the exit code. */
class TerminalSink implements TaskSink {
  exitCode = 1;
  /** What stopped the task, when the person did: it is what the exit code says. */
  stoppedBy: InterruptSignal = 'SIGINT';
  private readonly terminal: Terminal;
  private readonly folder: AllowedFolder | undefined;
  private tokens = { input: 0, output: 0 };

  constructor(terminal: Terminal, folder: AllowedFolder | undefined) {
    this.terminal = terminal;
    this.folder = folder;
  }

  accepted(): void {
    this.terminal.out('Working. Press Ctrl-C to stop it.');
  }

  rejected(reason: TaskRejection, message: string): void {
    this.terminal.err(`The task was not run: ${message}`);
    if (reason === 'not-allowed' && !this.folder) this.terminal.err('See the folders that are shared with: escritoriio-runner folders list');
  }

  event(event: TaskEvent): void {
    if (event.kind === 'text') this.terminal.out(event.text);
    else if (event.kind === 'tool') this.terminal.out(`  > ${event.name}${event.summary === '' ? '' : `: ${event.summary}`}${event.denied ? ' (not allowed)' : ''}`);
    else this.tokens = { input: this.tokens.input + event.inputTokens, output: this.tokens.output + event.outputTokens };
  }

  done(done: Omit<TaskDone, 'taskId'>): void {
    this.exitCode = 0;
    const out = (line: string): void => this.terminal.out(line);
    out('');
    out(`Done in ${describeSeconds(done.durationMs)}.`);
    if (done.text.trim() !== '') out(`\n${done.text}`);
    out('');
    if (done.branch !== null) {
      out(`The work is on the branch ${done.branch}, in the repository of that folder. Nothing was pushed.`);
      if (done.diffStat) out(done.diffStat);
      out(`Look at it with: git log --stat ${done.branch}${this.folder ? ` (in ${this.folder.path})` : ''}`);
    } else if (this.folder?.isolation === 'in-place') {
      out('The work was done in place: whatever it changed is in the folder now, and nothing was committed.');
    } else {
      out('It changed no files.');
    }
    if (done.truncated) out('Some of what the coding agent said was left out, to keep within the limit.');
    if (this.tokens.input + this.tokens.output > 0) out(`Tokens: ${this.tokens.input} in, ${this.tokens.output} out.`);
  }

  failed(failed: Omit<TaskFailed, 'taskId'>): void {
    this.exitCode = failed.reason === 'cancelled' ? EXIT_AFTER_SIGNAL[this.stoppedBy] : 1;
    this.terminal.err(failed.reason === 'cancelled' ? 'The task was cancelled.' : `The task failed (${failed.reason}) after ${describeSeconds(failed.durationMs)}: ${failed.message}`);
  }
}

/**
 * Runs one task by hand with no office: the machine's own rules apply as they do to a task from the office (the same `TaskService`), and
 * the answer goes to the terminal. A folder that asks before each task asks here, with the exact text in front of the person, unless they
 * already approved it. Gives the exit code: 0 only when the work was done, 130 when it was cancelled with Ctrl-C and 143 when the program was
 * asked to end, as a shell says them, and 1 for anything else.
 * Throws, with words, when the instruction cannot be given or the settings cannot be read.
 */
export async function runByHand({ service, policy, terminal, newTaskId }: OwnerRunDeps, task: OwnerTask): Promise<number> {
  const instruction = task.instruction.trim();
  if (instruction === '') throw new Error('Say what the coding agent should do.');
  if (instruction.length > TASK_LIMITS.instruction) throw new Error(`An instruction is at most ${TASK_LIMITS.instruction} characters.`);

  const { folders } = await policy.load();
  // The person is forgiven a label written in another case, and the machine is given the label as it is kept. A folder that is not shared is for the machine to refuse, with its own words, like any other task.
  const folder = findByLabel(folders, task.folder);
  let approved = task.approve;
  if (folder?.approval === 'ask' && !approved) {
    terminal.out(`The folder "${folder.label}" asks you to approve each task. This is the exact text the coding agent would be given:\n\n${instruction}\n`);
    approved = isYes(await terminal.ask('Approve it and run it? [y/N] '));
    if (!approved) {
      terminal.err('Not approved. Nothing was run.');
      return 1;
    }
  }

  const taskId = newTaskId();
  const sink = new TerminalSink(terminal, folder);
  const stopListening = terminal.onInterrupt((signal) => {
    sink.stoppedBy = signal;
    terminal.out('Stopping the task.');
    service.cancel(taskId);
  });
  try {
    await service.runForOwner({ taskId, folder: folder?.label ?? task.folder, agent: task.agent, instruction }, sink, approved);
  } finally {
    stopListening();
  }
  return sink.exitCode;
}
