import type { FolderQuestion, PairQuestion } from '@escritoriio/runner';
import { describePairQuestion } from '@escritoriio/runner';
import { describeFolderForDialog } from './folder-words.ts';
import { describe, expect, it, vi } from 'vitest';
import type { ConfirmRequest } from './confirmations.ts';
import { boxOptions, createConfirmations, importRequest, launchAtLoginRequest, restartRequest, updateRequest, weakStorageRequest } from './confirmations.ts';

const folderQuestion: FolderQuestion = {
  aiMember: 'Ana',
  folder: { label: 'site', path: '/Users/me/site', realPath: '/Users/me/site', access: 'edit', approval: 'auto', isolation: 'in-place', trusted: true, agent: null },
};
const pairQuestion: PairQuestion = { host: 'office.example', agentName: 'Ana', workspaceName: 'Acme', deviceName: 'Laptop' };

function confirmationsAnswering(answer: boolean) {
  const confirm = vi.fn((request: ConfirmRequest) => {
    void request;
    return Promise.resolve(answer);
  });
  return { confirmations: createConfirmations({ confirm }), confirm };
}

describe('the questions that decide something', () => {
  it('shows the short words of what sharing a folder means, with every fact that widens it, and says what the answers are', async () => {
    const { confirmations, confirm } = confirmationsAnswering(true);
    expect(await confirmations.shareFolder(folderQuestion)).toBe(true);
    const request = confirm.mock.calls[0]?.[0];
    expect(request?.detail).toBe(describeFolderForDialog(folderQuestion).join('\n'));
    expect(request?.detail).toMatch(/shell that can read the rest of this machine/);
    expect(request?.detail).toMatch(/everything your user account can reach/);
    expect(request?.detail).toMatch(/files themselves/);
    expect(request?.detail).toMatch(/without asking/);
    expect(request?.detail).toContain('/Users/me/site');
    expect(request?.no).toMatch(/not|cancel/i);
  });

  it('asks to make a working folder in its own words, with the same short facts, before anything is made', async () => {
    const { confirmations, confirm } = confirmationsAnswering(false);
    const question = { ...folderQuestion, folder: { ...folderQuestion.folder, kind: 'workspace' as const } };
    expect(await confirmations.shareFolder(question)).toBe(false);
    const request = confirm.mock.calls[0]?.[0];
    expect(request?.title).toBe('Make a working folder?');
    expect(request?.message).toBe('Make the empty folder "site" for Ana to build in?');
    expect(request?.detail).toBe(describeFolderForDialog(question).join('\n'));
    expect(request?.detail).toMatch(/create folders inside without asking/);
    expect(request?.yes).toBe('Make folder');
    expect(request?.no).toMatch(/not/i);
  });

  it('shows the office’s own words, with the address first, before a pairing code is used up', async () => {
    const { confirmations, confirm } = confirmationsAnswering(true);
    await confirmations.pair(pairQuestion);
    const request = confirm.mock.calls[0]?.[0];
    expect(`${request?.message}\n${request?.detail}`).toContain(describePairQuestion(pairQuestion));
    expect(request?.detail).toMatch(/only a yes|nothing is used up/i);
  });

  it('shows the whole question of an MCP server and of a tool, without the prompt meant for a terminal', async () => {
    const { confirmations, confirm } = confirmationsAnswering(false);
    expect(await confirmations.setUpMcpServer({ lines: ['Server "git"', 'runs: npx git-server'], prompt: 'Set this server up? [y/N] ' })).toBe(false);
    expect(await confirmations.approveMcpTool({ lines: ['Tool "push"'], prompt: 'Let the office use "push"? [y/N] ' })).toBe(false);
    expect(confirm.mock.calls[0]?.[0].detail).toBe('Server "git"\nruns: npx git-server');
    expect(confirm.mock.calls[0]?.[0].message).toBe('Set this server up?');
    expect(confirm.mock.calls[1]?.[0].detail).toBe('Tool "push"');
    expect(confirm.mock.calls[1]?.[0].message).toBe('Let the office use "push"?');
  });

  it('keeps what runs, whole, and says in two lines that it is not contained, instead of the long explanation of the command line', async () => {
    const { confirmations, confirm } = confirmationsAnswering(true);
    await confirmations.setUpMcpServer({ lines: ['MCP server "git":', '  runs: npx', '  in:           nowhere', '', 'What this means:', '- a long explanation', '- another'], prompt: 'Set this server up? [y/N] ' });
    const detail = confirm.mock.calls[0]?.[0].detail ?? '';
    expect(detail).toContain('MCP server "git":\n  runs: npx\n  in:           nowhere');
    expect(detail).toMatch(/runs as you, and nothing contains it/);
    expect(detail).toMatch(/until you approve it/);
    expect(detail).not.toMatch(/long explanation/);
  });

  it('is a no whenever the dialog says no', async () => {
    const { confirmations } = confirmationsAnswering(false);
    expect(await confirmations.pair(pairQuestion)).toBe(false);
    expect(await confirmations.shareFolder(folderQuestion)).toBe(false);
  });
});

describe('every dialog of the app', () => {
  const requests: [string, ConfirmRequest][] = [
    ['sharing a folder', { title: 'Share this folder?', message: 'm', detail: 'd', yes: 'Share', no: 'Do not share' }],
    ['keeping the token without protection', weakStorageRequest()],
    ['moving the pairing of the command line', importRequest({ host: 'office.example', deviceName: 'Laptop', agentName: 'Ana', workspaceName: 'Acme' })],
    ['opening at login', launchAtLoginRequest()],
    ['an update', updateRequest('1.2.3')],
    ['restarting to install', restartRequest('1.2.3')],
  ];

  it.each(requests)('has no as the button that is chosen by default and by escape: %s', (_name, request) => {
    const options = boxOptions(request);
    expect(options.buttons).toEqual([request.no, request.yes]);
    expect(options.defaultId).toBe(0);
    expect(options.cancelId).toBe(0);
    expect(options.noLink).toBe(true);
    expect(options.detail).toBe(request.detail);
  });

  it('says in words what each choice costs', () => {
    expect(weakStorageRequest().detail).toMatch(/not encrypted|no protection|fixed key|any program/i);
    const move = importRequest({ host: 'office.example', deviceName: 'Laptop', agentName: 'Ana', workspaceName: 'Acme' });
    expect(move.detail).toMatch(/command line/i);
    expect(move.detail).toMatch(/no longer|pair again|deleted/i);
    expect(launchAtLoginRequest().detail).toMatch(/log in/i);
    expect(updateRequest('1.2.3').message).toContain('1.2.3');
    expect(weakStorageRequest().detail).toMatch(/asked again|every time/i);
    const update = updateRequest('1.2.3').detail;
    expect(update).toMatch(/signature is checked only where the system checks one \(macOS\)/);
    expect(update).toMatch(/Nothing is installed until you say so/);
    expect(update).toMatch(/checksum/i);
    expect(update).not.toMatch(/and its signature is checked\./);
  });
});
