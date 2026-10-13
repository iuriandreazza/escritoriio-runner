import { scrubText } from './mcp-scrub.ts';

const MARK = '[secret removed]';

/** Keys and tokens that are written the same way wherever they come from: a prefix somebody chose, then characters that are no word. */
const KNOWN_FORMS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk[-_][A-Za-z0-9][A-Za-z0-9_-]{15,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b[0-9a-fA-F]{32,}\b/g,
];

/** "api_key = ...", "token: ...", "ANTHROPIC_API_KEY=...": a word that names a secret, a sign, and the value, of which only the value goes. */
const LABELLED = /\b([A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|apikey|credentials?|authorization)[A-Za-z0-9_-]*)(\s*[=:]\s*["'`]?)([^\s"'`,;]{6,})/gi;

/**
 * Long runs of the characters of base64 (or of its URL form) that mix digits and both cases of letters and hold no word: how a random secret
 * is written. A path that begins with a slash never starts one, since the match cannot begin right after a slash or a dot, and the names
 * in a path that has spaces in it are words.
 */
const LONG_RANDOM = /(?<![A-Za-z0-9+/_.=-])(?![/.])[A-Za-z0-9+/_-]{40,}={0,2}/g;

const looksRandom = (run: string): boolean => /\d/.test(run) && /\p{Ll}/u.test(run) && /\p{Lu}/u.test(run) && !/[a-z]{8}/.test(run);

/**
 * Takes out of a text what looks like a secret, by how it is written and by what it is: `known` are values that are secret whatever they
 * look like (the device token) and go wherever they are. What the runner says of itself for a person to read, or to send to whoever helps
 * them, goes through this first. It goes by shape, so a secret that is a plain word with nothing to mark it is not found.
 */
export function scrubSecrets(text: string, known: readonly string[] = []): string {
  let clean = scrubText(text, known.filter((value) => value !== '').sort((a, b) => b.length - a.length)).replaceAll('[removed]', MARK);
  for (const form of KNOWN_FORMS) clean = clean.replace(form, MARK);
  clean = clean.replace(LABELLED, (whole, name: string, sign: string, value: string) => (value.startsWith('[secret') ? whole : `${name}${sign}${MARK}`));
  return clean.replace(LONG_RANDOM, (run) => (looksRandom(run) ? MARK : run));
}
