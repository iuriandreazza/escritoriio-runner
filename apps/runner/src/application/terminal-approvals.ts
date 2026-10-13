import { isYes } from '../domain/answer.ts';
import { cleanText } from '../domain/clean-text.ts';
import { plainText } from '../domain/plain-text.ts';
import type { ApprovalAnswer, ApprovalPort } from './approvals.ts';
import type { Terminal } from './ports.ts';

const PROMPT = 'Approve it and run it? [y/N] ';
const CLONE_PROMPT = 'Clone it? [y/N] ';

/**
 * Asks at the terminal of a runner that is running, with the exact text in front of the person. The text came from the office: what hides
 * or rewrites text on a terminal is turned into spaces, and the person is told when that was done. Anything but a yes is a no, and a
 * question that is taken away, or an input that ended, is a no.
 */
export function createTerminalApprovals(terminal: Terminal): ApprovalPort {
  async function answerOf(prompt: string, signal: AbortSignal): Promise<ApprovalAnswer> {
    const answer = await terminal.ask(prompt, signal);
    if (signal.aborted) {
      terminal.out('The question is no longer needed: the task ended before it was answered.');
      return 'denied';
    }
    return isYes(answer) ? 'approved' : 'denied';
  }

  return {
    async ask(request, signal) {
      const shown = cleanText(request.instruction);
      terminal.out(`The folder "${plainText(request.folder, 64)}" (${request.access}) asks you to approve each task. The office asks for this one. This is the exact text the coding agent would be given:\n\n${shown}\n`);
      if (shown !== request.instruction) terminal.out('(Characters that hide or reorder text were shown as spaces.)');
      return answerOf(PROMPT, signal);
    },
    askToClone(request, signal) {
      terminal.out(`The AI member asks to clone a repository into the workspace "${plainText(request.workspace, 64)}".\n\n  Address: ${cleanText(request.url)}\n  Into the folder: "${plainText(request.folder, 64)}"\n`);
      return answerOf(CLONE_PROMPT, signal);
    },
  };
}
