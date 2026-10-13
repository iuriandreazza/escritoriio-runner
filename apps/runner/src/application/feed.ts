export type Unsubscribe = () => void;

/** What a screen is given to follow something: the listener hears every change after it listens, and what it gives back stops it. */
export interface Subscribable<T> {
  subscribe(listener: (value: T) => void): Unsubscribe;
}

/** A value that can be read and followed. */
export interface Followable<T> extends Subscribable<T> {
  readonly current: T;
}

/**
 * Something that is told to whoever listens. A listener that throws is a mistake of a screen and not of the runner, so it is reported to
 * `onError` and the others still hear what was said: what draws a window must never be what stops a task.
 */
export class Emitter<T> implements Subscribable<T> {
  private readonly listeners = new Set<(value: T) => void>();
  private readonly onError: (error: unknown) => void;

  constructor(onError: (error: unknown) => void = () => undefined) {
    this.onError = onError;
  }

  subscribe(listener: (value: T) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch (error) {
        this.onError(error);
      }
    }
  }
}

/** A value that is replaced as things happen, and told each time. Replaced by one that is the same value, it tells nobody. */
export class Feed<T> extends Emitter<T> implements Followable<T> {
  private value: T;

  constructor(initial: T, onError?: (error: unknown) => void) {
    super(onError);
    this.value = initial;
  }

  get current(): T {
    return this.value;
  }

  set(next: T): void {
    if (Object.is(next, this.value)) return;
    this.value = next;
    this.emit(next);
  }
}
