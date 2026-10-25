/* Pilot account recovery: only the platform operator (ADMIN_UIDS) issues a short-lived, single-use
   reset code; issuing it ends the member's sessions and is audited without the code itself. A gym
   owner is an ordinary account here and has no reset authority. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootProduct } from '../storage/product-server.mjs';
import { hashPassword } from '../../password.js';

const GOOD = 'correct horse battery staple';
const NEXT = 'staple battery horse correct';
let ipN = 0;
const ip = () => `203.0.113.${++ipN}`;

async function setup(t) {
  const h = await bootProduct(t, { env: { ADMIN_UIDS: 'op' } });
  const pw = { h: await hashPassword(GOOD), set: new Date().toISOString() };
  const now = new Date().toISOString();
  await h.store.createUser({ id: 'op', name: 'Operator', created: now, pw });
  await h.store.createUser({ id: 'owner', name: 'Gym Owner', created: now, pw });
  await h.store.createUser({ id: 'u1', name: 'Mei', created: now, pw });
  return h;
}

test('the operator issues a reset: old sessions end, the code works once, and it is not logged', async t => {
  const h = await setup(t);
  const memberSession = h.session('u1');
  const r = await h.req('POST', '/api/admin/user/password-reset', { cookie: h.session('op'), body: { id: 'u1' }, ip: ip() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { code } = r.body;
  assert.equal((await h.req('GET', '/api/me', { cookie: memberSession })).status, 401);
  assert.equal((await h.req('POST', '/api/login/password', { body: { identifier: 'mei', password: GOOD }, ip: ip() })).status, 401);
  const stored = await h.store.getUser('u1');
  assert.equal(stored.pw, undefined);
  assert.ok(stored.pwReset.exp > Date.now());
  assert.notEqual(stored.pwReset.h, code);

  const redeem = await h.req('POST', '/api/login/password-reset', { body: { identifier: 'mei', code, next: NEXT }, ip: ip() });
  assert.equal(redeem.status, 200, JSON.stringify(redeem.body));
  assert.equal((await h.req('GET', '/api/me', { cookie: redeem.cookie })).status, 200);
  assert.equal((await h.req('POST', '/api/login/password-reset', { body: { identifier: 'mei', code, next: GOOD }, ip: ip() })).status, 400);

  const events = h.audit();
  assert.ok(events.some(e => e.ev === 'admin.password.reset'));
  assert.ok(!JSON.stringify(events).includes(code), 'the reset code never reaches the audit log');
});

test('a gym owner without operator authority cannot reset anyone', async t => {
  const h = await setup(t);
  const r = await h.req('POST', '/api/admin/user/password-reset', { cookie: h.session('owner'), body: { id: 'u1' }, ip: ip() });
  assert.equal(r.status, 403);
  assert.ok((await h.store.getUser('u1')).pw);
});

test('an expired reset code is refused', async t => {
  const h = await setup(t);
  const { code } = (await h.req('POST', '/api/admin/user/password-reset', { cookie: h.session('op'), body: { id: 'u1' }, ip: ip() })).body;
  await h.store.updateUser('u1', u => ({ ...u, pwReset: { ...u.pwReset, exp: Date.now() - 1000 } }));
  const r = await h.req('POST', '/api/login/password-reset', { body: { identifier: 'mei', code, next: NEXT }, ip: ip() });
  assert.equal(r.status, 400);
});
