/**
 * Whatever a local server says may echo what it was given: its environment is typed on this machine and must not leave it. A value of
 * it is taken out of everything that is sent when it is long enough to be told from a word of text, or when its name says it is a
 * secret (a key, a token, a password...) and it is at least not a letter or two. What a program is given is the owner's own, so a short value
 * of any other name (a region, a level of logging) is left: replacing it would spoil every text that has the word.
 */
const SECRET_NAME = /key|token|secret|pass|credential|auth|cookie|session/i;
const LONG_VALUE = 8;
const SHORT_SECRET = 3;

export function secretsOf(env: Readonly<Record<string, string>>): string[] {
  const secrets = Object.entries(env)
    .filter(([name, value]) => value.length >= LONG_VALUE || (SECRET_NAME.test(name) && value.length >= SHORT_SECRET))
    .map(([, value]) => value);
  // A value that a program writes inside JSON (structured content) is written escaped: both forms are taken out.
  const escaped = secrets.map((secret) => JSON.stringify(secret).slice(1, -1));
  return [...new Set([...secrets, ...escaped])].sort((a, b) => b.length - a.length);
}

const REMOVED = '[removed]';

/** The text with every secret taken out; `secrets` longest first, so that a value that holds another goes whole. */
export function scrubText(text: string, secrets: readonly string[]): string {
  let clean = text;
  for (const secret of secrets) clean = clean.split(secret).join(REMOVED);
  return clean;
}

/** A definition or an answer with every secret taken out of every string in it, the keys included. The value itself when there is nothing to take out. */
export function scrubJson<T>(value: T, secrets: readonly string[]): T {
  if (secrets.length === 0) return value;
  const scrub = (item: unknown): unknown => {
    if (typeof item === 'string') return scrubText(item, secrets);
    if (Array.isArray(item)) return item.map(scrub);
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, inner]) => [scrubText(key, secrets), scrub(inner)]));
    return item;
  };
  return scrub(value) as T;
}
