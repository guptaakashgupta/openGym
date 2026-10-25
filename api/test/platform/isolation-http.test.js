/* Every platform route, from every seat: owners, trainers and members of gym A and gym B, a
   reassigned trainer and an authenticated outsider, using each other's identifiers. A resource of
   a gym the caller has no role in does not exist (404); a known action the caller's role may not
   take is forbidden (403); no session is 401. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootProduct } from '../storage/product-server.mjs';
import { createGym } from '../../platform/organisations.js';
import { addMembership } from '../../platform/memberships.js';

let ipN = 0;
const ip = () => `198.19.0.${++ipN}`;

async function world(t) {
  const h = await bootProduct(t);
  const now = new Date().toISOString();
  for (const id of ['ownA', 'trA', 'trA2', 'memA', 'ownB', 'trB', 'memB', 'out'])
    await h.store.createUser({ id, name: id, created: now });
  const A = await createGym(h.pool, { name: 'Gym A' });
  const B = await createGym(h.pool, { name: 'Gym B' });
  const m = {};
  for (const [key, gym, user, role] of [
    ['ownA', A, 'ownA', 'owner'], ['trA', A, 'trA', 'trainer'], ['trA2', A, 'trA2', 'trainer'], ['memA', A, 'memA', 'member'],
    ['ownB', B, 'ownB', 'owner'], ['trB', B, 'trB', 'trainer'], ['memB', B, 'memB', 'member'],
  ]) m[key] = await addMembership(h.pool, { gymId: gym.id, userId: user, role });
  const as = (who, method, url, body) => h.req(method, url, { cookie: h.session(who), body: method === 'GET' ? undefined : (body ?? {}), ip: ip() });
  return { h, A, B, m, as };
}

test('/api/platform/me reports current roles from the server, and nothing without a session', async t => {
  const { h, A, m, as } = await world(t);
  assert.equal((await h.req('GET', '/api/platform/me')).status, 401);
  const me = await as('memA', 'GET', '/api/platform/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.roles, [{ gymId: A.id, gymName: 'Gym A', role: 'member', membershipId: m.memA.id }]);
  assert.deepEqual((await as('out', 'GET', '/api/platform/me')).body.roles, []);
});

test('member lists: own gym for its owner only', async t => {
  const { A, B, as } = await world(t);
  const list = await as('ownA', 'GET', `/api/platform/gyms/${A.id}/members`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.members.map(x => x.userId).sort(), ['memA', 'ownA', 'trA', 'trA2']);
  assert.ok(list.body.members.every(x => !('pw' in x) && !('email' in x)));
  assert.equal((await as('ownA', 'GET', `/api/platform/gyms/${B.id}/members`)).status, 404);
  assert.equal((await as('trA', 'GET', `/api/platform/gyms/${A.id}/members`)).status, 403);
  assert.equal((await as('memA', 'GET', `/api/platform/gyms/${A.id}/members`)).status, 403);
  assert.equal((await as('out', 'GET', `/api/platform/gyms/${A.id}/members`)).status, 404);
  assert.equal((await as('ownA', 'GET', '/api/platform/gyms/g_doesnotexist/members')).status, 404);
});

test('assignments: same-gym active memberships, by the owner of that gym only', async t => {
  const { A, B, m, as } = await world(t);
  const url = g => `/api/platform/gyms/${g.id}/assignments`;
  assert.equal((await as('ownA', 'POST', url(A), { memberMembershipId: m.memB.id, trainerMembershipId: m.trA.id })).status, 404);
  assert.equal((await as('ownB', 'POST', url(B), { memberMembershipId: m.memA.id, trainerMembershipId: m.trB.id })).status, 404);
  assert.equal((await as('ownB', 'POST', url(A), { memberMembershipId: m.memA.id, trainerMembershipId: m.trA.id })).status, 404);
  assert.equal((await as('trA', 'POST', url(A), { memberMembershipId: m.memA.id, trainerMembershipId: m.trA.id })).status, 403);
  assert.equal((await as('ownA', 'POST', url(A), { memberMembershipId: m.trA.id, trainerMembershipId: m.memA.id })).status, 400);
  const made = await as('ownA', 'POST', url(A), { memberMembershipId: m.memA.id, trainerMembershipId: m.trA.id });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const id = made.body.assignment.id;
  assert.equal((await as('ownB', 'DELETE', `/api/platform/gyms/${B.id}/assignments/${id}`)).status, 404);
  assert.equal((await as('ownB', 'DELETE', `/api/platform/gyms/${A.id}/assignments/${id}`)).status, 404);
  assert.equal((await as('trA', 'DELETE', `/api/platform/gyms/${A.id}/assignments/${id}`)).status, 403);
  assert.equal((await as('ownA', 'DELETE', `/api/platform/gyms/${A.id}/assignments/${id}`)).status, 200);
  assert.equal((await as('ownA', 'DELETE', `/api/platform/gyms/${A.id}/assignments/${id}`)).status, 404);
});

test('a trainer lists current clients only; reassignment takes effect on the next request of the same session', async t => {
  const { A, m, as } = await world(t);
  await as('ownA', 'POST', `/api/platform/gyms/${A.id}/assignments`, { memberMembershipId: m.memA.id, trainerMembershipId: m.trA.id });
  const before = await as('trA', 'GET', '/api/platform/clients');
  assert.deepEqual(before.body.clients.map(c => c.membershipId), [m.memA.id]);
  assert.deepEqual((await as('trB', 'GET', '/api/platform/clients')).body.clients, []);
  assert.deepEqual((await as('memA', 'GET', '/api/platform/clients')).body.clients, []);
  await as('ownA', 'POST', `/api/platform/gyms/${A.id}/assignments`, { memberMembershipId: m.memA.id, trainerMembershipId: m.trA2.id });
  assert.deepEqual((await as('trA', 'GET', '/api/platform/clients')).body.clients, []);
  assert.deepEqual((await as('trA2', 'GET', '/api/platform/clients')).body.clients.map(c => c.membershipId), [m.memA.id]);
});

test('ending a membership: the owner of that gym only; personal account untouched', async t => {
  const { h, A, B, m, as } = await world(t);
  assert.equal((await as('ownB', 'POST', `/api/platform/gyms/${A.id}/memberships/${m.memA.id}/end`)).status, 404);
  assert.equal((await as('ownA', 'POST', `/api/platform/gyms/${A.id}/memberships/${m.memB.id}/end`)).status, 404);
  assert.equal((await as('ownA', 'POST', `/api/platform/gyms/${B.id}/memberships/${m.memB.id}/end`)).status, 404);
  assert.equal((await as('memA', 'POST', `/api/platform/gyms/${A.id}/memberships/${m.memA.id}/end`)).status, 403);
  assert.equal((await as('ownA', 'POST', `/api/platform/gyms/${A.id}/memberships/${m.memA.id}/end`)).status, 200);
  assert.ok(await h.store.getUser('memA'));
  assert.deepEqual((await as('memA', 'GET', '/api/platform/me')).body.roles, []);
});

test('a session ended elsewhere is refused on platform routes', async t => {
  const { h, A, as } = await world(t);
  const cookie = h.session('ownA');
  assert.equal((await h.req('POST', '/api/logout/all', { cookie, body: {}, ip: ip() })).status, 200);
  assert.equal((await h.req('GET', `/api/platform/gyms/${A.id}/members`, { cookie })).status, 401);
  assert.equal((await as('ownA', 'GET', `/api/platform/gyms/${A.id}/members`)).status, 401, 'version 0 is stale too');
});

test('role-looking fields in a request body or in the personal document grant nothing', async t => {
  const { h, A, m, as } = await world(t);
  const cookie = h.session('memA');
  const put = await h.req('PUT', '/api/data', { cookie, body: { state: { workouts: [], admin: true, gym_id: A.id, roles: ['owner'] } } });
  assert.equal(put.status, 200);
  assert.equal((await as('memA', 'GET', `/api/platform/gyms/${A.id}/members`)).status, 403);
  const forged = await as('memA', 'POST', `/api/platform/gyms/${A.id}/assignments`, { memberMembershipId: m.memA.id, trainerMembershipId: m.trA.id, role: 'owner', gymId: A.id });
  assert.equal(forged.status, 403);
  assert.deepEqual((await as('memA', 'GET', '/api/platform/me')).body.roles.map(r => r.role), ['member']);
  const back = await h.req('GET', '/api/data', { cookie });
  assert.equal(back.body.state.admin, true, 'the member may keep any field in their own document');
});

test('a cross-site browser request to a platform mutation is refused before it runs', async t => {
  const { h, A, m } = await world(t);
  const r = await h.req('POST', `/api/platform/gyms/${A.id}/assignments`, {
    cookie: h.session('ownA'), body: { memberMembershipId: m.memA.id, trainerMembershipId: m.trA.id }, headers: { 'Sec-Fetch-Site': 'cross-site' }, ip: ip(),
  });
  assert.equal(r.status, 403);
  assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM trainer_assignments')).rows[0].n, 0);
});
