import { Notification } from 'electron';
import type { NotificationRequest, Notifier } from '../approval-desk.ts';

// A notification that nothing refers to may be collected before it is answered.
const alive = new Set<Notification>();

/** Native notifications. Buttons are drawn only where the system draws them (macOS); elsewhere the notification opens the window, where the owner answers. */
export const nativeNotifier: Notifier = {
  show(request: NotificationRequest) {
    if (!Notification.isSupported()) return { close: () => undefined };
    const notification = new Notification({
      title: request.title,
      body: request.body,
      actions: request.actions.map((action) => ({ type: 'button' as const, text: action.label })),
    });
    notification.on('action', (_event, index) => {
      const action = request.actions[index];
      if (action) request.onAction(action.id);
    });
    notification.on('click', request.onClick);
    notification.on('close', () => alive.delete(notification));
    alive.add(notification);
    notification.show();
    return {
      close: () => {
        notification.close();
        alive.delete(notification);
      },
    };
  },
};
