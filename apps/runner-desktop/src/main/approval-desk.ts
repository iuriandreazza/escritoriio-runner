import type { ApprovalAnswer, ApprovalPort, ApprovalRequest, CloneApprovalRequest, Followable, TaskNote, Unsubscribe } from '@escritoriio/runner';
import { describeTaskNote, hasHiddenCharacters } from '@escritoriio/runner';
import { randomUUID } from 'node:crypto';

/** One native notification: what it says, the buttons it may have, and what to do when one is pressed or the body is clicked. */
export interface NotificationRequest {
  readonly title: string;
  readonly body: string;
  readonly actions: readonly { readonly id: 'approve' | 'deny'; readonly label: string }[];
  onAction(id: 'approve' | 'deny'): void;
  onClick(): void;
}

export interface Notifier {
  show(notification: NotificationRequest): { close(): void };
}

/** A task that waits for its owner, as the window lists it: the instruction is the office's, whole, since it is what is being approved. */
export interface PendingTask {
  readonly kind?: never;
  /** Names this ask and no other: an answer is for one ask, so that a stale answer cannot approve a later ask of the same task. */
  readonly askId: string;
  readonly taskId: string;
  readonly folder: string;
  readonly access: ApprovalRequest['access'];
  readonly instruction: string;
}

/** The agent of a workspace waiting to be allowed to clone a repository: the address is the runner's, whole, since it is what is being approved. */
export interface PendingClone {
  readonly kind: 'clone';
  readonly askId: string;
  readonly taskId: string;
  readonly workspace: string;
  readonly url: string;
  readonly folder: string;
}

export type PendingApproval = PendingTask | PendingClone;

/** What a notification of a system shows of its body is a few lines. Above this the instruction would be cut, and an owner must not approve words they cannot read. */
export const NOTIFIABLE_INSTRUCTION_CHARS = 240;

/** A notification shows a few lines, and a line that is cut is words nobody read. */
export const NOTIFIABLE_INSTRUCTION_LINES = 3;

/**
 * The notification for a task that asks first. When the whole instruction fits in it and is what a person reads (no more than a few lines, nothing
 * that hides or reorders), it can be approved or denied right there; when it does not, the notification only says that a task waits (and a click
 * opens the window), because the owner approves the exact text and only the window shows it whole, with what hides made visible.
 */
export function notificationFor(request: ApprovalRequest): { readonly title: string; readonly body: string; readonly canAnswerHere: boolean } {
  const { instruction } = request;
  const fits = instruction.length <= NOTIFIABLE_INSTRUCTION_CHARS && instruction.split(/\r\n|\r|\n/).length <= NOTIFIABLE_INSTRUCTION_LINES && !hasHiddenCharacters(instruction);
  const title = `A task waits for your approval in "${request.folder}"`;
  return fits ? { title, body: request.instruction, canAnswerHere: true } : { title, body: 'It cannot be read whole in a notification: open the window to read it and decide.', canAnswerHere: false };
}

/** An address is offered for approval in a notification only when it is this short: a long one is cut by the system, and what is cut is words nobody read. */
export const NOTIFIABLE_URL_CHARS = 100;

/** Whether a text is one plain line: nothing that hides or reorders, no line break and no space. What is shown to be approved must be what is read. */
const isPlainWord = (text: string): boolean => text !== '' && !hasHiddenCharacters(text) && !/[\s\p{Z}]/u.test(text);

/**
 * The same rule for an address: it is offered for approval in a notification only when all of it is shown, on one line of at most 100 characters,
 * and the name of the folder and of the working folder are plain too. In any other case the notification only says that a clone waits and a click
 * opens the window, which shows each of them with what hides made visible, and has the buttons.
 */
export function cloneNotificationFor(request: CloneApprovalRequest): { readonly title: string; readonly body: string; readonly canAnswerHere: boolean } {
  const { url, folder, workspace } = request;
  const fits = url.length <= NOTIFIABLE_URL_CHARS && isPlainWord(url) && isPlainWord(folder) && !hasHiddenCharacters(workspace) && !/[\r\n]/.test(workspace);
  if (!fits) return { title: 'A repository is to be cloned', body: 'It cannot be read whole in a notification: open the window to read it and decide.', canAnswerHere: false };
  return { title: `A repository is to be cloned into "${workspace}"`, body: `${url}\ninto the folder "${folder}"`, canAnswerHere: true };
}

/** The notice for a task that ended, in the runner’s own words (which task and how it went, never what was asked or what came of it). Nothing for what the owner did themselves. */
export function taskNotice(note: TaskNote): { readonly title: string; readonly body: string } | undefined {
  if (note.kind !== 'ended' || note.outcome === 'cancelled') return undefined;
  return { title: note.outcome === 'done' ? 'Task done' : 'Task failed', body: describeTaskNote(note) };
}

interface Waiting {
  readonly pending: PendingApproval;
  settle(answer: ApprovalAnswer): void;
}

/**
 * Where the owner approves what waits for them, for the app: a pending entry the window lists with the exact words (the text of a task of a folder that
 * asks first, the address of a repository a workspace would clone), and a native notification that can answer too where the words fit in it. The first
 * answer wins; when the runner stops waiting (the task was cancelled, the machine paused or stopped, nobody answered in time) whatever was shown is
 * taken away and the answer is a no.
 */
export class ApprovalDesk implements ApprovalPort, Followable<readonly PendingApproval[]> {
  private readonly waiting = new Map<string, Waiting>();
  private readonly listeners = new Set<(pending: readonly PendingApproval[]) => void>();
  private readonly notifier: Notifier;
  private readonly openWindow: () => void;
  private readonly newAskId: () => string;

  constructor({ notifier, openWindow, newAskId = randomUUID }: { readonly notifier: Notifier; readonly openWindow: () => void; readonly newAskId?: () => string }) {
    this.notifier = notifier;
    this.openWindow = openWindow;
    this.newAskId = newAskId;
  }

  get current(): readonly PendingApproval[] {
    return [...this.waiting.values()].map(({ pending }) => pending);
  }

  subscribe(listener: (pending: readonly PendingApproval[]) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  ask(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer> {
    if (signal.aborted) return Promise.resolve('denied');
    // The same task asking again is a new ask: the earlier one is over.
    for (const entry of [...this.waiting.values()]) if (entry.pending.kind === undefined && entry.pending.taskId === request.taskId) entry.settle('denied');
    const { taskId, folder, access, instruction } = request;
    return this.wait(signal, notificationFor(request), (askId) => ({ askId, taskId, folder, access, instruction }));
  }

  askToClone(request: CloneApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer> {
    if (signal.aborted) return Promise.resolve('denied');
    const { taskId, workspace, url, folder } = request;
    // Each clone is its own ask: one that is waiting is never taken for another.
    return this.wait(signal, cloneNotificationFor(request), (askId) => ({ kind: 'clone', askId, taskId, workspace, url, folder }));
  }

  private wait(signal: AbortSignal, shown: { readonly title: string; readonly body: string; readonly canAnswerHere: boolean }, describe: (askId: string) => PendingApproval): Promise<ApprovalAnswer> {
    return new Promise<ApprovalAnswer>((resolve) => {
      const askId = this.newAskId();
      const pending = describe(askId);
      const notification = this.notifier.show({
        title: shown.title,
        body: shown.body,
        actions: shown.canAnswerHere
          ? [
              { id: 'approve', label: 'Approve' },
              { id: 'deny', label: 'Deny' },
            ]
          : [],
        onAction: (id) => this.answer(pending.taskId, askId, id === 'approve' ? 'approved' : 'denied'),
        onClick: this.openWindow,
      });
      const onAbort = (): void => entry.settle('denied');
      const entry: Waiting = {
        pending,
        settle: (answer) => {
          if (this.waiting.get(askId) !== entry) return;
          this.waiting.delete(askId);
          signal.removeEventListener('abort', onAbort);
          notification.close();
          this.tell();
          resolve(answer);
        },
      };
      this.waiting.set(askId, entry);
      signal.addEventListener('abort', onAbort, { once: true });
      this.tell();
    });
  }

  /** The owner's answer, from the window or from a notification, to the ask that was shown. False when that ask is not waiting any more. */
  answer(taskId: string, askId: string, answer: ApprovalAnswer): boolean {
    const entry = this.waiting.get(askId);
    if (!entry || entry.pending.taskId !== taskId) return false;
    entry.settle(answer);
    return true;
  }

  /** Denies everything that waits: for when the app quits. */
  denyAll(): void {
    for (const entry of [...this.waiting.values()]) entry.settle('denied');
  }

  private tell(): void {
    const pending = this.current;
    for (const listener of [...this.listeners]) listener(pending);
  }
}
