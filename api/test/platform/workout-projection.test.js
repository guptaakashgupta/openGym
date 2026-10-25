/* What an assigned trainer reads of a member: only workouts the gym may see (workout_visibility,
   under the member's current membership), only the allowlisted fields, and progress computed from
   those workouts alone. Private measurements, photos, settings, notes and lifetime records never
   appear, and a revoked assignment ends access on the very next request. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootProduct } from '../storage/product-server.mjs';
import { createGym } from '../../platform/organisations.js';
import { addMembership, endMembership } from '../../platform/memberships.js';
import { assignTrainer, endAssignment } from '../../platform/assignments.js';

const today = new Date().toISOString().slice(0, 10);
const SECRET_NOTE = 'private-note-xyz';

async function world(t) {
  const h = await bootProduct(t);
  const now = new Date().toISOString();
  for (const id of ['own', 'tr', 'tr2', 'mem']) await h.store.createUser({ id, name: id, created: now });
  const A = await createGym(h.pool, { name: 'A' });
  await addMembership(h.pool, { gymId: A.id, userId: 'own', role: 'owner' });
  const tr = await addMembership(h.pool, { gymId: A.id, userId: 'tr', role: 'trainer' });
  const tr2 = await addMembership(h.pool, { gymId: A.id, userId: 'tr2', role: 'trainer' });
  const cookie = h.session('mem');
  // History from before the gym, full of private things.
  const before = await h.req('PUT', '/api/data', { cookie, body: { stamped: true, state: {
    unit: 'kg', lang: 'en', reminder: { on: true, tz: 'UTC', time: '07:00' },
    bodyweight: [{ d: '2026-01-01', w: 82.4 }], measurements: [{ d: '2026-01-01', waist: 88 }],
    customEx: [{ id: 'c-secret-move', name: 'My secret move', custom: true }],
    workouts: [{ id: 'w-history', d: '2026-01-02', name: 'Old', entries: [{ id: 'bench', sets: [{ w: 200, r: 1, done: true }] }], prs: [{ id: 'bench', w: 200 }] }],
  } } });
  const m = await addMembership(h.pool, { gymId: A.id, userId: 'mem', role: 'member' });
  const recorded = {
    id: 'w-gym', d: today, start: 1, end: 2, name: 'Legs with my ex', bw: 82, note: SECRET_NOTE,
    prs: [{ id: 'squat', w: 120 }],
    media: [{ hash: 'a'.repeat(64) }],
    entries: [
      { id: 'squat', topW: 120, target: { w: 125 }, note: SECRET_NOTE, muscleSnapshot: { quads: 1 }, planned: { sets: 5 },
        sets: [{ w: 100, r: 5, done: true, at: 5, rpe: 8 }, { w: 120, r: 3, done: true }, { w: 130, r: 1, done: false }] },
      { id: 'c-secret-move', sets: [{ min: 1, sec: 30, done: true }] },
      { id: 'plank-side', sets: [{ sides: { L: { sec: 30 }, R: { sec: 25 } }, done: true }] },
    ],
  };
  const r = await h.req('PUT', '/api/data', { cookie, body: { stamped: true, baseRev: before.body.rev, state: {
    unit: 'kg', bodyweight: [{ d: '2026-01-01', w: 82.4 }], measurements: [{ d: '2026-01-01', waist: 88 }],
    customEx: [{ id: 'c-secret-move', name: 'My secret move', custom: true }],
    workouts: [{ id: 'w-history', d: '2026-01-02', entries: [{ id: 'bench', sets: [{ w: 200, r: 1, done: true }] }] }, recorded],
  }, platformRecordings: [{ eventId: 'e1', workoutId: 'w-gym', membershipId: m.id }] } });
  assert.deepEqual(r.body.platformRecordings, [{ eventId: 'e1', result: 'granted' }]);
  const assignment = await assignTrainer(h.pool, { gymId: A.id, memberMembershipId: m.id, trainerMembershipId: tr.id });
  const read = who => h.req('GET', `/api/platform/clients/${m.id}/workouts`, { cookie: h.session(who) });
  return { h, A, m, tr, tr2, assignment, read, cookie, rev: r.body.rev };
}

test('the assigned trainer gets the gym workout with allowlisted fields only', async t => {
  const { read } = await world(t);
  const r = await read('tr');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.unit, 'kg');
  assert.deepEqual(r.body.workouts, [{
    id: 'w-gym', date: today,
    exercises: [
      { exerciseId: 'squat', custom: false, sets: [{ reps: 5, load: 100, done: true }, { reps: 3, load: 120, done: true }, { reps: 1, load: 130, done: false }] },
      { exerciseId: null, custom: true, sets: [{ seconds: 90, done: true }] },
      { exerciseId: 'plank-side', custom: false, sets: [{ done: true, sides: { L: { seconds: 30 }, R: { seconds: 25 } } }] },
    ],
  }]);
  const text = JSON.stringify(r.body);
  for (const leak of [SECRET_NOTE, 'w-history', '82.4', 'waist', 'secret move', 'c-secret-move', 'My secret', 'Legs with', 'reminder', 'muscleSnapshot', 'prs', 'media', 'a'.repeat(64), 'target', 'rpe', '200'])
    assert.ok(!text.includes(leak), `trainer JSON must not contain ${leak}`);
});

test('progress comes from the visible workouts only', async t => {
  const { read } = await world(t);
  const { progress } = (await read('tr')).body;
  assert.deepEqual(progress, [{ exerciseId: 'squat', sessions: 1, bestLoad: 120, lastDate: today }]);
});

test('another trainer, the owner and an ended assignment all get 404, on the next request', async t => {
  const { h, A, assignment, read } = await world(t);
  assert.equal((await read('tr2')).status, 404);
  assert.equal((await read('own')).status, 404, 'owning the gym is not coaching the member');
  assert.equal((await read('mem')).status, 404);
  assert.equal((await read('tr')).status, 200);
  await endAssignment(h.pool, { gymId: A.id, assignmentId: assignment.id });
  assert.equal((await read('tr')).status, 404, 'same session, next request');
});

test('a deleted workout stops appearing, visibility record or not', async t => {
  const { h, read, cookie, rev } = await world(t);
  const r = await h.req('PUT', '/api/data', { cookie, body: { stamped: true, baseRev: rev, state: { unit: 'kg', workouts: [] } } });
  assert.equal(r.status, 200);
  assert.deepEqual((await read('tr')).body.workouts, []);
});

test('after leaving and joining another gym, the new gym sees nothing of the old membership', async t => {
  const { h, A, m, read } = await world(t);
  await endMembership(h.pool, { gymId: A.id, membershipId: m.id });
  assert.equal((await read('tr')).status, 404);
  const B = await createGym(h.pool, { name: 'B' });
  await h.store.createUser({ id: 'trB', name: 'trB', created: new Date().toISOString() });
  const trB = await addMembership(h.pool, { gymId: B.id, userId: 'trB', role: 'trainer' });
  const mB = await addMembership(h.pool, { gymId: B.id, userId: 'mem', role: 'member' });
  await assignTrainer(h.pool, { gymId: B.id, memberMembershipId: mB.id, trainerMembershipId: trB.id });
  const r = await h.req('GET', `/api/platform/clients/${mB.id}/workouts`, { cookie: h.session('trB') });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.workouts, []);
});
