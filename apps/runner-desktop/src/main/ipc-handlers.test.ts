import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Runner } from '@escritoriio/runner';
import { createRunner, STATE_DIRECTORY_VARIABLE } from '@escritoriio/runner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFUSED } from '../shared/channels.ts';
import { APP_ENTRY_URL } from './app-url.ts';
import { ApprovalDesk } from './approval-desk.ts';
import type { ConfirmRequest } from './confirmations.ts';
import { createConfirmations } from './confirmations.ts';
import type { HandlerDeps } from './ipc-handlers.ts';
import { createHandlers } from './ipc-handlers.ts';
import { createRouter } from './ipc-router.ts';
import { PendingLink } from './pair-link.ts';
import { createUpdateService } from './update-service.ts';
import { describeFolderForDialog } from './folder-words.ts';

let home: string;
let site: string;
let runner: Runner;
let asked: ConfirmRequest[];
let answer: boolean;
let picked: string | undefined;
const startConnection = vi.fn(() => ({ started: true }));

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'escritoriio-desktop-handlers-')));
  site = join(home, 'work', 'site');
  await mkdir(site, { recursive: true });
  asked = [];
  answer = true;
  picked = site;
  startConnection.mockClear();
  const dialog = {
    confirm: (request: ConfirmRequest) => {
      asked.push(request);
      return Promise.resolve(answer);
    },
  };
  runner = await createRunner({ env: { [STATE_DIRECTORY_VARIABLE]: join(home, 'state'), PATH: process.env.PATH ?? '' }, confirmations: createConfirmations(dialog) });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(`${join(home, 'state')}-worktrees`, { recursive: true, force: true });
});

function routerFor(overrides: Partial<HandlerDeps> = {}) {
  const pendingLink = new PendingLink();
  const deps: HandlerDeps = {
    runner,
    approvals: new ApprovalDesk({ notifier: { show: () => ({ close: () => undefined }) }, openWindow: () => undefined }),
    pendingLink,
    pickers: { folder: () => Promise.resolve(picked), program: () => Promise.resolve(undefined) },
    updates: createUpdateService({ port: undefined, dialog: { confirm: () => Promise.resolve(false) }, log: () => undefined }),
    launch: { supported: false, get: () => Promise.resolve(false), set: () => Promise.resolve(false) },
    info: { appVersion: '0.0.0', platform: 'darwin', updatesSupported: false },
    startConnection,
    signal: new AbortController().signal,
    ...overrides,
  };
  const router = createRouter({ handlers: createHandlers(deps), log: () => undefined });
  const call = (channel: string, payload: unknown = {}) => router.handle({ fromOurWindow: true, isMainFrame: true, frameUrl: APP_ENTRY_URL }, { channel, payload });
  return { call, deps, pendingLink };
}

const share = { access: 'read-only', approval: 'ask', isolation: 'in-place', trusted: false, agent: null } as const;

describe('adding a folder', () => {
  it('opens the system’s picker in the main process, then asks the owner in a native dialog with the exact words, and only a yes keeps it', async () => {
    const { call } = routerFor();
    const answered = await call('folders:add', { ...share, label: 'site' });
    expect(answered).toMatchObject({ ok: true, value: { added: true, label: 'site' } });
    expect(asked).toHaveLength(1);
    const [folder] = await runner.folders.list();
    expect(asked[0]?.detail).toBe(describeFolderForDialog({ folder: folder!.folder, aiMember: 'your AI member' }).join('\n'));
    expect(asked[0]?.detail).toContain(site);
    expect(asked[0]?.no).toBeTruthy();
  });

  it('keeps nothing on a no', async () => {
    answer = false;
    const { call } = routerFor();
    expect(await call('folders:add', { ...share })).toMatchObject({ ok: true, value: { added: false } });
    expect(await runner.folders.list()).toEqual([]);
  });

  it('does not ask, and keeps nothing, when no folder is picked', async () => {
    picked = undefined;
    const { call } = routerFor();
    expect(await call('folders:add', { ...share })).toMatchObject({ ok: true, value: { added: false, message: expect.stringMatching(/no folder/i) } });
    expect(asked).toEqual([]);
  });

  it('never takes the place from the window: a request that names one is refused before anything is opened', async () => {
    const pickFolder = vi.fn(() => Promise.resolve(site));
    const { call } = routerFor({ pickers: { folder: pickFolder, program: () => Promise.resolve(undefined) } });
    expect(await call('folders:add', { ...share, path: '/' })).toEqual({ ok: false, error: REFUSED });
    expect(pickFolder).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
    expect(await runner.folders.list()).toEqual([]);
  });
});

describe('making a working folder', () => {
  const make = { name: 'build', approval: 'ask', trusted: false, agent: null } as const;
  let parent: string;
  beforeEach(async () => {
    parent = join(home, 'work');
    picked = parent;
  });

  it('opens the picker of the main process for the folder to make it in, asks in a native dialog with the exact words, and only then makes and shares it', async () => {
    const pickFolder = vi.fn((purpose: string) => Promise.resolve(purpose === 'parent' ? picked : undefined));
    const { call } = routerFor({ pickers: { folder: pickFolder, program: () => Promise.resolve(undefined) } });
    expect(await call('folders:new-workspace', make)).toMatchObject({ ok: true, value: { added: true, label: 'build' } });
    expect(pickFolder).toHaveBeenCalledWith('parent');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.title).toBe('Make a working folder?');
    const [folder] = await runner.folders.list();
    expect(folder?.folder).toMatchObject({ label: 'build', path: join(parent, 'build'), access: 'edit', isolation: 'in-place', approval: 'ask', kind: 'workspace' });
    expect(asked[0]?.detail).toBe(describeFolderForDialog({ folder: folder!.folder, aiMember: 'your AI member' }).join('\n'));
    expect(await readdir(join(parent, 'build'))).toEqual([]);
  });

  it('makes nothing on a no, and nothing when no folder is picked', async () => {
    answer = false;
    const { call } = routerFor();
    expect(await call('folders:new-workspace', make)).toMatchObject({ ok: true, value: { added: false } });
    expect(await readdir(parent)).not.toContain('build');
    expect(await runner.folders.list()).toEqual([]);
    answer = true;
    picked = undefined;
    asked.length = 0;
    expect(await call('folders:new-workspace', make)).toMatchObject({ ok: true, value: { added: false, message: expect.stringMatching(/no folder/i) } });
    expect(asked).toEqual([]);
  });

  it.each(['..', '../escape', 'a/b', '.hidden', 'con'])('refuses the name %j with the runner’s words, and makes nothing', async (name) => {
    const { call } = routerFor();
    const refused = await call('folders:new-workspace', { ...make, name });
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/folder name/i) });
    expect(asked).toEqual([]);
    expect(await runner.folders.list()).toEqual([]);
  });

  it('refuses a folder that is there already, and leaves what is there as it was', async () => {
    await mkdir(join(parent, 'build'));
    const { call } = routerFor();
    expect(await call('folders:new-workspace', make)).toMatchObject({ ok: false, error: expect.stringMatching(/there already/) });
    expect(await readdir(join(parent, 'build'))).toEqual([]);
    expect(await runner.folders.list()).toEqual([]);
  });

  it('never takes the place, the access or the isolation from the window, and does not open the picker for such a request', async () => {
    const pickFolder = vi.fn(() => Promise.resolve(picked));
    const { call } = routerFor({ pickers: { folder: pickFolder, program: () => Promise.resolve(undefined) } });
    for (const extra of [{ path: '/' }, { parent: '/' }, { access: 'read-only' }, { isolation: 'worktree' }]) {
      expect(await call('folders:new-workspace', { ...make, ...extra })).toEqual({ ok: false, error: REFUSED });
    }
    expect(pickFolder).not.toHaveBeenCalled();
  });

  it('is refused for a caller that is not the window of the app', async () => {
    const { deps } = routerFor();
    const router = createRouter({ handlers: createHandlers(deps), log: () => undefined });
    const wire = { channel: 'folders:new-workspace', payload: make };
    expect(await router.handle({ fromOurWindow: false, isMainFrame: true, frameUrl: APP_ENTRY_URL }, wire)).toEqual({ ok: false, error: REFUSED });
    expect(await router.handle({ fromOurWindow: true, isMainFrame: false, frameUrl: APP_ENTRY_URL }, wire)).toEqual({ ok: false, error: REFUSED });
    expect(await router.handle({ fromOurWindow: true, isMainFrame: true, frameUrl: 'https://evil.example/' }, wire)).toEqual({ ok: false, error: REFUSED });
    expect(await runner.folders.list()).toEqual([]);
  });

  it('refuses to change a working folder to read only or to a copy, in the runner’s words', async () => {
    const { call } = routerFor();
    await call('folders:new-workspace', make);
    asked.length = 0;
    for (const changes of [{ access: 'read-only' }, { isolation: 'worktree' }]) {
      expect(await call('folders:update', { label: 'build', changes })).toMatchObject({ ok: false, error: expect.stringMatching(/always edited in place/) });
    }
    expect(asked).toEqual([]);
  });
});

describe('widening what is shared', () => {
  async function shared() {
    const { call } = routerFor();
    await call('folders:add', { ...share, label: 'site' });
    asked.length = 0;
    return call;
  }

  it.each([
    ['access edit', { access: 'edit' }],
    ['trusted', { trusted: true }],
    ['approval auto, without asking each time', { approval: 'auto' }],
  ])('puts the new words to the owner in a native dialog before it is kept: %s', async (_name, changes) => {
    const call = await shared();
    expect(await call('folders:update', { label: 'site', changes })).toMatchObject({ ok: true, value: { updated: true } });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.detail).toContain('Folder "site"');
  });

  it('changes nothing on a no, and the window cannot answer for the owner', async () => {
    const call = await shared();
    answer = false;
    expect(await call('folders:update', { label: 'site', changes: { access: 'edit', trusted: true, approval: 'auto' } })).toMatchObject({ ok: true, value: { updated: false } });
    const [folder] = await runner.folders.list();
    expect(folder?.folder).toMatchObject({ access: 'read-only', approval: 'ask', trusted: false });
  });

  it('removes a folder without asking, since less is shared afterwards', async () => {
    const call = await shared();
    expect(await call('folders:remove', { label: 'site' })).toMatchObject({ ok: true, value: { label: 'site' } });
    expect(asked).toEqual([]);
    expect(await runner.folders.list()).toEqual([]);
  });
});

describe('where a coding agent is', () => {
  it('is picked in the system’s file dialog and never named by the window', async () => {
    const program = vi.fn(() => Promise.resolve(undefined));
    const { call } = routerFor({ pickers: { folder: () => Promise.resolve(undefined), program } });
    expect(await call('agents:set-path', { kind: 'claude-code' })).toMatchObject({ ok: true, value: { picked: false } });
    expect(program).toHaveBeenCalledWith('claude-code');
    expect(await call('agents:set-path', { kind: 'claude-code', path: '/bin/sh' })).toEqual({ ok: false, error: REFUSED });
  });
});

describe('pairing', () => {
  it('uses the link that waits by its id, with the code kept in the main process, and refuses an id that is not waiting', async () => {
    const pair = vi.fn(() => Promise.resolve({ paired: false as const }));
    const fakeRunner = { ...runner, pairing: { current: runner.pairing.current, pair } } as unknown as Runner;
    const { call, pendingLink } = routerFor({ runner: fakeRunner });
    const shown = pendingLink.hold({ server: 'https://office.example', code: 'ABCDEFGH' });
    expect(await call('pairing:pending-link')).toEqual({ ok: true, value: shown });
    expect(JSON.stringify(shown)).not.toContain('ABCDEFGH');

    expect(await call('pairing:pair', { linkId: 'not-waiting' })).toMatchObject({ ok: false, error: expect.stringMatching(/not waiting|open it again/i) });
    expect(pair).not.toHaveBeenCalled();

    expect(await call('pairing:pair', { linkId: shown.linkId })).toMatchObject({ ok: true, value: { paired: false } });
    expect(pair).toHaveBeenCalledWith({ input: ['https://office.example', 'ABCDEFGH'] });
    // Not paired: the link waits, so that the owner can decide again.
    expect(pendingLink.current()).toEqual(shown);
    expect(startConnection).not.toHaveBeenCalled();
  });

  it('uses up the link and connects once the machine is paired', async () => {
    const pair = vi.fn(() => Promise.resolve({ paired: true as const, host: 'office.example', agentName: 'Ana', workspaceName: 'Acme', deviceName: 'Laptop' }));
    const fakeRunner = { ...runner, pairing: { current: runner.pairing.current, pair } } as unknown as Runner;
    const { call, pendingLink } = routerFor({ runner: fakeRunner });
    const shown = pendingLink.hold({ server: 'https://office.example', code: 'ABCDEFGH' });
    expect(await call('pairing:pair', { linkId: shown.linkId })).toMatchObject({ ok: true, value: { paired: true, agentName: 'Ana' } });
    expect(pendingLink.current()).toBeNull();
    expect(startConnection).toHaveBeenCalledTimes(1);
  });

  it('takes what the owner typed as it is, for the runner to read', async () => {
    const pair = vi.fn(() => Promise.resolve({ paired: false as const }));
    const fakeRunner = { ...runner, pairing: { current: runner.pairing.current, pair } } as unknown as Runner;
    const { call } = routerFor({ runner: fakeRunner });
    await call('pairing:pair', { server: 'office.example', code: 'ABCD-EFGH', deviceName: 'Laptop' });
    expect(pair).toHaveBeenCalledWith({ input: ['office.example', 'ABCD-EFGH'], deviceName: 'Laptop' });
  });
});

describe('the approvals of the window', () => {
  it('answers the task that waits, by its id', async () => {
    const { call, deps } = routerFor();
    const waiting = deps.approvals.ask({ taskId: 't1', folder: 'site', access: 'edit', instruction: 'Do the thing' }, new AbortController().signal);
    expect(await call('approvals:list')).toMatchObject({ ok: true, value: [{ taskId: 't1', instruction: 'Do the thing' }] });
    const askId = deps.approvals.current[0]!.askId;
    expect(await call('approvals:answer', { taskId: 't1', askId: 'another-ask', answer: 'approved' })).toEqual({ ok: true, value: { answered: false } });
    expect(await call('approvals:answer', { taskId: 't1', askId, answer: 'approved' })).toEqual({ ok: true, value: { answered: true } });
    expect(await waiting).toBe('approved');
    expect(await call('approvals:answer', { taskId: 't1', askId, answer: 'approved' })).toEqual({ ok: true, value: { answered: false } });
  });
});

describe('the rest of what the window asks for', () => {
  it('reads the connection and the tasks, pauses and resumes, and runs the doctor', async () => {
    const { call } = routerFor();
    expect(await call('connection:get')).toMatchObject({ ok: true, value: { state: 'not-paired', paused: false } });
    expect(await call('tasks:get')).toEqual({ ok: true, value: { running: [], recent: [] } });
    expect(await call('pause:set', { paused: true })).toEqual({ ok: true, value: { changed: true } });
    expect(await call('connection:get')).toMatchObject({ ok: true, value: { paused: true, pausedHere: true } });
    expect(await call('pause:set', { paused: false })).toEqual({ ok: true, value: { changed: true } });
    const doctor = await call('doctor:run');
    expect(doctor).toMatchObject({ ok: true, value: { checks: expect.any(Array) } });
    expect(await call('mcp:list')).toEqual({ ok: true, value: [] });
    expect(await call('agents:inspect')).toMatchObject({ ok: true, value: expect.any(Array) });
  });

  it('tells the version, and what this system can do', async () => {
    const { call } = routerFor();
    expect(await call('app:info')).toMatchObject({ ok: true, value: { appVersion: '0.0.0', platform: 'darwin', launchAtLoginSupported: false, updatesSupported: false } });
    expect(await call('app:check-update')).toMatchObject({ ok: true, value: { state: 'unavailable' } });
  });

  it('starts the connection through the one place that knows how', async () => {
    const { call } = routerFor();
    expect(await call('connection:start')).toEqual({ ok: true, value: { started: true } });
    expect(startConnection).toHaveBeenCalledTimes(1);
  });
});
