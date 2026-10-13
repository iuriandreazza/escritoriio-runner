/** How long something took, in words a person reads at a glance. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(Math.max(0, ms) / 1000);
  if (seconds < 1) return 'under a second';
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** How long ago something began. */
export function formatSince(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  return seconds < 5 ? 'just now' : `${formatDuration(now - startedAt)} ago`;
}

export const countOf = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;
