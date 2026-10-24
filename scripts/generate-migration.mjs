#!/usr/bin/env node
/**
 * `drizzle-kit generate` wrapper.
 *
 * drizzle-kit resolves its own `node_modules` with a path join that breaks when
 * the repository lives under a directory whose name contains a space (for
 * example `E:\Downloads\SaaS 12345\CollectFlow`). This script runs the generator
 * in a space-free temporary directory and copies the resulting SQL migration and
 * metadata back into `server/drizzle`, so `npm run db:generate` works on every
 * machine.
 *
 * Usage: npm run db:generate
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const serverDir = join(repoRoot, 'server');
const outputDir = join(serverDir, 'drizzle');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

const workDir = mkdtempSync(join(tmpdir(), 'drizzle-gen-'));
try {
  mkdirSync(join(workDir, 'src', 'db'), { recursive: true });
  cpSync(join(serverDir, 'src', 'db', 'schema.ts'), join(workDir, 'src', 'db', 'schema.ts'));
  cpSync(join(serverDir, 'drizzle.config.ts'), join(workDir, 'drizzle.config.ts'));
  cpSync(join(serverDir, 'tsconfig.json'), join(workDir, 'tsconfig.json'));
  writeFileSync(
    join(workDir, 'package.json'),
    JSON.stringify({ name: 'drizzle-generate-sandbox', private: true, type: 'module' }, null, 2),
  );

  // drizzle-kit resolves its real path, so linking the repository's
  // node_modules is not enough when that path contains a space. Install the two
  // generator packages locally instead (npm cache keeps this fast).
  const install = spawnSync(
    npm,
    ['install', '--no-audit', '--no-fund', 'drizzle-orm@0.45.4', 'drizzle-kit@0.31.11', 'zod@^3.24.1'],
    { cwd: workDir, stdio: 'inherit', shell: true },
  );
  if (install.status !== 0) process.exit(install.status ?? 1);

  // Seed the sandbox with the migrations that already exist so drizzle-kit
  // appends the next one instead of regenerating from scratch.
  if (existsSync(outputDir)) {
    cpSync(outputDir, join(workDir, 'drizzle'), { recursive: true });
  }

  const generate = spawnSync('npx.cmd', ['drizzle-kit', 'generate'], {
    cwd: workDir,
    stdio: 'inherit',
    shell: true,
  });
  if (generate.status !== 0) process.exit(generate.status ?? 1);

  const generated = join(workDir, 'drizzle');
  if (!existsSync(generated)) {
    console.error('drizzle-kit reported success but produced no output.');
    process.exit(1);
  }
  cpSync(generated, outputDir, { recursive: true });
  const sqlFiles = readdirSync(outputDir).filter((name) => name.endsWith('.sql'));
  console.log(`\nMigration written to ${outputDir}: ${sqlFiles.join(', ')}`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}