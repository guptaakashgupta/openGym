#!/usr/bin/env node
/* Imports a file-mode instance (its DATA_DIR: db.json and state-<uid>.json) into a freshly
   migrated product database. docs/ops/PILOT_DATA_RECOVERY.md has the cutover procedure.

     node scripts/import-file-store.mjs --source /path/to/data                 # dry run
     node scripts/import-file-store.mjs --source /path/to/data --apply --maintenance-window

   - The source is only read. The dry run validates everything (JSONB included, by asking the
     database to parse each document) and reports counts, the source fingerprint and a checksum;
     never a name, e-mail, id, hash or key.
   - --apply also needs --maintenance-window: the file-mode service is stopped, so nothing writes
     the source while it is read. Everything is written in one transaction: an import that is
     interrupted leaves nothing, and the rerun starts clean.
   - The target must hold no accounts. A completed import is recorded with its fingerprint: the
     same source again changes nothing; a different one is refused.
   - Accounts keep their ids, claims, passwords and passkeys; documents keep every field and their
     revision (_rev) and write id (_wid), so devices sync on without a conflict. Nothing becomes
     visible to a gym: there are no memberships, and joining one later marks history private.
   - Not imported: push subscriptions (devices subscribe again) and file-mode invite codes.
   - ponytail: one transaction holds every account; fine for a pilot instance, batch it for
     thousands of accounts. Uploaded media are not copied; devices upload what the server lacks. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, transaction } from '../storage/postgres.js';
import { insertAccount } from '../storage/identity-postgres.js';
import { claimsOf } from '../storage/identity.js';

const STATE_RE = /^state-(.+)\.json$/;
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
// The same sanitising as server.js stateFile(): the file a user's document lives in.
const fileId = id => String(id).replace(/[^a-zA-Z0-9_-]/g, '');
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

function readSource(dir) {
  const names = fs.readdirSync(dir).filter(n => n === 'db.json' || STATE_RE.test(n)).sort();
  const files = names.map(name => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') }));
  return { files, fingerprint: sha(files.map(f => `${f.name}:${sha(f.text)}`).join('\n')) };
}

function validate(files) {
  const errors = [];
  const plan = { users: [], creds: [], states: [] };
  const dbFile = files.find(f => f.name === 'db.json');
  let db = null;
  if (!dbFile) errors.push('db.json is missing');
  else {
    try { db = JSON.parse(dbFile.text); } catch { errors.push('db.json is not valid JSON'); }
    if (db !== null && !Array.isArray(db?.users)) { errors.push('db.json has no users list'); db = null; }
  }
  const byFile = new Map(), ids = new Set(), claims = new Map();
  (db?.users || []).forEach((u, i) => {
    const n = `user #${i + 1}`;
    if (!isObj(u) || typeof u.id !== 'string' || !u.id) return errors.push(`${n} has no id`);
    if (ids.has(u.id) || byFile.has(fileId(u.id))) return errors.push(`${n} repeats an id`);
    if ((u.name !== undefined && typeof u.name !== 'string') || (u.email !== undefined && typeof u.email !== 'string')
      || (u.disabled !== undefined && typeof u.disabled !== 'boolean') || (u.sv !== undefined && !Number.isSafeInteger(u.sv))) {
      return errors.push(`${n} has a field of the wrong type`);
    }
    for (const key of claimsOf(u).keys()) {
      if (claims.has(key)) return errors.push(`${n} claims a name or e-mail already taken`);
      claims.set(key, i);
    }
    ids.add(u.id);
    byFile.set(fileId(u.id), u.id);
    plan.users.push(u);
  });
  const credIds = new Set();
  (Array.isArray(db?.creds) ? db.creds : []).forEach((c, i) => {
    const n = `credential #${i + 1}`;
    if (!isObj(c) || typeof c.id !== 'string' || !c.id) return errors.push(`${n} has no id`);
    if (!ids.has(c.userId)) return errors.push(`${n} belongs to no user`);
    if (credIds.has(c.id)) return errors.push(`${n} repeats an id`);
    credIds.add(c.id);
    plan.creds.push(c);
  });
  files.filter(f => STATE_RE.test(f.name)).forEach((f, i) => {
    const n = `state #${i + 1}`;
    const uid = byFile.get(STATE_RE.exec(f.name)[1]);
    let doc;
    try { doc = JSON.parse(f.text); } catch { return errors.push(`${n} is not valid JSON`); }
    if (!isObj(doc)) return errors.push(`${n} is not an object`);
    if (!uid) return errors.push(`${n} belongs to no user`);
    plan.states.push({ n, uid, doc, text: f.text });
  });
  const counts = {
    users: plan.users.length, credentials: plan.creds.length, states: plan.states.length,
    workouts: plan.states.reduce((k, s) => k + (Array.isArray(s.doc.workouts) ? s.doc.workouts.length : 0), 0),
    notImported: { subscriptions: Array.isArray(db?.subs) ? db.subs.length : 0, invites: Array.isArray(db?.invites) ? db.invites.length : 0 },
  };
  const checksum = sha(JSON.stringify([plan.users, plan.creds, plan.states.map(s => [s.uid, s.doc])]));
  return { plan, errors, counts, checksum };
}

// PostgreSQL decides what JSONB can hold (an escaped NUL, for one): it parses, nothing is stored.
async function checkJsonb(pool, v) {
  for (const s of v.plan.states) {
    try { await pool.query('SELECT $1::jsonb IS NOT NULL', [s.text]); }
    catch { v.errors.push(`${s.n} holds text PostgreSQL cannot store`); }
  }
}

export async function importFileStore({ source, pool, apply = false, maintenanceWindow = false }) {
  if (apply && !maintenanceWindow) {
    throw new Error('--apply needs the maintenance window acknowledged (--maintenance-window): stop the file-mode service first, so nothing writes the source while it is imported');
  }
  const { files, fingerprint } = readSource(source);
  const v = validate(files);
  await checkJsonb(pool, v);
  const report = { status: 'dry-run', fingerprint, checksum: v.checksum, counts: v.counts, errors: v.errors };
  if (!apply) return report;
  if (v.errors.length) throw new Error(`validation failed: ${v.errors.length} problem(s); run without --apply to list them`);
  return transaction(pool, async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('opengym-file-import'))");
    const runs = (await c.query('SELECT source_fingerprint FROM import_runs')).rows;
    if (runs.some(r => r.source_fingerprint === fingerprint)) return { ...report, status: 'already-imported' };
    if (runs.length) throw new Error('the target holds an import of a different source; refusing an inconsistent rerun');
    if ((await c.query('SELECT 1 FROM users LIMIT 1')).rows.length) throw new Error('the target database is not empty; import only into a freshly migrated database');
    for (const u of v.plan.users) await insertAccount(c, u, v.plan.creds.filter(cr => cr.userId === u.id));
    for (const s of v.plan.states) {
      const rev = Number.isSafeInteger(s.doc._rev) && s.doc._rev >= 0 ? s.doc._rev : 0;
      await c.query('INSERT INTO member_states (user_id, document, revision, write_id) VALUES ($1, $2::jsonb, $3, $4)',
        [s.uid, s.text, rev, typeof s.doc._wid === 'string' ? s.doc._wid : null]);
    }
    await c.query('INSERT INTO import_runs (source_fingerprint, checksum, counts) VALUES ($1, $2, $3::jsonb)', [fingerprint, v.checksum, JSON.stringify(v.counts)]);
    return { ...report, status: 'imported' };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--source');
  const source = at >= 0 ? args[at + 1] : null;
  if (!source || !process.env.DATABASE_URL) {
    console.error('usage: DATABASE_URL=… node scripts/import-file-store.mjs --source <DATA_DIR> [--apply --maintenance-window]');
    process.exit(2);
  }
  const pool = createPool(process.env.DATABASE_URL);
  try {
    const r = await importFileStore({ source, pool, apply: args.includes('--apply'), maintenanceWindow: args.includes('--maintenance-window') });
    console.log(JSON.stringify(r, null, 2));
    process.exitCode = r.errors.length ? 1 : 0;
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally { await pool.end(); }
}
