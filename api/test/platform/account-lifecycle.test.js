/* The pilot account lifecycle. Deleting an account ends every session and token, removes its
   memberships and assignments, queues its uploaded objects for removal and keeps no display name
   in the audit trail; a device that synced before and comes back with an old token restores
   nothing. Export hands the member their own history, memberships and received plans in a
   documented format, never credentials or anyone else's data. After a restore from backup, a
   device that holds newer work merges it back instead of being overwritten or overwriting. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootProduct } from '../storage/product-server.mjs';
import { hashPassword } from '../../password.js';
import { createGym } from '../../platform/organisations.js';
import { addMembership } from '../../platform/memberships.js';
import { assignTrainer } from '../../platform/assignments.js';
import { pruneAudit } from '../../platform/lifecycle.js';
import * as M from '../media-samples.mjs';

const GOOD = 'correct horse battery staple';
let ipN = 0;
const ip = () => `192.0.2.${++ipN}`;
const bundle = () => ({
  opengym_plan: 1, unit: 'kg', name: 'Push', week: { 1: ['r1'] },
  routines: [{ id: 'r1', name: 'Push', ex: [{ id: '0025', sets: 3, reps: 5, weight: 60, restSec: 120 }] }], customEx: [],
});

async function world(t) {
  const objectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-life-'));
  t.after(() => fs.rmSync(objectsDir, { recursive: true, force: true }));
  const h = await bootProduct(t, { env: { OBJECT_STORE: 'fs:' + objectsDir, MEDIA_MIN_FREE_MB: '0' } });
  const pw = { h: await hashPassword(GOOD), set: new Date().toISOString() };
  const now = new Date().toISOString();
  for (const id of ['own', 'tr']) await h.store.createUser({ id, name: 'Name of ' + id, created: now });
  await h.store.createUser({ id: 'mem', name: 'Mei Tan', created: now, pw });
  const gym = await createGym(h.pool, { name: 'Gym A' });
  await addMembership(h.pool, { gymId: gym.id, userId: 'own', role: 'owner' });
  const tr = await addMembership(h.pool, { gymId: gym.id, userId: 'tr', role: 'trainer' });
  const mem = await addMembership(h.pool, { gymId: gym.id, userId: 'mem', role: 'member' });
  await assignTrainer(h.pool, { gymId: gym.id, memberMembershipId: mem.id, trainerMembershipId: tr.id });
  const as = (who, method, url, body) => h.req(method, url, { cookie: h.session(who), body, ip: ip() });
  return { h, gym, tr, mem, as, objectsDir };
}

test('deleting an account ends its sessions, gym rows and objects, and an old token restores nothing', async t => {
  const { h, as, mem } = await world(t);
  const cookie = h.session('mem');
  const bearer = h.token('mem');
  assert.equal((await as('mem', 'PUT', '/api/data', { state: { workouts: [{ id: 'w1', d: '2026-10-01' }] } })).status, 200);
  const img = M.jpeg(1500);
  const up = await fetch(`${h.api}/api/media/${M.sha(img)}`, { method: 'PUT', body: img, headers: { Cookie: cookie, 'Content-Type': 'image/jpeg', 'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-For': ip() } });
  assert.equal(up.status, 201);
  await h.req('POST', '/api/login/password', { body: { identifier: 'Mei Tan', password: 'wrong password here' }, ip: ip() });

  const del = await h.req('POST', '/api/account/delete', { cookie, body: { name: 'Mei Tan', current: GOOD }, ip: ip() });
  assert.equal(del.status, 200, JSON.stringify(del.body));

  assert.equal((await h.req('GET', '/api/me', { cookie })).status, 401);
  const stale = await h.req('PUT', '/api/data', { headers: { Authorization: `Bearer ${bearer}` }, body: { state: { workouts: [{ id: 'w1', d: '2026-10-01' }, { id: 'w2', d: '2026-10-02' }] }, baseRev: 1 } });
  assert.equal(stale.status, 401);
  const count = async (sql, args) => (await h.pool.query(sql, args)).rows[0].n;
  assert.equal(await count('SELECT count(*)::int AS n FROM member_states WHERE user_id = $1', ['mem']), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM gym_memberships WHERE user_id = $1', ['mem']), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM trainer_assignments WHERE member_membership_id = $1', [mem.id]), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM media_objects WHERE user_id = $1', ['mem']), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM media_object_deletions'), 1, 'the object is queued for the cleanup job');
  // The trail keeps what happened and the account id, not the person's name.
  await new Promise(r => setTimeout(r, 200));
  const trail = (await h.pool.query("SELECT detail FROM audit_events WHERE user_id = 'mem' OR detail->>'tgt' = 'mem'")).rows;
  assert.ok(trail.length >= 2);
  assert.ok(!JSON.stringify(trail).includes('Mei Tan'));
});

test('export hands over the member’s own history, memberships and received plans, nothing else', async t => {
  const { as } = await world(t);
  await as('mem', 'PUT', '/api/data', { state: { workouts: [{ id: 'w1', d: '2026-10-01' }], bodyweight: [{ w: 70 }] } });
  assert.equal((await as('tr', 'POST', `/api/platform/clients/${(await as('tr', 'GET', '/api/platform/clients')).body.clients[0].membershipId}/proposals`, { bundle: bundle() })).status, 200);
  const r = await as('mem', 'GET', '/api/platform/export');
  assert.equal(r.status, 200);
  const x = r.body;
  assert.equal(x.format, 'opengym-pilot-export/1');
  assert.equal(x.account.id, 'mem');
  assert.deepEqual(x.state.workouts.map(w => w.id), ['w1']);
  assert.deepEqual(x.memberships.map(m => [m.gymName, m.role]), [['Gym A', 'member']]);
  assert.equal(x.proposals.received.length, 1);
  assert.equal(x.proposals.received[0].bundle.name, 'Push');
  const text = JSON.stringify(x);
  for (const secret of ['"pw"', 'publicKey', 'credential', 'Name of tr', 'Name of own', '"sv"']) assert.ok(!text.includes(secret), secret);
  assert.equal((await as('mem', 'GET', '/api/platform/export')).body.account.id, 'mem');
  assert.equal((await as('tr', 'GET', '/api/platform/export')).body.state, null, 'a trainer exports their own (empty) history, not a client’s');
});

test('after a restore, a device holding newer work merges it back', async t => {
  const { h, as } = await world(t);
  const put = (body) => as('mem', 'PUT', '/api/data', { stamped: true, ...body });
  const one = await put({ state: { workouts: [{ id: 'w1', d: '2026-10-01', _ts: 1 }], _ts: 1 } });
  const backup = (await h.pool.query("SELECT document, revision, write_id FROM member_states WHERE user_id = 'mem'")).rows[0];
  const two = await put({ state: { workouts: [{ id: 'w1', d: '2026-10-01', _ts: 1 }, { id: 'w2', d: '2026-10-02', _ts: 2 }], _ts: 2 }, baseRev: one.body.rev, baseWid: one.body.wid });
  assert.equal(two.status, 200);
  // The database comes back from the backup taken after the first write.
  await h.pool.query("UPDATE member_states SET document = $1, revision = $2, write_id = $3 WHERE user_id = 'mem'", [backup.document, backup.revision, backup.write_id]);
  const device = { workouts: [{ id: 'w1', d: '2026-10-01', _ts: 1 }, { id: 'w2', d: '2026-10-02', _ts: 2 }], _ts: 2 };
  const refused = await put({ state: device, baseRev: two.body.rev, baseWid: two.body.wid });
  assert.equal(refused.status, 409, 'the server never takes a write against a revision it no longer has');
  assert.equal(refused.body.rev, one.body.rev);
  const merged = await put({ state: device, baseRev: refused.body.rev, baseWid: refused.body.wid });
  assert.equal(merged.status, 200);
  const doc = (await h.pool.query("SELECT document FROM member_states WHERE user_id = 'mem'")).rows[0].document;
  assert.deepEqual(doc.workouts.map(w => w.id), ['w1', 'w2']);
});

test('audit events older than the retention are pruned', async t => {
  const { h } = await world(t);
  await h.pool.query("INSERT INTO audit_events (at, ev, ok, user_id, detail) VALUES (now() - interval '400 days', 'auth.login', true, 'mem', '{}'), (now(), 'auth.login', true, 'mem', '{}')");
  const removed = await pruneAudit(h.pool, { days: 365 });
  assert.equal(removed, 1);
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM audit_events WHERE at < now() - interval '365 days'")).rows[0].n, 0);
});
