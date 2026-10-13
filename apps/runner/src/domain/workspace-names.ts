/** What a folder made in a workspace may be called: one name, the same on every file system, which nothing can read as a path. */
export type WorkspaceNameProblem = 'empty' | 'too-long' | 'not-one-segment' | 'dots' | 'leading-dot' | 'hidden-characters' | 'not-normalized' | 'reserved' | 'trailing' | 'spaces' | 'forbidden-characters';

export const MAX_WORKSPACE_NAME_CHARACTERS = 64;

/** What most file systems keep in one name, in bytes. */
const MAX_NAME_BYTES = 255;

export const DESCRIBE_WORKSPACE_NAME_PROBLEM: Readonly<Record<WorkspaceNameProblem, string>> = {
  empty: 'A folder name cannot be empty.',
  'too-long': `A folder name is at most ${MAX_WORKSPACE_NAME_CHARACTERS} characters.`,
  'not-one-segment': 'A folder name is one name and not a path: it cannot have a slash or a backslash.',
  dots: 'A folder name cannot be . or .. or have two dots in a row.',
  'leading-dot': 'A folder name cannot begin with a dot: such folders are the ones that tools and Git act on by themselves.',
  'hidden-characters': 'A folder name cannot have control characters or characters that hide or reorder text.',
  'not-normalized': 'A folder name must be written in its composed Unicode form (NFC), so that it is one name on every system.',
  reserved: 'A folder name cannot be one that Windows keeps for devices (CON, PRN, AUX, NUL, COM1 to COM9, LPT1 to LPT9), with or without an extension.',
  trailing: 'A folder name cannot end with a dot.',
  spaces: 'A folder name cannot have a space in it, of any kind: use a dash or an underscore.',
  'forbidden-characters': 'A folder name cannot have any of < > : " | ? *.',
};

// Control characters, direction overrides and what is invisible, a line break and a tab included: unlike text said by a coding agent, a name has no lines.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Mn}\u{3164}\u{115F}\u{1160}\u{FFA0}\u{2800}\u{AD}\u{61C}\u{180E}\u{200B}-\u{200F}\u{2028}\u{2029}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{206F}\u{FEFF}\u{E0000}-\u{E007F}]|[\u{34F}]|[\u{17B4}\u{17B5}]|[\u{FE00}-\u{FE0F}]|[\u{E0100}-\u{E01EF}]/u;

// The superscript digits are accepted by Windows as the digit they look like.
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9\u{B9}\u{B2}\u{B3}]|lpt[1-9\u{B9}\u{B2}\u{B3}])(\..*)?$/iu;

/** Why a name cannot be the name of a folder made in a workspace, or nothing when it can. The same rules are asked for every name that the agent gives. */
export function problemWithWorkspaceName(name: string): WorkspaceNameProblem | undefined {
  if (typeof name !== 'string' || name === '') return 'empty';
  if ([...name].length > MAX_WORKSPACE_NAME_CHARACTERS || new TextEncoder().encode(name).length > MAX_NAME_BYTES) return 'too-long';
  if (/[\\/]/.test(name)) return 'not-one-segment';
  if (name === '.' || name === '..' || name.includes('..')) return 'dots';
  if (name.startsWith('.')) return 'leading-dot';
  if (/\p{Z}/u.test(name)) return 'spaces';
  if (name.normalize('NFC') !== name) return 'not-normalized';
  if (HIDDEN.test(name)) return 'hidden-characters';
  if (/[<>:"|?*]/.test(name)) return 'forbidden-characters';
  if (RESERVED.test(name)) return 'reserved';
  if (name.endsWith('.')) return 'trailing';
  return undefined;
}
