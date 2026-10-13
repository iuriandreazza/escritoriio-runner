import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PairedDevice } from '@escritoriio/runner';
import { createFileDeviceStore, STATE_DIRECTORY_VARIABLE } from '@escritoriio/runner';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnerEvent } from '../shared/channels.ts';
import type { NotificationRequest } from './approval-desk.ts';
import type { ConfirmRequest } from './confirmations.ts';
import type { DesktopAppDeps } from './desktop-app.ts';
import { startDesktopApp } from './desktop-app.ts';
import type { SafeStorageLike } from './token-store.ts';

const device: PairedDevice = { server: 'http://127.0.0.1:9', deviceId: 'dev-1', token: 'secret-device-token-123', deviceName: 'Laptop', agentName: 'Ana', workspaceName: 'Acme' };

const storage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`sealed:${Buffer.from(text).toString('hex')}`),
  decryptString: (data) => Buffer.from(data.toString().slice('sealed:'.length), 'hex').toString(),
};

let state: string;
let pushed: RunnerEvent[];
let asked: ConfirmRequest[];
let answers: boolean[];
let notifications: NotificationRequest[];
let logged: string[];
let trayViews: string[];
let showWindow: Mock<() => void>;

beforeEach(async () => {
  state = join(await realpath(await mkdtemp(join(tmpdir(), 'escritoriio-desktop-app-'))), 'state');
  await mkdir(state, { recursive: true });
  pushed = [];
  asked = [];
  answers = [];
  notifications = [];
  logged = [];
  trayViews = [];
  showWindow = vi.fn<() => void>();
});

afterEach(async () => {
  await rm(join(state, '..'), { recursive: true, force: true });
  await rm(`${state}-worktrees`, { recursive: true, force: true });
});

function deps(overrides: Partial<DesktopAppDeps> = {}): DesktopAppDeps {
  return {
    env: { [STATE_DIRECTORY_VARIABLE]: state, PATH: process.env.PATH ?? '' },
    platform: 'darwin',
    packaged: false,
    appVersion: '0.0.0',
    storage,
    dialog: {
      confirm: (request) => {
        asked.push(request);
        return Promise.resolve(answers.shift() ?? false);
      },
      pickFolder: () => Promise.resolve(undefined),
      pickProgram: () => Promise.resolve(undefined),
    },
    notifier: {
      show: (notification) => {
        notifications.push(notification);
        return { close: () => undefined };
      },
    },
    window: { show: showWindow, push: (event) => void pushed.push(event as RunnerEvent) },
    tray: { show: (view) => void trayViews.push(view.state) },
    loginItems: { set: () => undefined },
    updater: undefined,
    quit: () => undefined,
    log: (line) => void logged.push(line),
    ...overrides,
  };
}

describe('the app starting with nothing paired', () => {
  it('shows not paired, asks nothing, and connects to nothing', async () => {
    const app = await startDesktopApp(deps());
    expect(trayViews.at(-1)).toBe('not-paired');
    expect(asked).toEqual([]);
    expect(app.runner.connection.current.state).toBe('not-paired');
    await app.shutdown();
  });

  it('tells the window of the connection when it changes, in what the table of events allows', async () => {
    const app = await startDesktopApp(deps());
    await app.runner.pause.set(true);
    expect(pushed.some((event) => event.kind === 'connection' && event.view.paused)).toBe(true);
    expect(trayViews.length).toBeGreaterThan(1);
    await app.shutdown();
  });
});

describe('a link that is opened', () => {
  it('opens the pairing in the window for review, and pairs nothing by itself', async () => {
    const app = await startDesktopApp(deps());
    app.openLink('escritoriio://pair?server=https%3A%2F%2Foffice.example&code=ABCD-EFGH');
    expect(showWindow).toHaveBeenCalledTimes(1);
    expect(pushed.find((event) => event.kind === 'pair-link')).toMatchObject({ host: 'office.example' });
    expect(JSON.stringify(pushed)).not.toContain('ABCDEFGH');
    expect(asked).toEqual([]);
    expect(app.runner.connection.current.state).toBe('not-paired');
    await app.shutdown();
  });

  it('ignores a link that is not exactly that, and logs it without the code', async () => {
    const app = await startDesktopApp(deps());
    app.openLink('escritoriio://folders/add?path=/&code=ZZZZZZZZ');
    app.openLink('escritoriio://pair?server=https://office.example&code=ZZZZZZZZ&allow=everything');
    expect(showWindow).not.toHaveBeenCalled();
    expect(pushed.filter((event) => event.kind === 'pair-link')).toEqual([]);
    expect(logged.length).toBe(2);
    expect(logged.join('\n')).not.toContain('ZZZZZZZZ');
    await app.shutdown();
  });
});

describe('the pairing of the command line', () => {
  it('is offered to the app, which leaves it as it is on a no', async () => {
    await createFileDeviceStore(state).save(device);
    answers = [false];
    const app = await startDesktopApp(deps());
    expect(asked).toHaveLength(1);
    expect(asked[0]?.no).toBeTruthy();
    expect(app.runner.connection.current.state).toBe('not-paired');
    expect(await readdir(state)).toContain('device.json');
    await app.shutdown();
  });

  it('is moved into the system’s protected storage on a yes, and is not asked about again', async () => {
    await createFileDeviceStore(state).save(device);
    answers = [true];
    const app = await startDesktopApp(deps());
    expect(app.runner.connection.current.device).toMatchObject({ agentName: 'Ana' });
    expect(await readdir(state)).not.toContain('device.json');
    expect(await readdir(state)).toContain('device.enc');
    await app.shutdown();
    asked.length = 0;
    const again = await startDesktopApp(deps());
    expect(asked).toEqual([]);
    await again.shutdown();
  });
});

describe('opening at login', () => {
  it('is asked on the first run of an installed app, and is off unless the owner says yes', async () => {
    const set = vi.fn();
    const app = await startDesktopApp(deps({ packaged: true, loginItems: { set } }));
    await app.firstRun;
    expect(asked).toHaveLength(1);
    expect(set).not.toHaveBeenCalled();
    await app.shutdown();
  });

  it('is not asked in a run from sources', async () => {
    const app = await startDesktopApp(deps());
    await app.firstRun;
    expect(asked).toEqual([]);
    await app.shutdown();
  });
});

describe('a task that waits for approval', () => {
  it('is listed for the window with its exact text, notified, and denied when the app quits', async () => {
    const app = await startDesktopApp(deps());
    const answer = app.approvals.ask({ taskId: 't1', folder: 'site', access: 'edit', instruction: 'Run the migration' }, new AbortController().signal);
    expect(pushed.at(-1)).toMatchObject({ kind: 'approvals', pending: [{ taskId: 't1', instruction: 'Run the migration' }] });
    expect(notifications).toHaveLength(1);
    await app.shutdown();
    expect(await answer).toBe('denied');
  });
});
