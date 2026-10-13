import { frameBytes, MAX_RUNNER_MESSAGE_BYTES, MCP_LIMITS } from '@escritoriio/runner-protocol';
import { describe, expect, it } from 'vitest';
import { fitAnswer } from './mcp-answer.ts';

describe('an answer that goes to the office', () => {
  it('goes as it is when it fits', () => {
    expect(fitAnswer('r1', 'Two notes.', false)).toEqual({ type: 'mcp.answered', id: 'r1', text: 'Two notes.', isError: false });
  });

  it('says that the tool failed when it did', () => {
    expect(fitAnswer('r1', 'No such note.', true)).toMatchObject({ isError: true });
  });

  it('is cut to what the office takes of a result, and says so', () => {
    const answer = fitAnswer('r1', 'x'.repeat(MCP_LIMITS.resultChars + 1_000), false);
    expect(answer.text.length).toBeLessThanOrEqual(MCP_LIMITS.resultChars);
    expect(answer.text).toContain('cut');
    expect(frameBytes(answer)).toBeLessThanOrEqual(MAX_RUNNER_MESSAGE_BYTES);
  });

  it('is cut further when what it is made of takes more bytes than characters, so that it is never a frame too large for the socket', () => {
    // A control character is one character and six bytes once it is written as JSON.
    const answer = fitAnswer('r'.repeat(64), '\u0001'.repeat(MCP_LIMITS.resultChars), false);
    expect(frameBytes(answer)).toBeLessThanOrEqual(MAX_RUNNER_MESSAGE_BYTES);
    expect(answer.text).toContain('cut');
    expect(answer.text.length).toBeGreaterThan(1_000);
  });

  it('is not cut in the middle of a character made of two halves', () => {
    const answer = fitAnswer('r1', '😀'.repeat(MCP_LIMITS.resultChars), false);
    expect(answer.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(frameBytes(answer)).toBeLessThanOrEqual(MAX_RUNNER_MESSAGE_BYTES);
  });
});
