import type { FolderQuestion } from '@escritoriio/runner';

type Folder = FolderQuestion['folder'];
type Facts = (folder: Folder, platform: NodeJS.Platform) => readonly string[];

/**
 * One short line for each thing the owner agrees to, in the words of this window. The native box cannot hold an (i) button, so what is said here is
 * only what decides: every fact that widens what the machine does is in it, and the explanations that the window shows behind its buttons are not.
 * The command line says the same at greater length (`describeFolderChoice`), for a terminal.
 *
 * It is keyed by every field of a folder, so that a field that is added to a folder (the way a workspace is worked in, for one) does not get past the
 * build until this says something about it. That is the place to say it: a line, short, that widens nothing without saying so.
 */
const FACTS: { readonly [K in keyof Folder]-?: Facts } = {
  label: () => [],
  path: ({ label, path, realPath }) => [`Folder "${label}": ${path}${path === realPath ? '' : ` (really ${realPath})`}`],
  realPath: () => [],
  access: ({ access }, platform) =>
    access === 'edit'
      ? [
          'Edit: file tools (not sandboxed) and a shell that can read the rest of this machine.',
          ...(platform === 'win32' ? ['There is no sandbox on this system: nothing contains the commands.'] : []),
        ]
      : ['Read only: reads the files and runs nothing.'],
  approval: ({ approval }) => [approval === 'auto' ? 'Each task starts without asking you.' : 'You approve each task, with its exact text, before it starts.'],
  isolation: ({ isolation, kind }) =>
    isolation === 'in-place'
      ? ['Works in place, on the files themselves, with no copy.', ...(kind === 'workspace' ? [] : ['Git hooks and settings that a task adds and that would run programs are removed after it.'])]
      : ['Works on a copy, on its own branch. Nothing is pushed.'],
  trusted: ({ trusted }) => [trusted ? 'Trusted: a coding agent with no sandbox may run here, with everything your user account can reach.' : 'Not trusted: only a coding agent that can be contained runs here.'],
  agent: ({ agent }) => [`Coding agent: ${agent ?? 'the first one that can run'}`],
  kind: ({ kind }) => (kind === 'workspace' ? ['Working folder: made empty for the agent, which works in place in it, may create folders inside without asking, and may ask to clone repositories that you approve one by one.'] : []),
};

/** What the dialog says to someone who shares a folder: the facts above, and how to undo it. */
export function describeFolderForDialog({ folder }: FolderQuestion, platform: NodeJS.Platform = process.platform): readonly string[] {
  const facts = (Object.values(FACTS) as Facts[]).flatMap((say) => say(folder, platform));
  return [...facts, 'You can stop sharing it at any time: Folders, Remove.'];
}
