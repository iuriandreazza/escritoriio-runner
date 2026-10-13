import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Starts a packaged app with `--smoke` and says whether it came up and left cleanly: `node scripts/smoke.mjs <executable> [more arguments]`.
// The app must do nothing but load itself and exit 0 (see the release workflow). It gets a state directory of its own, thrown away afterwards, so that
// the test never touches the settings or the token of whoever runs it.
const [executable, ...extra] = process.argv.slice(2);
if (!executable) {
  console.error('Usage: node scripts/smoke.mjs <executable> [arguments]');
  process.exit(2);
}

const TIMEOUT_MS = 60_000;
const state = mkdtempSync(join(tmpdir(), 'runner-smoke-'));
const child = spawn(executable, [...extra, '--smoke'], { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ESCRITORIIO_RUNNER_HOME: join(state, 'state') } });
const timer = setTimeout(() => {
  console.error(`The app did not exit within ${String(TIMEOUT_MS / 1000)} seconds.`);
  child.kill('SIGKILL');
}, TIMEOUT_MS);

child.on('error', (error) => {
  console.error(`The app could not be started: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  clearTimeout(timer);
  rmSync(state, { recursive: true, force: true });
  if (code === 0) console.log('The app started and exited cleanly.');
  else {
    console.error(`The app exited with ${signal ?? String(code)}.`);
    process.exitCode = 1;
  }
});
