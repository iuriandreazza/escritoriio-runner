/** How far the clock of this machine may be from the office's before it is said to be wrong: a few minutes already make signed things, and logins, fail. */
export const CLOCK_WARN_MS = 2 * 60_000;

/**
 * How far this machine's clock is ahead of the office's (negative: behind), from the time the office put in its answer. The answer was
 * written somewhere between sending the request and receiving it, so the middle of that is taken as the moment it was. The header has a
 * resolution of a second. Undefined when there is no time there or it is not one.
 */
export function clockSkewMs(dateHeader: string | null | undefined, sentAt: number, receivedAt: number): number | undefined {
  if (!dateHeader) return undefined;
  const office = Date.parse(dateHeader);
  if (Number.isNaN(office)) return undefined;
  return Math.round((sentAt + receivedAt) / 2 - office);
}
