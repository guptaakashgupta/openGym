/* The pilot account lifecycle. Deleting an account ends every session and token, removes its
   document, queues its uploaded objects for removal and keeps no display name in the audit
   trail; a device that synced before and comes back with an old token restores nothing. After a
   restore from backup, a device that holds newer work merges it back instead of being
   overwritten or overwriting. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootProduct } from '../storage/product-server.mjs';
import { hashPassword } from '../../password.js';
import { pruneAudit } from '../../platform/lifecycle.js';
import * as M from '../media-samples.mjs';

const GOOD = 'correct horse battery staple';
let ipN = 0;
const ip = () => `192.0.2.${++ipN}`;

async function world(t) {
  const objectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-life-'));
  t.after(() => fs.rmSync(objectsDir, { recursive: true, force: true }));
  const h = await bootProduct(t, { env: { OBJECT_STORE: 'fs:' + objectsDir, MEDIA_MIN_FREE_MB: '0' } });
  const pw = { h: await hashPassword(GOOD), set: new Date().toISOString() };
  await h.store.createUser({ id: 'mem', name: 'Mei Tan', created: new Date().toISOString(), pw });
  const as = (who, method, url, body) => h.req(method, url, { cookie: h.session(who), body, ip: ip() });
  return { h, as, objectsDir };
}

test('deleting an account ends its sessions, document and objects, and an old token restores nothing', async t => {
  const { h, as } = await world(t);
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
  assert.equal(await count('SELECT count(*)::int AS n FROM media_objects WHERE user_id = $1', ['mem']), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM media_object_deletions'), 1, 'the object is queued for the cleanup job');
  // The trail keeps what happened and the account id, not the person's name.
  await new Promise(r => setTimeout(r, 200));
  const trail = (await h.pool.query("SELECT detail FROM audit_events WHERE user_id = 'mem' OR detail->>'tgt' = 'mem'")).rows;
  assert.ok(trail.length >= 2);
  assert.ok(!JSON.stringify(trail).includes('Mei Tan'));
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
