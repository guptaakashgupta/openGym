/* A real server.js in product mode against a disposable PostgreSQL schema, with the request
   helper and software passkey the upstream suites use (server-passkeys.test.js), so product tests
   drive the same HTTP flows. `restart()` replaces the process; `another()` boots a second one on
   the same database, as a second API replica would be. Sessions are signed with the managed
   SESSION_SECRET, never a per-process file. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from '../helpers.mjs';
import { testSchema, testDatabaseUrl } from './helpers.mjs';
import { postgresIdentityStore } from '../../storage/identity-postgres.js';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ORIGIN = 'http://localhost:8080';
const b64u = b => Buffer.from(b).toString('base64url');
const sha = b => crypto.createHash('sha256').update(b).digest();

export async function bootProduct(t, { env = {} } = {}) {
  const { pool, schema } = await testSchema(t, { migrated: true });
  const secret = crypto.randomBytes(32).toString('hex');   // product mode signs with this
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-auth-'));
  // A different file secret: a session that verifies proves the managed one is in use.
  fs.writeFileSync(path.join(dataDir, 'secret'), crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [], creds: [], subs: [], invites: [] }));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const url = new URL(testDatabaseUrl());
  url.searchParams.set('options', `-c search_path=${schema}`);
  const databaseUrl = env.DATABASE_URL || url.toString();

  const h = { pool, schema, dataDir, store: postgresIdentityStore(pool), log: '' };
  async function spawnOne() {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost',
        OPENGYM_MODE: 'product', SESSION_SECRET: secret,
        PASSWORD_LOGIN: '1', TRUST_PROXY: '1', INVITE_ONLY: '', ADMIN_UIDS: '', AUDIT_LOG: '1', ...env, DATABASE_URL: databaseUrl,
      }
    });
    child.stdout.on('data', d => h.log += d);
    child.stderr.on('data', d => h.log += d);
    t.after(() => child.kill('SIGKILL'));
    return { child, api: `http://127.0.0.1:${await boundPort(child, () => h.log)}` };
  }
  async function start() { Object.assign(h, await spawnOne()); }
  await start();
  h.restart = async () => { h.child.kill('SIGKILL'); await start(); };
  const reqAt = base => async (method, p, { body, cookie, ip = '198.51.100.1', headers = {} } = {}) => {
    const r = await fetch(`${base()}${p}`, {
      signal: AbortSignal.timeout(30000),   // a request that never answers fails the test, by name
      method,
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const setCookie = r.headers.getSetCookie().find(c => c.startsWith('gymsid=') && !c.startsWith('gymsid=;'));
    let parsed = null;
    try { parsed = await r.json(); } catch { /* an empty or non-JSON answer */ }
    return { status: r.status, body: parsed, cookie: setCookie ? setCookie.split(';')[0] : null };
  };
  h.req = reqAt(() => h.api);
  h.another = async () => { const { api } = await spawnOne(); return reqAt(() => api); };
  h.token = (uid, { sv = 0, ttlMs = 86400000, kind } = {}) => {
    const payload = `${uid}:${Date.now() + ttlMs}:${sv}${kind ? ':' + kind : ''}`;
    return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  };
  h.session = (uid, sv = 0) => {
    const payload = `${uid}:${Date.now() + 86400000}:${sv}`;
    return 'gymsid=' + payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  };
  h.audit = () => { try { return fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return []; } };
  h.fileDb = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  // A passkey assertion for this request, the way Settings confirms before a change.
  h.stepUp = async (key, ip) => {
    const { cid, options } = (await h.req('POST', '/api/login/options', { body: {}, ip })).body;
    return { cid, credential: key.assertion(options.challenge) };
  };
  return h;
}

const cborHead = (major, n) => n < 24 ? Buffer.from([(major << 5) | n])
  : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
const cborText = s => Buffer.concat([cborHead(3, Buffer.byteLength(s)), Buffer.from(s)]);
const cborBytes = b => Buffer.concat([cborHead(2, b.length), b]);

// Copied from server-passkeys.test.js: a P-256 key that attests ("none") and asserts like a browser.
export function softPasskey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), Buffer.from(jwk.x, 'base64url'),
    Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y, 'base64url')
  ]);
  const raw = crypto.randomBytes(16);
  const id = b64u(raw);
  let counter = 0;
  return {
    id,
    row: (userId, extra = {}) => ({ id, userId, publicKey: cose.toString('base64url'), counter: 0, transports: ['internal'], ...extra }),
    attestation(challenge) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN, crossOrigin: false }));
      const len = Buffer.from([raw.length >> 8, raw.length & 255]);
      const authData = Buffer.concat([sha('localhost'), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, raw, cose]);
      const attestationObject = Buffer.concat([
        Buffer.from([0xa3]), cborText('fmt'), cborText('none'), cborText('attStmt'), Buffer.from([0xa0]),
        cborText('authData'), cborBytes(authData)
      ]);
      return {
        id, rawId: id, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
        response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal', 'hybrid'] }
      };
    },
    assertion(challenge) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false }));
      const c = Buffer.alloc(4); c.writeUInt32BE(++counter);
      const authData = Buffer.concat([sha('localhost'), Buffer.from([0x05]), c]);
      const signature = crypto.sign('sha256', Buffer.concat([authData, sha(clientDataJSON)]), privateKey);
      return {
        id, rawId: id, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
        response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: null }
      };
    }
  };
}
