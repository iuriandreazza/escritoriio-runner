import { describe, expect, it } from 'vitest';
import { isYes } from './answer.ts';

describe('a yes', () => {
  it.each(['y', 'Y', 'yes', 'YES', ' yes ', 'y\n'])('is %j', (answer) => {
    expect(isYes(answer)).toBe(true);
  });

  it.each(['', 'n', 'no', 'yep', 'yess', 'sure', 'y es'])('is not %j', (answer) => {
    expect(isYes(answer)).toBe(false);
  });
});
