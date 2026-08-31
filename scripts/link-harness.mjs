/**
 * Links the real DSH packages from a local harness checkout into this repo's
 * node_modules so `npm run e2e` can resolve them. Node's ESM ignores NODE_PATH,
 * so the packages are symlinked individually. Run:
 *
 *   node scripts/link-harness.mjs /path/to/dsh/checkout/node_modules
 *
 * The default falls back to $DSH_HARNESS_NODE_MODULES. node_modules is
 * gitignored, so this never pollutes the published bundle.
 */
import { existsSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGES = ['cordis', 'cordis-plugin-timer', 'dsh-session', 'dsh-commands', 'dsh-typert-registry', 'dsh-typert-protocol'];

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = process.argv[2] || process.env.DSH_HARNESS_NODE_MODULES;

if (!source || !existsSync(source)) {
  console.error('usage: node scripts/link-harness.mjs <path-to-dsh-checkout>/node_modules');
  process.exit(1);
}

for (const pkg of PACKAGES) {
  const from = path.join(source, '@deepseek-ai', pkg);
  const to = path.join(root, 'node_modules', '@deepseek-ai', pkg);
  if (!existsSync(from)) {
    console.error(`missing in harness: ${from}`);
    process.exit(1);
  }
  mkdirSync(path.dirname(to), { recursive: true });
  if (existsSync(to)) {
    const current = readlinkSync(to);
    if (current !== from) {
      rmSync(to, { recursive: true, force: true });
      symlinkSync(from, to, 'dir');
    }
  } else {
    symlinkSync(from, to, 'dir');
  }
}
process.stdout.write(`linked ${PACKAGES.length} DSH packages from ${source}\n`);
