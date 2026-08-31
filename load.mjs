/**
 * Prints the exact `cordis_define` payload for the BTW plugin, read from
 * plugin/host.js and plugin/client.js.
 *
 * Dynamic Cordis plugins are defined through the harness's own tools (there is
 * no file-based loader), so this script is a reproducibility aid: run
 * `node load.mjs` and paste the printed JSON into `cordis_define` in a fresh
 * session with the `cordis` preset (idPrefix "btw"), then `cordis_run` the
 * returned pluginId/packageId.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const host = readFileSync(join(here, 'plugin', 'host.js'), 'utf8');
const client = readFileSync(join(here, 'plugin', 'client.js'), 'utf8');

const payload = {
  plugin: { kind: 'new', idPrefix: 'btw' },
  name: 'BTW side questions',
  purpose:
    "Recreates Claude CLI's /btw: ask a question in a side thread while the main agent keeps running, without touching the main conversation's model surface.",
  code: { host, client },
};

process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
