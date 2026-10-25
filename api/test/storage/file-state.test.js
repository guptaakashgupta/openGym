/* The file adapter behind the async member-state interface: the self-hosted default. Same files,
   same durable writes and stat cache as before; reads tell missing from unreadable, and an update
   is a compare-and-write serialised per user. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileStateStore, StateUnreadableError } from '../../storage/state-file.js';

function store(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-fstate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, s: fileStateStore(dir) };
}
const write = doc => ({ status: 200, state: doc, text: JSON.stringify(doc), body: { rev: doc._rev } });

test('a profile with no file reads as null with revision 0', async t => {
  const { s } = store(t);
  assert.equal(await s.readMemberState('u1'), null);
  assert.deepEqual(await s.readMemberRevision('u1'), { rev: 0 });
});

test('an unreadable state file is an error, never an empty profile', async t => {
  const { dir, s } = store(t);
  fs.writeFileSync(path.join(dir, 'state-u1.json'), '{not json');
  await assert.rejects(s.readMemberState('u1'), StateUnreadableError);
  await assert.rejects(s.updateMemberState('u1', () => write({ _rev: 1 })), StateUnreadableError);
  assert.equal(fs.readFileSync(path.join(dir, 'state-u1.json'), 'utf8'), '{not json');
});

test('an update persists what the work returns, durably, and reads it back', async t => {
  const { dir, s } = store(t);
  const r = await s.updateMemberState('u1', cur => { assert.equal(cur, null); return write({ _rev: 1, _wid: 'a', workouts: [] }); });
  assert.deepEqual(r.body, { rev: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state-u1.json'), 'utf8')), { _rev: 1, _wid: 'a', workouts: [] });
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), []);
  assert.deepEqual(await s.readMemberState('u1'), { _rev: 1, _wid: 'a', workouts: [] });
  assert.deepEqual(await s.readMemberRevision('u1'), { rev: 1, wid: 'a' });
});

test('a refusal from the work writes nothing', async t => {
  const { dir, s } = store(t);
  const r = await s.updateMemberState('u1', () => ({ status: 409, body: { error: 'conflict' } }));
  assert.equal(r.status, 409);
  assert.equal(fs.existsSync(path.join(dir, 'state-u1.json')), false);
});

test('the revision is fresh after a same-size write in the same mtime tick', async t => {
  const { dir, s } = store(t);
  const file = path.join(dir, 'state-u1.json');
  await s.updateMemberState('u1', () => write({ _rev: 7, _wid: 'aaaa' }));
  assert.deepEqual(await s.readMemberRevision('u1'), { rev: 7, wid: 'aaaa' });   // now cached
  const { mtime } = fs.statSync(file);
  await s.updateMemberState('u1', () => write({ _rev: 8, _wid: 'bbbb' }));
  fs.utimesSync(file, mtime, mtime);              // same size, same mtime: the stat key cannot tell
  assert.deepEqual(await s.readMemberRevision('u1'), { rev: 8, wid: 'bbbb' });
});

test('concurrent updates of one user are serialised: each work sees the previous result', async t => {
  const { s } = store(t);
  const cas = base => async cur => {
    await new Promise(r => setTimeout(r, 5));
    const rev = cur?._rev || 0;
    return rev !== base ? { status: 409, body: { rev } } : write({ _rev: rev + 1 });
  };
  const results = await Promise.all([s.updateMemberState('u1', cas(0)), s.updateMemberState('u1', cas(0))]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await s.readMemberState('u1'))._rev, 1);
});

test('a work that throws releases the lock for the next update', async t => {
  const { s } = store(t);
  await assert.rejects(s.updateMemberState('u1', () => { throw new Error('boom'); }), /boom/);
  const r = await s.updateMemberState('u1', () => write({ _rev: 1 }));
  assert.equal(r.status, 200);
});

test('user ids are confined to the data directory', async t => {
  const { dir, s } = store(t);
  await s.updateMemberState('../../etc/x', () => write({ _rev: 1 }));
  assert.ok(fs.existsSync(path.join(dir, 'state-etcx.json')));
});
