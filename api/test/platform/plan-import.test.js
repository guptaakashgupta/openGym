/* The shared plan-import rules under plain Node, with the API's catalogue — the same cases the app
   runs under vitest (plan-import-contract.mjs) — plus the server's stable proposal ids. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planImportCases } from './plan-import-contract.mjs';
import { serverPlanImport } from '../../platform/plan-catalogue.js';
import { proposalEntityId } from '../../platform/proposal-ids.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// The server merges with explicit ids in production; the cases that use default ids get a counter.
let n = 0;
for (const [name, run] of Object.entries(planImportCases(serverPlanImport({ newId: () => 'srv' + (++n) })))) test(name, run);

test('the server refuses to invent ids of its own', () => {
  const { mergePlan, parsePlan, buildPlanBundle } = serverPlanImport();
  const bundle = parsePlan(buildPlanBundle({ unit: 'kg', routines: [{ id: 'r', name: 'R', ex: [{ id: '0025', sets: 1, reps: 1 }] }] }, ''), 'kg');
  assert.throws(() => mergePlan({ unit: 'kg', routines: [] }, bundle), /explicit ids/);
  assert.equal(mergePlan({ unit: 'kg', routines: [] }, bundle, { ids: () => 'x' }).routineMap.r, 'x');
});

test('the shared module loads under plain node, with nothing from the browser build', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./api/shared/plan-import.js')"], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('proposal entity ids are stable, distinct per input, and prefixed', () => {
  const a = proposalEntityId('u1', 'v1', 'routine', 'r-push');
  assert.equal(a, proposalEntityId('u1', 'v1', 'routine', 'r-push'));
  assert.match(a, /^gp_[0-9a-f]{24}$/);
  assert.notEqual(a, proposalEntityId('u1', 'v2', 'routine', 'r-push'));
  assert.notEqual(a, proposalEntityId('u2', 'v1', 'routine', 'r-push'));
  assert.notEqual(a, proposalEntityId('u1', 'v1', 'custom', 'r-push'));
});
