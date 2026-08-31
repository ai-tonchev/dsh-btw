/**
 * Verifies the committed client bundle registers the expected ModuleLoader id
 * and that the Host half exports the plugin contract.
 */
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const clientBundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const hostModule = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

const expectedRegistration = `id: ${JSON.stringify(pkg.name)}`;
if (!clientBundle.includes(expectedRegistration)) {
  throw new Error(`client bundle does not register ${pkg.name} via ModuleLoader.load`);
}

for (const required of ['export const name =', 'export const inject =', 'export function apply(', 'btwPanel']) {
  if (!hostModule.includes(required)) throw new Error(`host half is missing ${required}`);
}

process.stdout.write(`verified client ModuleLoader id: ${pkg.name}\n`);
process.stdout.write('verified host plugin contract (name/inject/apply/btwPanel)\n');
