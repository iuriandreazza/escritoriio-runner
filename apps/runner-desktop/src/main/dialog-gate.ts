/** How long, after the owner said no to a kind of dialog, that kind is not shown again: a page that asks over and over is not given the owner's attention. */
export const DECLINE_COOLDOWN_MS = 2_000;

export interface DialogGate {
  /**
   * Shows a dialog of a kind (`key`) once the one before it is answered. Of a kind that is already open or waiting, or that was said no to a moment ago,
   * nothing is shown and the answer is `declined`, which is what a no is for that dialog.
   */
  run<T>(key: string, declined: T, show: () => Promise<T>): Promise<T>;
}

/**
 * The one line that every native dialog of the app is in. A window that was taken over can ask for a dialog as often as it likes; whatever it asks, the owner
 * sees one at a time, never two of a kind, and a no is not asked again at once. The answer to what was not shown is the same as a no, so nothing is agreed to.
 */
export function createDialogGate({ now }: { readonly now: () => number }): DialogGate {
  let line: Promise<unknown> = Promise.resolve();
  const inLine = new Set<string>();
  const declinedAt = new Map<string, number>();

  return {
    run<T>(key: string, declined: T, show: () => Promise<T>): Promise<T> {
      const lastNo = declinedAt.get(key);
      if (inLine.has(key) || (lastNo !== undefined && now() - lastNo < DECLINE_COOLDOWN_MS)) return Promise.resolve(declined);
      inLine.add(key);
      const turn = line.then(async () => {
        try {
          const answer = await show();
          if (answer === declined) declinedAt.set(key, now());
          else declinedAt.delete(key);
          return answer;
        } finally {
          inLine.delete(key);
        }
      });
      line = turn.catch(() => undefined);
      return turn;
    },
  };
}
