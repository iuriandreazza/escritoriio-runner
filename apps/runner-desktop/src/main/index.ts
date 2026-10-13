import { resolveStateDirectory } from '@escritoriio/runner';
import { app, ipcMain, safeStorage } from 'electron';
import { WIRE } from '../shared/channels.ts';
import { bundleFile, electronDataDirectory } from './app-paths.ts';
import type { DesktopApp } from './desktop-app.ts';
import { startDesktopApp } from './desktop-app.ts';
import { registerBundleScheme, hardenSession, serveBundle } from './electron/bundle-protocol.ts';
import { nativeDialogs } from './electron/dialogs.ts';
import { nativeNotifier } from './electron/notifier.ts';
import { createTray } from './electron/tray.ts';
import { createElectronUpdater } from './electron/updater.ts';
import { applyPagePolicy, setApplicationMenu, WindowController } from './electron/window-controller.ts';
import { linkFromArgv, protocolRegistration } from './pair-link.ts';
import { runSmoke } from './electron/smoke-run.ts';
import { planSmoke } from './smoke.ts';

const log = (line: string): void => void process.stderr.write(`${line}\n`);

// What can arrive before the app is ready is kept until it is: the system hands over a link by an event that fires once, at a start, and a second
// start by another one, and neither is heard again. These listeners are the first thing the module does, before anything is awaited.
let desktop: DesktopApp | undefined;
const waiting: string[] = [];
const handleLink = (raw: string): void => (desktop ? desktop.openLink(raw) : void waiting.push(raw));
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleLink(url);
});
app.on('second-instance', (_event, argv) => (desktop ? desktop.secondStart(argv) : void waiting.push(...argv)));

registerBundleScheme();
app.setName('Escritoriio Runner');
// A smoke start only loads the bundle, the preload and the page, in a state directory that is named; it is decided before the lock, the tray, the pairing
// link, the safe storage, the login item and the updater, none of which it may touch.
const smoke = planSmoke(process.argv, process.env);
// Awaited before Electron is ready, which is fine: the app is told to wait for the entry to finish loading. Nothing that waits for `ready` may be awaited
// at the top of this module, since `ready` is not emitted until the module has finished (it would wait for itself): that is what `run` is for.
const state = smoke.kind === 'smoke' ? smoke.stateDirectory : await resolveStateDirectory(process.env);
// Before the lock, which is kept in it: the data of Electron is beside the runner's own settings and follows them.
app.setPath('userData', electronDataDirectory(state));

async function run(): Promise<void> {
  // Opening a link is registered for the installed app only: a run from sources must not take over `escritoriio://` for the system.
  if (app.isPackaged) app.setAsDefaultProtocolClient(...protocolRegistration(process.platform, process.execPath));
  const initialLink = linkFromArgv(process.argv);
  if (initialLink) waiting.push(initialLink);

  await app.whenReady();
  const here = import.meta.dirname;
  serveBundle(bundleFile(here, 'renderer'));
  hardenSession();
  applyPagePolicy();
  setApplicationMenu(process.platform);

  const window = new WindowController(bundleFile(here, 'preload'), here, process.platform);
  const running = await startDesktopApp({
    env: process.env,
    platform: process.platform,
    packaged: app.isPackaged,
    appVersion: app.getVersion(),
    stateDirectory: state,
    storage: safeStorage,
    dialog: nativeDialogs,
    notifier: nativeNotifier,
    window,
    tray: createTray(),
    loginItems: { set: (enabled) => app.setLoginItemSettings({ openAtLogin: enabled }) },
    updater: app.isPackaged ? createElectronUpdater() : undefined,
    quit: () => app.quit(),
    log,
  });
  desktop = running;

  // The one door of the window into the main process. Who is calling is read from the wire (which window, which frame, loaded from where), never from the call.
  ipcMain.handle(WIRE.call, (event, wire: unknown) =>
    running.router.handle({ fromOurWindow: window.owns(event.sender), isMainFrame: event.senderFrame !== null && event.senderFrame === event.sender.mainFrame, frameUrl: event.senderFrame?.url }, wire),
  );

  for (const raw of waiting.splice(0)) {
    const link = linkFromArgv([raw]);
    if (link) running.openLink(link);
  }

  // The app lives in the tray: closing the window does not quit it.
  app.on('window-all-closed', () => undefined);
  app.on('activate', window.show);

  // Quit stops the connection and everything that waits for the owner before the process goes.
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void running.shutdown().finally(() => app.quit());
  });

  // A start from the login or from the tray keeps to the tray: the window comes when it is wanted. Any other start shows it.
  if (!app.getLoginItemSettings().wasOpenedAtLogin) window.show();
}

if (smoke.kind === 'refused') {
  log(smoke.message);
  app.exit(2);
} else if (smoke.kind === 'smoke') {
  void runSmoke(import.meta.dirname, log);
} else if (!app.requestSingleInstanceLock()) {
  // Another one runs: it was told of this start (and of the link in it) by `second-instance`.
  app.quit();
} else {
  run().catch((error: unknown) => {
    log(`The app could not start: ${error instanceof Error ? error.message : String(error)}`);
    app.exit(1);
  });
}
