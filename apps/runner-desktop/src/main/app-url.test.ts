import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ENTRY_URL, APP_ORIGIN, fileForAppUrl, isOwnUrl } from './app-url.ts';

const root = join(sep, 'opt', 'app', 'renderer');

describe('the address of the app’s own bundle', () => {
  it('is its own scheme and host, not a web address and not a file', () => {
    expect(APP_ENTRY_URL).toBe(`${APP_ORIGIN}/index.html`);
    expect(new URL(APP_ORIGIN).protocol).not.toMatch(/^(https?|file|ftp|wss?):$/);
  });

  it.each([
    [`${APP_ORIGIN}/index.html`, true],
    [`${APP_ORIGIN}/`, true],
    [`${APP_ORIGIN}/assets/index-abc.js?x=1#top`, true],
    ['https://escritoriio.example/', false],
    ['http://app/index.html', false],
    ['file:///opt/app/renderer/index.html', false],
    ['about:blank', false],
    ['data:text/html,<script>1</script>', false],
    ['javascript:alert(1)', false],
    ['escritoriio://pair?server=https://x&code=ABCDEFGH', false],
    [`${APP_ORIGIN.replace('//app', '//other')}/index.html`, false],
    [`${APP_ORIGIN.replace('//app', '//user:pass@app')}/index.html`, false],
    [`${APP_ORIGIN.replace('//app', '//app:8080')}/index.html`, false],
    ['', false],
    ['not a url', false],
    [undefined, false],
  ])('says whether %s is its own', (url, own) => {
    expect(isOwnUrl(url)).toBe(own);
  });
});

describe('the file an address of the bundle stands for', () => {
  it('maps the root and paths inside the renderer folder', () => {
    expect(fileForAppUrl(root, `${APP_ORIGIN}/`)).toBe(join(root, 'index.html'));
    expect(fileForAppUrl(root, `${APP_ORIGIN}/index.html`)).toBe(join(root, 'index.html'));
    expect(fileForAppUrl(root, `${APP_ORIGIN}/assets/index-abc.js?v=1`)).toBe(join(root, 'assets', 'index-abc.js'));
  });

  it.each([
    '/../secret',
    '/assets/../../secret',
    '/%2e%2e/secret',
    '/%2E%2E/secret',
    '/assets/%2e%2e/%2e%2e/secret',
    '/..%2fsecret',
    '/assets%2f..%2f..%2fsecret',
    '/..\\secret',
    '/assets\\..\\..\\secret',
    '/%5c..%5csecret',
    '/%00',
    '/index.html%00.png',
    '/./index.html',
    '//index.html',
    '/assets//index.js',
  ])('refuses a way out of the folder: %s', (path) => {
    expect(fileForAppUrl(root, `${APP_ORIGIN}${path}`)).toBeUndefined();
  });

  it('refuses an address that is not its own', () => {
    expect(fileForAppUrl(root, 'https://app/index.html')).toBeUndefined();
    expect(fileForAppUrl(root, 'file:///etc/passwd')).toBeUndefined();
    expect(fileForAppUrl(root, 'nonsense')).toBeUndefined();
  });
});
