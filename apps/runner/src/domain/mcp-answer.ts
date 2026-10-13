import type { McpAnsweredMessage } from '@escritoriio/runner-protocol';
import { frameBytes, MAX_RUNNER_MESSAGE_BYTES, MCP_LIMITS } from '@escritoriio/runner-protocol';

const CUT = '\n[The answer was cut: it was too long to send.]';
const SHRINK = 0.9;

/** `text` with no more than `max` characters, and not ending in the first half of a character that is written as two. */
function head(text: string, max: number): string {
  const kept = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(kept) ? kept.slice(0, -1) : kept;
}

/**
 * What a tool answered, as the message that tells the office. Its text is what the office takes of a result at most, and the message is no
 * larger than a frame of the socket: a result is capped in characters, but a frame is capped in bytes, and a text of characters that JSON
 * writes with six (control characters) or that UTF-8 writes with four (most emoji) is more of them. What is cut says so, to the model that reads it.
 */
export function fitAnswer(id: string, text: string, isError: boolean): McpAnsweredMessage {
  const message = (body: string): McpAnsweredMessage => ({ type: 'mcp.answered', id, text: body, isError });
  if (text.length <= MCP_LIMITS.resultChars && frameBytes(message(text)) <= MAX_RUNNER_MESSAGE_BYTES) return message(text);
  let kept = head(text, MCP_LIMITS.resultChars - CUT.length);
  while (frameBytes(message(kept + CUT)) > MAX_RUNNER_MESSAGE_BYTES) kept = head(kept, Math.floor(kept.length * SHRINK));
  return message(kept + CUT);
}
