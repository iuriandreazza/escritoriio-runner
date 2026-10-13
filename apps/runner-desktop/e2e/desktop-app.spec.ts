import { execFile } from 'node:child_process';
import type { IncomingMessage, Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron, expect, test } from '@playwright/test';

const appDirectory = join(import.meta.dirname, '..');
const ENTRY_URL = 'escritoriio-app://app/index.html';
// The binary of Electron that this package installed: the app is run by it, from its built folder.
const electronBinary = createRequire(import.meta.url)('electron') as string;

const run = promisify(execFile);

let scratch: string;
let app: ElectronApplication;
let page: Page;

// A state directory of its own, so that the app never meets the settings or the single-instance lock of one installed on this machine.
const environment = () => ({ ...process.env, ESCRITORIIO_RUNNER_HOME: join(scratch, 'state') });

const callOf = (channel: string, request: unknown) =>
  page.evaluate(([name, payload]) => (window as unknown as { escritoriioRunner: { call(c: string, r: unknown): Promise<unknown> } }).escritoriioRunner.call(name as string, payload), [channel, request] as const);

test.beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'escritoriio-desktop-e2e-'));
  app = await electron.launch({ executablePath: electronBinary, args: [appDirectory, '--disable-gpu'], env: environment() });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterEach(async () => {
  await app.close();
  await rm(scratch, { recursive: true, force: true });
  await rm(join(scratch, 'state-worktrees'), { recursive: true, force: true });
});

test.describe('H4 the desktop app', () => {
  test('H4 loads only its own bundle and the page reaches the runner through the preload', async () => {
    expect(page.url()).toBe(ENTRY_URL);
    await expect(page.getByRole('heading', { name: 'Escritoriio Runner' })).toBeVisible();
    // The answer of the main process to a call of the page: this machine is not paired.
    await expect(page.getByRole('status', { name: 'Connection status' })).toHaveText('Not paired');
  });

  test('H4 gives the page no Node and a preload that exposes only the listed calls', async () => {
    expect(await page.evaluate(() => typeof require)).toBe('undefined');
    expect(await page.evaluate(() => typeof process)).toBe('undefined');
    expect(await page.evaluate(() => typeof (globalThis as { Buffer?: unknown }).Buffer)).toBe('undefined');
    expect(await page.evaluate(() => Object.keys((window as unknown as { escritoriioRunner: object }).escritoriioRunner).sort())).toEqual(['call', 'onEvent']);
    expect(await page.evaluate(() => typeof (window as unknown as { electron?: unknown }).electron)).toBe('undefined');
  });

  test('H4 refuses a call that is not in the table, and one that names a path for a folder', async () => {
    const outcome = (channel: string, request: unknown) =>
      page.evaluate(
        ([name, payload]) => (window as unknown as { escritoriioRunner: { call(c: string, r: unknown): Promise<unknown> } }).escritoriioRunner.call(name as string, payload).then(() => 'answered', (error: Error) => error.message),
        [channel, request] as const,
      );
    expect(await outcome('shell:exec', {})).toBe('The app refused that request.');
    expect(await outcome('folders:add', { access: 'edit', approval: 'auto', isolation: 'in-place', trusted: true, agent: null, path: '/' })).toBe('The app refused that request.');
  });

  test('H4 opens no window and goes nowhere but its own bundle', async () => {
    expect(await page.evaluate(() => window.open('https://example.com/', '_blank'))).toBeNull();
    expect(app.windows()).toHaveLength(1);

    // What the main process decides, read at its source: the navigation event is refused before the page leaves.
    const refused = app.evaluate(
      ({ webContents }) =>
        new Promise<{ url: string; prevented: boolean }>((resolve) => {
          webContents.getAllWebContents()[0]?.once('will-navigate', (event, url) => resolve({ url, prevented: event.defaultPrevented }));
        }),
    );
    await page.evaluate(() => {
      window.location.assign('https://example.com/');
    });
    expect(await refused).toEqual({ url: 'https://example.com/', prevented: true });
    expect(page.url()).toBe(ENTRY_URL);
  });

  test('H4 applies a strict content security policy: in the page and in what the app serves', async () => {
    const meta = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(meta).toContain("default-src 'none'");
    expect(meta).toContain("connect-src 'none'");
    // The page cannot even ask the network: the policy refuses it before it is sent.
    expect(await page.evaluate(() => fetch('https://example.com/').then(() => 'reached', () => 'refused'))).toBe('refused');

    const header = await app.evaluate(async ({ net }) => (await net.fetch('escritoriio-app://app/index.html')).headers.get('content-security-policy'));
    expect(header).toBe(meta);
    // A file outside the folder of the bundle is not served, however the address is written.
    expect(await app.evaluate(async ({ net }) => (await net.fetch('escritoriio-app://app/%2e%2e/%2e%2e/package.json')).status)).toBe(404);
  });

  test('H4 runs one instance, and a link given to a second start only opens the pairing for review in the first', async () => {
    const link = 'escritoriio://pair?server=https%3A%2F%2Foffice.example&code=ABCD-EFGH';
    // The second start finds the first and ends, after handing it the link.
    await run(electronBinary, [appDirectory, '--disable-gpu', link], { env: environment() });
    await expect.poll(() => callOf('pairing:pending-link', {})).toMatchObject({ host: 'office.example' });
    expect(JSON.stringify(await callOf('pairing:pending-link', {}))).not.toContain('ABCDEFGH');
    expect(app.windows()).toHaveLength(1);
    // Nothing was paired and nothing was shared by it.
    expect(await callOf('connection:get', {})).toMatchObject({ state: 'not-paired' });
    expect(await callOf('folders:list', {})).toEqual([]);
    // A link that is not exactly that one is ignored.
    await run(electronBinary, [appDirectory, '--disable-gpu', 'escritoriio://folders/add?path=/'], { env: environment() });
    expect(await callOf('pairing:pending-link', {})).toMatchObject({ host: 'office.example' });
  });

  test('H4 asks for no permission of the system for the page, and grants none', async () => {
    const state = await page.evaluate(async () => (await navigator.permissions.query({ name: 'geolocation' })).state);
    expect(state).not.toBe('granted');
  });
});

// --- the screens of the window, in the real app --------------------------------------------------------------------------------------

const RUNNER_CLI = join(appDirectory, '../runner/dist/cli.js');
// Not the example the window shows, so that a test can tell the code from the words of the form.
const CODE = 'WXYZ-2345';

/** An office that is only what pairing needs of one: it says who a code is for, makes a device of it, and answers nothing after that (so the connection never comes up). */
async function startOffice(names: { agentName: string; workspaceName: string } = { agentName: 'Robby', workspaceName: 'Acme' }) {
  const seen: string[] = [];
  const server: Server = createServer((request: IncomingMessage, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      seen.push(`${request.method} ${request.url}`);
      const reply = (status: number, payload: object) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
      const code = (JSON.parse(body || '{}') as { code?: string }).code;
      // The runner sends the code as the office writes it, without the dash.
      if (code?.replace('-', '') !== CODE.replace('-', '')) return reply(400, { error: 'That code is not valid.' });
      if (request.url === '/api/runner/pairing/preview') return reply(200, names);
      if (request.url === '/api/runner/pair') return reply(200, { deviceId: 'device-1', token: 'a-token-for-a-test', deviceName: (JSON.parse(body) as { deviceName: string }).deviceName, ...names });
      return reply(404, { error: 'No such page.' });
    });
  });
  // A connection of the runner to the office is not answered: the window is tried, not the office.
  server.on('upgrade', (_request, socket) => socket.destroy());
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, seen, close: () => new Promise<void>((done) => server.close(() => done())) };
}

/** What the native windows of the main process would be asked, and the answer the test gives them: the app's own words are kept, to be read. */
const answerNativeDialogs = (response: 0 | 1) =>
  app.evaluate(({ dialog, safeStorage }, answer) => {
    const asked: string[] = [];
    (globalThis as { __asked?: string[] }).__asked = asked;
    (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async (...args: unknown[]) => {
      const options = args.find((arg): arg is { message: string; detail?: string } => typeof arg === 'object' && arg !== null && 'message' in arg);
      asked.push(`${options?.message ?? ''}\n${options?.detail ?? ''}`);
      return { response: answer, checkboxChecked: false };
    };
    // The keychain is not what this tries: the token is sealed by the system, which tests of the main process cover.
    const seal = safeStorage as unknown as Record<string, unknown>;
    seal.isEncryptionAvailable = () => true;
    seal.getSelectedStorageBackend = () => 'gnome_libsecret';
    seal.encryptString = (text: string) => Buffer.from(text, 'utf8');
    seal.decryptString = (data: Buffer) => data.toString('utf8');
  }, response);

const asked = () => app.evaluate(() => (globalThis as { __asked?: string[] }).__asked ?? []);

const goTo = async (name: string) => {
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByRole('heading', { level: 2, name })).toBeFocused();
};

async function pairByTyping(office: { origin: string }) {
  await answerNativeDialogs(1);
  await page.getByLabel('Pairing link or the address of the office').fill(office.origin);
  await page.getByLabel('Code', { exact: true }).fill(CODE);
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByRole('list', { name: 'This machine' })).toBeVisible();
}

test.describe('S40 the screens of the desktop app', () => {
  test('S40 starts at the connection of a machine that is not paired, with the pairing form and every section within reach', async () => {
    await expect(page.getByRole('heading', { level: 2, name: 'Connection' })).toBeVisible();
    await expect(page.getByRole('status', { name: 'Connection status' })).toHaveText('Not paired');
    await expect(page.getByLabel('Pairing link or the address of the office')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pair', exact: true })).toBeDisabled();
    for (const name of ['Tasks', 'Approvals', 'Folders', 'Coding agents', 'MCP servers', 'Doctor', 'Settings', 'Connection']) await goTo(name);
    // Nothing of the office is in the window, and no inline style: the policy would have refused it, and the page says nothing of it.
    expect(await page.evaluate(() => document.querySelectorAll('[style]').length)).toBe(0);
  });

  test('S40 pairs from an address and a code, after the app asks in its own words, and shows who the machine works for', async () => {
    const office = await startOffice();
    try {
      await pairByTyping(office);
      const facts = page.getByRole('list', { name: 'This machine' });
      await expect(facts).toContainText('Robby');
      await expect(facts).toContainText('Acme');
      await expect(facts).toContainText('127.0.0.1');
      // The question was the app's, in the words of the runner, with the office's names in it.
      expect((await asked()).join('\n')).toContain('Robby');
      expect(office.seen).toEqual(['POST /api/runner/pairing/preview', 'POST /api/runner/pair']);
      expect(await callOf('pairing:current', {})).toMatchObject({ agentName: 'Robby', workspaceName: 'Acme' });
      // The office does not answer the connection, so the machine is on its way and says so.
      await expect(page.getByRole('status', { name: 'Connection status' })).toHaveText(/Connecting|Reconnecting|Not connected/);
    } finally {
      await office.close();
    }
  });

  test('S40 pairs with a link that was opened, by its host, and the code never reaches the window', async () => {
    const office = await startOffice();
    try {
      await run(electronBinary, [appDirectory, '--disable-gpu', `escritoriio://pair?server=${encodeURIComponent(office.origin)}&code=${CODE}`], { env: environment() });
      const waiting = page.getByRole('region', { name: 'A link was opened' });
      await expect(waiting).toContainText('127.0.0.1');
      expect(await page.content()).not.toContain('WXYZ2345');
      expect(await page.content()).not.toContain(CODE);
      // No: nothing is used up.
      await answerNativeDialogs(0);
      await waiting.getByRole('button', { name: /^Pair/ }).click();
      await expect(page.getByText('Nothing was paired. The code was not used.')).toBeVisible();
      expect(office.seen).toEqual(['POST /api/runner/pairing/preview']);
      // Yes: it is paired. The app does not ask again at once after a no (a window that was taken over could ask in a loop), so the press is repeated until the question is put again.
      await answerNativeDialogs(1);
      await expect(async () => {
        await waiting.getByRole('button', { name: /^Pair/ }).click();
        await expect(page.getByRole('list', { name: 'This machine' })).toContainText('Robby', { timeout: 1_000 });
      }).toPass({ timeout: 15_000 });
      expect(office.seen.at(-1)).toBe('POST /api/runner/pair');
    } finally {
      await office.close();
    }
  });

  test('S40 shows what a hostile office called itself as text, and nothing it wrote runs', async () => {
    const office = await startOffice({ agentName: '<img src=x onerror="document.title=\'owned\'">', workspaceName: 'safe \u202Eevil\u202C [x](javascript:alert(1))' });
    try {
      await pairByTyping(office);
      const facts = page.getByRole('list', { name: 'This machine' });
      await expect(facts).toContainText('<img src=x onerror=');
      // What the runner already takes out of a name (an override that reorders text) never reaches the window; what is left is shown as it is.
      await expect(facts).toContainText('safe');
      expect(await facts.textContent()).not.toContain('\u202E');
      expect(await page.locator('img, a, script:not([src])').count()).toBe(0);
      expect(await page.title()).toBe('Escritoriio Runner');
    } finally {
      await office.close();
    }
  });

  test('S40 pauses and resumes the machine from the window', async () => {
    const office = await startOffice();
    try {
      await pairByTyping(office);
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await expect(page.getByRole('status', { name: 'Connection status' })).toHaveText('Paused on this machine');
      await expect(page.getByText('No task is taken until you resume.')).toBeVisible();
      await page.getByRole('button', { name: 'Resume', exact: true }).click();
      await expect(page.getByRole('status', { name: 'Connection status' })).not.toHaveText('Paused on this machine');
      await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    } finally {
      await office.close();
    }
  });

  test('S40 lists a folder that was shared from the command line of the same machine, and removes it after asking', async () => {
    const folder = await mkdtemp(join(scratch, 'shared-'));
    const shared = await run(process.execPath, [RUNNER_CLI, 'folders', 'add', folder, '--label', 'from-the-cli', '--access', 'read-only', '--approval', 'ask', '--isolation', 'in-place', '--yes'], { env: environment() });
    expect(shared.stdout).toContain('from-the-cli');
    await goTo('Folders');
    const item = page.getByRole('list', { name: 'Shared folders' }).getByRole('listitem').filter({ hasText: 'from-the-cli' }).first();
    await expect(item).toContainText('Read only');
    await expect(item).toContainText('Asks you first');
    await expect(item).toContainText('In place');
    await expect(item).toContainText('Not trusted');
    // Removing asks first: Keep it changes nothing.
    await item.getByRole('button', { name: 'Remove' }).click();
    await item.getByRole('button', { name: 'Keep it' }).click();
    await expect(item).toBeVisible();
    await item.getByRole('button', { name: 'Remove' }).click();
    await item.getByRole('button', { name: 'Yes, stop sharing' }).click();
    await expect(page.getByText(/No folder is shared yet/)).toBeVisible();
    expect(await callOf('folders:list', {})).toEqual([]);
  });

  test('S40 changes the options of a folder in the window, and says what the choices mean', async () => {
    const folder = await mkdtemp(join(scratch, 'shared-'));
    await run(process.execPath, [RUNNER_CLI, 'folders', 'add', folder, '--label', 'notes', '--isolation', 'in-place', '--yes'], { env: environment() });
    await goTo('Folders');
    await page.getByRole('button', { name: 'Change options' }).click();
    await expect(page.getByRole('radio', { name: 'Edit' })).toBeVisible();
    // The line that widens what the machine does is in view; the long words are behind an (i) button.
    await expect(page.getByText('Changes the files and runs commands, and the shell can read the rest of this machine.')).toBeVisible();
    const tip = page.getByRole('button', { name: 'More about edit' });
    await expect(tip).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByText(/The file tools are not inside that sandbox/)).toBeHidden();
    // The native question of the runner is answered no: nothing is widened without a yes.
    await answerNativeDialogs(0);
    await page.getByRole('radio', { name: 'Edit' }).check();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(() => asked()).toHaveLength(1);
    expect(await callOf('folders:list', {})).toMatchObject([{ folder: { label: 'notes', access: 'read-only' } }]);
  });

  test('S40 opens the (i) button of a choice by keyboard, keeps the words inside the window, and closes on Escape with the focus back on the button', async () => {
    await goTo('Folders');
    await page.getByRole('button', { name: 'Add a folder' }).click();
    const tip = page.getByRole('button', { name: 'More about trusted' });
    const words = page.getByText(/may run in this folder, with everything your user account can reach/);
    await expect(words).toBeHidden();
    await tip.focus();
    await page.keyboard.press('Enter');
    await expect(tip).toHaveAttribute('aria-expanded', 'true');
    await expect(words).toBeVisible();
    const box = (await words.boundingBox())!;
    const width = () => page.evaluate(() => window.innerWidth);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(await width());
    // The same after the window is made narrow.
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setMinimumSize(300, 300);
      window.setSize(360, 700);
    });
    await expect.poll(width).toBeLessThanOrEqual(360);
    const narrow = (await words.boundingBox())!;
    expect(narrow.x).toBeGreaterThanOrEqual(0);
    expect(narrow.x + narrow.width).toBeLessThanOrEqual(await width());
    await page.keyboard.press('Escape');
    await expect(tip).toHaveAttribute('aria-expanded', 'false');
    await expect(words).toBeHidden();
    await expect(tip).toBeFocused();
    expect(await page.evaluate(() => document.querySelectorAll('[style]').length)).toBe(0);
  });

  test('S40 runs the doctor and shows each check in words, with the report ready to copy', async () => {
    await goTo('Doctor');
    await page.getByRole('button', { name: 'Run the checks' }).click();
    const checks = page.getByRole('list', { name: 'Checks' });
    await expect(checks).toBeVisible({ timeout: 30_000 });
    expect(await checks.getByRole('listitem').count()).toBeGreaterThan(0);
    await expect(checks).toContainText(/OK|Warning|Failed/);
    await expect(page.getByLabel('The report as text')).toHaveValue(/^Escritoriio Runner: checks\n\[(ok|warn|fail)\]/);
    await page.getByRole('button', { name: 'Copy the report' }).click();
    // The system's clipboard is not granted to the page: the copy is done the old way, or the window says to do it by hand. Never silence.
    await expect(page.getByText(/Copied\.|Could not copy it/)).toBeVisible();
  });

  test('S40 shows the settings: launch at login is off, the versions, the state folder, and an update is only ever offered', async () => {
    await goTo('Settings');
    await expect(page.getByRole('checkbox', { name: 'Open the app when I log in' })).not.toBeChecked();
    const about = page.getByRole('list', { name: 'About this app' });
    await expect(about).toContainText(join(scratch, 'state'));
    // A run from sources is not an installed app: it says so and looks for nothing.
    await expect(page.getByRole('button', { name: 'Check for an update' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Accept the update…' })).toHaveCount(0);
  });

  test('S40 lists the coding agents and the MCP servers, and puts no path in any request of the window', async () => {
    await goTo('Coding agents');
    await expect(page.getByRole('heading', { name: 'Claude Code' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose where it is…' }).first()).toBeVisible();
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await goTo('MCP servers');
    await expect(page.getByText(/No MCP server is set up/)).toBeVisible();
    await expect(page.getByText(/Programs that run on this machine, as you, with nothing to contain them/)).toBeVisible();
  });
});

// --- working folders: made empty for the agent to build in ---------------------------------------------------------------------------

/** The system's own folder picker, answered by the test: the main process opens it, and the page never names a path. */
const pickFolder = (path: string | undefined) =>
  app.evaluate(({ dialog }, chosen) => {
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: chosen === undefined, filePaths: chosen === undefined ? [] : [chosen] });
  }, path);

const refusalOf = (channel: string, request: unknown) =>
  page.evaluate(
    ([name, payload]) => (window as unknown as { escritoriioRunner: { call(c: string, r: unknown): Promise<unknown> } }).escritoriioRunner.call(name as string, payload).then(() => 'answered', (error: Error) => error.message),
    [channel, request] as const,
  );

const failureOf = (command: Promise<unknown>) =>
  command.then(
    () => 'succeeded',
    (error: { stderr?: string; stdout?: string }) => `${error.stderr ?? ''}${error.stdout ?? ''}`,
  );

async function openNewWorkingFolder(name: string) {
  await goTo('Folders');
  await page.getByRole('button', { name: 'New empty working folder' }).click();
  await page.getByLabel('Name of the new folder').fill(name);
}

const makeIt = () => page.getByRole('button', { name: 'Choose where to make it…' }).click();

test.describe('S42 working folders in the desktop app', () => {
  test('S42 makes an empty working folder: the app opens the picker for where, asks in its own words, and only a yes makes and shares it', async () => {
    const parent = await mkdtemp(join(scratch, 'parent-'));
    await pickFolder(parent);
    await answerNativeDialogs(1);
    await openNewWorkingFolder('build');
    await expect(page.getByRole('radio', { name: 'Read only' })).toHaveCount(0);
    await expect(page.getByRole('radio', { name: 'Ask me first' })).toBeChecked();
    await makeIt();
    await expect(page.getByRole('status').filter({ hasText: 'Made and shared "build".' })).toBeVisible();

    // The question was the app's, with what a working folder means, and it was put before anything was made.
    const words = (await asked()).join('\n');
    expect(words).toContain('Make the empty folder "build"');
    expect(words).toContain(join(parent, 'build'));
    expect(words).toMatch(/create folders inside without asking/);
    expect(words).toMatch(/approve one by one/);
    expect(await readdir(join(parent, 'build'))).toEqual([]);

    const item = page.getByRole('list', { name: 'Shared folders' }).getByRole('listitem').filter({ hasText: 'build' }).first();
    await expect(item).toContainText('Working folder');
    await expect(item).toContainText('In place');
    await expect(item).toContainText('Asks you first');
    await expect(item).toContainText('may create folders in it and ask to clone repositories, which you approve one by one');
    expect(await callOf('folders:list', {})).toMatchObject([{ folder: { label: 'build', access: 'edit', isolation: 'in-place', kind: 'workspace' } }]);
  });

  test('S42 makes nothing on a no, and nothing when the picker is closed', async () => {
    const parent = await mkdtemp(join(scratch, 'parent-'));
    await pickFolder(parent);
    await answerNativeDialogs(0);
    await openNewWorkingFolder('build');
    await makeIt();
    await expect(page.getByRole('status').filter({ hasText: 'The folder was not made.' })).toBeVisible();
    expect(await readdir(parent)).toEqual([]);
    expect(await callOf('folders:list', {})).toEqual([]);

    await pickFolder(undefined);
    await answerNativeDialogs(1);
    await makeIt();
    await expect(page.getByText('No folder was chosen.')).toBeVisible();
    expect(await readdir(parent)).toEqual([]);
    expect(await callOf('folders:list', {})).toEqual([]);
  });

  test('S42 refuses a name that is a path, one that goes up, and a folder that is there already, in the runner’s words, and makes nothing', async () => {
    const parent = await mkdtemp(join(scratch, 'parent-'));
    await mkdir(join(parent, 'taken'));
    await pickFolder(parent);
    await answerNativeDialogs(1);
    await openNewWorkingFolder('..');
    await makeIt();
    await expect(page.getByRole('alert')).toContainText(/folder name/i);
    await page.getByLabel('Name of the new folder').fill('a/b');
    await makeIt();
    await expect(page.getByRole('alert')).toContainText(/not a path/i);
    await page.getByLabel('Name of the new folder').fill('taken');
    await makeIt();
    await expect(page.getByRole('alert')).toContainText(/there already/);
    expect(await readdir(parent)).toEqual(['taken']);
    expect(await readdir(join(parent, 'taken'))).toEqual([]);
    expect(await asked()).toEqual([]);
    expect(await callOf('folders:list', {})).toEqual([]);
  });

  test('S42 takes no path, no access and no isolation from the window for a working folder, and cannot make one read only or a copy', async () => {
    const parent = await mkdtemp(join(scratch, 'parent-'));
    await pickFolder(parent);
    await answerNativeDialogs(1);
    const request = { name: 'build', approval: 'ask', trusted: false, agent: null };
    for (const extra of [{ path: '/' }, { parent: '/' }, { access: 'read-only' }, { isolation: 'worktree' }]) {
      expect(await refusalOf('folders:new-workspace', { ...request, ...extra })).toBe('The app refused that request.');
    }
    expect(await readdir(parent)).toEqual([]);

    expect(await callOf('folders:new-workspace', request)).toMatchObject({ added: true, label: 'build' });
    for (const changes of [{ access: 'read-only' }, { isolation: 'worktree' }]) {
      expect(await refusalOf('folders:update', { label: 'build', changes })).toMatch(/always edited in place/);
    }
    expect(await callOf('folders:list', {})).toMatchObject([{ folder: { access: 'edit', isolation: 'in-place' } }]);

    // The window does not offer what the runner would refuse.
    await goTo('Folders');
    await page.getByRole('button', { name: 'Change options' }).click();
    await expect(page.getByRole('radio', { name: 'Read only' })).toHaveCount(0);
    await expect(page.getByRole('radio', { name: 'A copy on its own branch' })).toHaveCount(0);
  });

  test('S42 lists a working folder made from the command line of the same machine, and the command line refuses what the window refuses', async () => {
    const parent = await mkdtemp(join(scratch, 'parent-'));
    const made = await run(process.execPath, [RUNNER_CLI, 'folders', 'new', parent, 'from-the-cli', '--approval', 'ask', '--yes'], { env: environment() });
    expect(made.stdout).toContain('from-the-cli');
    expect(await readdir(join(parent, 'from-the-cli'))).toEqual([]);

    await goTo('Folders');
    const item = page.getByRole('list', { name: 'Shared folders' }).getByRole('listitem').filter({ hasText: 'from-the-cli' }).first();
    await expect(item).toContainText('Working folder');
    await expect(item).toContainText('Asks you first');

    // The same name again, a name that goes up, and a place that is the home of the runner: refused, and nothing is made.
    expect(await failureOf(run(process.execPath, [RUNNER_CLI, 'folders', 'new', parent, 'from-the-cli', '--yes'], { env: environment() }))).toMatch(/there already/);
    expect(await failureOf(run(process.execPath, [RUNNER_CLI, 'folders', 'new', parent, '../escape', '--yes'], { env: environment() }))).toMatch(/folder name/i);
    expect(await failureOf(run(process.execPath, [RUNNER_CLI, 'folders', 'new', parent, 'sneaky', '--access', 'read-only', '--yes'], { env: environment() }))).toMatch(/option of folders add, not of folders new/);
    expect(await readdir(parent)).toEqual(['from-the-cli']);
    expect(await callOf('folders:list', {})).toHaveLength(1);
  });
});
