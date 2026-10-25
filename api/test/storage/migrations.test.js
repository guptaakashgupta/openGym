/* Migrations apply once, in order, and refuse to run over an applied file that has since changed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testDatabaseUrl, testSchema } from './helpers.mjs';
import { migrate } from '../../scripts/migrate.mjs';

test('a missing test database fails loudly instead of skipping', () => {
  assert.throws(() => testDatabaseUrl({}), /TEST_DATABASE_URL is not set/);
});

test('a test database other than pilot_test is refused', () => {
  assert.throws(() => testDatabaseUrl({ TEST_DATABASE_URL: 'postgres://u:p@localhost:5432/production' }), /pilot_test/);
});

test('running migrations twice applies each migration once', async t => {
  const { pool } = await testSchema(t);
  const first = await migrate(pool);
  assert.ok(first.length > 0, 'the first run applies the shipped migrations');
  const second = await migrate(pool);
  assert.deepEqual(second, []);
  const { rows } = await pool.query('SELECT filename, count(*)::int AS n FROM schema_migrations GROUP BY filename');
  assert.ok(rows.every(r => r.n === 1));
  assert.deepEqual(rows.map(r => r.filename).sort(), first.slice().sort());
});

function migrationDir(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-mig-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

test('migrations apply in filename order', async t => {
  const { pool } = await testSchema(t);
  const dir = migrationDir(t, {
    '002_b.sql': 'INSERT INTO t (v) VALUES (2);',
    '001_a.sql': 'CREATE TABLE t (v int); INSERT INTO t (v) VALUES (1);',
  });
  assert.deepEqual(await migrate(pool, { dir }), ['001_a.sql', '002_b.sql']);
  const { rows } = await pool.query('SELECT v FROM t ORDER BY v');
  assert.deepEqual(rows.map(r => r.v), [1, 2]);
});

test('a changed, already-applied migration is refused', async t => {
  const { pool } = await testSchema(t);
  const dir = migrationDir(t, { '001_a.sql': 'CREATE TABLE t (v int);' });
  await migrate(pool, { dir });
  fs.writeFileSync(path.join(dir, '001_a.sql'), 'CREATE TABLE t (v bigint);');
  await assert.rejects(migrate(pool, { dir }), /001_a\.sql.*changed/);
});

test('a failing migration leaves nothing of itself applied', async t => {
  const { pool } = await testSchema(t);
  const dir = migrationDir(t, { '001_a.sql': 'CREATE TABLE t (v int); SELECT broken_syntax_here FROM;' });
  await assert.rejects(migrate(pool, { dir }));
  const { rows } = await pool.query("SELECT to_regclass('t') AS t, to_regclass('schema_migrations') AS m");
  assert.equal(rows[0].t, null);
  if (rows[0].m !== null) {
    const applied = await pool.query('SELECT filename FROM schema_migrations');
    assert.equal(applied.rows.length, 0);
  }
});

test('two concurrent runs apply each migration once', async t => {
  const { pool } = await testSchema(t);
  const dir = migrationDir(t, { '001_a.sql': 'CREATE TABLE t (v int);' });
  const results = await Promise.all([migrate(pool, { dir }), migrate(pool, { dir })]);
  assert.deepEqual(results.flat(), ['001_a.sql']);
});
