/* Every route that needs a session answers 401 without one (file mode). The session lookup is
   asynchronous since the storage seam (readSession, requireAdmin): a call site that forgets
   `await` gets a Promise, which is truthy, so its "not signed in" check passes and the route runs
   for nobody. This walks every session route openapi.yaml lists, with every feature on.
   test/platform/session-required.test.js is the same walk in product mode. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import { sessionRoutes, concrete, OAUTH_PUBLIC } from './session-routes.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://localhost:8080';

test('file mode: every session route answers 401 without a session', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-401-'));
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [], creds: [], subs: [], invites: [] }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost',
      PASSWORD_LOGIN: '1', TRAINERS: '1', LIBRARY: 'on', MCP: '1', INTEGRATIONS: 'webhook',
      INVITE_ONLY: '', ADMIN_UIDS: '', OIDC_ISSUER: '', OIDC_CLIENT_ID: ''
    }
  });
  let log = '';
  child.stdout.on('data', d => log += d);
  child.stderr.on('data', d => log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const api = `http://127.0.0.1:${await boundPort(child, () => log)}`;

  const wrong = [];
  for (const { method, path: p } of sessionRoutes()) {
    const key = `${method} ${p}`;
    if (OAUTH_PUBLIC.has(key)) continue;
    const r = await fetch(api + concrete(p), {
      method, redirect: 'manual', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: method === 'GET' ? undefined : '{}'
    });
    const body = await r.json().catch(() => ({}));
    // OIDC is registered only with a provider configured; unregistered is not unguarded.
    if (p.includes('/oidc') && r.status === 404 && body.error === 'not found') continue;
    // The integrations' OAuth hops are browser navigations: refused, they send the browser back to
    // Settings with the reason, never on to the provider.
    if (p.startsWith('/api/integrations/oauth/')) {
      const to = r.headers.get('location') || '';
      if (r.status !== 302 || !to.startsWith(ORIGIN + '/settings/integrations?') || !/[?&]error=/.test(to)) wrong.push(`${key} → ${r.status} ${to}`);
      continue;
    }
    if (r.status !== 401) wrong.push(`${key} → ${r.status}`);
  }
  assert.deepEqual(wrong, []);
});
