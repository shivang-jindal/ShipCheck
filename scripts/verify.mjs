#!/usr/bin/env node
/**
 * Local quality gate (Part G / G4). Runs everything that must pass before a
 * release and prints a summary.
 *
 * Usage: npm run verify
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const steps = [
  ['Shared type-check + build', 'run', 'build:shared'],
  ['Server type-check', 'run', 'typecheck', '-w', '@shipcheck/server'],
  ['Client type-check', 'run', 'typecheck', '-w', '@shipcheck/client'],
  ['Lint', 'run', 'lint'],
  ['Unit + integration tests', 'run', 'test'],
  ['Production build', 'run', 'build'],
];

let failed = 0;

for (const [label, ...command] of steps) {
  process.stdout.write(`\n=== ${label} ===\n`);
  const result = spawnSync(npm, command, { cwd: root, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    failed += 1;
    process.stdout.write(`--- FAILED: ${label}\n`);
  }
}

process.stdout.write(
  failed === 0
    ? '\nAll verification steps passed.\n'
    : `\n${failed} verification step(s) failed.\n`,
);
process.exit(failed === 0 ? 0 : 1);