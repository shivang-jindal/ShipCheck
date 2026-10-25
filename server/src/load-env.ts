/**
 * Minimal `.env` loader.
 *
 * The repository documents `cp .env.example .env`, but the server, the worker
 * and the seed script are separate processes started by npm, and npm runs each
 * one from its workspace directory (or the repository root). This loader reads
 * the first `.env` it finds in the current directory or the parent, so the
 * documented file actually takes effect. Real environment variables always win,
 * so CI and container configuration are never overridden by a local file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnvFiles(): void {
  const candidates = [resolve(process.cwd(), '.env'), resolve(process.cwd(), '..', '.env')];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const text = readFileSync(candidate, 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const key = match[1];
      const value = match[2];
      if (!key || value === undefined) continue;
      if (process.env[key] !== undefined) continue;
      let parsed = value.trim();
      if (
        (parsed.startsWith('"') && parsed.endsWith('"')) ||
        (parsed.startsWith("'") && parsed.endsWith("'"))
      ) {
        parsed = parsed.slice(1, -1);
      } else {
        const comment = parsed.indexOf(' #');
        if (comment >= 0) parsed = parsed.slice(0, comment).trim();
      }
      process.env[key] = parsed;
    }
    return;
  }
}

loadEnvFiles();
