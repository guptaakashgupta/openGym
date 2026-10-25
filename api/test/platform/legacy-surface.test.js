/* What product mode exposes of upstream, request by request (docs/dev/PILOT_ENDPOINT_MATRIX.md):
   the operator-wide admin dashboard, the Coach and per-profile uploads are switched off with an
   intentional answer; push, reminders, health and audit work from PostgreSQL; nothing reads
   db.json as an authority; a gym role or an `admin` field on a record never makes an admin. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootProduct } from '../storage/product-server.mjs';
import { hashPassword } from '../../password.js';

const GOOD = 'correct horse battery staple';
let ipN = 0;
const ip = () => `198.18.0.${++ipN}`;
const UNAVAILABLE = { status: 404, code: 'unavailable' };

async function seed(h) {
  const pw = { h: await hashPassword(GOOD), set: new Date().toISOString() };
  const now = new Date().toISOString();
  await h.store.createUser({ id: 'op', name: 'Operator', created: now, pw });
  await h.store.createUser({ id: 'm1', name: 'Member', created: now, pw, admin: true, owner: true, roles: ['owner'], gym_id: 'g1' });
}

const ADMIN_ROUTES = [
  ['GET', '/api/admin/users'], ['GET', '/api/admin/user?id=m1'], ['POST', '/api/admin/user/disable'],
  ['POST', '/api/admin/user/delete'], ['POST', '/api/admin/user/role'], ['POST', '/api/admin/owner'],
  ['GET', '/api/admin/invites'], ['POST', '/api/admin/invites/new'], ['POST', '/api/admin/invites/revoke'],
  ['GET', '/api/admin/audit'], ['POST', '/api/admin/audit/clear'],
];

test('the upstream admin dashboard is unavailable in product mode, even to the operator', async t => {
  const h = await bootProduct(t, { env: { ADMIN_UIDS: 'op' } });
  await seed(h);
  for (const who of ['op', 'm1']) {
    for (const [method, url] of ADMIN_ROUTES) {
      const r = await h.req(method, url, { cookie: h.session(who), body: method === 'GET' ? undefined : { id: 'm1' }, ip: ip() });
      assert.equal(r.status, UNAVAILABLE.status, `${who} ${method} ${url}`);
      assert.equal(r.body.code, UNAVAILABLE.code, `${who} ${method} ${url}`);
    }
  }
  assert.equal((await h.store.getUser('m1')).disabled, undefined);
});

test('an admin or owner field on an account record grants nothing; only ADMIN_UIDS is the operator', async t => {
  const h = await bootProduct(t, { env: { ADMIN_UIDS: 'op' } });
  await seed(h);
  const me = await h.req('GET', '/api/me', { cookie: h.session('m1') });
  assert.equal(me.body.user.admin, false);
  assert.equal(me.body.user.owner, undefined);
  const reset = await h.req('POST', '/api/admin/user/password-reset', { cookie: h.session('m1'), body: { id: 'op' }, ip: ip() });
  assert.equal(reset.status, 403);
  assert.equal((await h.req('GET', '/api/me', { cookie: h.session('op') })).body.user.admin, true);
});

test('Coach and upload routes answer as unavailable and /api/config does not offer them', async t => {
  const h = await bootProduct(t, { env: { COACH: '1', MEDIA_UPLOADS: '1' } });
  await seed(h);
  const cookie = h.session('m1');
  for (const [method, url] of [['GET', '/api/coach/disclosure'], ['POST', '/api/coach/plan'], ['GET', '/api/media/' + 'a'.repeat(64)], ['POST', '/api/media/missing']]) {
    const r = await h.req(method, url, { cookie, body: method === 'GET' ? undefined : {}, ip: ip() });
    assert.equal(r.status, 404, `${method} ${url}`);
    assert.equal(r.body.code, 'unavailable', `${method} ${url}`);
  }
  const config = await h.req('GET', '/api/config', { cookie });
  assert.equal(config.body.media, undefined);
  assert.equal(config.body.coach, undefined);
});

test('health checks the database without counting accounts, and says so when it is gone', async t => {
  const h = await bootProduct(t);
  await seed(h);
  const r = await h.req('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.database, true);
  assert.equal('users' in r.body, false);
  const down = await bootProduct(t, { env: { DATABASE_URL: 'postgres://pilot_test:pilot_test@127.0.0.1:1/pilot_test' } });
  const d = await down.req('GET', '/api/health');
  assert.equal(d.status, 503);
  assert.equal(d.body.database, false);
});

test('push subscriptions live in PostgreSQL and go with the account', async t => {
  const h = await bootProduct(t);
  await seed(h);
  const cookie = h.session('m1');
  const endpoint = 'https://push.example.net/sub/abc';
  const keys = { p256dh: 'BPk', auth: 'aut' };
  assert.equal((await h.req('POST', '/api/push/subscribe', { cookie, body: { subscription: { endpoint, keys }, deviceId: 'phoneAAAAAA' }, ip: ip() })).status, 200);
  const { rows } = await h.pool.query('SELECT user_id, device_id FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
  assert.deepEqual(rows, [{ user_id: 'm1', device_id: 'phoneAAAAAA' }]);
  const status = await h.req('GET', '/api/push/status?endpoint=' + encodeURIComponent(endpoint), { cookie });
  assert.deepEqual(status.body, { subscribed: true, deviceId: 'phoneAAAAAA' });
  assert.deepEqual(h.fileDb().subs, []);
  assert.equal((await h.req('POST', '/api/push/subscribe', { cookie: h.session('op'), body: { subscription: { endpoint, keys: { p256dh: 'x', auth: 'y' } } }, ip: ip() })).status, 409);
  assert.equal((await h.req('POST', '/api/push/unsubscribe', { cookie, body: { endpoint }, ip: ip() })).status, 200);
  assert.equal((await h.pool.query('SELECT 1 FROM push_subscriptions')).rows.length, 0);
});

test('the reminder tick reads PostgreSQL: a planned day fires once and is recorded on the account', async t => {
  const h = await bootProduct(t, { env: { REMINDER_TICK_MS: '200' } });
  await seed(h);
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const hhmm = now.toISOString().slice(11, 16);
  await h.pool.query(`INSERT INTO member_states (user_id, document, revision) VALUES ('m1', $1::jsonb, 1)`, [JSON.stringify({
    _rev: 1, lang: 'en', reminder: { on: true, tz: 'UTC', time: hhmm }, routines: [{ id: 'r1', name: 'Legs' }], dayPlan: { [today]: 'r1' }, workouts: [],
  })]);
  // A private endpoint: the send path refuses and prunes it without opening a socket, so the row
  // disappearing is the proof the reminder fired.
  await h.pool.query(`INSERT INTO push_subscriptions (endpoint, user_id, keys, created) VALUES ('https://10.0.0.2/x', 'm1', '{"p256dh":"p","auth":"a"}', $1)`, [now.toISOString()]);
  let fired = false;
  for (let i = 0; i < 40 && !fired; i++) {
    await new Promise(r => setTimeout(r, 100));
    fired = (await h.store.getUser('m1')).lastReminder === today;
  }
  assert.ok(fired, 'lastReminder recorded on the account in PostgreSQL');
  assert.equal((await h.pool.query('SELECT 1 FROM push_subscriptions')).rows.length, 0);
});

test('nudge-check answers from PostgreSQL state', async t => {
  const h = await bootProduct(t);
  await seed(h);
  await h.pool.query(`INSERT INTO member_states (user_id, document, revision) VALUES ('m1', $1::jsonb, 4)`, [JSON.stringify({
    _rev: 4, workouts: [{ id: 'w', d: '2026-10-20' }],
  })]);
  const r = await h.req('GET', '/api/nudge-check?date=2026-10-20', { cookie: h.session('m1') });
  assert.equal(r.status, 200);
  assert.equal(r.body.done, true);
  assert.equal(r.body.rev, 4);
});

test('audit events go to PostgreSQL, not a file in DATA_DIR', async t => {
  const h = await bootProduct(t);
  await seed(h);
  assert.equal((await h.req('POST', '/api/login/password', { body: { identifier: 'member', password: GOOD }, ip: ip() })).status, 200);
  let rows = [];
  for (let i = 0; i < 20 && !rows.length; i++) {
    rows = (await h.pool.query("SELECT ev, user_id FROM audit_events WHERE ev = 'auth.password.ok'")).rows;
    if (!rows.length) await new Promise(r => setTimeout(r, 50));
  }
  assert.deepEqual(rows, [{ ev: 'auth.password.ok', user_id: 'm1' }]);
  assert.equal(fs.existsSync(path.join(h.dataDir, 'audit.log')), false);
});

test('a state write and read never touch state files in DATA_DIR', async t => {
  const h = await bootProduct(t);
  await seed(h);
  const cookie = h.session('m1');
  assert.equal((await h.req('PUT', '/api/data', { cookie, body: { state: { workouts: [] } } })).status, 200);
  assert.equal((await h.req('GET', '/api/data', { cookie })).status, 200);
  assert.deepEqual(fs.readdirSync(h.dataDir).filter(f => f.startsWith('state-')), []);
});
