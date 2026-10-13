import { describe, expect, it } from 'vitest';
import { byteLength } from './byte-length.ts';

describe('the bytes a text takes', () => {
  it('are one for each character of plain text, and more for the rest', () => {
    expect(byteLength('')).toBe(0);
    expect(byteLength('abc')).toBe(3);
    expect(byteLength('ç')).toBe(2);
    expect(byteLength('你好')).toBe(6);
    expect(byteLength('\u{1F600}')).toBe(4);
  });
});
