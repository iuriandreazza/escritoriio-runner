import type { CodingAgentKind } from '@escritoriio/runner-protocol';
import { BrowserWindow, dialog } from 'electron';
import type { ConfirmRequest } from '../confirmations.ts';
import { boxOptions } from '../confirmations.ts';
import { createDialogGate } from '../dialog-gate.ts';
import type { FolderPurpose } from '../ipc-handlers.ts';

const WORDS_OF_PICKER = {
  share: { title: 'Choose the folder to share', buttonLabel: 'Choose folder' },
  parent: { title: 'Choose the folder to make the working folder in', buttonLabel: 'Choose folder' },
} as const;

const parent = (): BrowserWindow | undefined => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];

// Every dialog of the app goes through one line: a compromised window that asks for them in a loop is shown one at a time, never two of a kind, and a no is not asked again at once.
const gate = createDialogGate({ now: Date.now });

/** The system's own dialogs: drawn by the main process, so that no page can draw, press or dismiss one. */
export const nativeDialogs = {
  confirm(request: ConfirmRequest): Promise<boolean> {
    return gate.run(`confirm:${request.title}`, false, async () => {
      const options = boxOptions(request);
      const window = parent();
      const { response } = window ? await dialog.showMessageBox(window, { ...options, buttons: [...options.buttons] }) : await dialog.showMessageBox({ ...options, buttons: [...options.buttons] });
      return response === 1;
    });
  },

  pickFolder(purpose: FolderPurpose): Promise<string | undefined> {
    return gate.run<string | undefined>('pick-folder', undefined, async () => {
      const options = { ...WORDS_OF_PICKER[purpose], properties: ['openDirectory' as const] };
      const window = parent();
      const { canceled, filePaths } = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return canceled ? undefined : filePaths[0];
    });
  },

  pickProgram(kind: CodingAgentKind): Promise<string | undefined> {
    return gate.run<string | undefined>('pick-program', undefined, async () => {
      const options = { title: `Choose where ${kind} is`, buttonLabel: 'Choose', properties: ['openFile' as const] };
      const window = parent();
      const { canceled, filePaths } = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return canceled ? undefined : filePaths[0];
    });
  },
};
