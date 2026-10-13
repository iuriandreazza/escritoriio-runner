/** How long something took, in whole seconds, and at least one: what a person reads of a task that ended. */
export const describeSeconds = (ms: number): string => `${Math.max(1, Math.round(ms / 1000))}s`;
