import { execFile, spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProcessTable, environmentHolds, parentFromStat, parseWorkingFolders, pidsCarrying } from './process-table.ts';
import type { Listing, ProcFiles } from './process-table.ts';

const ENTRY = 'ESCRITORIIO_TASK=abc123';

describe('the processes that carry an entry of the environment, as `ps` lists them', () => {
  it('are the ones whose environment, printed after the command, has the entry as a word of its own', () => {
    const lines = [
      `  101 node server.js PATH=/usr/bin ${ENTRY} HOME=/Users/ana`,
      `  102 /bin/sleep 600 PATH=/usr/bin HOME=/Users/ana`,
      `   7 python3 job.py ${ENTRY}`,
    ];
    expect(pidsCarrying(lines, ENTRY)).toEqual([101, 7]);
  });

  it('are not taken for one that has a longer name or value that only ends the same way', () => {
    const lines = [`1 a XESCRITORIIO_TASK=abc123`, `2 a ESCRITORIIO_TASK=abc1234`, `3 a ESCRITORIIO_TASK=abc12`, `4 a SOME_ESCRITORIIO_TASK=abc123 B=1`, `5 a OTHER=${ENTRY}x`];
    expect(pidsCarrying(lines, ENTRY)).toEqual([]);
  });

  it('are none when a line is not a process', () => {
    expect(pidsCarrying(['', 'no pid here ESCRITORIIO_TASK=abc123', `x 1 ${ENTRY}`], ENTRY)).toEqual([]);
  });
});

describe('the environment of a process, as Linux gives it', () => {
  it('has the entry when it is one of those the NUL separates, and not when it only ends one of them', () => {
    expect(environmentHolds(`PATH=/usr/bin\0${ENTRY}\0HOME=/home/ana\0`, ENTRY)).toBe(true);
    expect(environmentHolds(`${ENTRY}`, ENTRY)).toBe(true);
    expect(environmentHolds(`PATH=/usr/bin\0X${ENTRY}\0`, ENTRY)).toBe(false);
    expect(environmentHolds(`A=${ENTRY}\0`, ENTRY)).toBe(false);
    expect(environmentHolds('', ENTRY)).toBe(false);
  });
});

describe('the folders that `lsof -FpRn` tells of', () => {
  it('are told for each process with its parent, and what is not a process or a place is left out', () => {
    expect(parseWorkingFolders(['p10', 'R1', 'fcwd', 'n/Users/ana/work/site', 'p11', 'R10', 'fcwd', 'n/', 'pnot-a-number', 'R1', 'n/lost', 'p12', 'fcwd', 'n/no-parent', 'n/orphan-before-any-process'])).toEqual([
      { pid: 10, parent: 1, folder: '/Users/ana/work/site' },
      { pid: 11, parent: 10, folder: '/' },
    ]);
    expect(parseWorkingFolders([])).toEqual([]);
    expect(parseWorkingFolders(['n/x'])).toEqual([]);
  });
});

describe('the parent of a process, as Linux says it', () => {
  it('is what follows the state, after a name that may have parentheses and spaces in it', () => {
    expect(parentFromStat('123 (node) S 1 123 123 0 -1')).toBe(1);
    expect(parentFromStat('124 (a) b (c)) R 777 124 124 0 -1')).toBe(777);
  });
});

describe('the table of macOS and the other Unix systems', () => {
  function listing(output: Readonly<Record<string, readonly string[]>>) {
    const asked: { file: string; args: readonly string[] }[] = [];
    const run: Listing = (file, args, keep) => {
      asked.push({ file, args });
      return Promise.resolve((output[file] ?? []).filter(keep));
    };
    return { asked, table: createProcessTable('darwin', { listing: run }) };
  }

  it('asks `ps` for the environment after each command, by its full path, and keeps only the lines that have the entry', async () => {
    const { asked, table } = listing({ '/bin/ps': [`  101 node a.js ${ENTRY}`, '  102 sleep 600', `  103 node b.js ${ENTRY} X=1`] });
    expect(await table.withEnvironmentEntry(ENTRY)).toEqual([101, 103]);
    expect(asked).toEqual([{ file: '/bin/ps', args: ['eww', '-axo', 'pid=,command='] }]);
  });

  it('never names this process, or the first one of the system, as one to end', async () => {
    const { table } = listing({ '/bin/ps': [`  ${process.pid} node ${ENTRY}`, `  1 launchd ${ENTRY}`, `  0 kernel ${ENTRY}`, `  500 node ${ENTRY}`] });
    expect(await table.withEnvironmentEntry(ENTRY)).toEqual([500]);
  });

  it('asks `lsof` for the current folder and the parent of every process, and keeps the orphans in the folder or below it', async () => {
    const output = [
      ...['p10', 'R1', 'fcwd', 'n/work/task-1'],
      ...['p11', 'R1', 'fcwd', 'n/work/task-1/src'],
      ...['p12', 'R1', 'fcwd', 'n/work/task-10'],
      ...['p13', 'R1', 'fcwd', 'n/work'],
      ...['p14', 'R1', 'fcwd', 'n/'],
      ...['p15', 'R300', 'fcwd', 'n/work/task-1'],
      ...[`p${process.pid}`, 'R1', 'fcwd', 'n/work/task-1'],
    ];
    const { asked, table } = listing({ '/usr/sbin/lsof': output });
    expect(await table.orphansWorkingIn('/work/task-1')).toEqual([10, 11]);
    expect(asked).toEqual([{ file: '/usr/sbin/lsof', args: ['-a', '-d', 'cwd', '-FpRn'] }]);
  });
});

describe('the table of Linux', () => {
  function files(processes: Readonly<Record<number, { environment?: string; folder?: string; parent?: number }>>, extra: readonly string[] = []): ProcFiles {
    return {
      names: () => Promise.resolve([...Object.keys(processes), ...extra]),
      environment: (pid) => (processes[pid]?.environment === undefined ? Promise.reject(new Error('EACCES')) : Promise.resolve(processes[pid].environment)),
      folder: (pid) => (processes[pid]?.folder === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(processes[pid].folder)),
      parent: (pid) => (processes[pid]?.parent === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(processes[pid].parent)),
    };
  }

  it('reads the environment of each process, whatever its program, and passes over the ones it may not read', async () => {
    const table = createProcessTable('linux', {
      files: files({ 20: { environment: `A=1\0${ENTRY}\0` }, 21: { environment: 'A=1\0' }, 22: {}, 23: { environment: `${ENTRY}\0` } }, ['self', 'net', 'sys']),
    });
    expect(await table.withEnvironmentEntry(ENTRY)).toEqual([20, 23]);
  });

  it('reads the folder and the parent of each process, and finds the orphans in a folder that was taken away, which Linux says is `(deleted)`', async () => {
    const table = createProcessTable('linux', {
      files: files({
        30: { folder: '/work/task-1', parent: 1 },
        31: { folder: '/work/task-1/src (deleted)', parent: 1 },
        32: { folder: '/work/task-2', parent: 1 },
        33: { folder: '/work/task-1 (deleted)', parent: 1 },
        35: { folder: '/work/task-1', parent: 4000 },
        34: { parent: 1 },
        36: { folder: '/work/task-1' },
      }),
    });
    expect(await table.orphansWorkingIn('/work/task-1')).toEqual([30, 31, 33]);
  });

  it('says nothing when it cannot list the processes at all', async () => {
    const table = createProcessTable('linux', { files: { ...files({}), names: () => Promise.reject(new Error('no /proc')) } });
    expect(await table.withEnvironmentEntry(ENTRY)).toEqual([]);
    expect(await table.orphansWorkingIn('/work')).toEqual([]);
  });
});

describe('the table of Windows', () => {
  it('says nothing: Windows does not tell the environment or the folder of the processes of another', async () => {
    const table = createProcessTable('win32');
    expect(await table.withEnvironmentEntry(ENTRY)).toEqual([]);
    expect(await table.orphansWorkingIn('C:\\work')).toEqual([]);
  });
});

// The system's own answer, for a process that this test starts: what the table says on the machine it runs on.
describe.skipIf(process.platform === 'win32')('the table of this system', () => {
  async function withChild<T>(options: { readonly env?: Record<string, string>; readonly cwd?: string }, use: (pid: number) => Promise<T>): Promise<T> {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', env: { ...process.env, ...options.env }, cwd: options.cwd });
    try {
      if (child.pid === undefined) throw new Error('the child was not started');
      return await use(child.pid);
    } finally {
      child.kill('SIGKILL');
    }
  }

  it('finds a process by the entry of its environment', async () => {
    const entry = `ESCRITORIIO_TASK=test${process.pid}${Date.now()}`;
    await withChild({ env: { ESCRITORIIO_TASK: entry.slice('ESCRITORIIO_TASK='.length) } }, async (pid) => {
      const found = await createProcessTable(process.platform).withEnvironmentEntry(entry);
      expect(found).toContain(pid);
      expect(found).not.toContain(process.pid);
    });
  });

  it('does not find a process that does not have the entry', async () => {
    await withChild({}, async (pid) => {
      expect(await createProcessTable(process.platform).withEnvironmentEntry(`ESCRITORIIO_TASK=never${process.pid}${Date.now()}`)).not.toContain(pid);
    });
  });

  async function inFolder<T>(use: (folder: string) => Promise<T>): Promise<T> {
    const folder = await realpath(await mkdtemp(join(tmpdir(), 'process-table-')));
    try {
      return await use(folder);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  it('does not find a process that works in the folder and still has its parent: it is not one that was left', async () => {
    await inFolder((folder) =>
      withChild({ cwd: folder }, async (pid) => {
        expect(await createProcessTable(process.platform).orphansWorkingIn(folder)).not.toContain(pid);
      }),
    );
  });

  // A process whose parent has ended is given to the first process of the system on macOS, and to the nearest process that adopts them on Linux, which may not be it.
  it.runIf(process.platform === 'darwin')('finds a process that works in the folder and was left by its parent, and only in that folder', async () => {
    await inFolder(async (folder) => {
      const program = `const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore', cwd: process.argv[1] }); console.log(child.pid); child.unref();`;
      const printed = await new Promise<string>((resolve, reject) => execFile(process.execPath, ['-e', program, folder], (error, stdout) => (error ? reject(error) : resolve(stdout))));
      const pid = Number(printed.trim());
      try {
        const table = createProcessTable(process.platform);
        expect(await table.orphansWorkingIn(folder)).toContain(pid);
        expect(await table.orphansWorkingIn(join(folder, 'elsewhere'))).not.toContain(pid);
      } finally {
        process.kill(pid, 'SIGKILL');
      }
    });
  });
});
