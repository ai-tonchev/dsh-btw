/**
 * Copies src/index.js + src/host-helpers.js -> lib/ (the committed Host half).
 *
 * The Host half is plain ESM and needs no bundling; committing the copies
 * keeps `lib/` self-contained for the profile install path (no build on the
 * user's machine), matching the ecosystem's committed-lib convention.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = path.resolve(here, '..', 'lib');

await mkdir(lib, { recursive: true });
await copyFile(path.resolve(here, '..', 'src', 'index.js'), path.join(lib, 'index.js'));
await copyFile(path.resolve(here, '..', 'src', 'host-helpers.js'), path.join(lib, 'host-helpers.js'));
console.log(`copied ${path.relative(process.cwd(), path.join(lib, 'index.js'))} + host-helpers.js`);
