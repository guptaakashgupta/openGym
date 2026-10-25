/* Picks the member-state and identity stores for the deployment mode (platform/config.js). */
import { fileStateStore } from './state-file.js';
import { postgresStateStore } from './state-postgres.js';
import { fileIdentityStore } from './identity-file.js';
import { postgresIdentityStore } from './identity-postgres.js';
import { memoryTransientStore } from './transient-memory.js';
import { postgresTransientStore } from './transient-postgres.js';

export function createStateStore(config, { dataDir, cacheTtlMs, cacheMax, pool } = {}) {
  if (config.mode === 'file') return fileStateStore(dataDir, { cacheTtlMs, cacheMax });
  if (config.mode === 'product') {
    if (!pool) throw new Error('product mode needs a database pool');
    return postgresStateStore(pool);
  }
  throw new Error(`no member-state store for mode "${config.mode}"`);
}

// File mode: upstream's db.json object and its save. Product mode: PostgreSQL only — db.json is
// never an authority for accounts there.
export function createIdentityStore(config, { db, save, pool } = {}) {
  if (config.mode === 'file') return fileIdentityStore({ db, save });
  if (config.mode === 'product') {
    if (!pool) throw new Error('product mode needs a database pool');
    return postgresIdentityStore(pool);
  }
  throw new Error(`no identity store for mode "${config.mode}"`);
}

// Challenges, pairing codes and device links: this process's memory and db.json in file mode,
// PostgreSQL (shared by every process) in product mode.
export function createTransientStore(config, { db, save, pool } = {}) {
  if (config.mode === 'file') return memoryTransientStore({ db, save });
  if (config.mode === 'product') {
    if (!pool) throw new Error('product mode needs a database pool');
    return postgresTransientStore(pool);
  }
  throw new Error(`no transient store for mode "${config.mode}"`);
}
