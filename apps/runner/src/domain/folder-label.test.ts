import { RUNNER_LIMITS } from '@escritoriio/runner-protocol';
import { describe, expect, it } from 'vitest';
import { defaultLabel, DESCRIBE_LABEL_PROBLEM, findByLabel, problemWithLabel, sameLabel } from './folder-label.ts';

describe('a label', () => {
  it.each(['site', 'My site', 'site-2', 'a'.repeat(RUNNER_LIMITS.folderLabel), 'caf\u00e9', 'api (old)', '..'])('may be %j', (label) => {
    expect(problemWithLabel(label)).toBeUndefined();
  });

  it.each([
    ['', 'empty'],
    ['a'.repeat(RUNNER_LIMITS.folderLabel + 1), 'too-long'],
    ['work/site', 'has-separator'],
    ['work\\site', 'has-separator'],
    ['/etc', 'has-separator'],
    ['two\nlines', 'not-plain'],
    ['tab\there', 'not-plain'],
    [' padded', 'not-plain'],
    ['padded ', 'not-plain'],
    ['two  spaces', 'not-plain'],
    ['bell\u0007', 'not-plain'],
    ['evil\u202Etxt', 'not-plain'],
    ['zero\u200Bwidth', 'not-plain'],
  ])('is refused when it is %j', (label, problem) => {
    expect(problemWithLabel(label)).toBe(problem);
  });

  it('has words for every problem', () => {
    for (const words of Object.values(DESCRIBE_LABEL_PROBLEM)) expect(words).toMatch(/^A label /);
  });

  it('is the same as another that differs only in case', () => {
    expect(sameLabel('Site', 'site')).toBe(true);
    expect(sameLabel('site', 'site-2')).toBe(false);
  });
});

describe('finding what a person means by a label', () => {
  const folders = [{ label: 'Site' }, { label: 'api' }];

  it('is the one with that label', () => {
    expect(findByLabel(folders, 'api')).toBe(folders[1]);
  });

  it('is the one that differs only in case, when there is no other', () => {
    expect(findByLabel(folders, 'SITE')).toBe(folders[0]);
  });

  it('is the exact one before the one that differs in case', () => {
    const both = [{ label: 'site' }, { label: 'SITE' }];
    expect(findByLabel(both, 'SITE')).toBe(both[1]);
  });

  it('is nothing for a label that nobody has', () => {
    expect(findByLabel(folders, 'docs')).toBeUndefined();
  });
});

describe('the label of a folder that was not named', () => {
  it('is the name of the folder', () => {
    expect(defaultLabel('site', [])).toBe('site');
  });

  it('has a number after it when another folder has the name already, whatever the case', () => {
    expect(defaultLabel('site', ['Site'])).toBe('site-2');
    expect(defaultLabel('site', ['site', 'site-2'])).toBe('site-3');
  });

  it('is made to fit the rules', () => {
    expect(defaultLabel('my\nsite', [])).toBe('my site');
    expect(defaultLabel('a/b', [])).toBe('a-b');
    expect(defaultLabel('   ', [])).toBe('folder');
    const long = defaultLabel('x'.repeat(100), []);
    expect(long).toHaveLength(RUNNER_LIMITS.folderLabel);
    expect(problemWithLabel(long)).toBeUndefined();
  });

  it('still fits with its number when the name is as long as a label can be', () => {
    const taken = ['x'.repeat(RUNNER_LIMITS.folderLabel)];
    const label = defaultLabel('x'.repeat(100), taken);
    expect(label).toHaveLength(RUNNER_LIMITS.folderLabel);
    expect(label.endsWith('-2')).toBe(true);
    expect(problemWithLabel(label)).toBeUndefined();
  });
});
