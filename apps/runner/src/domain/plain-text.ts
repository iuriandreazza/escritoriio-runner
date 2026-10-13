import { toOneLine } from '@escritoriio/runner-protocol';

/**
 * A text of the office, made safe to print: on one line, with the characters that a terminal acts on (an escape sequence can redraw
 * the line a person is about to answer) or that reorder or hide text turned into spaces, and cut to a length. What is cut ends in an
 * ellipsis, which is part of the length, so that nobody takes a path that was cut for a whole one.
 *
 * Only three kinds of text of the office are ever shown, and each goes through here: the names it gives to a device, an AI member and
 * a workspace (`displayName`), and the words of the refusal of a call to pair, which tell the person why a code did not work. What
 * it says with a close or a refusal of the socket, and what its `error` messages say, is not shown at all.
 */
export function plainText(text: string, max = 200): string {
  const line = toOneLine(text);
  return line.length <= max ? line : `${line.slice(0, Math.max(0, max - 1)).trimEnd()}\u2026`;
}

/**
 * A name the office gave, to be shown between double quotes: one of those inside it becomes a single quote, so that it cannot close
 * the quotes it is shown in and write what follows as if the runner had.
 */
export function displayName(name: string): string {
  return plainText(name, 100).replaceAll('"', "'");
}
