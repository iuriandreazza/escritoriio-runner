import { describe, expect, it } from 'vitest';
import { FakeTerminal } from '../testing/fake-terminal.ts';
import { createTerminalApprovals } from './terminal-approvals.ts';

const request = { taskId: 't1', folder: 'site', access: 'edit', instruction: 'Fix the typo\nin the README' } as const;
const never = new AbortController().signal;
const cloneRequest = { kind: 'clone', taskId: 't1', workspace: 'build', url: 'https://github.com/octocat/Hello-World.git', folder: 'Hello-World' } as const;

describe('approving at the terminal', () => {
  it('shows the exact text and the folder, and approves on a yes', async () => {
    const terminal = new FakeTerminal();
    terminal.answers = ['y'];
    expect(await createTerminalApprovals(terminal).ask(request, never)).toBe('approved');
    expect(terminal.stdout.join('\n')).toContain('The folder "site" (edit) asks you to approve each task.');
    expect(terminal.stdout.join('\n')).toContain('\n\nFix the typo\nin the README\n');
    expect(terminal.questions).toEqual(['Approve it and run it? [y/N] ']);
  });

  it.each([[''], ['n'], ['no'], ['maybe'], ['yes please, and then some']])('denies on %j', async (answer) => {
    const terminal = new FakeTerminal();
    terminal.answers = [answer];
    expect(await createTerminalApprovals(terminal).ask(request, never)).toBe('denied');
  });

  it('turns what rewrites text on a terminal into spaces, and says so', async () => {
    const terminal = new FakeTerminal();
    terminal.answers = ['n'];
    await createTerminalApprovals(terminal).ask({ ...request, instruction: 'Fix it\u001b[2J and ‮evil' }, never);
    const shown = terminal.stdout.join('\n');
    expect(shown).not.toContain('\u001b');
    expect(shown).not.toContain('‮');
    expect(shown).toContain('(Characters that hide or reorder text were shown as spaces.)');
  });

  it('denies, and says the question is gone, when the task ended before the person answered', async () => {
    const terminal = new FakeTerminal();
    terminal.holding = true;
    const stopping = new AbortController();
    const answered = createTerminalApprovals(terminal).ask(request, stopping.signal);
    stopping.abort();
    expect(await answered).toBe('denied');
    expect(terminal.stdout.join('\n')).toContain('no longer needed');
  });

  it('does not take a yes that comes after the task ended for an approval', async () => {
    const terminal = new FakeTerminal();
    terminal.holding = true;
    const stopping = new AbortController();
    const answered = createTerminalApprovals(terminal).ask(request, stopping.signal);
    stopping.abort();
    terminal.answerNow('y');
    expect(await answered).toBe('denied');
  });
});

describe('approving a clone at the terminal', () => {
  it('shows the exact address, the folder it goes into and the workspace, and approves on a yes', async () => {
    const terminal = new FakeTerminal();
    terminal.answers = ['y'];
    expect(await createTerminalApprovals(terminal).askToClone?.(cloneRequest, never)).toBe('approved');
    const shown = terminal.stdout.join('\n');
    expect(shown).toContain('The AI member asks to clone a repository into the workspace "build".');
    expect(shown).toContain('https://github.com/octocat/Hello-World.git');
    expect(shown).toContain('"Hello-World"');
    expect(terminal.questions).toEqual(['Clone it? [y/N] ']);
  });

  it.each([[''], ['n'], ['maybe']])('denies on %j', async (answer) => {
    const terminal = new FakeTerminal();
    terminal.answers = [answer];
    expect(await createTerminalApprovals(terminal).askToClone?.(cloneRequest, never)).toBe('denied');
  });

  it('shows nothing that rewrites a terminal, whatever the address held', async () => {
    const terminal = new FakeTerminal();
    terminal.answers = ['n'];
    await createTerminalApprovals(terminal).askToClone?.({ ...cloneRequest, url: 'https://github.com/a/b\u001b[2J' }, never);
    expect(terminal.stdout.join('\n')).not.toContain('\u001b');
  });

  it('denies, and says the question is gone, when the task ended before the person answered', async () => {
    const terminal = new FakeTerminal();
    terminal.holding = true;
    const stopping = new AbortController();
    const answered = createTerminalApprovals(terminal).askToClone?.(cloneRequest, stopping.signal);
    stopping.abort();
    terminal.answerNow('y');
    expect(await answered).toBe('denied');
    expect(terminal.stdout.join('\n')).toContain('no longer needed');
  });
});
