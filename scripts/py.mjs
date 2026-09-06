/**
 * Cross-platform launcher for the server's virtualenv interpreter.
 *
 * `./.venv/Scripts/python.exe` works in bash and fails in cmd; `.venv\Scripts\...`
 * does the reverse. pnpm picks the shell, so neither literal is portable. This
 * resolves the interpreter for the current platform and fails with an actionable
 * message rather than a cryptic one when the venv is missing.
 *
 * Usage: node scripts/py.mjs -m pytest tests/ -q
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = resolve(root, 'server');

const candidates = [
  resolve(serverDir, '.venv/Scripts/python.exe'), // Windows
  resolve(serverDir, '.venv/bin/python'), // POSIX
];

const python = candidates.find((p) => existsSync(p));

if (python === undefined) {
  console.error(
    'No server virtualenv found. Create one with Python 3.12:\n\n' +
      '  py -3.12 -m venv server/.venv          (Windows)\n' +
      '  python3.12 -m venv server/.venv        (macOS/Linux)\n\n' +
      'then install:\n\n' +
      '  node scripts/py.mjs -m pip install -r server/requirements-dev.txt\n',
  );
  process.exit(1);
}

const result = spawnSync(python, process.argv.slice(2), {
  cwd: serverDir,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
