/* Accepting a trainer's plan: one transaction that rechecks the membership and assignment, checks
   the member's revision, adds the plan's routines with stable ids, changes only the weekdays the
   member confirmed, stores the document and records the acceptance — or does none of it. A retry
   gets the original mapping and the latest document; history and unrelated routines never move. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootProduct } from '../storage/product-server.mjs';
import { createGym } from '../../platform/organisations.js';
import { addMembership, endMembership } from '../../platform/memberships.js';
import { assignTrainer } from '../../platform/assignments.js';

let ipN = 0;
const ip = () => `198.22.0.${++ipN}`;
const plan = (name, ex = [{ id: '0025', sets: 3, reps: 5, weight: 60 }], week = { 1: ['r1'] }) => ({
  opengym_plan: 1, unit: 'kg', name, week, routines: [{ id: 'r1', name, ex }], customEx: [],
});
const MINE = { id: 'r-mine', name: 'Mine', ex: [{ id: '0043', sets: 5, reps: 5, weight: 100 }] };
const DONE = { id: 'w-done', d: '2026-10-01', entries: [{ id: '0043', sets: [{ w: 100, r: 5, done: true }] }] };
const pick = (o, keys) => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]));

async function world(t) {
  const h = await bootProduct(t);
  const now = new Date().toISOString();
  for (const id of ['own', 'tr', 'mem', 'other']) await h.store.createUser({ id, name: id, created: now });
  const A = await createGym(h.pool, { name: 'A' });
  await addMembership(h.pool, { gymId: A.id, userId: 'own', role: 'owner' });
  const tr = await addMembership(h.pool, { gymId: A.id, userId: 'tr', role: 'trainer' });
  const mem = await addMembership(h.pool, { gymId: A.id, userId: 'mem', role: 'member' });
  await assignTrainer(h.pool, { gymId: A.id, memberMembershipId: mem.id, trainerMembershipId: tr.id });
  const cookie = h.session('mem');
  const seeded = await h.req('PUT', '/api/data', { cookie, body: { stamped: true, state: { unit: 'kg', routines: [MINE], week: { 0: ['r-mine'], 1: ['r-mine'] }, workouts: [DONE] } } });
  const as = (who, method, url, body) => h.req(method, url, { cookie: h.session(who), body: method === 'GET' ? undefined : (body ?? {}), ip: ip() });
  const propose = async (b, extra = {}) => (await as('tr', 'POST', `/api/platform/clients/${mem.id}/proposals`, { bundle: b, ...extra })).body.proposal;
  const state = async () => (await h.req('GET', '/api/data', { cookie })).body;
  const accept = (id, body) => as('mem', 'POST', `/api/platform/proposals/${id}/accept`, body);
  return { h, A, mem, cookie, as, propose, state, accept, rev: seeded.body.rev, wid: seeded.body.wid };
}

test('accepting adds the plan’s routines with stable ids and changes only the confirmed weekdays', async t => {
  const { h, propose, state, accept, rev, wid } = await world(t);
  const p = await propose(plan('Push', undefined, { 1: ['r1'], 3: ['r1'] }));
  const r = await accept(p.id, { baseRev: rev, baseWid: wid, days: [1, 3] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const newId = r.body.routineMap.r1;
  assert.match(newId, /^gp_[0-9a-f]{24}$/);
  const s = (await state()).state;
  assert.deepEqual(s.routines.map(x => x.id), ['r-mine', newId]);
  assert.deepEqual(s.routines[0], { ...MINE, ...pick(s.routines[0], ['_ts', '_f']) }, 'the member’s own routine is untouched');
  assert.deepEqual(s.workouts.map(w => w.id), ['w-done'], 'history untouched');
  assert.deepEqual(s.week[0], ['r-mine'], 'an unconfirmed, unrelated day keeps its plan');
  assert.deepEqual(s.week[1], ['r-mine', newId]);
  assert.deepEqual(s.week[3], [newId]);
  assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM plan_acceptances')).rows[0].n, 1);
  assert.equal((await h.pool.query('SELECT status FROM plan_proposal_versions WHERE id = $1', [p.id])).rows[0].status, 'accepted');
});

test('a weekday the plan would change needs the member’s confirmation', async t => {
  const { propose, state, accept, rev, wid } = await world(t);
  const p = await propose(plan('Push'));
  const r = await accept(p.id, { baseRev: rev, baseWid: wid, days: [] });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'confirm-schedule');
  assert.deepEqual(r.body.days, [1]);
  assert.equal((await state()).rev, rev, 'nothing stored');
  const skip = await accept(p.id, { baseRev: rev, baseWid: wid, skipSchedule: true });
  assert.equal(skip.status, 200);
  assert.deepEqual((await state()).state.week[1], ['r-mine']);
});

test('a stale revision is a conflict carrying the current document, and nothing is accepted', async t => {
  const { h, cookie, propose, accept, rev, wid } = await world(t);
  const p = await propose(plan('Push'));
  const edit = await h.req('PUT', '/api/data', { cookie, body: { stamped: true, baseRev: rev, baseWid: wid, state: { unit: 'kg', routines: [MINE], week: { 0: ['r-mine'], 1: ['r-mine'] }, workouts: [DONE], note: 'changed' } } });
  const r = await accept(p.id, { baseRev: rev, baseWid: wid, days: [1] });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'conflict');
  assert.equal(r.body.rev, edit.body.rev);
  assert.equal(r.body.state.note, 'changed');
  assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM plan_acceptances')).rows[0].n, 0);
  assert.equal((await accept(p.id, { baseRev: edit.body.rev, baseWid: edit.body.wid, days: [1] })).status, 200);
});

test('two acceptances at once, then a retry: one acceptance, one set of routines, the latest document', async t => {
  const { h, cookie, propose, state, accept, rev, wid } = await world(t);
  const p = await propose(plan('Push'));
  const [a, b] = await Promise.all([accept(p.id, { baseRev: rev, baseWid: wid, days: [1] }), accept(p.id, { baseRev: rev, baseWid: wid, days: [1] })]);
  assert.ok([a.status, b.status].includes(200));
  assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM plan_acceptances')).rows[0].n, 1);
  const after = await state();
  assert.equal(after.state.routines.length, 2);
  // the response was lost; the member changes something else, then retries
  const later = await h.req('PUT', '/api/data', { cookie, body: { stamped: true, baseRev: after.rev, state: { ...after.state, note: 'later' } } });
  const retry = await accept(p.id, { baseRev: rev, baseWid: wid, days: [1] });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.alreadyAccepted, true);
  assert.deepEqual(retry.body.routineMap, (a.status === 200 && !a.body.alreadyAccepted ? a : b).body.routineMap);
  assert.equal(retry.body.rev, later.body.rev, 'never a stale stored snapshot');
  assert.equal(retry.body.state.note, 'later');
  assert.equal((await state()).state.routines.length, 2);
});

test('a membership ended before acceptance blocks it; an earlier acceptance stands', async t => {
  const { h, A, mem, propose, accept, rev, wid } = await world(t);
  const first = await propose(plan('One'));
  const done = await accept(first.id, { baseRev: rev, baseWid: wid, days: [1] });
  assert.equal(done.status, 200);
  const second = await propose(plan('Two', undefined, {}));
  await endMembership(h.pool, { gymId: A.id, membershipId: mem.id });
  const r = await accept(second.id, { baseRev: done.body.rev, baseWid: done.body.wid });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'not-pending');
  assert.equal((await h.pool.query('SELECT status FROM plan_proposal_versions WHERE id = $1', [first.id])).rows[0].status, 'accepted');
});

test('only the recipient accepts, and only a pending version', async t => {
  const { as, propose, accept, rev, wid } = await world(t);
  const p = await propose(plan('Push'));
  assert.equal((await as('other', 'POST', `/api/platform/proposals/${p.id}/accept`, { baseRev: rev })).status, 404);
  assert.equal((await as('tr', 'POST', `/api/platform/proposals/${p.id}/accept`, { baseRev: rev })).status, 404);
  assert.equal((await as('mem', 'POST', `/api/platform/proposals/${p.id}/decline`)).status, 200);
  assert.equal((await accept(p.id, { baseRev: rev, baseWid: wid })).status, 409);
});

test('an update replaces only the routines the previous plan added, after the member saw them as they are', async t => {
  const { h, cookie, as, propose, state, accept, rev, wid } = await world(t);
  const v1 = await propose(plan('V1', undefined, {}));
  const a1 = await accept(v1.id, { baseRev: rev, baseWid: wid });
  const oldId = a1.body.routineMap.r1;
  const v2 = await propose(plan('V2', [{ id: '0025', sets: 5, reps: 3, weight: 70 }], {}), { previousVersionId: v1.id });
  const preview = (await as('mem', 'GET', `/api/platform/proposals/${v2.id}`)).body;
  assert.deepEqual(preview.replaces.routineIds, [oldId]);
  // the member edits the routine the update would replace, after seeing the preview
  const s = await state();
  const edited = s.state.routines.map(r => (r.id === oldId ? { ...r, name: 'My tweak' } : r));
  const put = await h.req('PUT', '/api/data', { cookie, body: { stamped: true, baseRev: s.rev, state: { ...s.state, routines: edited } } });
  const stale = await accept(v2.id, { baseRev: put.body.rev, baseWid: put.body.wid, replacedFingerprint: preview.replaces.fingerprint });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'preview-changed');
  const fresh = (await as('mem', 'GET', `/api/platform/proposals/${v2.id}`)).body.replaces.fingerprint;
  const ok = await accept(v2.id, { baseRev: put.body.rev, baseWid: put.body.wid, replacedFingerprint: fresh });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const final = (await state()).state;
  assert.deepEqual(final.routines.map(r => r.id), ['r-mine', ok.body.routineMap.r1]);
  assert.equal(final.routines[1].ex[0].weight, 70);
  assert.deepEqual(final.workouts.map(w => w.id), ['w-done']);
});
