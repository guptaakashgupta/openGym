/* Upstream's trainers in product mode (docs/plans/2026-11-26-adopt-upstream-trainers.md step 3):
   accounts and member state in PostgreSQL, org.json and share/<uid>.json as files under DATA_DIR.
   A trainer's code, the member's connect, the trainer's yes, the list and the detail, a direct
   change through the PostgreSQL sync path, a stale phone that merges instead of overwriting, and
   a disabled member gone from the very next request. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootProduct } from '../storage/product-server.mjs';

const today = new Date().toISOString().slice(0, 10);
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

async function world(t, env = {}) {
  const h = await bootProduct(t, { env: { TRAINERS: 'on', ...env } });
  const now = new Date().toISOString();
  await h.store.createUser({ id: 'coach', name: 'Marco', created: now });
  await h.store.createUser({ id: 'mem', name: 'Lea', created: now });
  await h.store.createUser({ id: 'other', name: 'Tim', created: now });
  // Marco may train people without a gym. The admin route for that is step 4; org.json is read at boot.
  fs.writeFileSync(path.join(h.dataDir, 'org.json'), JSON.stringify({ trainers: [{ userId: 'coach', since: Date.now() }] }));
  await h.restart();
  const as = (who, method, url, body) => h.req(method, url, { cookie: h.session(who), body });
  return { h, as };
}

test('product mode: connect, list, detail, a direct change and a stale phone that merges', async t => {
  const { h, as } = await world(t);
  assert.equal((await as('mem', 'PUT', '/api/data', { state: { unit: 'kg', lang: 'de',
    workouts: [{ id: 'w1', name: 'Push A', d: daysAgo(1), start: Date.now() - 86400000, end: Date.now() - 86400000 + 3000000, entries: [] }],
    routines: [{ id: 'r1', name: 'Push A', ex: [{ id: 'bench' }] }] } })).status, 200);
  assert.equal((await as('coach', 'PUT', '/api/data', { state: { unit: 'kg', routines: [{ id: 'm1', name: 'Full body', ex: [{ id: 'squat' }] }] } })).status, 200);

  // The app is told about trainers in product mode now.
  assert.equal((await as('coach', 'GET', '/api/config')).body.trainers.roles.trainer, true);

  const { code } = (await as('coach', 'POST', '/api/trainer/codes', {})).body;
  const preview = (await as('mem', 'POST', '/api/sharing/code', { code })).body;
  assert.equal(preview.trainer.name, 'Marco');          // the account came from PostgreSQL
  const conn = (await as('mem', 'POST', '/api/sharing/connect', { code, consent: preview.consent, lang: 'de',
    scopes: { metrics: 'view', workouts: 'view', plans: 'apply' } })).body;
  assert.equal(conn.status, 'pending');
  assert.equal((await as('coach', 'GET', '/api/trainer')).body.requests.length, 1);
  assert.equal((await as('coach', 'POST', '/api/trainer/requests/answer', { id: conn.id, accept: true })).status, 200);

  const list = (await as('coach', 'GET', `/api/trainer/members?today=${today}`)).body;
  assert.equal(list.members.length, 1);
  assert.equal(list.members[0].member.name, 'Lea');
  assert.equal(list.members[0].summary.lastWorkout, daysAgo(1));   // her state came from PostgreSQL
  const d = (await as('coach', 'GET', `/api/trainer/member?id=mem&today=${today}`)).body;
  assert.equal(d.plans.routines[0].name, 'Push A');

  // A direct change: one revision up, in her own document.
  const S0 = (await as('mem', 'GET', '/api/data')).body;
  const assigned = (await as('coach', 'POST', '/api/trainer/assign', { memberIds: ['mem'], routineId: 'm1' })).body;
  assert.deepEqual(assigned.results.map(r => r.outcome), ['applied']);
  assert.equal((await as('mem', 'GET', '/api/data/rev')).body.rev, S0.rev + 1);
  const S1 = (await as('mem', 'GET', '/api/data')).body.state;
  const copy = S1.routines.find(r => r.name === 'Full body');
  assert.equal(copy._by.name, 'Marco');
  // Her phone, still on the old revision, gets a conflict carrying the change, not an overwrite.
  const stale = await as('mem', 'PUT', '/api/data', { state: { ...S0.state, routines: [] }, baseRev: S0.rev, stamped: true });
  assert.equal(stale.status, 409);
  assert.ok(stale.body.state.routines.some(r => r.id === copy.id));

  // org.json and her sharing log are files on the disk; nothing of them went to PostgreSQL.
  const org = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'org.json'), 'utf8'));
  assert.equal(org.grants.find(g => g.id === conn.id).status, 'active');
  const log = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'share', 'mem.json'), 'utf8'));
  assert.ok(log.log.some(e => e.ev === 'trainer.change'));

  // Disabled in PostgreSQL: gone from the trainer's next request, list and detail alike.
  await h.store.updateUser('mem', u => { u.disabled = true; });
  assert.equal((await as('coach', 'GET', `/api/trainer/members?today=${today}`)).body.members.length, 0);
  assert.equal((await as('coach', 'GET', '/api/trainer/member?id=mem')).status, 404);
  assert.equal((await as('coach', 'POST', '/api/trainer/assign', { memberIds: ['mem'], routineId: 'm1' })).body.results[0].outcome, 'skipped');
});

test('product mode: a disabled member is not counted as a request', async t => {
  const { as, h } = await world(t);
  const { code } = (await as('coach', 'POST', '/api/trainer/codes', { maxUses: 2 })).body;
  for (const who of ['mem', 'other']) {
    const preview = (await as(who, 'POST', '/api/sharing/code', { code })).body;
    assert.equal((await as(who, 'POST', '/api/sharing/connect', { code, consent: preview.consent, scopes: { metrics: 'view' } })).status, 200);
  }
  assert.equal((await as('coach', 'GET', '/api/trainer')).body.requests.length, 2);
  await h.store.updateUser('other', u => { u.disabled = true; });
  const mine = (await as('coach', 'GET', '/api/trainer')).body;
  assert.deepEqual(mine.requests.map(r => r.member.name), ['Lea']);
  assert.equal((await as('coach', 'GET', `/api/trainer/members?today=${today}`)).body.requests, 1);
});

test('product mode: trainers stay closed with TRAINERS off, and the gym admin routes stay closed with it on', async t => {
  const off = await bootProduct(t);
  for (const p of ['/api/sharing', '/api/trainer', '/api/gym?id=x']) {
    assert.equal((await off.req('GET', p, { cookie: off.session('mem') })).body?.code, 'unavailable', p);
  }
  const { as } = await world(t);
  assert.equal((await as('mem', 'GET', '/api/sharing')).status, 200);
  assert.equal((await as('mem', 'GET', '/api/admin/gyms')).body?.code, 'unavailable');
});
