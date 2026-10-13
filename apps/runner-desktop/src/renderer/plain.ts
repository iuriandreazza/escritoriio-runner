// What the office or the machine said is shown as text and as nothing else: React never reads it as markup, and this makes what the eye can be
// fooled by visible. A character that reorders or hides text (a right-to-left override, a zero-width space, a control code) is shown by its code
// point, so that the owner who reads an instruction before approving it reads what is really there.

const isHidden = (code: number): boolean =>
  (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
  (code >= 0x7f && code <= 0x9f) ||
  code === 0x00ad ||
  code === 0x061c ||
  code === 0x180e ||
  (code >= 0x200b && code <= 0x200f) ||
  (code >= 0x2028 && code <= 0x202e) ||
  (code >= 0x2060 && code <= 0x2064) ||
  (code >= 0x2066 && code <= 0x206f) ||
  code === 0xfeff ||
  (code >= 0xfff9 && code <= 0xfffb) ||
  (code >= 0xe0000 && code <= 0xe007f) ||
  (code >= 0xe0100 && code <= 0xe01ef);

const marker = (code: number): string => `‹U+${code.toString(16).toUpperCase().padStart(4, '0')}›`;

/** The text with every character that hides or reorders shown by its code point. Nothing else is changed: it is still the whole text. */
export function visible(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    out += isHidden(code) ? marker(code) : char;
  }
  return out;
}

const ESCAPE = 0x1b;

/** A line of what a program printed: the colour and cursor codes of a terminal are of no use in a window, and are taken out before the rest is made visible. */
export function terminalLine(line: string): string {
  let out = '';
  for (let i = 0; i < line.length; i += 1) {
    if (line.codePointAt(i) === ESCAPE && line[i + 1] === '[') {
      let end = i + 2;
      while (end < line.length && !/[@-~]/.test(line[end] ?? '')) end += 1;
      i = end;
    } else {
      out += line[i];
    }
  }
  return visible(out);
}

const GENERIC_PROBLEM = 'Something went wrong. Try again.';

/** What a failure of a call says, in the words the app gave it: never a stack, never an object, and cut to a length a line can hold. */
export function wordsOf(error: unknown): string {
  if (!(error instanceof Error) || error.message.trim() === '') return GENERIC_PROBLEM;
  const message = visible(error.message.trim());
  return message.length <= 400 ? message : `${message.slice(0, 399)}…`;
}
