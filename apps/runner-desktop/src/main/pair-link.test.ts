import { describe, expect, it } from 'vitest';
import { linkFromArgv, PAIR_SCHEME, parseDeepLink, PendingLink, protocolRegistration } from './pair-link.ts';

const good = 'escritoriio://pair?server=https%3A%2F%2Foffice.example&code=ABCD-EFGH';

describe('the link that pairs', () => {
  it('reads the server and the code of the one link it knows', () => {
    expect(parseDeepLink(good)).toEqual({ ok: true, server: 'https://office.example', code: 'ABCDEFGH' });
    expect(parseDeepLink('escritoriio://pair?server=http://localhost:8201&code=ABCDEFGH')).toEqual({ ok: true, server: 'http://localhost:8201', code: 'ABCDEFGH' });
  });

  it.each([
    ['another scheme', 'https://pair?server=https://office.example&code=ABCDEFGH'],
    ['another action', 'escritoriio://folders?server=https://office.example&code=ABCDEFGH'],
    ['an action that is a prefix', 'escritoriio://pairing?server=https://office.example&code=ABCDEFGH'],
    ['a path after the action', 'escritoriio://pair/add?server=https://office.example&code=ABCDEFGH'],
    ['a field it does not know', 'escritoriio://pair?server=https://office.example&code=ABCDEFGH&folder=/'],
    ['a field twice', 'escritoriio://pair?server=https://office.example&server=https://evil.example&code=ABCDEFGH'],
    ['no code', 'escritoriio://pair?server=https://office.example'],
    ['no server', 'escritoriio://pair?code=ABCDEFGH'],
    ['a code that is not one', 'escritoriio://pair?server=https://office.example&code=abc'],
    ['plain http for an office that is not this machine', 'escritoriio://pair?server=http://office.example&code=ABCDEFGH'],
    ['credentials in the server', 'escritoriio://pair?server=https://me:secret@office.example&code=ABCDEFGH'],
    ['a server that is not a web address', 'escritoriio://pair?server=file:///etc&code=ABCDEFGH'],
    ['a text that is too long', `escritoriio://pair?server=https://office.example&code=ABCDEFGH&${'x'.repeat(3_000)}`],
    ['nothing', ''],
    ['nonsense', 'not a link'],
  ])('ignores %s', (_name, link) => {
    expect(parseDeepLink(link).ok).toBe(false);
  });

  it('says why it ignored a link without saying its code', () => {
    const result = parseDeepLink('escritoriio://pair?server=https://office.example&code=ZZZZZZZZ&folder=/');
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain('ZZZZZZZZ');
    expect(JSON.stringify(parseDeepLink('escritoriio://pair?server=http://office.example&code=ZZZZZZZZ'))).not.toContain('ZZZZZZZZ');
  });
});

describe('the link in the arguments of a start', () => {
  it('finds the first link and nothing else', () => {
    expect(linkFromArgv(['/app/Runner.exe', '--flag', good])).toBe(good);
    expect(linkFromArgv(['/app/Runner.exe', '--flag'])).toBeUndefined();
    expect(linkFromArgv(['/app/Runner.exe', 'https://office.example/', 'ESCRITORIIO://pair?server=x&code=y'])).toBe('ESCRITORIIO://pair?server=x&code=y');
    expect(linkFromArgv([])).toBeUndefined();
  });
});

describe('the link that waits to be looked at', () => {
  const link = { server: 'https://office.example', code: 'ABCDEFGH' };

  it('is told to the window by an id and the host, and keeps the code to itself', () => {
    const pending = new PendingLink();
    const shown = pending.hold(link);
    expect(shown.host).toBe('office.example');
    expect(JSON.stringify(shown)).not.toContain('ABCDEFGH');
    expect(pending.current()).toEqual(shown);
  });

  it('can be looked at without being used up', () => {
    const pending = new PendingLink();
    const { linkId } = pending.hold(link);
    expect(pending.peek(linkId)).toEqual(link);
    expect(pending.peek('another')).toBeUndefined();
    expect(pending.current()).not.toBeNull();
  });

  it('is given back once, by the id it was told by', () => {
    const pending = new PendingLink();
    const { linkId } = pending.hold(link);
    expect(pending.take('another')).toBeUndefined();
    expect(pending.take(linkId)).toEqual(link);
    expect(pending.take(linkId)).toBeUndefined();
    expect(pending.current()).toBeNull();
  });

  it('is replaced by a newer one, whose id the older one cannot be taken by', () => {
    const pending = new PendingLink();
    const first = pending.hold(link);
    const second = pending.hold({ server: 'https://other.example', code: 'HGFEDCBA' });
    expect(second.linkId).not.toBe(first.linkId);
    expect(pending.take(first.linkId)).toBeUndefined();
    expect(pending.take(second.linkId)?.server).toBe('https://other.example');
  });
});

describe('how the system is told to hand links to the app', () => {
  it('registers the scheme of the link, with the arguments `--` first on Windows, where the system puts the link after them: whatever the link says is then never read as a switch', () => {
    expect(protocolRegistration('win32', 'C:\\App\\Runner.exe')).toEqual([PAIR_SCHEME, 'C:\\App\\Runner.exe', ['--']]);
  });

  it('registers only the scheme elsewhere, where the system takes no path or arguments', () => {
    expect(protocolRegistration('darwin', '/Applications/Runner')).toEqual([PAIR_SCHEME]);
    expect(protocolRegistration('linux', '/opt/Runner')).toEqual([PAIR_SCHEME]);
  });

  it('still finds the link among the arguments when `--` is in front of it', () => {
    expect(linkFromArgv(['Runner.exe', '--', good])).toBe(good);
  });
});
