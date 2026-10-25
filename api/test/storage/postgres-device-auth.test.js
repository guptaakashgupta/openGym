/* Sessions, pairing codes, WebAuthn challenges and device links in product mode: shared by every
   API process through PostgreSQL, consumed exactly once, stored as hashes, and ended by revocation.
   Browser cookies and paired-phone bearer tokens keep their upstream meaning. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootProduct, softPasskey } from './product-server.mjs';
import { hashPassword } from '../../password.js';

const GOOD = 'correct horse battery staple';
let ipN = 0;
const ip = () => `192.0.2.${++ipN}`;

async function withUser(h, id = 'u1', name = 'Mei') {
  await h.store.createUser({ id, name, created: new Date().toISOString(), pw: { h: await hashPassword(GOOD), set: new Date().toISOString() } });
  return h.session(id);
}
const bearer = tok => ({ Authorization: `Bearer ${tok}` });

test('a session signed by one process is accepted by another: one managed secret', async t => {
  const h = await bootProduct(t);
  const cookie = await withUser(h);
  const other = await h.another();
  assert.equal((await h.req('GET', '/api/me', { cookie })).status, 200);
  assert.equal((await other('GET', '/api/me', { cookie })).status, 200);
});

test('a pairing code minted on one process redeems on another, once, as a renewable bearer', async t => {
  const h = await bootProduct(t, { env: { SESSION_DAYS: '1' } });
  const cookie = await withUser(h);
  const other = await h.another();
  const { code } = (await h.req('POST', '/api/pair/create', { cookie, body: {}, ip: ip() })).body;
  const { rows } = await h.pool.query('SELECT code_hash FROM pairing_codes');
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].code_hash, code, 'only a hash of the code is stored');

  const [a, b] = await Promise.all([
    h.req('POST', '/api/pair/redeem', { body: { code }, ip: ip() }),
    other('POST', '/api/pair/redeem', { body: { code }, ip: ip() }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 400]);
  const token = (a.status === 200 ? a : b).body.token;
  assert.equal((await other('GET', '/api/me', { headers: bearer(token) })).status, 200);

  // a phone's token past half its life is renewed; a browser cookie replayed as a bearer is not
  const ageing = h.token('u1', { ttlMs: 3600000, kind: 'b' });
  assert.ok((await h.req('GET', '/api/me', { headers: bearer(ageing) })).body.token);
  const cookieAsBearer = h.token('u1', { ttlMs: 3600000, kind: 'c' });
  assert.equal((await h.req('GET', '/api/me', { headers: bearer(cookieAsBearer) })).body.token, undefined);
});

test('an expired pairing code is refused', async t => {
  const h = await bootProduct(t);
  const cookie = await withUser(h);
  const { code } = (await h.req('POST', '/api/pair/create', { cookie, body: {}, ip: ip() })).body;
  await h.pool.query("UPDATE pairing_codes SET expires_at = now() - interval '1 second'");
  assert.equal((await h.req('POST', '/api/pair/redeem', { body: { code }, ip: ip() })).status, 400);
});

test('sign out everywhere ends bearers on every process and voids an unredeemed pairing code', async t => {
  const h = await bootProduct(t);
  const cookie = await withUser(h);
  const other = await h.another();
  const token = h.token('u1', { kind: 'b' });
  const { code } = (await h.req('POST', '/api/pair/create', { cookie, body: {}, ip: ip() })).body;
  assert.equal((await other('POST', '/api/logout/all', { cookie, body: {}, ip: ip() })).status, 200);
  assert.equal((await h.req('GET', '/api/me', { headers: bearer(token) })).status, 401);
  assert.equal((await h.req('POST', '/api/pair/redeem', { body: { code }, ip: ip() })).status, 400);
});

test('a WebAuthn challenge issued by one process is consumed once, by whichever process gets it first', async t => {
  const h = await bootProduct(t);
  const key = softPasskey();
  await withUser(h);
  await h.store.addCredential(key.row('u1'));
  const other = await h.another();
  const { cid, options } = (await h.req('POST', '/api/login/options', { body: {}, ip: ip() })).body;
  const body = { cid, credential: key.assertion(options.challenge) };
  const [a, b] = await Promise.all([
    h.req('POST', '/api/login/verify', { body, ip: ip() }),
    other('POST', '/api/login/verify', { body, ip: ip() }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 400]);
  assert.equal((await h.req('POST', '/api/login/verify', { body, ip: ip() })).status, 400, 'a replay finds it gone');
  const { rows } = await h.pool.query('SELECT cid_hash FROM auth_challenges');
  assert.ok(rows.every(r => r.cid_hash !== cid));
});

test('an expired challenge is refused', async t => {
  const h = await bootProduct(t);
  const key = softPasskey();
  await withUser(h);
  await h.store.addCredential(key.row('u1'));
  const { cid, options } = (await h.req('POST', '/api/login/options', { body: {}, ip: ip() })).body;
  await h.pool.query("UPDATE auth_challenges SET expires_at = now() - interval '1 second'");
  assert.equal((await h.req('POST', '/api/login/verify', { body: { cid, credential: key.assertion(options.challenge) }, ip: ip() })).status, 400);
});

test('a device link made on one process adds exactly one passkey, redeemed on another', async t => {
  const h = await bootProduct(t);
  const cookie = await withUser(h);
  const other = await h.another();
  const made = await h.req('POST', '/api/account/device-link', { cookie, body: { current: GOOD }, ip: ip() });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const { code } = made.body;
  const { rows } = await h.pool.query('SELECT code_hash FROM device_links');
  assert.ok(rows.length === 1 && !rows[0].code_hash.includes(code.replace(/-/g, '')));

  const one = softPasskey(), two = softPasskey();
  const oa = (await h.req('POST', '/api/device-link/options', { body: { code }, ip: ip() })).body;
  const ob = (await other('POST', '/api/device-link/options', { body: { code }, ip: ip() })).body;
  const [a, b] = await Promise.all([
    h.req('POST', '/api/device-link/verify', { body: { code, cid: oa.cid, credential: one.attestation(oa.options.challenge) }, ip: ip() }),
    other('POST', '/api/device-link/verify', { body: { code, cid: ob.cid, credential: two.attestation(ob.options.challenge) }, ip: ip() }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 400]);
  assert.equal((await h.store.listCredentials('u1')).length, 1);
});
