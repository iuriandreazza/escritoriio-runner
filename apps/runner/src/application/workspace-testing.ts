import type { MadeFolder, PlacedFolder, WorkspaceOps } from './workspace-ports.ts';

/** The files of a workspace, in memory: the folders at its top, and what the git steps are told to say. */
export class FakeWorkspaceOps implements WorkspaceOps {
  folders: string[] = [];
  clones = 0;
  /** What `makeFolder` and the placing of a folder say, whatever the name. */
  made: MadeFolder = 'made';
  /** The words of a failure of the git steps, or nothing. */
  startFails: string | undefined;
  cloneFails: string | undefined;
  /** Words of a problem with the address, or nothing. */
  addressFails: string | undefined;
  /** What was done, in order. */
  readonly calls: string[] = [];
  /** The signals the git steps were given. */
  readonly signals: AbortSignal[] = [];
  /** Makes the clone go on until the signal aborts, as git does while it fetches. */
  cloneHangs = false;
  note: string | undefined;

  folderNames(): Promise<readonly string[]> {
    return Promise.resolve([...this.folders]);
  }

  countClones(): Promise<number> {
    return Promise.resolve(this.clones);
  }

  makeFolder(_workspace: string, name: string): Promise<MadeFolder> {
    this.calls.push(`make ${name}`);
    if (this.made === 'made') this.folders.push(name);
    return Promise.resolve(this.made);
  }

  addressProblem(url: string): Promise<string | undefined> {
    this.calls.push(`address ${url}`);
    return Promise.resolve(this.addressFails);
  }

  newRepository(_workspace: string, name: string, signal: AbortSignal): Promise<PlacedFolder> {
    this.calls.push(`new ${name}`);
    this.signals.push(signal);
    if (this.startFails !== undefined) return Promise.resolve({ outcome: 'failed', words: this.startFails });
    return Promise.resolve(this.place(name));
  }

  cloneRepository(_workspace: string, name: string, url: string, signal: AbortSignal): Promise<PlacedFolder> {
    this.calls.push(`clone ${name} ${url}`);
    this.signals.push(signal);
    if (this.cloneHangs) return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ outcome: 'failed', words: 'git was stopped' }), { once: true }));
    if (this.cloneFails !== undefined) return Promise.resolve({ outcome: 'failed', words: this.cloneFails });
    return Promise.resolve(this.place(name));
  }

  private place(name: string): PlacedFolder {
    if (this.made !== 'made') return { outcome: this.made };
    this.folders.push(name);
    return this.note === undefined ? { outcome: 'made' } : { outcome: 'made', note: this.note };
  }

  discardFolder(_workspace: string, name: string): Promise<void> {
    this.calls.push(`discard ${name}`);
    this.folders = this.folders.filter((folder) => folder !== name);
    return Promise.resolve();
  }
}
