export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_CAP_MS = 60_000;

/** For a machine the office does not allow for now: that changes when somebody changes it in the office, so there is no use asking every minute. */
export const SLOW_RETRY_MS = 5 * 60_000;

/**
 * How long to wait before the next try, after `failures` tries in a row that did not end in a welcome. The ceiling doubles from a second
 * to a minute and the wait is a random point under it ("full jitter"): a server that restarts is not met by every machine at once.
 */
export function reconnectDelay(failures: number, random: () => number): number {
  const ceiling = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** failures);
  return Math.floor(random() * ceiling);
}
