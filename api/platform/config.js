/* Deployment mode. `file` is upstream's self-hosted mode (JSON files under DATA_DIR) and needs
   nothing new; `product` is the shared gym pilot and refuses to start without a database and a
   managed session secret, so instances never fall back to a per-container generated one. */

const MIN_SECRET = 32;
const VERIFYING_SSL = new Set(['verify-full', 'verify-ca']);

export function loadConfig(env = process.env) {
  const mode = env.OPENGYM_MODE || 'file';
  if (mode === 'file') return { mode };
  if (mode !== 'product') throw new Error(`OPENGYM_MODE must be "file" or "product", not "${mode}"`);

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('product mode needs DATABASE_URL');
  let url;
  try { url = new URL(databaseUrl); } catch { throw new Error('DATABASE_URL is not a valid URL'); }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
    throw new Error('DATABASE_URL must be a postgres:// URL');
  if (env.NODE_ENV === 'production' && !VERIFYING_SSL.has(url.searchParams.get('sslmode')))
    throw new Error('production DATABASE_URL needs sslmode=verify-full (or verify-ca)');

  const sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < MIN_SECRET)
    throw new Error(`product mode needs SESSION_SECRET of at least ${MIN_SECRET} characters`);

  return { mode, databaseUrl, sessionSecret };
}
