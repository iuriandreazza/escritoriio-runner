import { spawn } from 'node:child_process';
import { signingPlan } from './signing-environment.mjs';

// `pnpm package` runs this after the build. Anything after the script's name goes to electron-builder (`pnpm package --mac --publish never`).
// Nothing is signed unless the environment asks for it: see signing-environment.mjs.
const plan = signingPlan(process.env, process.platform);
const args = process.argv.slice(2);

if (args.includes('--print-signing')) {
  console.log(plan.label);
} else {
  console.error(`Signing: ${plan.label}.`);
  // Windows needs a shell to run the .cmd that pnpm puts on the path.
  const child = spawn('electron-builder', [...args, ...plan.args], { stdio: 'inherit', env: plan.env, shell: process.platform === 'win32' });
  child.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
