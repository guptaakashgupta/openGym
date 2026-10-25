/* Picks the member-state store for the deployment mode (platform/config.js). */
import { fileStateStore } from './state-file.js';

export function createStateStore(config, { dataDir, cacheTtlMs, cacheMax } = {}) {
  if (config.mode === 'file') return fileStateStore(dataDir, { cacheTtlMs, cacheMax });
  throw new Error(`no member-state store for mode "${config.mode}" yet`);
}
