import { describe, expect, it } from 'vitest';
import { Emitter, Feed } from './feed.ts';

describe('Emitter', () => {
  it('tells every listener what is said, in the order they began to listen, and not what was said before', () => {
    const emitter = new Emitter<number>();
    emitter.emit(0);
    const heard: string[] = [];
    emitter.subscribe((value) => void heard.push(`a${value}`));
    emitter.subscribe((value) => void heard.push(`b${value}`));
    emitter.emit(1);
    expect(heard).toEqual(['a1', 'b1']);
  });

  it('stops telling a listener that stopped listening, even while it is being told', () => {
    const emitter = new Emitter<number>();
    const heard: number[] = [];
    const stop = emitter.subscribe((value) => {
      heard.push(value);
      stop();
    });
    emitter.emit(1);
    emitter.emit(2);
    expect(heard).toEqual([1]);
  });

  it('reports a listener that throws and goes on to the others', () => {
    const errors: unknown[] = [];
    const emitter = new Emitter<number>((error) => void errors.push(error));
    const heard: number[] = [];
    emitter.subscribe(() => {
      throw new Error('could not draw');
    });
    emitter.subscribe((value) => void heard.push(value));
    emitter.emit(1);
    expect(heard).toEqual([1]);
    expect(errors).toEqual([new Error('could not draw')]);
  });
});

describe('Feed', () => {
  it('holds the value, and tells listeners when it is replaced', () => {
    const feed = new Feed({ n: 1 });
    const heard: unknown[] = [];
    feed.subscribe((value) => void heard.push(value));
    feed.set({ n: 2 });
    expect(feed.current).toEqual({ n: 2 });
    expect(heard).toEqual([{ n: 2 }]);
  });

  it('tells nobody when the value is the very same one', () => {
    const value = { n: 1 };
    const feed = new Feed(value);
    const heard: unknown[] = [];
    feed.subscribe((next) => void heard.push(next));
    feed.set(value);
    expect(heard).toEqual([]);
  });
});
