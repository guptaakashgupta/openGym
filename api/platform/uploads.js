/* Photos and videos in product mode: the same upload rules as the file store (media.js — the
   streaming, the hash, the magic bytes, the caps, the quota), with the bytes in a private object
   store (storage/objects.js) under random keys and the ownership in PostgreSQL (migration 010).

   - Access: every lookup is the caller's own (user_id, media_hash) row. Another account's hash is
     exactly as missing as one never uploaded; reads are proxied by the API, per request.
   - Order: the row is written 'pending' before the object, and made 'final' only after the
     object is stored, so no reference ever names bytes that are not there.
   - Removal: deleting a row (sweep, replaced or failed upload, the account's cascade) queues its
     key (migration 010's trigger); cleanup() deletes queued objects and pending rows whose upload
     died, and can stop and resume anywhere.
   - A row whose object is gone (a restore of the database without the objects) reads as missing,
     so the device that has the file uploads it again. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { transaction } from '../storage/postgres.js';
import {
  HASH_RE, MEDIA_TYPES, MAX_INFLIGHT, MediaError, capMB, contentLength, contentType, drain,
  referencedHashes, streamToFile, verifyUpload,
} from '../media.js';

const MB = 1024 * 1024;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const BATCH = 100;

export function createProductMedia({ pool, objects, limits, tmpDir, readState = async () => null, idleMs = 60000, log = console }) {
  const L = limits;
  const quotaBytes = L.quotaMB > 0 ? Math.round(L.quotaMB * MB) : 0;
  const capOf = kind => Math.round(capMB(L, kind) * MB);
  const maxCap = Math.max(capOf('image'), capOf('gif'), capOf('video'));
  // ponytail: per process, so two replicas allow two each; the hourly budget in server.js bounds the rest.
  const inflight = new Map();

  const finalRow = async (uid, hash) => (await pool.query(
    "SELECT object_key, ext, mime, size FROM media_objects WHERE user_id = $1 AND media_hash = $2 AND status = 'final'",
    [uid, hash])).rows[0] || null;
  async function usage(uid) {
    const { rows: [r] } = await pool.query(
      "SELECT coalesce(sum(size), 0)::bigint AS bytes, count(*)::int AS count FROM media_objects WHERE user_id = $1 AND status = 'final'", [uid]);
    return { bytes: Number(r.bytes), count: r.count, quotaBytes };
  }
  const stateOf = async uid => { try { const S = await readState(uid); return S && typeof S === 'object' ? S : null; } catch { return null; } };
  // A device vouched for a file on its way out: its grace starts over (media.js touch).
  const touch = (uid, hash) => pool.query(
    "UPDATE media_objects SET unreferenced_since = now() WHERE user_id = $1 AND media_hash = $2 AND status = 'final' AND unreferenced_since IS NOT NULL",
    [uid, hash]);

  async function noteState(uid, state) {
    const refs = [...referencedHashes(state)];
    await pool.query(
      "UPDATE media_objects SET unreferenced_since = NULL WHERE user_id = $1 AND status = 'final' AND unreferenced_since IS NOT NULL AND media_hash = ANY($2)",
      [uid, refs]);
    await pool.query(
      "UPDATE media_objects SET unreferenced_since = now() WHERE user_id = $1 AND status = 'final' AND unreferenced_since IS NULL AND NOT (media_hash = ANY($2))",
      [uid, refs]);
  }

  // Never from a state that cannot be read: nothing is inferred from a missing document.
  async function sweep(uid, { graceMs = L.gcGraceDays * DAY } = {}) {
    const S = await stateOf(uid);
    if (!S) return { removed: 0, freedBytes: 0, skipped: true };
    await noteState(uid, S);
    const { rows } = await pool.query(
      `DELETE FROM media_objects WHERE user_id = $1 AND status = 'final' AND unreferenced_since IS NOT NULL
         AND unreferenced_since <= now() - make_interval(secs => $2::double precision / 1000) RETURNING size`,
      [uid, graceMs]);
    return { removed: rows.length, freedBytes: rows.reduce((n, r) => n + Number(r.size), 0), skipped: false };
  }

  async function cleanup() {
    await pool.query("DELETE FROM media_objects WHERE status = 'pending' AND created_at < now() - interval '1 hour'");
    let deleted = 0;
    for (;;) {
      const { rows } = await pool.query('SELECT object_key FROM media_object_deletions ORDER BY queued_at LIMIT $1', [BATCH]);
      for (const { object_key: key } of rows) {
        await objects.delete(key);
        await pool.query('DELETE FROM media_object_deletions WHERE object_key = $1', [key]);
        deleted++;
      }
      if (rows.length < BATCH) return { deleted };
    }
  }

  const existed = (hash, row) => ({ status: 200, body: { ok: true, hash, mime: row.mime, size: Number(row.size), existed: true } });

  async function receive(uid, hash, req) {
    if (!HASH_RE.test(String(hash))) { drain(req, maxCap); throw new MediaError(400, 'bad-request'); }
    const n = inflight.get(uid) || 0;
    if (n >= MAX_INFLIGHT) {
      drain(req, 2 * maxCap);
      throw new MediaError(429, 'busy', { retryAfter: 5 }, { 'Retry-After': '5' });
    }
    inflight.set(uid, n + 1);
    let tmp = null, cap = maxCap, pending = null;
    try {
      const declared = MEDIA_TYPES[contentType(req)];
      if (!declared) throw new MediaError(415, 'media-type');
      cap = capOf(declared.kind);
      const len = contentLength(req);
      if (len != null && len > cap) { cap = maxCap; throw new MediaError(413, 'media-too-large', { maxMB: capMB(L, declared.kind) }); }
      // Kept as it is only when its object is really there and the sizes agree (media.js intact).
      const have = await finalRow(uid, hash);
      if (have && (len == null || len === Number(have.size)) && await objects.exists(have.object_key)) {
        drain(req, 2 * cap); await touch(uid, hash); return existed(hash, have);
      }
      const need = len ?? cap;
      const used = async () => Number((await pool.query('SELECT coalesce(sum(size), 0)::bigint AS b FROM media_objects WHERE user_id = $1', [uid])).rows[0].b);
      // ponytail: checked, not reserved, across replicas; two concurrent uploads can overshoot by one file.
      if (quotaBytes && await used() + need > quotaBytes) {
        try { await sweep(uid, { graceMs: HOUR }); } catch (err) { log.error('media: quota sweep failed for', uid, err.message); }
        if (await used() + need > quotaBytes) throw new MediaError(413, 'media-quota', { usedMB: Math.round((await usage(uid)).bytes / MB * 10) / 10, quotaMB: L.quotaMB });
      }

      fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
      tmp = path.join(tmpDir, crypto.randomBytes(12).toString('hex'));
      const got = await streamToFile(req, tmp, { max: cap, maxMB: capMB(L, declared.kind), idleMs });
      const sn = verifyUpload(tmp, got, hash, declared, L);

      pending = crypto.randomBytes(24).toString('base64url');
      await pool.query(
        "INSERT INTO media_objects (object_key, user_id, media_hash, ext, mime, size, status) VALUES ($1, $2, $3, $4, $5, $6, 'pending')",
        [pending, uid, hash, sn.ext, sn.mime, got.size]);
      await objects.put(pending, tmp, { contentType: sn.mime, size: got.size });
      const referenced = referencedHashes(await stateOf(uid)).has(hash);
      await transaction(pool, async c => {
        await c.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [uid]);   // one finalise per user at a time
        await c.query("DELETE FROM media_objects WHERE user_id = $1 AND media_hash = $2 AND status = 'final'", [uid, hash]);
        await c.query(
          "UPDATE media_objects SET status = 'final', unreferenced_since = CASE WHEN $2 THEN NULL ELSE now() END, updated_at = now() WHERE object_key = $1",
          [pending, referenced]);
      });
      pending = null;
      return { status: 201, body: { ok: true, hash, mime: sn.mime, size: got.size, existed: false } };
    } catch (err) {
      if (!err?.clientGone) drain(req, 2 * cap);
      // Not finalised: the row goes, its key is queued, and cleanup removes whatever was stored.
      if (pending) await pool.query("DELETE FROM media_objects WHERE object_key = $1 AND status = 'pending'", [pending]).catch(e => log.error('media: could not drop pending upload', e.message));
      throw err;
    } finally {
      if (tmp) { try { fs.unlinkSync(tmp); } catch { /* never created, or already gone */ } }
      const left = (inflight.get(uid) || 1) - 1;
      if (left) inflight.set(uid, left); else inflight.delete(uid);
    }
  }

  return {
    limits: L,
    discard: req => drain(req, 2 * maxCap),
    usage,
    receive,
    // { stream, size, mime, ext } of the caller's own file, or null.
    async open(uid, hash) {
      if (!HASH_RE.test(String(hash))) return null;
      const row = await finalRow(uid, hash);
      const got = row && await objects.get(row.object_key);
      return got ? { ...got, mime: row.mime, ext: row.ext } : null;
    },
    async missing(uid, hashes) {
      const asked = [...new Set(hashes)];
      const { rows } = await pool.query(
        "SELECT media_hash, object_key FROM media_objects WHERE user_id = $1 AND status = 'final' AND media_hash = ANY($2)", [uid, asked]);
      const present = new Set();
      await Promise.all(rows.map(async r => { if (await objects.exists(r.object_key)) present.add(r.media_hash); }));
      return { missing: asked.filter(h => !present.has(h)), usage: await usage(uid) };
    },
    noteState,
    sweep,
    cleanup,
    // The hourly pass: every user with a file past its grace, then the deletion queue.
    async sweepAll({ graceMs } = {}) {
      const out = { swept: 0, removed: 0, freedBytes: 0, skipped: 0, tmp: 0 };
      const { rows } = await pool.query('SELECT DISTINCT user_id FROM media_objects WHERE unreferenced_since IS NOT NULL');
      for (const { user_id: uid } of rows) {
        try {
          const r = await sweep(uid, graceMs === undefined ? {} : { graceMs });
          if (r.skipped) out.skipped++; else out.swept++;
          out.removed += r.removed;
          out.freedBytes += r.freedBytes;
        } catch (err) { log.error('media: sweep failed for', uid, err.message); }
      }
      await cleanup();
      return out;
    },
    // The account's rows go with it (ON DELETE CASCADE) and queue their keys; nothing to do here.
    removeUser() {},
    // Boot: nothing is in flight yet, so every temp file is a leftover.
    cleanTmp() {
      let n = 0;
      try { for (const f of fs.readdirSync(tmpDir)) { fs.rmSync(path.join(tmpDir, f), { force: true }); n++; } } catch { /* none */ }
      return n;
    },
  };
}
