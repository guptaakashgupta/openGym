/* Member state in PostgreSQL: the same write rules as the file store (state/prepare-write.js), run
   inside one transaction per write against a real database, so concurrent writers and first writes
   serialise and nothing is acknowledged before it commits. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testSchema, testDatabaseUrl } from './helpers.mjs';
import { createPool } from '../../storage/postgres.js';
import { postgresStateStore, StateUnsupportedError, UnknownMemberError } from '../../storage/state-postgres.js';
import { prepareWrite } from '../../state/prepare-write.js';

let wid = 0;
const put = (s, uid, body) => s.updateMemberState(uid, cur => prepareWrite(cur, structuredClone(body), { nextWriteId: () => 'w' + (++wid) }));

async function setup(t) {
  const { pool, schema } = await testSchema(t, { migrated: true });
  await pool.query("INSERT INTO users (id) VALUES ('u1'), ('u2')");
  return { pool, schema, s: postgresStateStore(pool) };
}

test('an absent profile reads as null with revision 0', async t => {
  const { s } = await setup(t);
  assert.equal(await s.readMemberState('u1'), null);
  assert.deepEqual(await s.readMemberRevision('u1'), { rev: 0 });
});

test('a write is stored as JSONB with the SQL revision equal to the document revision', async t => {
  const { s, pool } = await setup(t);
  const r = await put(s, 'u1', { state: { z: 1, a: 2, workouts: [{ id: 'k', d: '2026-10-01' }] }, stamped: true });
  assert.equal(r.status, 200);
  const doc = await s.readMemberState('u1');
  assert.deepEqual(doc, r.state);                       // parsed structure, not bytes: JSONB reorders keys
  const { rows } = await pool.query("SELECT revision, write_id FROM member_states WHERE user_id = 'u1'");
  assert.equal(Number(rows[0].revision), doc._rev);
  assert.equal(rows[0].write_id, doc._wid);
  assert.deepEqual(await s.readMemberRevision('u1'), { rev: doc._rev, wid: doc._wid });
});

test('two writers at the same revision: exactly one wins, the other gets the current state in a 409', async t => {
  const { s } = await setup(t);
  await put(s, 'u1', { state: { workouts: [] }, stamped: true });
  const [a, b] = await Promise.all([
    put(s, 'u1', { state: { workouts: [{ id: 'a' }] }, baseRev: 1, stamped: true }),
    put(s, 'u1', { state: { workouts: [{ id: 'b' }] }, baseRev: 1, stamped: true }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const lost = a.status === 409 ? a : b, won = a.status === 409 ? b : a;
  assert.equal(lost.body.rev, 2);
  assert.deepEqual(lost.body.state.workouts, won.state.workouts);
  assert.equal((await s.readMemberState('u1'))._rev, 2);
});

test('two first writes to an absent document serialise on the user row', async t => {
  const { s } = await setup(t);
  const [a, b] = await Promise.all([
    put(s, 'u1', { state: { workouts: [{ id: 'a' }] }, baseRev: 0, stamped: true }),
    put(s, 'u1', { state: { workouts: [{ id: 'b' }] }, baseRev: 0, stamped: true }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal((await s.readMemberState('u1'))._rev, 1);
});

test('state survives a new pool (a restarted process)', async t => {
  const { s, schema } = await setup(t);
  await put(s, 'u1', { state: { workouts: [{ id: 'kept' }] }, stamped: true });
  const fresh = createPool(testDatabaseUrl(), { searchPath: schema });
  t.after(() => fresh.end());
  const doc = await postgresStateStore(fresh).readMemberState('u1');
  assert.deepEqual(doc.workouts, [{ id: 'kept' }]);
});

test('a restored older document refuses a client that quotes a write id it does not hold', async t => {
  const { s, pool } = await setup(t);
  await put(s, 'u1', { state: { workouts: [] }, stamped: true });
  const before = await s.readMemberState('u1');
  await put(s, 'u1', { state: { workouts: [{ id: 'later' }] }, baseRev: 1, stamped: true });
  const later = await s.readMemberState('u1');
  // a backup restore puts revision 1 back; the client still holds what it saw at revision 2
  await pool.query("UPDATE member_states SET document = $1::jsonb, revision = 1, write_id = $2 WHERE user_id = 'u1'", [JSON.stringify(before), before._wid]);
  const r = await put(s, 'u1', { state: { workouts: [] }, baseRev: 1, baseWid: later._wid, stamped: true });
  assert.equal(r.status, 409);
});

test('a document the server corrected for an older app is stored one revision further', async t => {
  const { s, pool } = await setup(t);
  const pyr = { id: 'r1', name: 'P', ex: [{ id: 'sq', sets: 4, pyramid: [12, 10, 8, 6] }], _ts: 5 };
  await put(s, 'u1', { state: { _ts: 1, workouts: [], routines: [pyr] }, stamped: true });
  const r = await put(s, 'u1', { state: { _ts: 2, workouts: [], routines: [{ id: 'r1', name: 'P', ex: [{ id: 'sq', sets: 4 }], _ts: 6 }] }, baseRev: 1 });
  assert.equal(r.body.rev, 2);
  const { rows } = await pool.query("SELECT revision FROM member_states WHERE user_id = 'u1'");
  assert.equal(Number(rows[0].revision), 3);
  assert.deepEqual(await s.readMemberRevision('u1'), { rev: 3, wid: r.state._wid });
});

test('text JSONB cannot hold (an embedded NUL) is refused and the stored document is untouched', async t => {
  const { s } = await setup(t);
  await put(s, 'u1', { state: { workouts: [{ id: 'safe' }] }, stamped: true });
  await assert.rejects(put(s, 'u1', { state: { workouts: [{ id: 'bad', note: 'a\u0000b' }] }, baseRev: 1, stamped: true }), StateUnsupportedError);
  const doc = await s.readMemberState('u1');
  assert.deepEqual(doc.workouts, [{ id: 'safe' }]);
  assert.equal(doc._rev, 1);
});

test('a write for a user the database does not know is refused', async t => {
  const { s } = await setup(t);
  await assert.rejects(put(s, 'ghost', { state: { workouts: [] } }), UnknownMemberError);
});

test('a refusal from the work stores nothing', async t => {
  const { s } = await setup(t);
  const r = await put(s, 'u1', { state: [] });
  assert.equal(r.status, 400);
  assert.equal(await s.readMemberState('u1'), null);
});

test('a work that throws rolls back and releases the row', async t => {
  const { s } = await setup(t);
  await assert.rejects(s.updateMemberState('u1', () => { throw new Error('boom'); }), /boom/);
  const r = await put(s, 'u1', { state: { workouts: [] } });
  assert.equal(r.status, 200);
});

test('profiles are independent', async t => {
  const { s } = await setup(t);
  await put(s, 'u1', { state: { workouts: [{ id: 'one' }] } });
  assert.equal(await s.readMemberState('u2'), null);
});
