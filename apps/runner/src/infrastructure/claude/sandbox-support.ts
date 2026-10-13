import { programCandidates } from '../../domain/program-path.ts';

export type SandboxSupport = { readonly available: true } | { readonly available: false; readonly why: string };

/** What the sandbox of Claude Code needs on Linux besides Claude Code itself: the tool that confines a command, and the relay of its network traffic. By program, and the package that has it. */
const LINUX_NEEDS: readonly { readonly program: string; readonly package: string }[] = [
  { program: 'bwrap', package: 'bubblewrap' },
  { program: 'socat', package: 'socat' },
];

async function isOnPath(program: string, searchPath: string | undefined, isExecutable: (path: string) => Promise<boolean>): Promise<boolean> {
  for (const candidate of programCandidates(program, searchPath, false)) {
    if (await isExecutable(candidate).catch(() => false)) return true;
  }
  return false;
}

/**
 * Whether the system can confine the shell commands of Claude Code, and when it cannot, why in words for the person. macOS has what it needs
 * built in. Linux has it only with two programs installed, and they are looked for on `searchPath`, which is where Claude Code is told to
 * look: a program that is not there is one that it would not find, whatever else is on the machine. Windows has no sandbox.
 */
export async function sandboxSupport(platform: NodeJS.Platform, searchPath: string | undefined, isExecutable: (path: string) => Promise<boolean>): Promise<SandboxSupport> {
  if (platform === 'darwin') return { available: true };
  if (platform === 'win32') return { available: false, why: 'Claude Code has no sandbox on Windows.' };
  if (platform !== 'linux') return { available: false, why: 'Claude Code has no sandbox on this system.' };
  const missing: string[] = [];
  for (const need of LINUX_NEEDS) if (!(await isOnPath(need.program, searchPath, isExecutable))) missing.push(need.package);
  if (missing.length === 0) return { available: true };
  return { available: false, why: `The sandbox of Claude Code needs ${LINUX_NEEDS.map((need) => need.package).join(' and ')}, and ${missing.join(' and ')} could not be found. Install ${missing.length === 1 ? 'it' : 'them'} to let it run in a folder that is not marked as trusted.` };
}
