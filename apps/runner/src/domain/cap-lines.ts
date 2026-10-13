const CUT_MARK = '\n...';

/** The text cut to at most `max` characters at the end of a line, with a closing line that says something was left out. A text that fits is left as it is. */
export function capLines(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.max(0, max - CUT_MARK.length));
  const lastBreak = head.lastIndexOf('\n');
  return `${(lastBreak > 0 ? head.slice(0, lastBreak) : head).trimEnd()}${CUT_MARK}`;
}
