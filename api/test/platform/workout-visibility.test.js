/* Which workouts a gym may ever see: only a new recording the member's own device reports with the
   membership it started under, decided in the same transaction as the state write. History from
   before joining, imports, restores, edits of old workouts, departed memberships, other people's
   memberships and anything without an event stay private, and a private id is never reclassified. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootProduct } from '../storage/product-server.mjs';
import { createGym } from '../../platform/organisations.js';
import { addMembership, endMembership } from '../../platform/memberships.js';

const today = new Date().toISOString().slice(0, 10);
const wk = (id, d = today, extra = {}) => ({ id, d, entries: [{ id: 'squat', sets: [{ w: 100, r: 5, done: true }] }], ...extra });

async function world(t) {
  const h = await bootProduct(t);
  const now = new Date().toISOString();
  for (const id of ['own', 'tr', 'mem', 'other']) await h.store.createUser({ id, name: id, created: now });
  const A = await createGym(h.pool, { name: 'A' });
  const B = await createGym(h.pool, { name: 'B' });
  await addMembership(h.pool, { gymId: A.id, userId: 'own', role: 'owner' });
  const otherM = await addMembership(h.pool, { gymId: B.id, userId: 'other', role: 'member' });
  const cookie = h.session('mem');
  let rev = 0;
  const put = async (workouts, platformRecordings, extra = {}) => {
    const r = await h.req('PUT', '/api/data', { cookie, body: { state: { workouts, ...extra }, baseRev: rev, stamped: true, ...(platformRecordings ? { platformRecordings } : {}) } });
    if (r.status === 200) rev = r.body.rev;
    return r;
  };
  const visible = async () => (await h.pool.query("SELECT workout_id FROM workout_visibility WHERE user_id = 'mem' ORDER BY workout_id")).rows.map(r => r.workout_id);
  const join = () => addMembership(h.pool, { gymId: A.id, userId: 'mem', role: 'member' });
  return { h, A, B, otherM, put, visible, join, setRev: v => { rev = v; } };
}
const ev = (eventId, workoutId, membershipId) => ({ eventId, workoutId, membershipId });

test('a new recording reported with its membership becomes visible to the gym', async t => {
  const { put, visible, join } = await world(t);
  const m = await join();
  const r = await put([wk('w-new')], [ev('e1', 'w-new', m.id)]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.platformRecordings, [{ eventId: 'e1', result: 'granted' }]);
  assert.deepEqual(await visible(), ['w-new']);
});

test('60 offline recordings in one sync all become visible to the gym', async t => {
  const { put, visible, join } = await world(t);
  const m = await join();
  const workouts = Array.from({ length: 60 }, (_, i) => wk('w' + String(i).padStart(2, '0')));
  const events = workouts.map((w, i) => ev('e' + i, w.id, m.id));
  const r = await put(workouts, events);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.platformRecordings.length, 60);
  assert.ok(r.body.platformRecordings.every(x => x.result === 'granted'));
  assert.deepEqual(await visible(), workouts.map(w => w.id));
});

test('workouts from before joining stay private, even with an event naming the membership', async t => {
  const { put, visible, join } = await world(t);
  await put([wk('w-old', '2026-01-01')]);
  const m = await join();
  const r = await put([wk('w-old', '2026-01-01')], [ev('e1', 'w-old', m.id)]);
  assert.deepEqual(r.body.platformRecordings, [{ eventId: 'e1', result: 'private' }]);
  assert.deepEqual(await visible(), []);
});

test('joining snapshots the history already stored, even history never re-sent since', async t => {
  const { h, put, visible, join, setRev } = await world(t);
  await h.pool.query(`INSERT INTO member_states (user_id, document, revision) VALUES ('mem', $1::jsonb, 1)`, [JSON.stringify({ _rev: 1, workouts: [wk('w-imported')] })]);
  setRev(1);
  const m = await join();
  const r = await put([wk('w-imported')], [ev('e1', 'w-imported', m.id)], {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.platformRecordings, [{ eventId: 'e1', result: 'private' }]);
  assert.deepEqual(await visible(), []);
});

test('an import with today’s date and no event, and a sync without events, stay private', async t => {
  const { put, visible, join } = await world(t);
  await join();
  await put([wk('w-imported-today')]);
  assert.deepEqual(await visible(), []);
});

test('editing an old workout, or restoring a backup over the profile, cannot make it visible', async t => {
  const { put, visible, join } = await world(t);
  const m = await join();
  await put([wk('w-private', '2026-02-01')]);
  const edited = await put([wk('w-private', today)], [ev('e1', 'w-private', m.id)]);
  assert.deepEqual(edited.body.platformRecordings, [{ eventId: 'e1', result: 'private' }]);
  await put([], undefined, { resetAt: Date.now() });
  const restored = await put([wk('w-private', today)], [ev('e2', 'w-private', m.id)]);
  assert.deepEqual(restored.body.platformRecordings, [{ eventId: 'e2', result: 'private' }]);
  assert.deepEqual(await visible(), []);
});

test('a workout recorded under a membership that has since ended syncs, but stays private', async t => {
  const { h, A, put, visible, join } = await world(t);
  const m = await join();
  await endMembership(h.pool, { gymId: A.id, membershipId: m.id });
  const r = await put([wk('w-offline')], [ev('e1', 'w-offline', m.id)]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.platformRecordings, [{ eventId: 'e1', result: 'denied' }]);
  assert.deepEqual(await visible(), []);
  assert.deepEqual((await h.req('GET', '/api/data', { cookie: h.session('mem') })).body.state.workouts.map(w => w.id), ['w-offline']);
});

test('a membership id that is not the member’s own grants nothing', async t => {
  const { otherM, put, visible, join } = await world(t);
  await join();
  const r = await put([wk('w-forged')], [ev('e1', 'w-forged', otherM.id), ev('e2', 'w-forged', 'm_made_up')]);
  assert.deepEqual(r.body.platformRecordings.map(x => x.result), ['denied', 'denied']);
  assert.deepEqual(await visible(), []);
});

test('an event for a workout not in the document is deferred, and decided when the workout arrives', async t => {
  const { put, visible, join } = await world(t);
  const m = await join();
  const early = await put([], [ev('e1', 'w-later', m.id)]);
  assert.deepEqual(early.body.platformRecordings, [{ eventId: 'e1', result: 'deferred' }]);
  assert.deepEqual(await visible(), []);
  const later = await put([wk('w-later')], [ev('e1', 'w-later', m.id)]);
  assert.deepEqual(later.body.platformRecordings, [{ eventId: 'e1', result: 'granted' }]);
  assert.deepEqual(await visible(), ['w-later']);
});

test('a retried event gets its stored answer', async t => {
  const { put, join } = await world(t);
  const m = await join();
  await put([wk('w1')], [ev('e1', 'w1', m.id)]);
  const retry = await put([wk('w1')], [ev('e1', 'w1', m.id)]);
  assert.deepEqual(retry.body.platformRecordings, [{ eventId: 'e1', result: 'granted' }]);
});

test('a refused write records nothing', async t => {
  const { put, visible, join, setRev } = await world(t);
  const m = await join();
  await put([wk('w0')]);
  setRev(0);
  const r = await put([wk('w-conflict')], [ev('e1', 'w-conflict', m.id)]);
  assert.equal(r.status, 409);
  assert.deepEqual(await visible(), []);
});

test('malformed recording metadata is refused before anything is written', async t => {
  const { put, join } = await world(t);
  await join();
  assert.equal((await put([wk('w1')], 'nope')).status, 400);
  assert.equal((await put([wk('w1')], [{ eventId: 1 }])).status, 400);
  assert.equal((await put([wk('w1')], Array.from({ length: 201 }, (_, i) => ev('e' + i, 'w1', 'm')))).status, 400);
});
