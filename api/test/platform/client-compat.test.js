/* The pilot clients this server must keep serving: each fixture in test/fixtures/pilot-clients/ is
   the requests one supported client build makes and the fields it reads from each answer. A change
   that removes a field, changes a status or drops state fields the server does not know fails
   here, by fixture and request, before any device meets it. Add a fixture for each new supported
   client build; remove one only when that build is no longer supported (docs/dev/PILOT_COMPATIBILITY.md). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootProduct } from '../storage/product-server.mjs';
import { createGym } from '../../platform/organisations.js';
import { addMembership } from '../../platform/memberships.js';
import { assignTrainer } from '../../platform/assignments.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/pilot-clients');
const fixtures = fs.readdirSync(DIR).filter(f => f.endsWith('.json')).sort();

test('both supported client builds have a fixture', () => {
  assert.deepEqual(fixtures, ['current.json', 'previous.json']);
});

for (const file of fixtures) {
  const fx = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  test(`client ${fx.client}: every request it makes still gets what it reads`, async t => {
    const h = await bootProduct(t);
    const now = new Date().toISOString();
    for (const id of ['owner', 'trainer', 'member']) await h.store.createUser({ id, name: 'Name ' + id, created: now });
    const gym = await createGym(h.pool, { name: 'Compat Gym' });
    await addMembership(h.pool, { gymId: gym.id, userId: 'owner', role: 'owner' });
    const tr = await addMembership(h.pool, { gymId: gym.id, userId: 'trainer', role: 'trainer' });
    const mem = await addMembership(h.pool, { gymId: gym.id, userId: 'member', role: 'member' });
    await assignTrainer(h.pool, { gymId: gym.id, memberMembershipId: mem.id, trainerMembershipId: tr.id });
    const fill = v => JSON.parse(JSON.stringify(v ?? null).replaceAll('{memberMembershipId}', mem.id));

    let n = 0;
    for (const r of fx.requests) {
      const where = `${fx.client} #${++n} ${r.method} ${r.path}`;
      const res = await h.req(r.method, fill(r.path), { cookie: h.session(r.as), body: r.body === undefined ? undefined : fill(r.body), ip: `198.18.0.${n}` });
      assert.equal(res.status, r.status, `${where}: ${JSON.stringify(res.body)}`);
      for (const k of r.keys || []) assert.ok(res.body && k in res.body, `${where}: no "${k}" in ${JSON.stringify(Object.keys(res.body || {}))}`);
      for (const [list, keys] of Object.entries(r.itemKeys || {})) {
        const items = res.body[list];
        assert.ok(Array.isArray(items) && items.length, `${where}: "${list}" is not a non-empty list`);
        for (const k of keys) assert.ok(k in items[0], `${where}: ${list}[0] has no "${k}" (has ${Object.keys(items[0])})`);
      }
      if (r.keepsField) assert.ok(r.keepsField in (res.body.state || {}), `${where}: the state lost "${r.keepsField}"`);
    }
  });
}
