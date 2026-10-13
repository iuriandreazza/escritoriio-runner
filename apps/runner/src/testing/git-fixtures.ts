import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Whoever runs the tests has settings of their own, and the same repository must come out of them everywhere: git here has an identity
// of its own and reads nothing of the person's.
const FIXTURE_ENVIRONMENT = {
  PATH: process.env.PATH ?? '',
  HOME: '/a-home-that-does-not-exist',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
};

/** Plain git, with nothing switched off: for building a repository, and for doing what a coding agent does in it. Gives what git said. */
export async function plainGit(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: FIXTURE_ENVIRONMENT });
  return stdout;
}

export async function writeInto(directory: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), content);
  }
}

/** A repository on `main` with one commit holding `files`. */
export async function createRepository(directory: string, files: Readonly<Record<string, string>>): Promise<void> {
  await mkdir(directory, { recursive: true });
  await plainGit(directory, 'init', '--quiet', '--initial-branch=main');
  await writeInto(directory, files);
  await plainGit(directory, 'add', '-A');
  await plainGit(directory, 'commit', '--quiet', '-m', 'First commit');
}

/** The signal of a task that nobody stops. */
export const neverAborted = (): AbortSignal => new AbortController().signal;
