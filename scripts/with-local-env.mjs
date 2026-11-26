// Runs a command with the local compose-stack defaults applied to unset variables.
//   node scripts/with-local-env.mjs [KEY=VALUE ...] <command> [args...]
// Leading KEY=VALUE pairs are forced into the child environment (cross-platform `env` replacement).
import { spawnSync } from 'node:child_process';
import { applyLocalDefaults } from './env.mjs';

const argv = process.argv.slice(2);
const forced = {};
while (argv.length > 0 && /^[A-Z_][A-Z0-9_]*=/.test(argv[0])) {
  const [key, ...rest] = argv.shift().split('=');
  forced[key] = rest.join('=');
}
const [command, ...args] = argv;
if (!command) {
  console.error('usage: node scripts/with-local-env.mjs [KEY=VALUE ...] <command> [args...]');
  process.exit(2);
}
const env = applyLocalDefaults({ ...process.env, ...forced });
// No shell: arguments (paths with spaces) are passed through verbatim.
const res = spawnSync(command === 'node' ? process.execPath : command, args, { stdio: 'inherit', env });
process.exit(res.status ?? 1);
