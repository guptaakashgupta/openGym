/* PUT /api/data's write rules as a pure function: what a store persists and what the client is told,
   independent of where the document lives. The HTTP suites (server-data-*.test.js) still cover the
   route; these pin the rules each storage adapter runs inside its own transaction. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareWrite, validateWrite, forClient } from '../../state/prepare-write.js';

const NOW = 1_800_000_000_000;
let n = 0;
const deps = () => { n = 0; return { nextWriteId: () => 'w' + (++n), now: () => NOW }; };
const clone = x => structuredClone(x);
const stored = (extra = {}) => ({ _rev: 4, _wid: 'w-old', _wids: ['w-older'], _ts: 10, workouts: [{ id: 'k', d: '2026-10-01' }], routines: [], ...extra });

test('an accepted write is stamped with the next revision, a fresh write id and the ancestry', () => {
  const r = prepareWrite(stored(), { state: { _ts: 11, workouts: [], routines: [] }, baseRev: 4, baseWid: 'w-old', stamped: true }, deps());
  assert.equal(r.status, 200);
  assert.equal(r.state._rev, 5);
  assert.equal(r.state._wid, 'w1');
  assert.deepEqual(r.state._wids, ['w-older', 'w-old']);
  assert.deepEqual(r.body, { ok: true, ts: 11, rev: 5, wid: 'w1' });
  assert.deepEqual(JSON.parse(r.text), r.state);
});

test('the device-local active workout is never stored', () => {
  const r = prepareWrite(null, { state: { workouts: [], active: { id: 'live' } } }, deps());
  assert.equal(r.status, 200);
  assert.equal('active' in r.state, false);
});

test('unknown fields are kept', () => {
  const r = prepareWrite(null, { state: { workouts: [], futureField: { x: 1 } } }, deps());
  assert.deepEqual(r.state.futureField, { x: 1 });
});

test('a stored reset marker newer than the write is kept', () => {
  const r = prepareWrite(stored({ resetAt: 50, resetIds: { w: ['a'] } }), { state: { workouts: [], resetAt: 20 }, stamped: true }, deps());
  assert.equal(r.state.resetAt, 50);
  assert.deepEqual(r.state.resetIds, { w: ['a'] });
});

test('a stale revision is a 409 carrying the current document, without server notes', () => {
  const cur = stored({ _unstamped: { fp: 'x' }, _prior: { a: 1 } });
  const r = prepareWrite(cur, { state: { workouts: [] }, baseRev: 3 }, deps());
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: 'conflict', rev: 4, state: forClient(cur) });
  assert.equal('_unstamped' in r.body.state, false);
  assert.equal(r.state, undefined);
});

test('a string baseRev is not the numeric revision', () => {
  const r = prepareWrite(stored(), { state: { workouts: [] }, baseRev: '4' }, deps());
  assert.equal(r.status, 409);
});

test('the right revision with an unrelated write id is a 409', () => {
  const r = prepareWrite(stored(), { state: { workouts: [] }, baseRev: 4, baseWid: 'someone-else' }, deps());
  assert.equal(r.status, 409);
});

test('a legacy write without a revision overwrites', () => {
  const r = prepareWrite(stored(), { state: { workouts: [] }, stamped: true }, deps());
  assert.equal(r.status, 200);
  assert.equal(r.state._rev, 5);
  assert.deepEqual(r.state.workouts, []);
});

test('the first write to an absent document is revision 1 with no ancestry', () => {
  const r = prepareWrite(null, { state: { workouts: [] } }, deps());
  assert.equal(r.state._rev, 1);
  assert.deepEqual(r.state._wids, []);
});

test('a document the server corrected for an older app is stored one revision further than it is told', () => {
  const pyr = { id: 'r1', name: 'P', ex: [{ id: 'sq', sets: 4, pyramid: [12, 10, 8, 6] }], _ts: 5 };
  const first = prepareWrite(null, { state: { _ts: 1, workouts: [], routines: [pyr] }, stamped: true }, deps());
  const old = { _ts: 2, workouts: [], routines: [{ id: 'r1', name: 'P', ex: [{ id: 'sq', sets: 4 }], _ts: 6 }] };
  const r = prepareWrite(clone(first.state), { state: old, baseRev: 1 }, deps());
  assert.equal(r.status, 200);
  assert.equal(r.body.rev, 2);
  assert.equal(r.state._rev, 3);
  assert.deepEqual(r.state.routines[0].ex[0].pyramid, [12, 10, 8, 6]);
});

test('malformed states are refused and nothing is prepared to replace stored workouts', () => {
  for (const state of [undefined, 'x', [], {}, { _rev: 5 }, { workouts: 'no' }, { routines: {} }]) {
    const r = prepareWrite(stored(), { state }, deps());
    assert.equal(r.status, 400, JSON.stringify(state));
    assert.equal(r.state, undefined);
  }
});

test('non-record entries are dropped from workouts and routines', () => {
  const r = prepareWrite(null, { state: { workouts: [null, 3, { id: 'a' }], routines: [[], { id: 'r' }] } }, deps());
  assert.deepEqual(r.state.workouts, [{ id: 'a' }]);
  assert.deepEqual(r.state.routines, [{ id: 'r' }]);
});

test('a state nested too deep to serialise is a 400, not a throw', () => {
  let deep = {};
  const root = { workouts: [], deep };
  for (let i = 0; i < 20000; i++) { deep.x = {}; deep = deep.x; }
  const r = prepareWrite(null, { state: root, stamped: true }, deps());
  assert.equal(r.status, 400);
});

test('validateWrite answers the request alone, before any document is read', () => {
  assert.deepEqual(validateWrite({ state: [] }), { status: 400, body: { error: 'invalid state' } });
  assert.deepEqual(validateWrite({}), { status: 400, body: { error: 'state required' } });
  assert.equal(validateWrite({ state: { workouts: [] } }), null);
});
