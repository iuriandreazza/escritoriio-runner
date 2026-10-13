/** Why an address cannot be cloned from by an agent that is not yet trusted with the machine: the words say what is accepted, never what was typed. */
export type CloneUrlProblem =
  | 'empty'
  | 'too-long'
  | 'leading-dash'
  | 'hidden-characters'
  | 'query-or-fragment'
  | 'not-supported'
  | 'credentials-in-url'
  | 'bad-host'
  | 'private-host'
  | 'bad-port'
  | 'odd-path';

export const MAX_CLONE_URL_CHARACTERS = 512;

export const DESCRIBE_CLONE_URL_PROBLEM: Readonly<Record<CloneUrlProblem, string>> = {
  empty: 'A repository address cannot be empty.',
  'too-long': `A repository address is at most ${MAX_CLONE_URL_CHARACTERS} characters.`,
  'leading-dash': 'A repository address cannot begin with a dash: Git would read it as an option.',
  'hidden-characters': 'A repository address cannot have spaces, control characters or characters that hide or reorder text.',
  'query-or-fragment': 'A repository address cannot have a ? or a # in it.',
  'not-supported': 'A repository address is https://host/path, git@host:path or ssh://git@host/path. Files, local paths, git://, http:// and programs are not cloned from.',
  'credentials-in-url': 'A repository address cannot carry a user name or a password: it is https://host/path, or ssh with the user git. Credentials are the owner’s own, on their machine.',
  'bad-host': 'A repository address needs a plain host name, such as github.com.',
  'private-host': 'A repository address needs a public host name: an IP address, localhost and the names of a private network are not cloned from.',
  'bad-port': 'A repository address can have a port from 1 to 65535, and only after the host name.',
  'odd-path': 'A repository address needs a path of plain names, such as owner/project.git: no empty parts, dots, dashes at the start, percent signs or a slash at the end.',
};

export type ParsedCloneUrl =
  | {
      readonly ok: true;
      /** As it came: it is what the owner is shown and approves. */
      readonly url: string;
      /** The host name, in lower case. */
      readonly host: string;
      /** The name of the repository, which is what the folder is called when nobody names it. */
      readonly repository: string;
    }
  | { readonly ok: false; readonly problem: CloneUrlProblem };

const HIDDEN = /[\s\p{Cc}\u{AD}\u{61C}\u{180E}\u{200B}-\u{200F}\u{2028}\u{2029}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{206F}\u{FEFF}\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/u;

/** The last name of a host that is for a network of one place and no other. Names are not resolved, so a public name that points at a private address is not caught here. */
const PRIVATE_TOP_LEVELS = new Set(['localhost', 'local', 'localdomain', 'internal', 'lan', 'intranet', 'corp', 'private', 'home', 'arpa', 'test', 'example', 'invalid', 'onion']);

const PATH_SEGMENT = /^[A-Za-z0-9._~][A-Za-z0-9._~-]*$/;

/** Whether the host is one that anybody on the internet can reach by name: not an address, not localhost, not a name of a private network. */
function problemWithHost(host: string): 'bad-host' | 'private-host' | undefined {
  if (host.startsWith('[')) return 'private-host';
  const name = host.toLowerCase();
  if (name === '' || name.length > 253 || !/^[a-z0-9.-]+$/.test(name)) return 'bad-host';
  const labels = name.split('.');
  if (labels.some((label) => label === '' || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) return 'bad-host';
  const last = labels.at(-1) ?? '';
  // An address in any of the forms that a resolver reads (`127.0.0.1`, `2130706433`, `0x7f.1`) is a number or a number in hexadecimal.
  if (/^\d+$/.test(last) || labels.some((label) => /^0x[0-9a-f]*$/.test(label))) return 'private-host';
  if (labels.length < 2 || PRIVATE_TOP_LEVELS.has(last)) return 'private-host';
  return undefined;
}

function problemWithPort(port: string | undefined): 'bad-port' | undefined {
  if (port === undefined) return undefined;
  const number = /^\d{1,5}$/.test(port) ? Number(port) : 0;
  return number >= 1 && number <= 65_535 ? undefined : 'bad-port';
}

/** The names of a path as a repository has them, and the last of them without `.git`: nothing that climbs, hides, starts like an option or is written in percent signs. */
function pathOf(path: string): { readonly repository: string } | undefined {
  const segments = path.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..' || !PATH_SEGMENT.test(segment))) return undefined;
  return { repository: (segments.at(-1) ?? '').replace(/\.git$/, '') };
}

/**
 * Whether an agent may ask for this repository to be cloned, and where it is: only `https://host/path`, `git@host:path` and
 * `ssh://git@host[:port]/path`, to a host that anybody reaches by name. What the agent asks for is a request for the owner to read and
 * approve, so nothing here is changed on the way: the address is accepted as it is or refused with a reason.
 */
export function parseCloneUrl(url: string): ParsedCloneUrl {
  const refuse = (problem: CloneUrlProblem): ParsedCloneUrl => ({ ok: false, problem });
  if (typeof url !== 'string' || url === '') return refuse('empty');
  if (url.length > MAX_CLONE_URL_CHARACTERS) return refuse('too-long');
  if (url.startsWith('-')) return refuse('leading-dash');
  if (HIDDEN.test(url)) return refuse('hidden-characters');
  if (/[?#]/.test(url)) return refuse('query-or-fragment');

  const address = /^(https|ssh):\/\/([^/]*)(?:\/(.*))?$/.exec(url);
  if (address) {
    const [, scheme, authority = '', path = ''] = address;
    const at = authority.lastIndexOf('@');
    const user = at === -1 ? undefined : authority.slice(0, at);
    // An https address has no user at all (a token in it would be shown, kept and said), and an ssh one has the user git, which holds no secret.
    if (scheme === 'https' && user !== undefined) return refuse('credentials-in-url');
    if (scheme === 'ssh') {
      if (user === undefined) return refuse('not-supported');
      if (user !== 'git') return refuse('credentials-in-url');
    }
    const hostAndPort = at === -1 ? authority : authority.slice(at + 1);
    const colon = hostAndPort.lastIndexOf(':');
    const bracketed = hostAndPort.startsWith('[');
    const host = colon === -1 || bracketed ? hostAndPort : hostAndPort.slice(0, colon);
    const port = colon === -1 || bracketed ? undefined : hostAndPort.slice(colon + 1);
    const hostProblem = problemWithHost(host);
    if (hostProblem) return refuse(hostProblem);
    const portProblem = problemWithPort(port);
    if (portProblem) return refuse(portProblem);
    const parsed = path === '' ? undefined : pathOf(path);
    return parsed ? { ok: true, url, host: host.toLowerCase(), repository: parsed.repository } : refuse('odd-path');
  }

  const scp = /^([^@/:]+)@([^:/]+):(.*)$/.exec(url);
  if (scp) {
    const [, user = '', host = '', path = ''] = scp;
    if (user !== 'git') return refuse('credentials-in-url');
    const hostProblem = problemWithHost(host);
    if (hostProblem) return refuse(hostProblem);
    const parsed = path === '' ? undefined : pathOf(path);
    return parsed ? { ok: true, url, host: host.toLowerCase(), repository: parsed.repository } : refuse('odd-path');
  }
  return refuse('not-supported');
}
