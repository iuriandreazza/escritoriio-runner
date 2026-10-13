import { describe, expect, it } from 'vitest';
import { scrubSecrets } from './scrub-diagnostics.ts';

const MARK = '[secret removed]';
const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';

describe('scrubSecrets', () => {
  it.each([
    ['an Anthropic key', 'logged in with sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv', `logged in with ${MARK}`],
    ['an OpenAI key', 'key sk-proj-1234567890abcdefghij', `key ${MARK}`],
    ['a GitHub token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', MARK],
    ['a fine-grained GitHub token', 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz_0123456789', MARK],
    ['a Slack token', 'xoxb-123456789012-abcdefghij', MARK],
    ['an AWS key id', 'AKIAIOSFODNN7EXAMPLE', MARK],
    ['a Google key', 'AIzaSyA-1234567890abcdefghijklmnopqrstu', MARK],
    ['a bearer token', 'Authorization: Bearer abcdefghijklmnop1234', `Authorization: ${MARK}`],
    ['a bearer token in lower case', 'bearer abcdefghijklmnop1234', MARK],
    ['a JWT', `session ${JWT} ended`, `session ${MARK} ended`],
    ['a private key block', `before\n${PRIVATE_KEY}\nafter`, `before\n${MARK}\nafter`],
    ['a private key block that was cut off', 'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA', `before\n${MARK}`],
    ['a long hexadecimal secret', 'digest 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', `digest ${MARK}`],
    ['a long random run', 'secret-ish aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7kL9', `secret-ish ${MARK}`],
    ['an assignment, keeping its name', 'ANTHROPIC_API_KEY=somevalue123', `ANTHROPIC_API_KEY=${MARK}`],
    ['a colon assignment', 'password: hunter2hunter2', `password: ${MARK}`],
    ['a quoted assignment', 'token = "abcd1234"', `token = "${MARK}"`],
  ])('takes out %s', (_name, text, expected) => {
    expect(scrubSecrets(text)).toBe(expected);
  });

  it.each([
    ['plain words', 'claude-code 2.1.250, logged in, sandbox of its own'],
    ['a path', '/Users/ana/Library/Application Support/escritoriio-runner/worktrees/Project2024/MyApp'],
    ['a long path with digits and capitals', '/Users/Ana2/Projects2024/MyAppWithALongName/packages/SomeOtherPackage1/src/Thing'],
    ['a Windows path', String.raw`C:\Users\Ana\AppData\Local\escritoriio-runner\worktrees\Project2024`],
    ['a short hexadecimal', 'revision 9f86d08'],
    ['an assignment with a short value', 'token: ok'],
    ['a name that only holds a word of a secret', 'the tokenizer is fine'],
    ['a version', 'runner 0.2.0 on node v24.15.0'],
    ['the time', 'the clock is 3 seconds ahead of the office'],
  ])('leaves %s as it is', (_name, text) => {
    expect(scrubSecrets(text)).toBe(text);
  });

  it('takes out the values it is told are secret, wherever they are, as they are written', () => {
    expect(scrubSecrets('connected with plain-token and then plain-token again', ['plain-token'])).toBe(`connected with ${MARK} and then ${MARK} again`);
  });

  it('takes out the longer of two secrets first, so that one that holds another goes whole', () => {
    expect(scrubSecrets('abc and abcdef', ['abc', 'abcdef'])).toBe(`${MARK} and ${MARK}`);
  });

  it('ignores an empty secret instead of cutting the text between every character', () => {
    expect(scrubSecrets('safe', [''])).toBe('safe');
  });

  it('takes out several secrets in one text', () => {
    expect(scrubSecrets(`a ${JWT} b sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv c`)).toBe(`a ${MARK} b ${MARK} c`);
  });

  it('is said once: scrubbing what was scrubbed changes nothing', () => {
    const once = scrubSecrets(`${JWT} password: hunter2hunter2`);
    expect(scrubSecrets(once)).toBe(once);
  });
});
