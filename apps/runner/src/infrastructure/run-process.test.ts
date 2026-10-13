import { describe, expect, it } from 'vitest';
import { MAX_PROCESS_OUTPUT_BYTES, runProcess } from './run-process.ts';

const node = (script: string, timeoutMs = 10_000) => runProcess(process.execPath, ['-e', script], { cwd: process.cwd(), env: {}, timeoutMs });

describe('running a program', () => {
  it('gives what it said and how it ended', async () => {
    expect(await node('process.stdout.write("out"); process.stderr.write("err")')).toEqual({ exitCode: 0, stdout: 'out', stderr: 'err', stopped: undefined });
  });

  it('gives the exit code of a program that failed, as an answer', async () => {
    expect(await node('process.exit(3)')).toMatchObject({ exitCode: 3, stopped: undefined });
  });

  it('starts it with the environment it was given and nothing of its own', async () => {
    process.env.RUN_PROCESS_TEST_SECRET = 'the-runner-has-it';
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env).filter((name) => /^(RUN_PROCESS|GIVEN)/.test(name))))'], { cwd: process.cwd(), env: { GIVEN: '1' }, timeoutMs: 10_000 });
    delete process.env.RUN_PROCESS_TEST_SECRET;
    expect(JSON.parse(result.stdout)).toEqual(['GIVEN']);
  });

  it('has no input to wait for: reading it ends at once', async () => {
    expect(await node('process.stdin.on("data", () => undefined); process.stdin.on("end", () => process.stdout.write("eof"))')).toMatchObject({ stdout: 'eof', exitCode: 0 });
  });

  it('reads no argument as anything but itself', async () => {
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1] ?? "")', '$(touch nothing); echo "x" | cat'], { cwd: process.cwd(), env: {}, timeoutMs: 10_000 });
    expect(result.stdout).toBe('$(touch nothing); echo "x" | cat');
  });

  it('stops a program that takes too long', async () => {
    const result = await node('setTimeout(() => undefined, 60000)', 200);
    expect(result).toMatchObject({ exitCode: null, stopped: 'timeout' });
  });

  it('stops a program that says too much', async () => {
    const result = await node(`process.stdout.write("x".repeat(${MAX_PROCESS_OUTPUT_BYTES + 10})); setTimeout(() => undefined, 60000)`);
    expect(result).toMatchObject({ exitCode: null, stopped: 'too-much-output' });
  });

  it.skipIf(process.platform === 'win32')('stops a program, and what it started, as soon as it is told to', async () => {
    const controller = new AbortController();
    const started = Date.now();
    // A shell that does not end with the program it started, so that the program holds the pipes after the shell is gone.
    const running = runProcess('sh', ['-c', 'sleep 30; echo late'], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' }, timeoutMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    expect(await running).toMatchObject({ exitCode: null, stdout: '', stopped: 'aborted' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it.skipIf(process.platform === 'win32')('stops what a program started when it takes too long as well', async () => {
    const started = Date.now();
    const result = await runProcess('sh', ['-c', 'sleep 30; echo late'], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' }, timeoutMs: 200 });
    expect(result).toMatchObject({ exitCode: null, stopped: 'timeout' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('does not start a program when it was told to stop already', async () => {
    const result = await runProcess(process.execPath, ['-e', 'require("fs").writeFileSync("never-written", "x")'], { cwd: process.cwd(), env: {}, timeoutMs: 10_000, signal: AbortSignal.abort() });
    expect(result).toEqual({ exitCode: null, stdout: '', stderr: '', stopped: 'aborted' });
  });

  it('rejects with the error of the system when the program cannot be started', async () => {
    await expect(runProcess('a-program-that-is-not-installed-anywhere', [], { cwd: process.cwd(), env: {}, timeoutMs: 1_000 })).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
