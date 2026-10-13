import type { Scheduler } from './ports.ts';
import type { PolicyStore } from './task-ports.ts';

/** How often the owner's own pause is looked for: a pause set from another terminal takes hold within this. */
export const PAUSE_POLL_MS = 1_000;

export interface PauseWatcherDeps {
  readonly policy: Pick<PolicyStore, 'load'>;
  readonly scheduler: Scheduler;
  /** The owner paused or resumed the machine on the machine itself. Told once for each change. */
  readonly onChange: (paused: boolean) => void;
  /** Settings that cannot be read. Told once for each way they could not be, not at every look. */
  readonly onError: (error: unknown) => void;
}

/**
 * Looks at the owner's own pause while the runner runs, since what pauses a machine on the machine is a command in another terminal, or
 * another window of the app, and the runner is not told. Settings that cannot be read change nothing: the machine stays as it was, and
 * every task is refused meanwhile (see `TaskService`), which is the safe way to be.
 */
export class PauseWatcher {
  private readonly deps: PauseWatcherDeps;
  private known = false;
  private running = false;
  private cancel: (() => void) | undefined;
  private lastProblem: string | undefined;
  /** The look that is under way, so that one asked for now does not start a second chain of looks beside it. */
  private looking: Promise<void> | undefined;

  constructor(deps: PauseWatcherDeps) {
    this.deps = deps;
  }

  /** `paused` is how the machine is now, as the rest of the runner has it: only a change from it is told. */
  start(paused: boolean): void {
    if (this.running) return;
    this.running = true;
    this.known = paused;
    this.lastProblem = undefined;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    this.cancel?.();
    this.cancel = undefined;
  }

  /** Looks now instead of at the next time: for the one who just changed the pause here, whose own runner should not wait a second to hear it. */
  async checkNow(): Promise<void> {
    if (!this.running) return;
    // One that is under way reads the settings as they are now, or a moment ago: waiting for it is enough, and it schedules the next.
    if (this.looking) return this.looking;
    this.cancel?.();
    this.cancel = undefined;
    await this.look();
  }

  private schedule(): void {
    this.cancel = this.deps.scheduler.after(PAUSE_POLL_MS, () => void this.look());
  }

  private look(): Promise<void> {
    const looking = this.lookOnce().finally(() => {
      if (this.looking === looking) this.looking = undefined;
    });
    this.looking = looking;
    return looking;
  }

  private async lookOnce(): Promise<void> {
    try {
      const { paused } = await this.deps.policy.load();
      this.lastProblem = undefined;
      if (this.running && paused !== this.known) {
        this.known = paused;
        this.deps.onChange(paused);
      }
    } catch (error) {
      const problem = error instanceof Error ? error.message : String(error);
      if (this.running && problem !== this.lastProblem) {
        this.lastProblem = problem;
        this.deps.onError(error);
      }
    } finally {
      if (this.running) this.schedule();
    }
  }
}
