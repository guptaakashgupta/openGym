/* Gym invitations: single use, expiring, revocable, stored as a hash, bound to a gym and a role
   (and optionally to one account). Redeeming one creates the membership in the same transaction.
   Product-mode signup needs one: there is no global signup. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { bootProduct, softPasskey } from '../storage/product-server.mjs';
import { createGym } from '../../platform/organisations.js';
import { addMembership } from '../../platform/memberships.js';
import { createInvitation } from '../../platform/invitations.js';

const GOOD = 'correct horse battery staple';
let ipN = 0;
const ip = () => `198.20.0.${++ipN}`;

async function world(t, env) {
  const h = await bootProduct(t, { env: { PILOT_OPEN_SIGNUP: '', ...env } });
  const now = new Date().toISOString();
  for (const id of ['ownA', 'trA', 'ownB', 'memB', 'u1', 'u2']) await h.store.createUser({ id, name: id, created: now });
  const A = await createGym(h.pool, { name: 'Gym A' });
  const B = await createGym(h.pool, { name: 'Gym B' });
  await addMembership(h.pool, { gymId: A.id, userId: 'ownA', role: 'owner' });
  await addMembership(h.pool, { gymId: A.id, userId: 'trA', role: 'trainer' });
  await addMembership(h.pool, { gymId: B.id, userId: 'ownB', role: 'owner' });
  await addMembership(h.pool, { gymId: B.id, userId: 'memB', role: 'member' });
  const as = (who, method, url, body) => h.req(method, url, { cookie: h.session(who), body: method === 'GET' ? undefined : (body ?? {}), ip: ip() });
  const invite = async (body = { role: 'member' }, who = 'ownA', gym = A) => as(who, 'POST', `/api/platform/gyms/${gym.id}/invitations`, body);
  return { h, A, B, as, invite };
}

test('an owner invites; trainers, members and other gyms cannot; only a hash is stored', async t => {
  const { h, A, B, as, invite } = await world(t);
  const r = await invite();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.token.length >= 32);
  const { rows } = await h.pool.query('SELECT token_hash FROM gym_invitations');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, crypto.createHash('sha256').update(r.body.token).digest('hex'));
  assert.equal((await invite({ role: 'member' }, 'trA')).status, 403);
  assert.equal((await invite({ role: 'member' }, 'ownB', A)).status, 404);
  assert.equal((await invite({ role: 'owner' })).status, 400, 'owners are provisioned by the operator');
  assert.equal((await invite({ role: 'admin' })).status, 400);
  const list = await as('ownA', 'GET', `/api/platform/gyms/${A.id}/invitations`);
  assert.equal(list.body.invitations.length, 1);
  assert.ok(!JSON.stringify(list.body).includes(r.body.token));
  assert.equal((await as('ownB', 'GET', `/api/platform/gyms/${A.id}/invitations`)).status, 404);
  assert.equal((await as('ownB', 'DELETE', `/api/platform/gyms/${B.id}/invitations/${list.body.invitations[0].id}`)).status, 404);
});

test('the gym and role are shown before joining; redeeming makes the membership', async t => {
  const { A, as, invite } = await world(t);
  const { token } = (await invite()).body;
  const preview = await as('u1', 'POST', '/api/platform/invitations/preview', { token });
  assert.deepEqual({ ...preview.body, expiresAt: undefined }, { gymName: 'Gym A', role: 'member', boundToAccount: false, expiresAt: undefined });
  const r = await as('u1', 'POST', '/api/platform/invitations/redeem', { token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await as('u1', 'GET', '/api/platform/me')).body.roles.map(x => [x.gymId, x.role]), [[A.id, 'member']]);
});

test('a used token: a safe answer for its redeemer, refused for anyone else', async t => {
  const { as, invite } = await world(t);
  const { token } = (await invite()).body;
  assert.equal((await as('u1', 'POST', '/api/platform/invitations/redeem', { token })).status, 200);
  const again = await as('u1', 'POST', '/api/platform/invitations/redeem', { token });
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyRedeemed, true);
  assert.equal((await as('u2', 'POST', '/api/platform/invitations/redeem', { token })).status, 410);
  assert.deepEqual((await as('u2', 'GET', '/api/platform/me')).body.roles, []);
});

test('two accounts redeeming one token at once: one membership', async t => {
  const { h, as, invite } = await world(t);
  const { token } = (await invite()).body;
  const [a, b] = await Promise.all([
    as('u1', 'POST', '/api/platform/invitations/redeem', { token }),
    as('u2', 'POST', '/api/platform/invitations/redeem', { token }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 410]);
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM gym_memberships WHERE role = 'member' AND user_id IN ('u1','u2')")).rows[0].n, 1);
});

test('expired, revoked, unknown and wrong-recipient tokens are refused', async t => {
  const { h, A, as, invite } = await world(t);
  const expired = (await invite()).body.token;
  await h.pool.query("UPDATE gym_invitations SET expires_at = now() - interval '1 second'");
  assert.equal((await as('u1', 'POST', '/api/platform/invitations/redeem', { token: expired })).status, 410);
  const made = (await invite()).body;
  assert.equal((await as('ownA', 'DELETE', `/api/platform/gyms/${A.id}/invitations/${made.invitation.id}`)).status, 200);
  assert.equal((await as('u1', 'POST', '/api/platform/invitations/redeem', { token: made.token })).status, 410);
  assert.equal((await as('u1', 'POST', '/api/platform/invitations/redeem', { token: 'x'.repeat(43) })).status, 404);
  const bound = (await invite({ role: 'member', recipientUserId: 'u2' })).body.token;
  assert.equal((await as('u1', 'POST', '/api/platform/invitations/redeem', { token: bound })).status, 403);
  assert.equal((await as('u2', 'POST', '/api/platform/invitations/redeem', { token: bound })).status, 200);
});

test('a member of another gym cannot join a second one, and the token is not spent', async t => {
  const { as, invite } = await world(t);
  const { token } = (await invite()).body;
  const r = await as('memB', 'POST', '/api/platform/invitations/redeem', { token });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'member-elsewhere');
  assert.equal((await as('u1', 'POST', '/api/platform/invitations/redeem', { token })).status, 200);
});

test('a trainer invitation makes a trainer', async t => {
  const { as, invite } = await world(t);
  const { token } = (await invite({ role: 'trainer' })).body;
  assert.equal((await as('u1', 'POST', '/api/platform/invitations/redeem', { token })).status, 200);
  assert.deepEqual((await as('u1', 'GET', '/api/platform/me')).body.roles.map(x => x.role), ['trainer']);
});

test('signing up needs a gym invitation, which the signup redeems', async t => {
  const { h, A } = await world(t);
  assert.equal((await h.req('POST', '/api/register/password', { body: { name: 'Nina', password: GOOD }, ip: ip() })).status, 403);
  const { token } = (await createInvitation(h.pool, { gymId: A.id, role: 'member', createdBy: 'ownA' }));
  const r = await h.req('POST', '/api/register/password', { body: { name: 'Nina', password: GOOD, invite: token }, ip: ip() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const me = await h.req('GET', '/api/platform/me', { cookie: r.cookie });
  assert.deepEqual(me.body.roles.map(x => [x.gymId, x.role]), [[A.id, 'member']]);
  assert.equal((await h.req('POST', '/api/register/password', { body: { name: 'Omar', password: GOOD, invite: token }, ip: ip() })).status, 403);
});

test('a passkey signup redeems its invitation too', async t => {
  const { h, A } = await world(t);
  const { token } = await createInvitation(h.pool, { gymId: A.id, role: 'member', createdBy: 'ownA' });
  const key = softPasskey();
  const refused = await h.req('POST', '/api/register/options', { body: { name: 'Pia' }, ip: ip() });
  assert.equal(refused.status, 403);
  const o = (await h.req('POST', '/api/register/options', { body: { name: 'Pia', invite: token }, ip: ip() })).body;
  const r = await h.req('POST', '/api/register/verify', { body: { cid: o.cid, credential: key.attestation(o.options.challenge) }, ip: ip() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await h.req('GET', '/api/platform/me', { cookie: r.cookie })).body.roles.map(x => x.role), ['member']);
});

test('the operator can open signup for bootstrapping only by an explicit switch', async t => {
  const { h } = await world(t, { PILOT_OPEN_SIGNUP: '1' });
  assert.equal((await h.req('POST', '/api/register/password', { body: { name: 'Operator', password: GOOD }, ip: ip() })).status, 200);
});

test('an operator owner invitation signs its holder up as the owner of the new gym', async t => {
  const { h } = await world(t);
  const C = await createGym(h.pool, { name: 'Gym C' });
  const { token } = await createInvitation(h.pool, { gymId: C.id, role: 'owner', createdBy: null });
  const r = await h.req('POST', '/api/register/password', { body: { name: 'Owen', password: GOOD, invite: token }, ip: ip() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await h.req('GET', '/api/platform/me', { cookie: r.cookie })).body.roles.map(x => [x.gymId, x.role]), [[C.id, 'owner']]);
  assert.equal((await h.req('GET', '/api/me', { cookie: r.cookie })).body.user.admin, false, 'a gym owner is not the platform operator');
});
