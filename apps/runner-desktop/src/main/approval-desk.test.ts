import type { ApprovalRequest, CloneApprovalRequest, TaskNote } from '@escritoriio/runner';
import { describe, expect, it, vi } from 'vitest';
import type { NotificationRequest, Notifier } from './approval-desk.ts';
import { ApprovalDesk, cloneNotificationFor, NOTIFIABLE_INSTRUCTION_CHARS, NOTIFIABLE_URL_CHARS, notificationFor, taskNotice } from './approval-desk.ts';

const request: ApprovalRequest = { taskId: 'task-1', folder: 'site', access: 'edit', instruction: 'Fix the failing test in src/app.ts' };

class FakeNotifier implements Notifier {
  readonly shown: NotificationRequest[] = [];
  readonly closed: NotificationRequest[] = [];
  show(notification: NotificationRequest) {
    this.shown.push(notification);
    return { close: () => void this.closed.push(notification) };
  }
}

function desk() {
  const notifier = new FakeNotifier();
  const openWindow = vi.fn();
  let asks = 0;
  return { notifier, openWindow, desk: new ApprovalDesk({ notifier, openWindow, newAskId: () => `ask-${++asks}` }) };
}

describe('the notification of a task that waits', () => {
  it('shows the instruction exactly and offers to approve or deny from it when all of it is shown', () => {
    const shown = notificationFor(request);
    expect(shown.body).toContain(request.instruction);
    expect(shown.canAnswerHere).toBe(true);
  });

  it('offers no answer from the notification when the text is not what a person reads: it holds what hides, or has more than three lines', () => {
    expect(notificationFor({ ...request, instruction: 'Fix it\u{E0041}' }).canAnswerHere).toBe(false);
    expect(notificationFor({ ...request, instruction: 'a\u202Eb' }).canAnswerHere).toBe(false);
    expect(notificationFor({ ...request, instruction: 'one\ntwo\nthree\nfour' }).canAnswerHere).toBe(false);
    expect(notificationFor({ ...request, instruction: 'one\ntwo\nthree' }).canAnswerHere).toBe(true);
    expect(notificationFor({ ...request, instruction: 'one\ntwo\nthree\nfour' }).body).toMatch(/open the window/);
  });

  it('offers no answer from the notification when the instruction does not fit in it: the owner reads it whole in the window', () => {
    const long = { ...request, instruction: 'x'.repeat(NOTIFIABLE_INSTRUCTION_CHARS + 1) };
    const shown = notificationFor(long);
    expect(shown.canAnswerHere).toBe(false);
    expect(shown.body).not.toContain(long.instruction);
  });
});

describe('asking the owner to approve a task', () => {
  it('waits as a pending entry that shows the exact text, and is answered from the window', async () => {
    const { desk: approvals } = desk();
    const heard: unknown[] = [];
    approvals.subscribe((pending) => heard.push(pending));
    const answer = approvals.ask(request, new AbortController().signal);
    expect(approvals.current).toEqual([{ askId: 'ask-1', taskId: 'task-1', folder: 'site', access: 'edit', instruction: request.instruction }]);
    expect(approvals.answer('task-1', 'ask-1', 'approved')).toBe(true);
    expect(await answer).toBe('approved');
    expect(approvals.current).toEqual([]);
    expect(heard.length).toBeGreaterThanOrEqual(2);
  });

  it('is answered from the notification, which is then taken away', async () => {
    const { desk: approvals, notifier } = desk();
    const answer = approvals.ask(request, new AbortController().signal);
    expect(notifier.shown[0]?.actions.map((action) => action.id)).toEqual(['approve', 'deny']);
    notifier.shown[0]?.onAction('deny');
    expect(await answer).toBe('denied');
    expect(notifier.closed).toEqual(notifier.shown);
    expect(approvals.current).toEqual([]);
  });

  it('opens the window when the notification is clicked, and does not answer', async () => {
    const { desk: approvals, notifier, openWindow } = desk();
    const answer = approvals.ask(request, new AbortController().signal);
    notifier.shown[0]?.onClick();
    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(approvals.current).toHaveLength(1);
    approvals.answer('task-1', approvals.current[0]!.askId, 'denied');
    await answer;
  });

  it('has a notification with no buttons for an instruction it cannot show whole', async () => {
    const { desk: approvals, notifier } = desk();
    const answer = approvals.ask({ ...request, instruction: 'y'.repeat(NOTIFIABLE_INSTRUCTION_CHARS + 50) }, new AbortController().signal);
    expect(notifier.shown[0]?.actions).toEqual([]);
    expect(approvals.current[0]).toMatchObject({ instruction: 'y'.repeat(NOTIFIABLE_INSTRUCTION_CHARS + 50) });
    approvals.answer('task-1', approvals.current[0]!.askId, 'denied');
    await answer;
  });

  it('is denied, and everything shown is taken away, when the task is cancelled, paused or timed out', async () => {
    const { desk: approvals, notifier } = desk();
    const controller = new AbortController();
    const answer = approvals.ask(request, controller.signal);
    controller.abort();
    expect(await answer).toBe('denied');
    expect(approvals.current).toEqual([]);
    expect(notifier.closed).toEqual(notifier.shown);
    // An answer that comes late changes nothing.
    expect(approvals.answer('task-1', 'ask-1', 'approved')).toBe(false);
  });

  it('is denied at once, and shows nothing, when the task was cancelled already', async () => {
    const { desk: approvals, notifier } = desk();
    const controller = new AbortController();
    controller.abort();
    expect(await approvals.ask(request, controller.signal)).toBe('denied');
    expect(notifier.shown).toEqual([]);
  });

  it('answers only the task it was asked about, and only once', async () => {
    const { desk: approvals } = desk();
    const first = approvals.ask(request, new AbortController().signal);
    const second = approvals.ask({ ...request, taskId: 'task-2' }, new AbortController().signal);
    expect(approvals.answer('nope', 'ask-1', 'approved')).toBe(false);
    expect(approvals.answer('task-2', 'ask-2', 'approved')).toBe(true);
    expect(approvals.answer('task-2', 'ask-2', 'denied')).toBe(false);
    expect(await second).toBe('approved');
    expect(approvals.current.map((pending) => pending.taskId)).toEqual(['task-1']);
    approvals.answer('task-1', approvals.current[0]!.askId, 'denied');
    expect(await first).toBe('denied');
  });

  it('denies the older ask when the same task asks again', async () => {
    const { desk: approvals } = desk();
    const first = approvals.ask(request, new AbortController().signal);
    const second = approvals.ask(request, new AbortController().signal);
    expect(await first).toBe('denied');
    approvals.answer('task-1', 'ask-2', 'approved');
    expect(await second).toBe('approved');
  });

  it('does not let an answer to an earlier ask of a task approve a later ask of the same task', async () => {
    const { desk: approvals } = desk();
    const first = approvals.ask(request, new AbortController().signal);
    const staleAskId = approvals.current[0]!.askId;
    const second = approvals.ask(request, new AbortController().signal);
    await first;
    expect(approvals.answer('task-1', staleAskId, 'approved')).toBe(false);
    expect(approvals.current).toHaveLength(1);
    expect(approvals.answer('task-1', 'not-an-ask', 'approved')).toBe(false);
    expect(approvals.answer('task-1', approvals.current[0]!.askId, 'denied')).toBe(true);
    expect(await second).toBe('denied');
  });

  it('gives every ask an id nobody can guess', async () => {
    const notifier = new FakeNotifier();
    const approvals = new ApprovalDesk({ notifier, openWindow: () => undefined });
    const controller = new AbortController();
    void approvals.ask(request, controller.signal);
    void approvals.ask({ ...request, taskId: 'task-2' }, controller.signal);
    const ids = approvals.current.map((pending) => pending.askId);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    controller.abort();
  });
});

describe('the notice of a task that ended', () => {
  const ended = (outcome: 'done' | 'error' | 'timeout' | 'cancelled' | 'paused' | 'interrupted'): TaskNote => ({ kind: 'ended', taskId: 't1', outcome, durationMs: 4_000 });

  it('says that it is done, or that it failed, in the runner’s own words and never what was asked or answered', () => {
    expect(taskNotice(ended('done'))).toMatchObject({ title: 'Task done' });
    expect(taskNotice(ended('error'))).toMatchObject({ title: 'Task failed' });
    expect(taskNotice(ended('timeout'))).toMatchObject({ title: 'Task failed' });
    expect(taskNotice(ended('done'))?.body).toContain('t1');
  });

  it('says nothing of what the owner did themselves, or of what is not an end', () => {
    expect(taskNotice(ended('cancelled'))).toBeUndefined();
    expect(taskNotice({ kind: 'accepted', taskId: 't1' })).toBeUndefined();
    expect(taskNotice({ kind: 'waiting-for-approval', taskId: 't1' })).toBeUndefined();
    expect(taskNotice({ kind: 'rejected', taskId: 't1', reason: 'paused' })).toBeUndefined();
  });
});

describe('the approval of a clone', () => {
  const clone: CloneApprovalRequest = { kind: 'clone', taskId: 'task-1', workspace: 'build', url: 'https://github.com/acme/site.git', folder: 'site' };

  it('lists the exact address, the folder and the workspace, and is answered once by the id of its ask', async () => {
    const { desk: approvals } = desk();
    const answer = approvals.askToClone(clone, new AbortController().signal);
    expect(approvals.current).toEqual([{ kind: 'clone', askId: 'ask-1', taskId: 'task-1', workspace: 'build', url: clone.url, folder: 'site' }]);
    expect(approvals.answer('task-1', 'not-this', 'approved')).toBe(false);
    expect(approvals.answer('other-task', 'ask-1', 'approved')).toBe(false);
    expect(approvals.answer('task-1', 'ask-1', 'approved')).toBe(true);
    expect(approvals.answer('task-1', 'ask-1', 'denied')).toBe(false);
    expect(await answer).toBe('approved');
    expect(approvals.current).toEqual([]);
  });

  it('offers Approve and Deny in a notification only when the address is plain and short, and shows all of it', () => {
    const shown = cloneNotificationFor(clone);
    expect(shown.canAnswerHere).toBe(true);
    expect(shown.body).toContain(clone.url);
    expect(shown.title).toContain('build');
    for (const url of [`https://example.com/${'p'.repeat(NOTIFIABLE_URL_CHARS)}`, 'https://example.com/a‮b', 'https://example.com/a\nb', 'https://example.com/\u{E0041}', 'https://example.com/a b']) {
      const long = cloneNotificationFor({ ...clone, url });
      expect(long.canAnswerHere, url).toBe(false);
      expect(long.body).toMatch(/open the window/);
      expect(long.body).not.toContain('example.com');
    }
  });

  it('offers no buttons, and says nothing of them, when the name of the folder or of the working folder is not plain, whatever the address is', () => {
    for (const change of [{ folder: 'a\u{200B}b' }, { folder: 'a\u{202E}b' }, { folder: 'two words' }, { folder: 'a\nb' }, { folder: '' }, { workspace: 'My\u{202E}desk' }, { workspace: 'two\nlines' }]) {
      const shown = cloneNotificationFor({ ...clone, ...change });
      expect(shown.canAnswerHere, JSON.stringify(change)).toBe(false);
      expect(shown.body).toMatch(/open the window/);
    }
  });

  it('offers them for an address of exactly the most that a notification takes', () => {
    expect(cloneNotificationFor({ ...clone, url: `https://e.com/${'p'.repeat(NOTIFIABLE_URL_CHARS - 14)}` }).canAnswerHere).toBe(true);
  });

  it('is answered from the notification, which is then taken away, and a click only opens the window', async () => {
    const { desk: approvals, notifier, openWindow } = desk();
    const answer = approvals.askToClone(clone, new AbortController().signal);
    expect(notifier.shown[0]?.actions.map((action) => action.id)).toEqual(['approve', 'deny']);
    notifier.shown[0]?.onClick();
    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(approvals.current).toHaveLength(1);
    notifier.shown[0]?.onAction('deny');
    expect(await answer).toBe('denied');
    expect(notifier.closed).toEqual(notifier.shown);
  });

  it('is denied, and taken away, when the signal aborts, and at once when it already has', async () => {
    const { desk: approvals, notifier } = desk();
    const controller = new AbortController();
    const answer = approvals.askToClone(clone, controller.signal);
    controller.abort();
    expect(await answer).toBe('denied');
    expect(approvals.current).toEqual([]);
    expect(notifier.closed).toEqual(notifier.shown);
    expect(approvals.answer('task-1', 'ask-1', 'approved')).toBe(false);
    expect(await approvals.askToClone(clone, controller.signal)).toBe('denied');
    expect(notifier.shown).toHaveLength(1);
  });

  it('keeps two clones of one task apart, and does not take a clone for the task asking again', async () => {
    const { desk: approvals } = desk();
    const first = approvals.askToClone(clone, new AbortController().signal);
    const second = approvals.askToClone({ ...clone, url: 'https://github.com/acme/other.git', folder: 'other' }, new AbortController().signal);
    const task = approvals.ask(request, new AbortController().signal);
    expect(approvals.current).toHaveLength(3);
    expect(approvals.answer('task-1', 'ask-2', 'approved')).toBe(true);
    expect(await second).toBe('approved');
    approvals.ask(request, new AbortController().signal);
    expect(await task).toBe('denied');
    expect(approvals.current.map((pending) => pending.askId)).toEqual(['ask-1', 'ask-4']);
    approvals.denyAll();
    expect(await first).toBe('denied');
  });
});
