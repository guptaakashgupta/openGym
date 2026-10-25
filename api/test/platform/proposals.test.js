/* Trainer plan proposals: only the assigned trainer sends one; each version is stored normalised
   and never changes; only its recipient decides; a newer version supersedes a pending one; an
   ended assignment invalidates what was pending, and a new trainer starts their own. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootProduct } from '../storage/product-server.mjs';
import { createGym } from '../../platform/organisations.js';
import { addMembership } from '../../platform/memberships.js';
import { assignTrainer, endAssignment } from '../../platform/assignments.js';

let ipN = 0;
const ip = () => `198.21.0.${++ipN}`;
const bundle = (name = 'Push', extra = {}) => ({
  opengym_plan: 1, unit: 'kg', name, week: { 1: ['r1'] },
  routines: [{ id: 'r1', name, ex: [{ id: '0025', sets: 3, reps: 5, weight: 60, restSec: 120 }] }], customEx: [], ...extra,
});

async function world(t) {
  const h = await bootProduct(t);
  const now = new Date().toISOString();
  for (const id of ['own', 'tr', 'tr2', 'mem', 'mem2', 'out']) await h.store.createUser({ id, name: id, created: now });
  const A = await createGym(h.pool, { name: 'A' });
  await addMembership(h.pool, { gymId: A.id, userId: 'own', role: 'owner' });
  const tr = await addMembership(h.pool, { gymId: A.id, userId: 'tr', role: 'trainer' });
  const tr2 = await addMembership(h.pool, { gymId: A.id, userId: 'tr2', role: 'trainer' });
  const mem = await addMembership(h.pool, { gymId: A.id, userId: 'mem', role: 'member' });
  const mem2 = await addMembership(h.pool, { gymId: A.id, userId: 'mem2', role: 'member' });
  const asg = await assignTrainer(h.pool, { gymId: A.id, memberMembershipId: mem.id, trainerMembershipId: tr.id });
  await h.req('PUT', '/api/data', { cookie: h.session('mem'), body: { state: { workouts: [{ id: 'w-secret', d: '2026-01-01' }], bodyweight: [{ w: 80 }] } } });
  const as = (who, method, url, body) => h.req(method, url, { cookie: h.session(who), body: method === 'GET' ? undefined : (body ?? {}), ip: ip() });
  const propose = (who = 'tr', b = bundle(), extra = {}, memberId = mem.id) => as(who, 'POST', `/api/platform/clients/${memberId}/proposals`, { bundle: b, ...extra });
  return { h, A, tr, tr2, mem, mem2, asg, as, propose };
}

test('only the assigned trainer can propose', async t => {
  const { mem2, propose } = await world(t);
  const r = await propose();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.proposal.status, 'pending');
  for (const who of ['tr2', 'own', 'mem', 'out']) assert.equal((await propose(who)).status, 404, who);
  assert.equal((await propose('tr', bundle(), {}, mem2.id)).status, 404, 'a member of the gym the trainer is not assigned to');
});

test('a malformed, oversized or unsupported plan is refused with a reason', async t => {
  const { propose } = await world(t);
  assert.equal((await propose('tr', { not: 'a plan' })).body.code, 'plan-invalid');
  assert.equal((await propose('tr', 'a string')).body.code, 'plan-invalid');
  const unknown = await propose('tr', bundle('X', { routines: [{ id: 'r1', name: 'X', ex: [{ id: 'not-an-exercise', sets: 1 }] }] }));
  assert.equal(unknown.status, 422);
  assert.equal(unknown.body.code, 'plan-unsupported');
  const big = bundle('Big', { routines: Array.from({ length: 40 }, (_, i) => ({ id: 'r' + i, name: 'R', ex: [{ id: '0025', sets: 1, reps: 1 }] })) });
  assert.equal((await propose('tr', big)).body.code, 'plan-too-large');
});

test('a stored version is immutable', async t => {
  const { h, propose } = await world(t);
  const { proposal } = (await propose()).body;
  await assert.rejects(h.pool.query("UPDATE plan_proposal_versions SET bundle = '{}'::jsonb WHERE id = $1", [proposal.id]), /never changed/);
});

test('the recipient sees and declines; nobody else can read or decide', async t => {
  const { as, propose } = await world(t);
  const { proposal } = (await propose()).body;
  const list = await as('mem', 'GET', '/api/platform/proposals');
  assert.deepEqual(list.body.received.map(p => [p.id, p.status]), [[proposal.id, 'pending']]);
  assert.deepEqual((await as('tr', 'GET', '/api/platform/proposals')).body.sent.map(p => p.id), [proposal.id]);
  const read = await as('mem', 'GET', `/api/platform/proposals/${proposal.id}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.bundle.routines[0].ex[0].id, '0025');
  const text = JSON.stringify(read.body);
  for (const leak of ['w-secret', 'bodyweight', '"80"']) assert.ok(!text.includes(leak), leak);
  for (const who of ['mem2', 'tr2', 'own', 'out']) assert.equal((await as(who, 'GET', `/api/platform/proposals/${proposal.id}`)).status, 404, who);
  assert.equal((await as('tr', 'POST', `/api/platform/proposals/${proposal.id}/decline`)).status, 404, 'the trainer does not decide');
  assert.equal((await as('mem2', 'POST', `/api/platform/proposals/${proposal.id}/decline`)).status, 404);
  assert.equal((await as('mem', 'POST', `/api/platform/proposals/${proposal.id}/decline`)).status, 200);
  assert.equal((await as('mem', 'POST', `/api/platform/proposals/${proposal.id}/decline`)).status, 409);
  assert.equal((await as('mem', 'GET', `/api/platform/proposals/${proposal.id}`)).body.status, 'declined');
});

test('a newer version supersedes the pending one', async t => {
  const { as, propose } = await world(t);
  const first = (await propose('tr', bundle('v1'))).body.proposal;
  const second = (await propose('tr', bundle('v2'))).body.proposal;
  const received = (await as('mem', 'GET', '/api/platform/proposals')).body.received;
  assert.deepEqual(Object.fromEntries(received.map(p => [p.id, p.status])), { [first.id]: 'superseded', [second.id]: 'pending' });
});

test('reassignment invalidates what was pending; the new trainer proposes their own', async t => {
  const { h, A, tr2, mem, asg, as, propose } = await world(t);
  const pending = (await propose()).body.proposal;
  await endAssignment(h.pool, { gymId: A.id, assignmentId: asg.id });
  assert.equal((await as('mem', 'GET', `/api/platform/proposals/${pending.id}`)).body.status, 'invalidated');
  assert.equal((await as('mem', 'POST', `/api/platform/proposals/${pending.id}/decline`)).status, 409);
  assert.equal((await propose('tr')).status, 404);
  await assignTrainer(h.pool, { gymId: A.id, memberMembershipId: mem.id, trainerMembershipId: tr2.id });
  assert.equal((await propose('tr2')).status, 200);
});
