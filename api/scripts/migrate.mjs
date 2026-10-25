/* Applies api/migrations/*.sql in filename order, each once. Bookkeeping stores the filename and a
   checksum; an applied file whose content changed is refused rather than silently skipped. One
   transaction under an advisory lock, so concurrent runs serialise and a failure applies nothing.

   Usage: DATABASE_URL=postgres://… node scripts/migrate.mjs */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, transaction } from '../storage/postgres.js';

const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const LOCK_KEY = 0x6f70656e; // arbitrary constant shared by every migrate run

export async function migrate(pool, { dir = DEFAULT_DIR } = {}) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  return transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query('SELECT filename, checksum FROM schema_migrations');
    const applied = new Map(rows.map(r => [r.filename, r.checksum]));
    const ran = [];
    for (const file of files) {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      if (applied.has(file)) {
        if (applied.get(file) !== checksum) throw new Error(`migration ${file} changed after it was applied`);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, checksum]);
      ran.push(file);
    }
    return ran;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }
  const pool = createPool(process.env.DATABASE_URL);
  try {
    const ran = await migrate(pool);
    console.log(ran.length ? `applied: ${ran.join(', ')}` : 'up to date');
  } finally { await pool.end(); }
}
