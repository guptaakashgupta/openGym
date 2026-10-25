#!/usr/bin/env node
/* Do the product's modules — api/platform, api/storage, api/state, api/shared — load under plain
 * node? api/shared is imported by the frontend under Vite as well, and Vite forgives what node
 * does not (see check-core-loadable.mjs for the incident that made that check). Importing a
 * module only defines things: none of these opens a connection or a file at import time. Run by
 * bare `node` on purpose — being outside the test runners IS the check. */
import { readdirSync } from 'node:fs';

const DIRS = ['platform', 'storage', 'state', 'shared'];
let failed = 0, loaded = 0;
for (const dir of DIRS) {
  const base = new URL(`../${dir}/`, import.meta.url);
  for (const f of readdirSync(base).filter(n => n.endsWith('.js')).sort()) {
    try {
      await import(new URL(f, base));
      loaded++;
      console.log(`  ok    ${dir}/${f}`);
    } catch (e) {
      failed++;
      console.error(`  FAIL  ${dir}/${f} — ${e.message}`);
    }
  }
}
if (failed) {
  console.error(`\n${failed} module(s) do not load under plain node — product mode would not start.`);
  process.exit(1);
}
console.log(`\n${loaded} product modules load under plain node.`);
