import type { RunnerApi } from '../shared/channels.ts';

declare global {
  interface Window {
    /** What the preload gives the page: the only way it reaches the main process. */
    readonly escritoriioRunner: RunnerApi;
  }
}
