import type { ConnectionView, Runner } from '@escritoriio/runner';
import { createFileDeviceStore, createRunner, DEVICE_FILE_NAME, privateFile, resolveStateDirectory } from '@escritoriio/runner';
import type { CodingAgentKind } from '@escritoriio/runner-protocol';
import { createAppSettingsStore } from './app-settings.ts';
import type { Notifier } from './approval-desk.ts';
import { ApprovalDesk, taskNotice } from './approval-desk.ts';
import type { ConfirmDialog } from './confirmations.ts';
import { createConfirmations, importRequest, weakStorageRequest } from './confirmations.ts';
import type { FolderPurpose } from './ipc-handlers.ts';
import { createHandlers } from './ipc-handlers.ts';
import type { Router } from './ipc-router.ts';
import { createEventPusher, createRouter } from './ipc-router.ts';
import type { LoginItems } from './launch-at-login.ts';
import { askLaunchAtLoginOnFirstRun, launchAtLoginSupported, setLaunchAtLogin } from './launch-at-login.ts';
import { linkFromArgv, parseDeepLink, PendingLink } from './pair-link.ts';
import type { SafeStorageLike } from './token-store.ts';
import { createSafeStorageDeviceStore, decideImport, importPlainDevice, protectionOf } from './token-store.ts';
import type { TrayActions } from './tray-model.ts';
import type { UpdaterPort } from './update-service.ts';
import { createUpdateService } from './update-service.ts';

/** Everything of the system the app uses, as ports: the one place Electron is, and the one a test replaces. */
export interface DesktopAppDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  /** An installed app, and not one run from its sources. */
  readonly packaged: boolean;
  readonly appVersion: string;
  readonly storage: SafeStorageLike;
  readonly dialog: ConfirmDialog & { pickFolder(purpose: FolderPurpose): Promise<string | undefined>; pickProgram(kind: CodingAgentKind): Promise<string | undefined> };
  readonly notifier: Notifier;
  readonly window: { show(): void; push(event: unknown): void };
  readonly tray: { show(view: ConnectionView, actions: TrayActions): void };
  readonly loginItems: LoginItems;
  /** Nothing when the app is not an installed one: it then has no feed to look at. */
  readonly updater: UpdaterPort | undefined;
  readonly quit: () => void;
  readonly log: (line: string) => void;
  /** Where the sealed pairing is kept; the state directory of the runner when nothing else is said. */
  readonly stateDirectory?: string;
}

export interface DesktopApp {
  readonly runner: Runner;
  readonly approvals: ApprovalDesk;
  /** Where the window's calls come in. */
  readonly router: Router;
  /** The question of the first run, asked after the window is up: ends when it is answered. */
  readonly firstRun: Promise<void>;
  /** A link the system handed over (a click, or an argument of a start): it only opens the pairing for review. */
  openLink(raw: string): void;
  /** What a second start was given: the window comes forward, and a link in it is looked at. */
  secondStart(argv: readonly string[]): void;
  /** Stops what runs, denies what waits for the owner and lets go of the connection. */
  shutdown(): Promise<void>;
}

const UPDATE_CHECK_EVERY_MS = 12 * 60 * 60_000;
const SHUTDOWN_WAIT_MS = 5_000;
const NOT_PAIRED = 'This machine is not paired yet.';
const ALREADY = 'The connection is on already.';

const wordsOf = (error: unknown): string => (error instanceof Error && error.message !== '' ? error.message : 'Something went wrong.');

/** Puts the app together: the runner with the app's own token store, dialogs and approvals, and the window, the tray and the notifications that follow it. */
export async function startDesktopApp(deps: DesktopAppDeps): Promise<DesktopApp> {
  const { platform, packaged, storage, dialog, log } = deps;
  const state = deps.stateDirectory ?? (await resolveStateDirectory(deps.env));
  const settings = createAppSettingsStore(state);
  const stopped = new AbortController();

  const sealedFile = privateFile(state, 'device.enc');
  const devices = createSafeStorageDeviceStore({ storage, platform, file: sealedFile, confirmWeakStorage: () => dialog.confirm(weakStorageRequest()) });
  await offerThePairingOfTheCommandLine();

  const approvals = new ApprovalDesk({ notifier: deps.notifier, openWindow: deps.window.show });
  const runner = await createRunner({ env: deps.env, confirmations: createConfirmations(dialog), approvals, devices });

  const updates = createUpdateService({ port: deps.updater, dialog, log });
  const pendingLink = new PendingLink();
  const pusher = createEventPusher((event) => deps.window.push(event), log);
  const tray: TrayActions = {
    setPaused: (paused) => void runner.pause.set(paused).catch((error: unknown) => log(`Pausing from the tray failed: ${wordsOf(error)}`)),
    openWindow: deps.window.show,
    quit: deps.quit,
  };

  // --- what the owner is told ---------------------------------------------------------------------------------

  deps.tray.show(runner.connection.current, tray);
  const unsubscribers = [
    runner.connection.subscribe((view) => {
      pusher.push({ kind: 'connection', view });
      deps.tray.show(view, tray);
    }),
    runner.tasks.subscribe((view) => pusher.push({ kind: 'tasks', view })),
    approvals.subscribe((pending) => pusher.push({ kind: 'approvals', pending })),
    updates.subscribe((update) => pusher.push({ kind: 'update', update })),
    runner.events.subscribe((event) => {
      if (event.kind === 'task') {
        const notice = taskNotice(event.note);
        if (notice) deps.notifier.show({ ...notice, actions: [], onAction: () => undefined, onClick: deps.window.show });
      } else if (event.kind === 'notice') pusher.push({ kind: 'notice', message: event.message });
      else if (event.kind === 'problem') {
        log(event.message);
        pusher.push({ kind: 'problem', message: event.message });
      }
    }),
  ];

  // --- the connection -------------------------------------------------------------------------------------------

  let running: Promise<void> | undefined;

  function startConnection(): { readonly started: boolean; readonly message?: string } {
    if (!runner.connection.current.device) return { started: false, message: NOT_PAIRED };
    if (running) return { started: false, message: ALREADY };
    const run = runner.connection
      .start()
      .then((end) => {
        // Its words are in the view already; they are said again where the owner may be looking elsewhere.
        if ('message' in end && end.message) pusher.push({ kind: 'problem', message: end.message });
      })
      .catch((error: unknown) => pusher.push({ kind: 'problem', message: wordsOf(error) }))
      .finally(() => {
        if (running === run) running = undefined;
      });
    running = run;
    return { started: true };
  }

  const settingsFor = { settings, items: deps.loginItems, packaged, platform };
  const router = createRouter({
    log,
    handlers: createHandlers({
      runner,
      approvals,
      pendingLink,
      pickers: { folder: dialog.pickFolder, program: dialog.pickProgram },
      updates,
      launch: { supported: launchAtLoginSupported(platform), get: async () => (await settings.load()).launchAtLogin, set: (enabled) => setLaunchAtLogin(settingsFor, enabled) },
      info: { appVersion: deps.appVersion, platform, updatesSupported: deps.updater !== undefined },
      startConnection,
      signal: stopped.signal,
    }),
  });

  function openLink(raw: string): void {
    const link = parseDeepLink(raw);
    if (!link.ok) {
      log(`Ignored a link: ${link.reason}.`);
      return;
    }
    const shown = pendingLink.hold(link);
    deps.window.show();
    pusher.push({ kind: 'pair-link', ...shown });
  }

  // --- what the owner decided before ----------------------------------------------------------------------------

  /** A pairing the command line made is the owner's to move: never silently, and never when the app could not keep it better than a file does. */
  async function offerThePairingOfTheCommandLine(): Promise<void> {
    const hasAppToken = (await sealedFile.read()) !== undefined;
    const hasPlainFile = (await privateFile(state, DEVICE_FILE_NAME).read()) !== undefined;
    if (decideImport({ hasAppToken, hasPlainFile, protection: protectionOf(storage, platform) }) !== 'offer') return;
    try {
      await importPlainDevice({ plain: createFileDeviceStore(state), plainFile: privateFile(state, DEVICE_FILE_NAME), into: devices, confirm: (device) => dialog.confirm(importRequest(device)) });
    } catch (error) {
      // What could not be moved stays where it was: the app starts unpaired, and says why.
      log(`The pairing of the command line was not moved: ${wordsOf(error)}`);
    }
  }

  const firstRun = askLaunchAtLoginOnFirstRun({ ...settingsFor, dialog }).catch((error: unknown) => log(`The question about opening at login failed: ${wordsOf(error)}`));

  if (runner.connection.current.device) startConnection();

  const checkTimer = deps.updater
    ? setInterval(() => void updates.check().catch(() => undefined), UPDATE_CHECK_EVERY_MS)
    : undefined;
  checkTimer?.unref();
  if (deps.updater) void updates.check();

  return {
    runner,
    approvals,
    router,
    firstRun,
    openLink,
    secondStart(argv) {
      deps.window.show();
      const link = linkFromArgv(argv);
      if (link) openLink(link);
    },
    async shutdown() {
      clearInterval(checkTimer);
      approvals.denyAll();
      stopped.abort();
      runner.connection.stop();
      for (const unsubscribe of unsubscribers) unsubscribe();
      await Promise.race([running, new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS).unref())]);
    },
  };
}
