import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from '../main/window-policy.ts';

const page = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

describe('the page of the renderer', () => {
  it('carries the same policy as the one the main process sends, so that the two cannot drift', () => {
    expect(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(page)?.[1]).toBe(CONTENT_SECURITY_POLICY);
  });

  it('has no inline script, no inline style and nothing that is not its own file', () => {
    expect(page).not.toMatch(/<script(?![^>]*\ssrc=)/i);
    expect(page).not.toMatch(/\sstyle=/i);
    expect(page).not.toMatch(/<style/i);
    expect(page).not.toMatch(/\son[a-z]+=/i);
    expect(page).not.toMatch(/(?:src|href)="(?:https?:)?\/\//i);
  });
});

describe('the screens of the renderer', () => {
  const sources = readdirSync(new URL('.', import.meta.url))
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'testing.tsx')
    .map((name) => ({ name, text: readFileSync(new URL(name, import.meta.url), 'utf8') }));

  it('draw nothing as markup, give nothing a style of its own and make no link or image', () => {
    expect(sources.length).toBeGreaterThan(10);
    for (const { name, text } of sources) {
      expect(text, name).not.toMatch(/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
      expect(text, name).not.toMatch(/\sstyle=\{/);
      expect(text, name).not.toMatch(/<(a|img|iframe|script|object|embed|link)[\s>]/);
      expect(text, name).not.toMatch(/window\.open|location\.(href|assign|replace)|eval\(|new Function/);
    }
  });
});
