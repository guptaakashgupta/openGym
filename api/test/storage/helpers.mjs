/* Real-PostgreSQL test fixtures. A missing or wrong test database is an error, never a skip: a
   storage suite that silently skips reads as green while testing nothing. Each test gets its own
   random schema and drops only that schema. */
import crypto from 'node:crypto';
import { createPool } from '../../storage/postgres.js';
import { migrate } from '../../scripts/migrate.mjs';

export const TEST_DATABASE = 'pilot_test';

export function testDatabaseUrl(env = process.env) {
  const raw = env.TEST_DATABASE_URL;
  if (!raw) throw new Error('TEST_DATABASE_URL is not set: start deploy/pilot/compose.test.yml and export it');
  let url;
  try { url = new URL(raw); } catch { throw new Error('TEST_DATABASE_URL is not a valid URL'); }
  const db = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (db !== TEST_DATABASE) throw new Error(`TEST_DATABASE_URL must name the "${TEST_DATABASE}" database, not "${db}"`);
  return raw;
}

const SCHEMA_RE = /^t_[0-9a-f]{16}$/;

/* A pool whose connections all use a fresh schema; `migrated` also applies api/migrations. */
export async function testSchema(t, { migrated = false } = {}) {
  const url = testDatabaseUrl();
  const schema = 't_' + crypto.randomBytes(8).toString('hex');
  if (!SCHEMA_RE.test(schema)) throw new Error('bad schema name');
  const admin = createPool(url);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = createPool(url, { searchPath: schema });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });
  if (migrated) await migrate(pool);
  return { pool, schema };
}
