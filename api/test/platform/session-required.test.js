/* Product mode: every session route openapi.yaml lists answers 401 without a session, or the
   intentional 404 `unavailable` when product mode does not offer it (productUnavailable in
   server.js). Never a 2xx, never a redirect onwards. test/server-session-required.test.js is the
   same walk in file mode, and says why it exists. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootProduct } from '../storage/product-server.mjs';
import { sessionRoutes, concrete, OAUTH_PUBLIC } from '../session-routes.mjs';

test('product mode: every session route answers 401 without a session, or unavailable', async t => {
  const h = await bootProduct(t, { env: { TRAINERS: '1', LIBRARY: 'on', MCP: '1', INTEGRATIONS: 'webhook', COACH: '1' } });
  const wrong = [];
  let guarded = 0;
  for (const { method, path: p } of sessionRoutes()) {
    const key = `${method} ${p}`;
    if (OAUTH_PUBLIC.has(key)) continue;
    const r = await h.req(method, concrete(p), { body: method === 'GET' ? undefined : {} });
    if (r.status === 404 && r.body?.code === 'unavailable') continue;
    if (r.status === 401) { guarded++; continue; }
    wrong.push(`${key} → ${r.status}`);
  }
  assert.deepEqual(wrong, []);
  // The member's own routes stay open in product mode: sync, push, passkeys, account.
  assert.ok(guarded >= 25, `only ${guarded} routes answered 401; the rest were unavailable`);
});
