/**
 * Bundles the browser half: src/client.js -> lib/client.js.
 *
 * Follows the Web shell's client bundle handshake — a CJS factory wrapped in
 * `window.__ModuleLoader__.load({ id, factory })`; the factory's `require`
 * resolves platform modules from the shell's frozen module table (React /
 * Cordis / client-UI packages), everything else is inlined. The output is
 * committed into the repo, so the `dsh plugin add` git-install path needs no
 * build on the user's machine. Development flow: edit src/client.js, then run
 * `node scripts/build-client.mjs`.
 */
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await readFile(path.join(here, '..', 'package.json'), 'utf8'));
const PLUGIN_ID = pkg.name;

/** Shell frozen module table (shared by the Web shell's platform externals); anything else is inlined. */
const PLATFORM_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
];

const OUT = path.resolve(here, '..', 'lib', 'client.js');

await mkdir(path.dirname(OUT), { recursive: true });

await build({
  entryPoints: [path.resolve(here, '..', 'src', 'client.js')],
  outfile: OUT,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  target: 'es2022',
  sourcemap: false,
  external: PLATFORM_EXTERNALS,
  minify: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {` },
  footer: { js: 'return module.exports; } });' },
  write: false,
}).then(async (result) => {
  for (const file of result.outputFiles) {
    // The factory needs module.exports semantics; esbuild's CJS output refers
    // to its own scope, which is safe here.
    let text = file.text;
    text = 'var module = { exports: {} }; var exports = module.exports;\n' + text;
    await writeFile(file.path, text);
  }
  const size = (await readFile(OUT)).length;
  console.log(`built ${path.relative(process.cwd(), OUT)} (${(size / 1024).toFixed(1)} KB)`);
});
