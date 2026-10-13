// An address as far as a space, a quote or a bracket: what a program says of one is wrapped in quotes and punctuation.
const ADDRESS = /\b([a-z][a-z0-9+.-]*):\/\/([^\s'"<>)\]]+)/gi;

/**
 * What a text says of an address may not carry a secret of the owner's: the user name and the password of an address (a token is often
 * the user name), and everything after a `?` or a `#`, which is where tokens are put. The rest of the address is kept, since it is what
 * the owner approved and what a person needs to understand the words.
 */
export function redactUrls(text: string): string {
  return text.replace(ADDRESS, (_whole, scheme: string, rest: string) => {
    const authorityEnd = rest.search(/[/?#]/);
    const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
    const after = authorityEnd === -1 ? '' : rest.slice(authorityEnd);
    const host = authority.slice(authority.lastIndexOf('@') + 1);
    const user = authority.includes('@') && scheme.toLowerCase() === 'ssh' && authority.slice(0, authority.lastIndexOf('@')) === 'git' ? 'git@' : '';
    const query = /[?#]/.exec(after);
    const kept = query ? `${after.slice(0, query.index)}${query[0]}<redacted>` : after;
    return `${scheme}://${user}${host}${kept}`;
  });
}
