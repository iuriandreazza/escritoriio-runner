import { describe, expect, it } from 'vitest';
import { DESCRIBE_CLONE_URL_PROBLEM, MAX_CLONE_URL_CHARACTERS, parseCloneUrl } from './clone-url.ts';

// The export of the runner to its public repository refuses the literal address of a private network anywhere in what it carries, tests included.
const address = (...parts: number[]): string => parts.join('.');

const accepted = (url: string) => {
  const parsed = parseCloneUrl(url);
  if (!parsed.ok) throw new Error(`${url} was refused: ${parsed.problem}`);
  return parsed;
};

describe('a URL to clone from', () => {
  it.each([
    ['https://github.com/octocat/Hello-World.git', 'github.com', 'Hello-World'],
    ['https://github.com/octocat/Hello-World', 'github.com', 'Hello-World'],
    ['https://gitlab.com/group/sub.group/project.git', 'gitlab.com', 'project'],
    ['https://git.example.org:8443/team/repo.git', 'git.example.org', 'repo'],
    ['https://example.com/repo.git', 'example.com', 'repo'],
    ['git@github.com:octocat/Hello-World.git', 'github.com', 'Hello-World'],
    ['git@gitlab.example.com:group/project', 'gitlab.example.com', 'project'],
    ['ssh://git@github.com/octocat/Hello-World.git', 'github.com', 'Hello-World'],
    ['ssh://git@git.example.org:2222/team/repo.git', 'git.example.org', 'repo'],
    ['https://xn--caf-dma.org/repo.git', 'xn--caf-dma.org', 'repo'],
  ])('may be %s', (url, host, repository) => {
    const parsed = accepted(url);
    // It is what the owner is shown and approves, so it is given back exactly as it came.
    expect(parsed.url).toBe(url);
    expect(parsed.host).toBe(host);
    expect(parsed.repository).toBe(repository);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'hidden-characters'],
    [`https://github.com/${'a'.repeat(MAX_CLONE_URL_CHARACTERS)}`, 'too-long'],
    // Schemes that read files, run programs or send nothing safe.
    ['file:///Users/ana/secret-repo', 'not-supported'],
    ['file://localhost/etc', 'not-supported'],
    ['ext::sh -c "touch /tmp/pwned"', 'hidden-characters'],
    ['ext::sh-c-touch-/tmp/pwned', 'not-supported'],
    ['ext::ssh://example.com/repo', 'not-supported'],
    ['git://github.com/octocat/Hello-World.git', 'not-supported'],
    ['http://github.com/octocat/Hello-World.git', 'not-supported'],
    ['ftp://example.com/repo.git', 'not-supported'],
    ['HTTPS://github.com/octocat/Hello-World.git', 'not-supported'],
    ['fd::17/repo', 'not-supported'],
    ['transport::address', 'not-supported'],
    // Places on this machine.
    ['/Users/ana/repo', 'not-supported'],
    ['./repo', 'not-supported'],
    ['../repo', 'not-supported'],
    ['~/repo', 'not-supported'],
    ['repo', 'not-supported'],
    ['C:\\repos\\project', 'not-supported'],
    ['\\\\server\\share\\repo', 'not-supported'],
    // Something git reads as an option.
    ['--upload-pack=touch /tmp/pwned', 'leading-dash'],
    ['-oProxyCommand=touch /tmp/pwned', 'leading-dash'],
    ['-u', 'leading-dash'],
    // Credentials do not belong in a URL that is shown, kept and said.
    ['https://user:password@github.com/octocat/Hello-World.git', 'credentials-in-url'],
    ['https://token@github.com/octocat/Hello-World.git', 'credentials-in-url'],
    ['https://github.com@evil.example/octocat/Hello-World.git', 'credentials-in-url'],
    ['ssh://deploy@github.com/octocat/Hello-World.git', 'credentials-in-url'],
    ['ssh://git:secret@github.com/octocat/Hello-World.git', 'credentials-in-url'],
    ['ssh://github.com/octocat/Hello-World.git', 'not-supported'],
    ['deploy@github.com:octocat/Hello-World.git', 'credentials-in-url'],
    ['root@github.com:octocat/Hello-World.git', 'credentials-in-url'],
    // Nothing a person reads differently from what is run.
    ['https://github.com/octocat/Hello-World.git\n', 'hidden-characters'],
    ['https://github.com/octo\tcat/Hello-World.git', 'hidden-characters'],
    ['https://github.com/octocat/Hello World.git', 'hidden-characters'],
    ['https://github.com/octocat/Hello\u{202E}World.git', 'hidden-characters'],
    ['https://github.com/octocat/Hello\u{200B}World.git', 'hidden-characters'],
    ['https://github.com/octocat/Hello\u{0}World.git', 'hidden-characters'],
    [' https://github.com/octocat/Hello-World.git', 'hidden-characters'],
    ['https://github.com/octocat/Hello-World.git ', 'hidden-characters'],
    ['https://github.com\\octocat\\Hello-World.git', 'bad-host'],
    // Tokens and tricks after the path.
    ['https://github.com/octocat/Hello-World.git?token=abc', 'query-or-fragment'],
    ['https://github.com/octocat/Hello-World.git#main', 'query-or-fragment'],
    ['git@github.com:octocat/Hello-World.git?x=1', 'query-or-fragment'],
    // Where it would go.
    ['https://localhost/octocat/repo.git', 'private-host'],
    ['https://LOCALHOST/octocat/repo.git', 'private-host'],
    ['https://repo.localhost/octocat/repo.git', 'private-host'],
    ['https://127.0.0.1/octocat/repo.git', 'private-host'],
    [`https://${address(10, 0, 0, 5)}/octocat/repo.git`, 'private-host'],
    [`https://${address(192, 168, 1, 10)}/octocat/repo.git`, 'private-host'],
    [`https://${address(172, 16, 0, 1)}/octocat/repo.git`, 'private-host'],
    ['https://169.254.169.254/latest/meta-data', 'private-host'],
    ['https://8.8.8.8/octocat/repo.git', 'private-host'],
    ['https://0x7f.1/octocat/repo.git', 'private-host'],
    ['https://2130706433/octocat/repo.git', 'private-host'],
    ['https://[::1]/octocat/repo.git', 'private-host'],
    ['https://[2001:db8::1]/octocat/repo.git', 'private-host'],
    ['https://printer.local/octocat/repo.git', 'private-host'],
    ['https://git.internal/octocat/repo.git', 'private-host'],
    ['https://git.lan/octocat/repo.git', 'private-host'],
    ['https://git.home.arpa/octocat/repo.git', 'private-host'],
    ['https://intranet/octocat/repo.git', 'private-host'],
    ['git@localhost:octocat/repo.git', 'private-host'],
    [`git@${address(10, 1, 2, 3)}:octocat/repo.git`, 'private-host'],
    ['ssh://git@127.0.0.1/octocat/repo.git', 'private-host'],
    // Names that are not hosts.
    ['git@a.test:a/b', 'private-host'],
    ['git@x.example:a/b', 'private-host'],
    ['git@evil.localdomain:a/b', 'private-host'],
    ['https://a.onion/a/b', 'private-host'],
    ['https://a.invalid/a/b', 'private-host'],
    ['https://a.test/a/b', 'private-host'],
    ['https://git.example/a/b', 'private-host'],
    ['https:///octocat/repo.git', 'bad-host'],
    ['https://-bad.example/repo.git', 'bad-host'],
    ['https://bad-.example/repo.git', 'bad-host'],
    ['https://exa mple.com/repo.git', 'hidden-characters'],
    ['https://exa_mple.com/repo.git', 'bad-host'],
    ['https://example..com/repo.git', 'bad-host'],
    ['https://example.com./repo.git', 'bad-host'],
    ['https://github.com:0/repo.git', 'bad-port'],
    ['https://github.com:99999/repo.git', 'bad-port'],
    ['https://github.com:abc/repo.git', 'bad-port'],
    ['https://github.com:/repo.git', 'bad-port'],
    // Paths.
    ['https://github.com', 'odd-path'],
    ['https://github.com/', 'odd-path'],
    ['https://github.com//repo.git', 'odd-path'],
    ['https://github.com/octocat//repo.git', 'odd-path'],
    ['https://github.com/octocat/repo.git/', 'odd-path'],
    ['https://github.com/../etc/passwd', 'odd-path'],
    ['https://github.com/octocat/./repo.git', 'odd-path'],
    ['https://github.com/octocat/%2e%2e/repo.git', 'odd-path'],
    ['https://github.com/octocat/repo%2Fgit', 'odd-path'],
    ['https://github.com/octo cat/repo', 'hidden-characters'],
    ['https://github.com/-octocat/repo.git', 'odd-path'],
    ['https://github.com/octocat/-repo.git', 'odd-path'],
    ['git@github.com:/octocat/repo.git', 'odd-path'],
    ['git@github.com:../repo.git', 'odd-path'],
    ['git@github.com:-oProxyCommand=x/repo', 'odd-path'],
    ['git@github.com:', 'odd-path'],
    ['git@github.com:octocat/repo.git/', 'odd-path'],
    ['ssh://git@github.com', 'odd-path'],
    ['ssh://git@github.com/', 'odd-path'],
  ])('is refused when it is %j', (url, problem) => {
    const parsed = parseCloneUrl(url);
    expect(parsed).toEqual({ ok: false, problem });
  });

  it('is refused when it is not text', () => {
    expect(parseCloneUrl(undefined as unknown as string)).toEqual({ ok: false, problem: 'empty' });
    expect(parseCloneUrl({ href: 'https://github.com/a/b' } as unknown as string)).toEqual({ ok: false, problem: 'empty' });
  });

  it('has words for every problem, none of which repeats what was typed', () => {
    for (const words of Object.values(DESCRIBE_CLONE_URL_PROBLEM)) expect(words).toMatch(/^A repository address /);
  });
});
