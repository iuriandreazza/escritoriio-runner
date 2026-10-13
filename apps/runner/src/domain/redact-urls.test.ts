import { describe, expect, it } from 'vitest';
import { redactUrls } from './redact-urls.ts';

describe('the addresses in a text', () => {
  it.each([
    ['https://github.com/octocat/Hello-World.git', 'https://github.com/octocat/Hello-World.git'],
    ['cloned https://github.com/a/b.git ok', 'cloned https://github.com/a/b.git ok'],
    ['https://user:secret@github.com/a/b.git', 'https://github.com/a/b.git'],
    ['https://ghp_abcdef123456@github.com/a/b.git', 'https://github.com/a/b.git'],
    ['fatal: unable to access "https://x-access-token:ghs_abc@github.com/a/b.git/": 403', 'fatal: unable to access "https://github.com/a/b.git/": 403'],
    ['https://github.com/a/b.git?token=abc123&x=1', 'https://github.com/a/b.git?<redacted>'],
    ['https://example.com/a?access_token=xyz#frag', 'https://example.com/a?<redacted>'],
    ['https://example.com/a#section', 'https://example.com/a#<redacted>'],
    ['ssh://git@github.com/a/b.git', 'ssh://git@github.com/a/b.git'],
    ['ssh://deploy:pw@example.com:2222/a/b.git', 'ssh://example.com:2222/a/b.git'],
    ['two https://u:p@a.example/x and https://q@b.example/y here', 'two https://a.example/x and https://b.example/y here'],
    ['ftp://u:p@files.example/x', 'ftp://files.example/x'],
    ['no address in this text, but an at sign: ana@example.com', 'no address in this text, but an at sign: ana@example.com'],
    ['', ''],
  ])('%j becomes %j', (text, redacted) => {
    expect(redactUrls(text)).toBe(redacted);
  });

  it('leaves no secret behind in a text that repeats an address several times', () => {
    const text = 'https://u:SECRET@h.example/a https://u:SECRET@h.example/a?k=SECRET';
    expect(redactUrls(text)).not.toContain('SECRET');
  });
});
