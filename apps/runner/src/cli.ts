import { createTerminal } from './infrastructure/terminal.ts';
import { runCli } from './main.ts';

process.exitCode = await runCli(process.argv.slice(2), { terminal: createTerminal(), env: process.env });
