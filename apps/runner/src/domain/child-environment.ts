/**
 * The only variables a coding agent is started with. It is built from nothing, not from what the runner was started with: the runner may
 * hold keys of its own or of the shell it was started from, and a coding agent given one would use it ahead of the login the person
 * already has on this machine (Claude Code uses `ANTHROPIC_API_KEY` ahead of its login, and is billed for it). What stays out is every
 * key, token and secret, and everything that names a provider; what goes in is what a program needs to find its own files, its login and a
 * terminal, and to run the person's tools.
 */
const ALLOWED = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TERM', 'TMPDIR', 'TZ', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME'];
const ALLOWED_ON_WINDOWS = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'TEMP', 'TMP', 'LANG', 'CLAUDE_CONFIG_DIR'];

export function childEnvironment(parent: Readonly<Record<string, string | undefined>>, windows: boolean): Record<string, string> {
  const wanted = new Set(windows ? ALLOWED_ON_WINDOWS : ALLOWED);
  const child: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    // Windows writes the same name in any case; the child is given the name as it was found.
    if (value !== undefined && wanted.has(windows ? name.toUpperCase() : name)) child[name] = value;
  }
  return child;
}
