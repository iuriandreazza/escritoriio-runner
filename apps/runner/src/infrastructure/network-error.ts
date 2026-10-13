/**
 * What went wrong with a request that never got an answer, in a word a person can look up. The library says `fetch failed` and puts
 * the reason (`ECONNREFUSED`, `ENOTFOUND`, an expired certificate) in the `cause`, a level or two down; a connection to a name that has
 * both an IPv6 and an IPv4 address gives an error with no message of its own, only the code.
 */
export function describeNetworkError(error: unknown): string {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return error instanceof Error && error.message !== '' ? error.message : 'unknown error';
}
