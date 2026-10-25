/* The account routes in product mode: every way in and every change to one goes through the
   PostgreSQL identity store, survives a restart, and observes revocation on the very next request.
   db.json is never the authority for accounts here. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootProduct, softPasskey } from './product-server.mjs';
import { hashPassword } from '../../password.js';

const GOOD = 'correct horse battery staple';
const NEXT = 'staple battery horse correct';
let ipN = 0;
const ip = () => `198.51.100.${++ipN}`;

// ---- password registration and sign-in ------------------------------------------------------

test('a password signup lands in PostgreSQL, not db.json, and signs in again after a restart', async t => {
  const h = await bootProduct(t);
  const r = await h.req('POST', '/api/register/password', { body: { name: 'Asha', password: GOOD }, ip: ip() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const uid = r.body.user.id;
  assert.equal((await h.store.getUser(uid)).name, 'Asha');
  assert.deepEqual(h.fileDb().users, []);
  assert.equal((await h.req('GET', '/api/me', { cookie: r.cookie })).body.user.id, uid);
  await h.restart();
  assert.equal((await h.req('GET', '/api/me', { cookie: r.cookie })).status, 200);
  const login = await h.req('POST', '/api/login/password', { body: { identifier: 'asha', password: GOOD }, ip: ip() });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.id, uid);
});

test('two simultaneous signups for one name: one account, one refusal', async t => {
  const h = await bootProduct(t);
  const [a, b] = await Promise.all([
    h.req('POST', '/api/register/password', { body: { name: 'Ravi', password: GOOD }, ip: ip() }),
    h.req('POST', '/api/register/password', { body: { name: 'RAVI', password: GOOD }, ip: ip() }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal((await h.store.listUsers()).length, 1);
});

test('a wrong password is refused; a disabled account cannot sign in and its open session stops', async t => {
  const h = await bootProduct(t);
  await h.store.createUser({ id: 'u1', name: 'Mei', created: new Date().toISOString(), pw: { h: await hashPassword(GOOD), set: new Date().toISOString() } });
  assert.equal((await h.req('POST', '/api/login/password', { body: { identifier: 'mei', password: 'nope nope nope nope' }, ip: ip() })).status, 401);
  const cookie = h.session('u1');
  assert.equal((await h.req('GET', '/api/me', { cookie })).status, 200);
  await h.store.updateUser('u1', u => ({ ...u, disabled: true }));
  assert.equal((await h.req('GET', '/api/me', { cookie })).status, 401);
  assert.equal((await h.req('POST', '/api/login/password', { body: { identifier: 'mei', password: GOOD }, ip: ip() })).status, 403);
});

// ---- password and e-mail changes --------------------------------------------------------------

async function withPasswordUser(h, extra = {}) {
  await h.store.createUser({ id: 'u1', name: 'Mei', created: new Date().toISOString(), pw: { h: await hashPassword(GOOD), set: new Date().toISOString() }, ...extra });
  return h.session('u1', extra.sv || 0);
}

test('changing the password ends other sessions, keeps the caller signed in, and swaps which password works', async t => {
  const h = await bootProduct(t);
  const old = await withPasswordUser(h);
  const other = h.session('u1');
  const r = await h.req('POST', '/api/account/password', { cookie: old, body: { current: GOOD, next: NEXT }, ip: ip() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.cookie);
  assert.equal((await h.req('GET', '/api/me', { cookie: other })).status, 401);
  assert.equal((await h.req('GET', '/api/me', { cookie: r.cookie })).status, 200);
  assert.equal((await h.req('POST', '/api/login/password', { body: { identifier: 'mei', password: GOOD }, ip: ip() })).status, 401);
  assert.equal((await h.req('POST', '/api/login/password', { body: { identifier: 'mei', password: NEXT }, ip: ip() })).status, 200);
});

test('a sign-in racing a password change never leaves a working session for the old password', async t => {
  const h = await bootProduct(t);
  const cookie = await withPasswordUser(h);
  const [login, change] = await Promise.all([
    h.req('POST', '/api/login/password', { body: { identifier: 'mei', password: GOOD }, ip: ip() }),
    h.req('POST', '/api/account/password', { cookie, body: { current: GOOD, next: NEXT }, ip: ip() }),
  ]);
  assert.equal(change.status, 200);
  if (login.status === 200) assert.equal((await h.req('GET', '/api/me', { cookie: login.cookie })).status, 401);
});

test('an e-mail set in Settings signs in and is unique; removing it needs the password', async t => {
  const h = await bootProduct(t);
  const cookie = await withPasswordUser(h);
  await h.store.createUser({ id: 'u2', name: 'Other', created: new Date().toISOString(), email: 'taken@x.io' });
  assert.equal((await h.req('POST', '/api/account/email', { cookie, body: { email: 'taken@x.io', current: GOOD }, ip: ip() })).status, 409);
  const set = await h.req('POST', '/api/account/email', { cookie, body: { email: 'Mei@X.io', current: GOOD }, ip: ip() });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal((await h.store.getUser('u1')).email, 'mei@x.io');
  assert.equal((await h.req('POST', '/api/login/password', { body: { identifier: 'mei@x.io', password: GOOD }, ip: ip() })).status, 200);
  assert.equal((await h.req('DELETE', '/api/account/email', { cookie, body: {}, ip: ip() })).status, 403);
  assert.equal((await h.req('DELETE', '/api/account/email', { cookie, body: { current: GOOD }, ip: ip() })).status, 200);
  assert.equal((await h.store.getUser('u1')).email, undefined);
});

// ---- passkeys -----------------------------------------------------------------------------------

test('a passkey signup, sign-in, second passkey and removal all live in PostgreSQL', async t => {
  const h = await bootProduct(t);
  const first = softPasskey(), second = softPasskey();
  const opts = (await h.req('POST', '/api/register/options', { body: { name: 'Kai' }, ip: ip() })).body;
  const reg = await h.req('POST', '/api/register/verify', { body: { cid: opts.cid, credential: first.attestation(opts.options.challenge) }, ip: ip() });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  const uid = reg.body.user.id;
  assert.deepEqual((await h.store.listCredentials(uid)).map(c => c.id), [first.id]);

  const lo = (await h.req('POST', '/api/login/options', { body: {}, ip: ip() })).body;
  const login = await h.req('POST', '/api/login/verify', { body: { cid: lo.cid, credential: first.assertion(lo.options.challenge) }, ip: ip() });
  assert.equal(login.status, 200);
  assert.equal((await h.store.findCredential(first.id)).counter, 1);

  const a = ip();
  const add = await h.req('POST', '/api/account/passkeys/options', { cookie: login.cookie, body: await h.stepUp(first, a), ip: a });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  const verify = await h.req('POST', '/api/account/passkeys/verify', { cookie: login.cookie, body: { cid: add.body.cid, credential: second.attestation(add.body.options.challenge) }, ip: a });
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  assert.deepEqual((await h.store.listCredentials(uid)).map(c => c.id), [first.id, second.id]);

  const list = await h.req('GET', '/api/account/passkeys', { cookie: login.cookie });
  assert.deepEqual(list.body.passkeys.map(p => p.id), [first.id, second.id]);

  const b = ip();
  const del = await h.req('DELETE', `/api/account/passkeys?id=${encodeURIComponent(first.id)}`, { cookie: login.cookie, body: await h.stepUp(second, b), ip: b });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.deepEqual((await h.store.listCredentials(uid)).map(c => c.id), [second.id]);
  const c = ip();
  const last = await h.req('DELETE', `/api/account/passkeys?id=${encodeURIComponent(second.id)}`, { cookie: login.cookie, body: await h.stepUp(second, c), ip: c });
  assert.equal(last.status, 409);
});

test('a passkey registered twice is refused', async t => {
  const h = await bootProduct(t);
  const key = softPasskey();
  for (const expected of [200, 409]) {
    const o = (await h.req('POST', '/api/register/options', { body: { name: 'Dup' }, ip: ip() })).body;
    const r = await h.req('POST', '/api/register/verify', { body: { cid: o.cid, credential: key.attestation(o.options.challenge) }, ip: ip() });
    assert.equal(r.status, expected);
  }
  assert.equal((await h.store.listUsers()).length, 1);
});

// ---- sign-out everywhere and account deletion ---------------------------------------------------

test('sign out everywhere ends every session at once', async t => {
  const h = await bootProduct(t);
  const cookie = await withPasswordUser(h);
  const other = h.session('u1');
  assert.equal((await h.req('POST', '/api/logout/all', { cookie, body: {}, ip: ip() })).status, 200);
  assert.equal((await h.req('GET', '/api/me', { cookie: other })).status, 401);
  assert.equal((await h.store.getUser('u1')).sv, 1);
});

test('deleting the account removes it, its passkeys and its training history; its session stops', async t => {
  const h = await bootProduct(t);
  const key = softPasskey();
  const cookie = await withPasswordUser(h);
  await h.store.addCredential(key.row('u1'));
  assert.equal((await h.req('PUT', '/api/data', { cookie, body: { state: { workouts: [{ id: 'w', d: '2026-10-01' }] } } })).status, 200);
  assert.equal((await h.req('POST', '/api/account/delete', { cookie, body: { name: 'Wrong', current: GOOD }, ip: ip() })).status, 400);
  const r = await h.req('POST', '/api/account/delete', { cookie, body: { name: 'Mei', current: GOOD }, ip: ip() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await h.store.getUser('u1'), null);
  assert.equal(await h.store.findCredential(key.id), null);
  const { rows } = await h.pool.query("SELECT 1 FROM member_states WHERE user_id = 'u1'");
  assert.equal(rows.length, 0);
  assert.equal((await h.req('GET', '/api/me', { cookie })).status, 401);
});

// ---- storage that is not there fails closed -------------------------------------------------------

test('with the database unreachable a valid-looking session is never let in', async t => {
  const h = await bootProduct(t, { env: { DATABASE_URL: 'postgres://pilot_test:pilot_test@127.0.0.1:1/pilot_test' } });
  const r = await h.req('GET', '/api/me', { cookie: h.session('u1') });
  assert.ok(r.status >= 500, `expected a server error, got ${r.status}`);
  const data = await h.req('GET', '/api/data', { cookie: h.session('u1') });
  assert.ok(data.status >= 500);
});
