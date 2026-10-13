import { RUNNER_LIMITS, toOneLine } from '@escritoriio/runner-protocol';

/** What the office is told of a folder, and asks for it by: a name its owner chose. It is never a path, so nothing in it may look like one. */
export type LabelProblem = 'empty' | 'too-long' | 'has-separator' | 'not-plain';

export const DESCRIBE_LABEL_PROBLEM: Readonly<Record<LabelProblem, string>> = {
  empty: 'A label cannot be empty.',
  'too-long': `A label is at most ${RUNNER_LIMITS.folderLabel} characters.`,
  'has-separator': 'A label is a name and not a path: it cannot have a slash or a backslash.',
  'not-plain': 'A label is one plain line of text: no line breaks, hidden characters, or runs of spaces.',
};

export function problemWithLabel(label: string): LabelProblem | undefined {
  if (label === '') return 'empty';
  if (label.length > RUNNER_LIMITS.folderLabel) return 'too-long';
  if (/[\\/]/.test(label)) return 'has-separator';
  // What the office would turn into something else on the way is not a label either: it would not be asked for by the name it was shared as.
  if (toOneLine(label) !== label) return 'not-plain';
  return undefined;
}

/** Two labels that differ only in case are the same one to a person, and are not allowed side by side. */
export const sameLabel = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The item a person means by a label they typed: the one with exactly that label, or else the one that differs only in case. The office
 * asks by the exact label it was told and is not given this: only what a person types is forgiven.
 */
export const findByLabel = <T extends { readonly label: string }>(items: readonly T[], label: string): T | undefined =>
  items.find((item) => item.label === label) ?? items.find((item) => sameLabel(item.label, label));

const FALLBACK_LABEL = 'folder';

/** A label for a folder that its owner did not name: the name of the folder, made to fit the rules, and with a number after it when another folder has it already. */
export function defaultLabel(folderName: string, taken: readonly string[]): string {
  const base = toOneLine(folderName.replace(/[\\/]/g, '-')).slice(0, RUNNER_LIMITS.folderLabel).trimEnd() || FALLBACK_LABEL;
  for (let attempt = 1; ; attempt++) {
    const suffix = attempt === 1 ? '' : `-${attempt}`;
    const candidate = `${base.slice(0, RUNNER_LIMITS.folderLabel - suffix.length).trimEnd()}${suffix}`;
    if (!taken.some((label) => sameLabel(label, candidate))) return candidate;
  }
}
