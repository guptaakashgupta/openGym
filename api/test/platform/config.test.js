/* Product mode refuses to boot without the configuration it cannot run safely without; the default
   self-hosted mode keeps needing nothing new. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../platform/config.js';

const SECRET = 'x'.repeat(48);

test('default mode needs no database or session secret', () => {
  assert.deepEqual(loadConfig({}), { mode: 'file' });
});

test('product mode without DATABASE_URL is refused', () => {
  assert.throws(() => loadConfig({ OPENGYM_MODE: 'product', SESSION_SECRET: SECRET }), /DATABASE_URL/);
});

test('product mode without a session secret is refused', () => {
  assert.throws(() => loadConfig({ OPENGYM_MODE: 'product', DATABASE_URL: 'postgres://u:p@db/x' }), /SESSION_SECRET/);
});

test('product mode refuses a short session secret', () => {
  assert.throws(() => loadConfig({ OPENGYM_MODE: 'product', DATABASE_URL: 'postgres://u:p@db/x', SESSION_SECRET: 'short' }), /SESSION_SECRET/);
});

test('product mode refuses a non-postgres or malformed DATABASE_URL', () => {
  for (const url of ['mysql://u:p@db/x', 'not a url'])
    assert.throws(() => loadConfig({ OPENGYM_MODE: 'product', DATABASE_URL: url, SESSION_SECRET: SECRET }), /DATABASE_URL/);
});

test('production refuses a database connection that skips TLS verification', () => {
  for (const mode of ['disable', 'prefer', 'require', 'no-verify'])
    assert.throws(() => loadConfig({ OPENGYM_MODE: 'product', NODE_ENV: 'production', SESSION_SECRET: SECRET,
      DATABASE_URL: `postgres://u:p@db/x?sslmode=${mode}` }), /sslmode/);
  assert.throws(() => loadConfig({ OPENGYM_MODE: 'product', NODE_ENV: 'production', SESSION_SECRET: SECRET,
    DATABASE_URL: 'postgres://u:p@db/x' }), /sslmode/);
  const ok = loadConfig({ OPENGYM_MODE: 'product', NODE_ENV: 'production', SESSION_SECRET: SECRET,
    DATABASE_URL: 'postgres://u:p@db/x?sslmode=verify-full' });
  assert.equal(ok.mode, 'product');
});

test('an unknown mode is refused rather than silently treated as file mode', () => {
  assert.throws(() => loadConfig({ OPENGYM_MODE: 'prodcut' }), /OPENGYM_MODE/);
});

test('product config carries the values it validated', () => {
  const c = loadConfig({ OPENGYM_MODE: 'product', DATABASE_URL: 'postgres://u:p@db/x', SESSION_SECRET: SECRET });
  assert.deepEqual(c, { mode: 'product', databaseUrl: 'postgres://u:p@db/x', sessionSecret: SECRET });
});
