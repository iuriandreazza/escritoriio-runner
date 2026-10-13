import type { ConnectionView } from '@escritoriio/runner';
import { Menu, nativeImage, Tray } from 'electron';
import { statusIconPng } from '../tray-icon.ts';
import type { TrayActions, TrayStatus } from '../tray-model.ts';
import { trayMenu, trayStatus, trayTooltip } from '../tray-model.ts';

const ICON_PIXELS = 32;

/** The icon in the menu bar or the tray: the status at a glance, the one-click pause, the window, and quitting. */
export function createTray(): { show(view: ConnectionView, actions: TrayActions): void } {
  let tray: Tray | undefined;
  let shown: TrayStatus | undefined;

  return {
    show(view, actions) {
      const status = trayStatus(view);
      const icon = (): Electron.NativeImage => nativeImage.createFromBuffer(statusIconPng(status, ICON_PIXELS), { scaleFactor: 2 });
      tray ??= new Tray(icon());
      if (shown !== status) tray.setImage(icon());
      shown = status;
      tray.setToolTip(trayTooltip(view));
      tray.setContextMenu(Menu.buildFromTemplate(trayMenu(view, actions).map((item) => ({ ...item }))));
    },
  };
}
