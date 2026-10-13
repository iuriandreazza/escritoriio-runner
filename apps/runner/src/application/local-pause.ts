import type { PolicyStore } from './task-ports.ts';

/** The owner pauses or resumes the machine, on the machine itself: what is kept is what a runner that is running looks for. False when it was so already. */
export function setLocalPause(policy: PolicyStore, paused: boolean): Promise<boolean> {
  return policy.update((current) => (current.paused === paused ? { policy: current, result: false } : { policy: { ...current, paused }, result: true }));
}

export const describeLocalPause = (paused: boolean, changed: boolean): readonly string[] =>
  paused
    ? [
        changed ? 'Paused.' : 'It was paused already.',
        'This machine takes no task, from the office or from run, and a task that runs is stopped. A runner that is running notices within a second.',
        'Resume it with: escritoriio-runner resume',
      ]
    : [
        changed ? 'Resumed.' : 'It was not paused.',
        'If the office paused this machine as well, it stays paused until it is resumed there.',
      ];
