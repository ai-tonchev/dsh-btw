/**
 * Smoke-tests the committed Host half (lib/index.js) against a minimal
 * typert fixture: imports the module and checks the exported plugin contract
 * (name / inject / apply). A temporary node_modules symlink resolves the
 * peerDependency; it is removed again afterwards.
 */
import { existsSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const link = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-typert-protocol');
const fixture = path.resolve(here, 'fixtures', 'dsh-typert-protocol');

const hadLink = existsSync(link);
const previous = hadLink ? readlinkSync(link) : null;
mkdirSync(path.dirname(link), { recursive: true });
if (!hadLink) symlinkSync(fixture, link, 'dir');

try {
  const mod = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href);
  if (mod.name !== 'dsh-btw') throw new Error(`unexpected plugin name: ${mod.name}`);
  if (!Array.isArray(mod.inject) || !mod.inject.includes('commands') || !mod.inject.includes('subagents')) {
    throw new Error('inject contract broken');
  }
  if (typeof mod.apply !== 'function') throw new Error('apply is not a function');
  process.stdout.write(`smoke ok: ${mod.name} exports name/inject/apply\n`);
} finally {
  if (!hadLink) {
    rmSync(link, { recursive: true, force: true });
  } else if (previous !== null && readlinkSync(link) !== previous) {
    rmSync(link, { recursive: true, force: true });
    symlinkSync(previous, link, 'dir');
  }
}
