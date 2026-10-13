// The characters that make text lie to whoever reads it: control characters, direction overrides and what is invisible. A line break and a
// tab are not among them, since what a coding agent writes has lines; the joiners that emoji and some scripts need stay too.
const HIDDEN_EXCEPT_LINE_BREAKS = /[\p{Cc}\u00AD\u061C\u180E\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/gu;

const HIDDEN = new RegExp(HIDDEN_EXCEPT_LINE_BREAKS, 'u');

/** Whether the text holds a character that hides or reverses text, or a control code: a line break and a tab are not one. Whoever approves an instruction reads what is run only if it holds none. */
export function hasHiddenCharacters(text: string): boolean {
  return [...text].some((character) => character !== '\n' && character !== '\t' && character !== '\r' && HIDDEN.test(character));
}

/** Text from a coding agent made safe to pass on: its lines kept, everything that hides or reverses text turned into a space. */
export function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(HIDDEN_EXCEPT_LINE_BREAKS, (character) => (character === '\n' || character === '\t' ? character : ' '));
}
