/**
 * Copies src/index.js -> lib/index.js (the committed Host half).
 *
 * The Host half is plain ESM and needs no bundling; committing the copy keeps
 * `lib/` self-contained for the profile install path (no build on the user's
 * machine), matching the ecosystem's committed-lib convention.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '..', 'lib', 'index.js');

await mkdir(path.dirname(out), { recursive: true });
await copyFile(path.resolve(here, '..', 'src', 'index.js'), out);
console.log(`copied ${path.relative(process.cwd(), out)}`);
