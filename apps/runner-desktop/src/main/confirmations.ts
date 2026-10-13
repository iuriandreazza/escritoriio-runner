import type { Confirmations, DeviceView } from '@escritoriio/runner';
import { describePairQuestion } from '@escritoriio/runner';
import { describeFolderForDialog } from './folder-words.ts';

/** A question that a native dialog asks: what it is about, what each answer is called, and the exact text that is being agreed to. */
export interface ConfirmRequest {
  readonly title: string;
  readonly message: string;
  /** The text itself, whole: what is shown is what is agreed to. */
  readonly detail: string;
  readonly yes: string;
  readonly no: string;
}

export interface ConfirmDialog {
  confirm(request: ConfirmRequest): Promise<boolean>;
}

/**
 * The options of the native box for a question. No comes first and is both what is chosen by default (Enter) and what Escape and a closed window
 * mean: nothing is agreed to by accident. It is a dialog of the main process, which no page can draw, press or dismiss.
 */
export function boxOptions({ title, message, detail, yes, no }: ConfirmRequest) {
  return { type: 'question' as const, title, message, detail, buttons: [no, yes], defaultId: 0, cancelId: 0, noLink: true };
}

/**
 * What a set-up dialog shows of an MCP server: what runs, where and with which variables (all of it, as the command line shows it), and then two short
 * lines in place of the explanation that the command line prints after a blank line. Lines with no such blank line are shown whole.
 */
function mcpSetUpDetail(lines: readonly string[]): string {
  const end = lines.indexOf('');
  if (end === -1) return lines.join('\n');
  return [...lines.slice(0, end), 'It runs as you, and nothing contains it: it can do what you can.', 'No tool is available to the office until you approve it, in MCP servers.'].join('\n');
}

/** The prompt that a terminal shows after a question (`Share this folder? [y/N] `) is the dialog's message, without the way to answer. */
const questionOf = (prompt: string): string => prompt.replace(/\s*\[y\/N\]\s*$/i, '').trim();

/**
 * The questions the runner puts to the owner, as native dialogs. This is the one place a change that widens what the machine does is agreed to: the
 * runner asks every time a folder is shared or its sharing changed, and a server or a tool is set up or approved, and nothing it does can go round it.
 */
export function createConfirmations(dialog: ConfirmDialog): Confirmations {
  return {
    pair: (question) =>
      dialog.confirm({
        title: 'Pair this machine?',
        message: describePairQuestion(question),
        detail: 'The names are the office’s own words. Only a yes uses the code up.',
        yes: 'Pair',
        no: 'Do not pair',
      }),
    shareFolder: (question) =>
      dialog.confirm({
        ...(question.folder.kind === 'workspace'
          ? { title: 'Make a working folder?', message: `Make the empty folder "${question.folder.label}" for ${question.aiMember} to build in?`, yes: 'Make folder', no: 'Do not make it' }
          : { title: 'Share this folder?', message: `Share the folder "${question.folder.label}" with ${question.aiMember}?`, yes: 'Share folder', no: 'Do not share' }),
        detail: describeFolderForDialog(question).join('\n'),
      }),
    setUpMcpServer: (question) => dialog.confirm({ title: 'Set up an MCP server?', message: questionOf(question.prompt), detail: mcpSetUpDetail(question.lines), yes: 'Set up', no: 'Do not set up' }),
    approveMcpTool: (question) => dialog.confirm({ title: 'Let the office use a tool?', message: questionOf(question.prompt), detail: question.lines.join('\n'), yes: 'Approve', no: 'Do not approve' }),
  };
}

export const weakStorageRequest = (): ConfirmRequest => ({
  title: 'Keep the token without system protection?',
  message: 'This system has no keyring to protect the token of this machine.',
  detail: [
    'The token would be kept in a file that only you can read, sealed with a fixed key that is not secret: any program running as you can read it.',
    'You are asked every time. If you do not, nothing is paired and no code is used.',
  ].join('\n'),
  yes: 'Keep it anyway',
  no: 'Do not pair',
});

export const importRequest = (device: DeviceView): ConfirmRequest => ({
  title: 'Use the pairing of the command line?',
  message: `The command line of this machine is paired with ${device.agentName} of ${device.workspaceName} at ${device.host}.`,
  detail: [
    `It is called "${device.deviceName}". The app keeps its token in the system’s protected storage.`,
    'If you move it, the file of the command line that holds the token is deleted: the command line has to pair again.',
    'If you do not, the app starts unpaired and the command line stays as it is.',
  ].join('\n'),
  yes: 'Move it to the app',
  no: 'Leave it as it is',
});

export const launchAtLoginRequest = (): ConfirmRequest => ({
  title: 'Open Escritoriio Runner when you log in?',
  message: 'Open the app when you log in to this computer?',
  detail: 'The app starts by itself when you log in and connects this machine to your office. It runs tasks only in the folders you shared. You can turn it off in Settings.',
  yes: 'Open at login',
  no: 'Not now',
});

export const updateRequest = (version: string): ConfirmRequest => ({
  title: 'Update the app?',
  message: `Download version ${version} of Escritoriio Runner?`,
  detail: 'It comes from the public releases of the runner. The signature is checked only where the system checks one (macOS); elsewhere, the checksum published with the release. Nothing is installed until you say so.',
  yes: 'Download',
  no: 'Not now',
});

export const restartRequest = (version: string): ConfirmRequest => ({
  title: 'Restart to install the update?',
  message: `Version ${version} is downloaded. Restart the app to install it?`,
  detail: 'A task that is running is stopped when the app restarts.',
  yes: 'Restart and install',
  no: 'Later',
});
