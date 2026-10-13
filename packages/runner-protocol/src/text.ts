import { z } from 'zod';

// Line breaks split a name in two, invisible characters make it look blank and direction overrides make it read backwards, so one
// machine could pass for another. The joiners U+200C and U+200D stay: emoji and some scripts need them. This is the rule of the
// office's own names (`singleLineText` in its shared package), written again here because the runner is published and cannot import it. The
// Unicode tag characters (U+E0000 to U+E007F) are in it too: they show as nothing to a person and read as words to a model. The variation
// selectors of emoji (U+FE00 to U+FE0F) stay, but the supplementary ones (U+E0100 to U+E01EF), which no emoji needs, hide text as the tags do.
const HIDDEN_CHARACTERS = /[\p{Cc}\u00AD\u061C\u180E\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/gu;

/** What a runner says of itself, made fit to show on one line: what the office would refuse becomes a space, runs of spaces one. */
export const toOneLine = (text: string): string => text.replace(HIDDEN_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();

/** A text from a runner, at most `max` characters as it was said, cleaned to one line and not empty once it is. Cleaning only ever shortens it. */
export const oneLine = (max: number) => z.string().max(max).transform(toOneLine).pipe(z.string().min(1));
