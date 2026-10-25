/* PostgreSQL connection pool and transaction helper. Every statement inside a transaction must use
   the client `work` receives — never `pool.query` — or it runs on another connection outside the
   transaction (https://node-postgres.com/features/transactions). */
import pg from 'pg';

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export function createPool(connectionString, { searchPath } = {}) {
  if (searchPath !== undefined && !IDENT_RE.test(searchPath)) throw new Error(`invalid schema name: ${searchPath}`);
  return new pg.Pool({
    connectionString,
    ...(searchPath ? { options: `-c search_path=${searchPath}` } : {}),
  });
}

export async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch { /* Preserve the original operation error. */ }
    throw error;
  } finally {
    client.release();
  }
}
