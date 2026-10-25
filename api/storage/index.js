/* Picks the member-state store for the deployment mode (platform/config.js). */
import { fileStateStore } from './state-file.js';
import { postgresStateStore } from './state-postgres.js';

export function createStateStore(config, { dataDir, cacheTtlMs, cacheMax, pool } = {}) {
  if (config.mode === 'file') return fileStateStore(dataDir, { cacheTtlMs, cacheMax });
  if (config.mode === 'product') {
    if (!pool) throw new Error('product mode needs a database pool');
    return postgresStateStore(pool);
  }
  throw new Error(`no member-state store for mode "${config.mode}"`);
}
