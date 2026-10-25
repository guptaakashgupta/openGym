/* Moving a file-mode instance (DATA_DIR: db.json and state-<uid>.json) into product PostgreSQL.
   The source is only read. A dry run validates and counts without writing; --apply needs the
   maintenance-window acknowledgement and writes everything in one transaction, so an interrupted
   import leaves nothing behind. A completed import is recorded with the source's fingerprint: the
   same source again is a no-op, a changed source is refused. Accounts, credentials and documents
   (unknown fields and revision ancestry included) arrive as they were; no gym visibility does.
   Reports carry counts and checksums only, never account data. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testSchema } from './helpers.mjs';
import { postgresIdentityStore } from '../../storage/identity-postgres.js';
import { importFileStore } from '../../scripts/import-file-store.mjs';

const users = [
  { id: 'u-alpha-1', name: 'Alpha Person', created: '2026-01-02T03:04:05.000Z', email: 'alpha@example.test', pw: { h: 'scrypt$fake$hash', set: '2026-01-02T03:04:05.000Z' }, sv: 2, futureFlag: true },
  { id: 'u-beta-2', name: 'Beta Person', created: '2026-02-03T04:05:06.000Z' },
];
const creds = [{ id: 'cred-1', userId: 'u-beta-2', publicKey: 'cHVibGljLWtleQ', counter: 4, transports: ['internal'] }];
const states = {
  'u-alpha-1': { _rev: 7, _wid: 'wid-7', _ts: 1700, workouts: [{ id: 'w1', d: '2026-03-01' }, { id: 'w2', d: '2026-03-02' }], futureField: { kept: [1, 2] } },
  'u-beta-2': { _rev: 3, _wid: 'wid-3', workouts: [{ id: 'w9', d: '2026-04-01' }] },
};

function source(t, { db = { users, creds, subs: [], invites: [] }, docs = states, raw = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-import-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'db.json'), typeof db === 'string' ? db : JSON.stringify(db));
  for (const [uid, doc] of Object.entries(docs)) fs.writeFileSync(path.join(dir, `state-${uid}.json`), JSON.stringify(doc));
  for (const [name, text] of Object.entries(raw)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}
const digest = dir => fs.readdirSync(dir).sort().map(n => n + ':' + crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, n))).digest('hex')).join('|');
const count = async (pool, table) => (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
const noPersonalData = report => {
  const text = JSON.stringify(report);
  for (const s of ['Alpha Person', 'Beta Person', 'alpha@example.test', 'scrypt$fake$hash', 'cHVibGljLWtleQ', 'u-alpha-1', 'u-beta-2']) assert.ok(!text.includes(s), s);
};

test('a dry run validates and counts, writes nothing and reports no account data', async t => {
  const { pool } = await testSchema(t, { migrated: true });
  const dir = source(t);
  const r = await importFileStore({ source: dir, pool });
  assert.equal(r.status, 'dry-run');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.counts, { users: 2, credentials: 1, states: 2, workouts: 3, notImported: { subscriptions: 0, invites: 0 } });
  assert.match(r.fingerprint, /^[0-9a-f]{64}$/);
  assert.match(r.checksum, /^[0-9a-f]{64}$/);
  noPersonalData(r);
  assert.equal(await count(pool, 'users'), 0);
});

test('apply needs the maintenance window, then preserves accounts, credentials and documents exactly', async t => {
  const { pool } = await testSchema(t, { migrated: true });
  const dir = source(t);
  const before = digest(dir);
  await assert.rejects(importFileStore({ source: dir, pool, apply: true }), /maintenance window/);
  const r = await importFileStore({ source: dir, pool, apply: true, maintenanceWindow: true });
  assert.equal(r.status, 'imported');
  noPersonalData(r);
  assert.equal(digest(dir), before, 'the source is only read');

  const ids = postgresIdentityStore(pool);
  for (const u of users) assert.deepEqual(await ids.getUser(u.id), u);
  assert.deepEqual(await ids.listCredentials('u-beta-2'), creds);
  assert.equal((await ids.findPasswordHolderByEmail('alpha@example.test')).id, 'u-alpha-1');
  for (const [uid, doc] of Object.entries(states)) {
    const row = (await pool.query('SELECT document, revision, write_id FROM member_states WHERE user_id = $1', [uid])).rows[0];
    assert.deepEqual(row.document, doc);
    assert.equal(Number(row.revision), doc._rev);
    assert.equal(row.write_id, doc._wid);
  }
  for (const table of ['workout_visibility', 'recording_events', 'seen_workout_ids', 'gym_memberships']) assert.equal(await count(pool, table), 0, table);

  const again = await importFileStore({ source: dir, pool, apply: true, maintenanceWindow: true });
  assert.equal(again.status, 'already-imported');
  assert.deepEqual(again.counts, r.counts);
  assert.equal(again.checksum, r.checksum);
  assert.equal(await count(pool, 'users'), 2);
});

test('a source that changed after its import, or a target that holds other accounts, is refused', async t => {
  const { pool } = await testSchema(t, { migrated: true });
  const dir = source(t);
  await importFileStore({ source: dir, pool, apply: true, maintenanceWindow: true });
  fs.writeFileSync(path.join(dir, 'state-u-beta-2.json'), JSON.stringify({ ...states['u-beta-2'], _rev: 4 }));
  await assert.rejects(importFileStore({ source: dir, pool, apply: true, maintenanceWindow: true }), /different source/);

  const other = await testSchema(t, { migrated: true });
  await postgresIdentityStore(other.pool).createUser({ id: 'live', name: 'Live', created: '2026-01-01T00:00:00.000Z' });
  await assert.rejects(importFileStore({ source: source(t), pool: other.pool, apply: true, maintenanceWindow: true }), /not empty/);
});

test('malformed sources and text JSONB cannot hold are reported without account data, and nothing is applied', async t => {
  const { pool } = await testSchema(t, { migrated: true });
  const cases = [
    [source(t, { db: '{"users": [' }), /db\.json is not valid JSON/],
    [source(t, { db: { users: 'nope' } }), /db\.json has no users list/],
    [source(t, { db: { users: [{ name: 'no id' }] } }), /user #1 has no id/],
    [source(t, { db: { users, creds: [{ id: 'c', userId: 'ghost' }] } }), /credential #1 belongs to no user/],
    [source(t, { raw: { 'state-u-beta-2.json': '{"workouts": [' } }), /state #2 is not valid JSON/],
    [source(t, { raw: { 'state-u-gone-9.json': '{}' } }), /state #3 belongs to no user/],
    [source(t, { raw: { 'state-u-beta-2.json': '{"note": "a\\u0000b"}' } }), /state #2 holds text PostgreSQL cannot store/],
    // Only a password holder claims its name (storage/identity.js claimsOf).
    [source(t, { db: { users: [users[0], { ...users[1], name: 'Alpha Person', pw: users[0].pw }] } }), /user #2 claims a name or e-mail already taken/],
  ];
  for (const [dir, why] of cases) {
    const r = await importFileStore({ source: dir, pool });
    assert.ok(r.errors.some(e => why.test(e)), `${why}: ${JSON.stringify(r.errors)}`);
    noPersonalData(r);
    await assert.rejects(importFileStore({ source: dir, pool, apply: true, maintenanceWindow: true }), /validation failed/);
  }
  assert.equal(await count(pool, 'users'), 0);
});

test('an import interrupted part-way leaves nothing, and the rerun completes', async t => {
  const { pool } = await testSchema(t, { migrated: true });
  const dir = source(t);
  // The database connection drops after a few statements of the apply.
  let n = 0;
  const flaky = {
    query: (...a) => pool.query(...a),
    connect: async () => {
      const c = await pool.connect();
      return { query: (...a) => (++n === 6 ? Promise.reject(new Error('connection lost')) : c.query(...a)), release: (...a) => c.release(...a) };
    },
  };
  await assert.rejects(importFileStore({ source: dir, pool: flaky, apply: true, maintenanceWindow: true }), /connection lost/);
  assert.equal(await count(pool, 'users'), 0);
  assert.equal(await count(pool, 'import_runs'), 0);
  assert.equal((await importFileStore({ source: dir, pool, apply: true, maintenanceWindow: true })).status, 'imported');
  assert.equal(await count(pool, 'users'), 2);
});
