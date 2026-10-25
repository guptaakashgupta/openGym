/* Private uploads in product mode: the bytes live in an object store under random keys, an
   ownership row maps (user, hash) to its key, and every read is the API checking the caller's own
   row. Knowing a hash grants nothing. The row is final only after the object is stored; whatever
   SQL and the object store could not do together (a failed upload, a crash between the two, a
   deleted account, a swept file) is finished by a resumable cleanup of a queue of keys. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootProduct } from '../storage/product-server.mjs';
import { testSchema } from '../storage/helpers.mjs';
import { postgresIdentityStore } from '../../storage/identity-postgres.js';
import { fsObjects } from '../../storage/objects.js';
import { createProductMedia } from '../../platform/uploads.js';
import { mediaLimits, MediaError } from '../../media.js';
import { projectWorkouts } from '../../platform/workout-projection.js';
import * as M from '../media-samples.mjs';

// Ids long enough that a random key containing one by chance is not a real risk.
const A = 'member-alice', B = 'member-bob';
const quiet = { warn() {}, error() {}, log() {} };
const tmpDir = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-objects-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const listObjects = dir => { try { return fs.readdirSync(dir, { recursive: true }).filter(n => fs.statSync(path.join(dir, n)).isFile()); } catch { return []; } };

async function storeWorld(t, { objects, state = {} } = {}) {
  const { pool } = await testSchema(t, { migrated: true });
  const ids = postgresIdentityStore(pool);
  const now = new Date().toISOString();
  for (const id of [A, B]) await ids.createUser({ id, name: id, created: now });
  const dir = tmpDir(t);
  const objs = objects || fsObjects(path.join(dir, 'objects'));
  const media = createProductMedia({
    pool, objects: objs, tmpDir: path.join(dir, 'tmp'), log: quiet,
    limits: { ...mediaLimits({}), minFreeMB: 0 }, readState: async uid => state[uid] || null,
  });
  return { pool, ids, media, objectsDir: path.join(dir, 'objects') };
}

test('a hash another account uploaded is exactly as missing as one never uploaded', async t => {
  const w = await storeWorld(t);
  const img = M.jpeg(2000), h = M.sha(img);
  assert.equal((await w.media.receive(A, h, M.fakeReq(img))).status, 201);
  assert.ok(await w.media.open(A, h));
  assert.equal(await w.media.open(B, h), null);
  assert.deepEqual((await w.media.missing(B, [h])).missing, [h]);
  // B uploading the same bytes gets its own copy, under its own key.
  assert.equal((await w.media.receive(B, h, M.fakeReq(img))).body.existed, false);
  const { rows } = await w.pool.query('SELECT user_id, object_key FROM media_objects WHERE media_hash = $1 ORDER BY user_id', [h]);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].object_key, rows[1].object_key);
  for (const r of rows) {
    assert.ok(!r.object_key.includes(h) && !r.object_key.includes(r.user_id), 'keys reveal neither hash nor account');
  }
  assert.equal(listObjects(w.objectsDir).length, 2);
});

test('refused MIME types and sizes store nothing', async t => {
  const w = await storeWorld(t);
  const svg = M.svg();
  await assert.rejects(w.media.receive(A, M.sha(svg), M.fakeReq(svg, { declare: 'image/svg+xml' })), e => e instanceof MediaError && e.status === 415);
  const lying = M.html();
  await assert.rejects(w.media.receive(A, M.sha(lying), M.fakeReq(lying, { declare: 'image/jpeg' })), e => e instanceof MediaError && e.status === 415);
  const big = M.jpeg(3 * 1024 * 1024);
  await assert.rejects(w.media.receive(A, M.sha(big), M.fakeReq(big)), e => e instanceof MediaError && e.status === 413);
  const img = M.jpeg(1000);
  await assert.rejects(w.media.receive(A, M.sha(M.png()), M.fakeReq(img)), e => e instanceof MediaError && e.code === 'hash-mismatch');
  assert.equal((await w.pool.query('SELECT count(*)::int AS n FROM media_objects')).rows[0].n, 0);
  assert.equal(listObjects(w.objectsDir).length, 0);
});

test('an upload whose object never stored leaves no reference, and cleanup removes any partial object', async t => {
  const dir = tmpDir(t);
  const real = fsObjects(dir);
  const failing = { ...real, put: async (key, file) => { await real.put(key, file); throw new Error('provider timed out'); } };
  const w = await storeWorld(t, { objects: failing });
  const img = M.jpeg(1500), h = M.sha(img);
  await assert.rejects(w.media.receive(A, h, M.fakeReq(img)), /provider timed out/);
  assert.equal(await w.media.open(A, h), null);
  assert.deepEqual((await w.media.missing(A, [h])).missing, [h]);
  assert.equal((await w.pool.query("SELECT count(*)::int AS n FROM media_objects WHERE status = 'final'")).rows[0].n, 0);
  await w.media.cleanup();
  assert.equal(listObjects(dir).length, 0);
  assert.equal((await w.pool.query('SELECT count(*)::int AS n FROM media_objects')).rows[0].n, 0);
});

test('a crash between storing the object and finalising it is cleaned up once the upload is stale', async t => {
  const w = await storeWorld(t);
  const objectsDir = w.objectsDir;
  const objs = fsObjects(objectsDir);
  const src = path.join(tmpDir(t), 'x');
  fs.writeFileSync(src, M.jpeg(500));
  await objs.put('orphan-key', src);
  await w.pool.query("INSERT INTO media_objects (user_id, media_hash, object_key, ext, mime, size, status, created_at) VALUES ($2, $1, 'orphan-key', 'jpg', 'image/jpeg', 500, 'pending', now() - interval '2 hours')", [M.sha(M.jpeg(500)), A]);
  await w.media.cleanup();
  assert.equal(await objs.exists('orphan-key'), false);
  assert.equal((await w.pool.query('SELECT count(*)::int AS n FROM media_objects')).rows[0].n, 0);
});

test('deleting the account queues every object it owned, and cleanup deletes them', async t => {
  const w = await storeWorld(t);
  for (const img of [M.jpeg(900), M.png(900)]) await w.media.receive(A, M.sha(img), M.fakeReq(img, { declare: img[0] === 0xff ? 'image/jpeg' : 'image/png' }));
  const keep = M.jpeg(901);
  await w.media.receive(B, M.sha(keep), M.fakeReq(keep));
  assert.equal(listObjects(w.objectsDir).length, 3);
  await w.ids.deleteUser(A);
  await w.media.cleanup();
  assert.equal(listObjects(w.objectsDir).length, 1);
  assert.ok(await w.media.open(B, M.sha(keep)));
});

test('an object missing after a restore reads as missing, and the device can upload it again', async t => {
  const w = await storeWorld(t);
  const img = M.jpeg(1200), h = M.sha(img);
  await w.media.receive(A, h, M.fakeReq(img));
  for (const n of listObjects(w.objectsDir)) fs.rmSync(path.join(w.objectsDir, n));
  assert.equal(await w.media.open(A, h), null);
  assert.deepEqual((await w.media.missing(A, [h])).missing, [h]);
  assert.equal((await w.media.receive(A, h, M.fakeReq(img))).status, 201);
  assert.ok(await w.media.open(A, h));
});

test('an unreferenced upload goes after its grace; a referenced one stays', async t => {
  const kept = M.jpeg(700), gone = M.jpeg(701);
  const state = { [A]: { customEx: [{ id: 'c1', media: { hash: M.sha(kept) } }] } };
  const w = await storeWorld(t, { state });
  await w.media.receive(A, M.sha(kept), M.fakeReq(kept));
  await w.media.receive(A, M.sha(gone), M.fakeReq(gone));
  await w.media.noteState(A, state[A]);
  const r = await w.media.sweep(A, { graceMs: 0 });
  assert.equal(r.removed, 1);
  await w.media.cleanup();
  assert.ok(await w.media.open(A, M.sha(kept)));
  assert.equal(await w.media.open(A, M.sha(gone)), null);
  assert.equal(listObjects(w.objectsDir).length, 1);
});

test('a photo referenced by a visible workout never reaches the trainer projection', () => {
  const hash = M.sha(M.jpeg(10));
  const doc = { workouts: [{ id: 'w1', d: '2026-10-01', media: [{ hash, kind: 'image', mime: 'image/jpeg' }], entries: [{ id: 'squat', sets: [{ w: 100, r: 5, done: true }] }] }] };
  const out = JSON.stringify(projectWorkouts(doc, new Set(['w1'])));
  assert.ok(out.includes('w1'));
  assert.ok(!out.includes(hash));
});

test('over HTTP: uploads need the object store, reads are per account, another account gets 404', async t => {
  const objectsDir = tmpDir(t);
  const h = await bootProduct(t, { env: { OBJECT_STORE: 'fs:' + objectsDir, MEDIA_MIN_FREE_MB: '0' } });
  const now = new Date().toISOString();
  for (const id of [A, B]) await h.store.createUser({ id, name: id, created: now });
  const cfg = await h.req('GET', '/api/config');
  assert.ok(cfg.body.media, 'media offered once an object store is configured');
  const img = M.jpeg(2048), hash = M.sha(img);
  const raw = (method, cookie, body, type = 'image/jpeg') => fetch(`${h.api}/api/media/${hash}`, {
    method, body, headers: { Cookie: cookie, 'Content-Type': type, 'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-For': '198.51.100.1' }
  });
  assert.equal((await raw('PUT', h.session(A), img)).status, 201);
  const mine = await raw('GET', h.session(A));
  assert.equal(mine.status, 200);
  assert.equal(mine.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await mine.arrayBuffer()), img);
  const theirs = await raw('GET', h.session(B));
  assert.equal(theirs.status, 404);
  assert.equal(listObjects(objectsDir).length, 1);
  assert.ok(!listObjects(objectsDir)[0].includes(hash));
});

test('over HTTP: without an object store, product media stays unavailable', async t => {
  const h = await bootProduct(t);
  const cfg = await h.req('GET', '/api/config');
  assert.ok(!cfg.body.media);
  const r = await h.req('POST', '/api/media/missing', { cookie: h.session('x'), body: { hashes: [] } });
  assert.equal(r.status, 404);
});
