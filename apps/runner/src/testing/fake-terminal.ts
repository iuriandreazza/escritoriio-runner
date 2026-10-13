import type { InterruptSignal, Terminal } from '../application/ports.ts';

/** A terminal with a person at it who is a test: what they will answer is set beforehand, and Ctrl-C is a method. */
export class FakeTerminal implements Terminal {
  readonly stdout: string[] = [];
  readonly stderr: string[] = [];
  readonly questions: string[] = [];
  /** What the person answers to the questions they are asked, in order. Nothing is an empty answer. */
  answers: string[] = [];
  private interrupt: ((signal: InterruptSignal) => void) | undefined;

  out(line: string): void {
    this.stdout.push(line);
  }

  err(line: string): void {
    this.stderr.push(line);
  }

  ask(question: string, signal?: AbortSignal): Promise<string> {
    this.questions.push(question);
    if (signal?.aborted) return Promise.resolve('');
    if (this.holding) {
      return new Promise((resolve) => {
        this.held = resolve;
        signal?.addEventListener('abort', () => resolve(''), { once: true });
      });
    }
    return Promise.resolve(this.answers.shift() ?? '');
  }

  /** Whether a question waits until `answerNow` or until it is taken away, as one does when the person is somewhere else. */
  holding = false;
  private held: ((answer: string) => void) | undefined;

  answerNow(answer: string): void {
    this.held?.(answer);
  }

  onInterrupt(handler: (signal: InterruptSignal) => void): () => void {
    this.interrupt = handler;
    return () => {
      this.interrupt = undefined;
    };
  }

  /** The person presses Ctrl-C, or the system asks the program to end (`SIGTERM`). */
  pressCtrlC(signal: InterruptSignal = 'SIGINT'): void {
    this.interrupt?.(signal);
  }

  /** Everything that was shown, on either output. */
  get shown(): string {
    return [...this.stdout, ...this.stderr, ...this.questions].join('\n');
  }
}
