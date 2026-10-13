import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Reads the fuses of a packaged app, as the tool of Electron prints them, and fails when one that lets a stolen copy of the program run other code is on:
// `node scripts/fuses-check.mjs <packaged app or executable>`. What electron-builder was asked for (electronFuses in electron-builder.yml) is not taken
// on trust: this reads what is in the file that was built.

// The state each fuse has to have. A fuse the output does not name is a fuse that was not read, and is not taken to be right.
const REQUIRED = {
  RunAsNode: 'Disabled',
  EnableNodeOptionsEnvironmentVariable: 'Disabled',
  EnableNodeCliInspectArguments: 'Disabled',
  OnlyLoadAppFromAsar: 'Enabled',
};

// Pinned, so that a release that holds signing secrets does not run whatever version of a tool the registry has that day.
const FUSES_TOOL = '@electron/fuses@1.8.0';

const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const withoutColours = (text) => text.replace(COLOUR, '');

// With a shell, the arguments are one string: a path with a space in it ("Escritoriio Runner.exe") has to be quoted or it is read as two.
export const forShell = (argument, shell) => (shell ? `"${argument.replaceAll('"', '\\"')}"` : argument);

export function fuseProblems(output) {
  const states = new Map([...withoutColours(output).matchAll(/^\s*(\w+) is (\w+)\s*$/gm)].map((match) => [match[1], match[2]]));
  return Object.entries(REQUIRED).flatMap(([name, wanted]) => {
    const state = states.get(name);
    return state === wanted ? [] : [`${name} is ${state ?? 'not in what was read'}, and has to be ${wanted}.`];
  });
}

function main(app) {
  if (!app) {
    console.error('Usage: node scripts/fuses-check.mjs <packaged app or executable>');
    return 2;
  }
  // Windows needs a shell to run the .cmd that npx is there.
  const shell = process.platform === 'win32';
  const read = spawnSync('npx', ['--yes', FUSES_TOOL, 'read', '--app', forShell(app, shell)], { encoding: 'utf8', shell, env: { ...process.env, NO_COLOR: '1' } });
  process.stdout.write(read.stdout ?? '');
  if (read.status !== 0) {
    console.error(`The fuses could not be read: ${read.stderr || read.error?.message || 'the tool failed'}`);
    return 1;
  }
  const problems = fuseProblems(read.stdout);
  for (const problem of problems) console.error(`FUSE: ${problem}`);
  if (problems.length === 0) console.log('The fuses of the packaged app are as they have to be.');
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv[2]);
