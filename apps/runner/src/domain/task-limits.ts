import { MAX_TASK_OUTPUT_BYTES, MAX_TASK_SECONDS } from '@escritoriio/runner-protocol';
import { byteLength } from './byte-length.ts';

export interface Ceilings {
  readonly seconds: number;
  readonly outputBytes: number;
}

/** What this machine allows at most, whatever the office asks for. */
export const LOCAL_CEILINGS: Ceilings = { seconds: MAX_TASK_SECONDS, outputBytes: MAX_TASK_OUTPUT_BYTES };

/** The office may ask for less time and less output than the machine allows, never for more. */
export function effectiveCeilings(asked: { readonly maxSeconds?: number | undefined; readonly maxOutputBytes?: number | undefined }, local: Ceilings = LOCAL_CEILINGS): Ceilings {
  return { seconds: Math.min(asked.maxSeconds ?? local.seconds, local.seconds), outputBytes: Math.min(asked.maxOutputBytes ?? local.outputBytes, local.outputBytes) };
}

/**
 * What a task may say in all: every piece of text is counted in the bytes it takes, and what does not fit is dropped, the last piece cut
 * at a whole character. Once it has run out nothing more is taken, so one chatty tool cannot push the rest of the task out of the budget.
 */
export class OutputBudget {
  private left: number;
  private cut = false;

  constructor(bytes: number) {
    this.left = Math.max(0, bytes);
  }

  /** The part of `text` that still fits, which is empty when nothing does. */
  take(text: string): string {
    const size = byteLength(text);
    if (size <= this.left) {
      this.left -= size;
      return text;
    }
    this.cut = true;
    let kept = '';
    for (const character of text) {
      const next = byteLength(character);
      if (next > this.left) break;
      kept += character;
      this.left -= next;
    }
    // Nothing else fits after a cut, small as it may be: the order of what was said must not skip.
    this.left = 0;
    return kept;
  }

  /** Whether anything was dropped. */
  get truncated(): boolean {
    return this.cut;
  }
}
