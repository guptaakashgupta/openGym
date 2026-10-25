/* The sync protocol over HTTP is the same whichever store holds the documents: one request
   sequence against a file-mode server and a product-mode (PostgreSQL) server, answers compared.
   Write ids are random per server, so they are compared by shape and by how they chain. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from '../helpers.mjs';
import { testSchema, testDatabaseUrl } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const mintSession = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};

// Servers of the current test, stopped (and exited) before its schema is dropped.
const running = [];
const stopAll = () => Promise.all(running.splice(0).map(c => (c.exitCode !== null || c.signalCode !== null)
  ? null : new Promise(r => { c.once('exit', r); c.kill('SIGKILL'); })));

async function boot(t, extraEnv) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-http-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [{ id: 'u1', name: 'One', created: new Date().toISOString() }], creds: [], subs: [], invites: [] }));
  const child = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost', ...extraEnv } });
  let log = '';
  child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  running.push(child);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${await boundPort(child, () => log)}`;
  const headers = { Cookie: `gymsid=${mintSession('u1')}`, 'Content-Type': 'application/json' };
  return async (method, url, body) => {
    const r = await fetch(base + url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  };
}

// A conversation a real client could have: first push, poll, stale push, merge, legacy push,
// malformed push, a string revision, a push with a device-local workout in it.
async function conversation(call) {
  const out = [];
  const step = async (...a) => { const r = await call(...a); out.push(r); return r; };
  await step('GET', '/api/data');
  await step('GET', '/api/data/rev');
  const first = await step('PUT', '/api/data', { state: { _ts: 1, workouts: [{ id: 'w1', d: '2026-10-01' }], routines: [] }, baseRev: 0, stamped: true });
  await step('GET', '/api/data/rev');
  await step('PUT', '/api/data', { state: { _ts: 2, workouts: [] }, baseRev: 0, stamped: true });
  await step('PUT', '/api/data', { state: { _ts: 2, workouts: [] }, baseRev: '1', stamped: true });
  await step('PUT', '/api/data', { state: { _ts: 2, workouts: [] }, baseRev: 1, baseWid: 'not-mine', stamped: true });
  await step('PUT', '/api/data', { state: { _ts: 3, workouts: [{ id: 'w1', d: '2026-10-01' }, { id: 'w2', d: '2026-10-02' }], active: { id: 'live' } }, baseRev: 1, baseWid: first.body.wid, stamped: true });
  await step('PUT', '/api/data', { state: [] });
  await step('PUT', '/api/data', { state: {} });
  await step('PUT', '/api/data', { state: { _ts: 4, workouts: [{ id: 'w3', d: '2026-10-03' }], futureField: { x: 1 } } });
  await step('GET', '/api/data');
  return out;
}

// Write ids differ per server; replace each with its order of first appearance.
function normalise(answers) {
  const seen = new Map();
  const name = w => { if (!seen.has(w)) seen.set(w, `wid${seen.size}`); return seen.get(w); };
  return JSON.parse(JSON.stringify(answers), (k, v) => {
    if ((k === 'wid' || k === '_wid') && typeof v === 'string') { assert.match(v, /^[0-9a-f]{16}$/); return name(v); }
    if (k === '_wids' && Array.isArray(v)) return v.map(name);
    return v;
  });
}

test('file mode and PostgreSQL product mode answer the same sync conversation identically', async t => {
  const { pool, schema } = await testSchema(t, { migrated: true, beforeDrop: stopAll });
  await pool.query("INSERT INTO users (id) VALUES ('u1')");
  const url = new URL(testDatabaseUrl());
  url.searchParams.set('options', `-c search_path=${schema}`);

  const fileCall = await boot(t, {});
  const pgCall = await boot(t, { OPENGYM_MODE: 'product', DATABASE_URL: url.toString(), SESSION_SECRET: SECRET });

  const fileAnswers = normalise(await conversation(fileCall));
  const pgAnswers = normalise(await conversation(pgCall));
  assert.deepEqual(pgAnswers, fileAnswers);
  assert.equal(fileAnswers.at(-1).body.state.futureField.x, 1);
  assert.deepEqual(fileAnswers.map(a => a.status), [200, 200, 200, 200, 409, 409, 409, 200, 400, 400, 200, 200]);

  const { rows } = await pool.query("SELECT revision FROM member_states WHERE user_id = 'u1'");
  assert.equal(Number(rows[0].revision), pgAnswers.at(-1).body.rev);
});

test('product mode answers a NUL-carrying push with a 400 and keeps the stored document', async t => {
  const { pool, schema } = await testSchema(t, { migrated: true, beforeDrop: stopAll });
  await pool.query("INSERT INTO users (id) VALUES ('u1')");
  const url = new URL(testDatabaseUrl());
  url.searchParams.set('options', `-c search_path=${schema}`);
  const call = await boot(t, { OPENGYM_MODE: 'product', DATABASE_URL: url.toString(), SESSION_SECRET: SECRET });
  await call('PUT', '/api/data', { state: { workouts: [{ id: 'safe' }] }, stamped: true });
  const r = await call('PUT', '/api/data', { state: { workouts: [{ id: 'x', note: 'a\u0000b' }] }, baseRev: 1, stamped: true });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'unsupported-text');
  const after = await call('GET', '/api/data');
  assert.deepEqual(after.body.state.workouts, [{ id: 'safe' }]);
});
