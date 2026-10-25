/* Member state as one JSON file per profile under DATA_DIR: upstream's self-hosted storage, moved
   out of server.js behind the async interface the PostgreSQL adapter also implements
   (readMemberState, readMemberRevision, updateMemberState). The synchronous readers stay exported
   for the reminder tick and the admin routes until they are adapted.

   Single process only: the per-user write lock below and the stat cache live in this process, so
   two API processes over one DATA_DIR would race. Product mode uses PostgreSQL instead. */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../durable.js';

export class StateUnreadableError extends Error {
  constructor(uid) { super(`state unreadable for ${uid}`); this.name = 'StateUnreadableError'; }
}

// GET and PUT /api/data tell a profile with no state yet from one whose file cannot be read: the
// second answers 503 instead of an empty profile, which a device would adopt, or a write would
// replace, losing what a restore could still bring back.
export const UNREADABLE = Symbol('unreadable');

export function fileStateStore(dir, { cacheTtlMs = 600000, cacheMax = 64 } = {}) {
  const stateFile = uid => path.join(dir, 'state-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
  function readState(uid) {
    try { return JSON.parse(fs.readFileSync(stateFile(uid), 'utf8')); } catch { return null; }
  }
  function readStateStrict(uid) {
    let raw;
    try { raw = fs.readFileSync(stateFile(uid), 'utf8'); }
    catch (e) { return e.code === 'ENOENT' ? null : UNREADABLE; }
    try { return JSON.parse(raw); } catch { return UNREADABLE; }
  }

  // The tick reads every subscribed user's state file every 10 s. Most of those files do not
  // change between ticks; a stat is far cheaper than a read and a parse of a state that can be
  // megabytes, and it keeps the tick short — a slow tick was one more way to miss the minute.
  //
  // What it holds is a whole parsed state per user, and a state can be megabytes, so the two
  // bounds (cacheMax, cacheTtlMs) are what keep it a cache rather than a leak on an instance with
  // more than one person on it: an entry nobody has touched for ten minutes is dropped, and the
  // map never holds more than cacheMax users. Map iteration order is insertion order, so
  // re-inserting on every hit makes the first key the least recently hit one — which is the one
  // to evict.
  const stateCache = new Map(); // uid -> { mtimeMs, size, hitAt, S }
  function readStateCached(uid) {
    let st;
    try { st = fs.statSync(stateFile(uid)); } catch { stateCache.delete(uid); return null; }
    const now = Date.now();
    for (const [k, v] of stateCache) if (now - v.hitAt > cacheTtlMs) stateCache.delete(k);
    const hit = stateCache.get(uid);
    stateCache.delete(uid);                       // re-inserted below, so the map stays in hit order
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      hit.hitAt = now;
      stateCache.set(uid, hit);
      return hit.S;
    }
    const S = readState(uid);
    stateCache.set(uid, { mtimeMs: st.mtimeMs, size: st.size, hitAt: now, S });
    while (stateCache.size > cacheMax) stateCache.delete(stateCache.keys().next().value);
    return S;
  }

  // One write at a time per profile. Upstream's compare-and-write was atomic because nothing was
  // awaited between the read and the rename; with an async `work` it needs this chain instead.
  const locks = new Map(); // uid -> tail promise
  async function withLock(uid, fn) {
    const prev = locks.get(uid) || Promise.resolve();
    let release;
    const mine = new Promise(r => { release = r; });
    const tail = prev.then(() => mine);
    locks.set(uid, tail);
    await prev;
    try { return await fn(); }
    finally {
      release();
      if (locks.get(uid) === tail) locks.delete(uid);
    }
  }

  return {
    stateFile, readState, readStateStrict, readStateCached,

    async readMemberState(uid) {
      const S = readStateStrict(uid);
      if (S === UNREADABLE) throw new StateUnreadableError(uid);
      return S;
    },

    // Just the revision, through the stat cache the reminder tick already uses: parsing a
    // megabytes-long document to read one number off it cost 31 ms per poll on a 2.4 MB state.
    async readMemberRevision(uid) {
      const doc = readStateCached(uid);
      return { rev: doc?._rev || 0, ...(doc?._wid ? { wid: doc._wid } : {}) };
    },

    // `work(current)` returns the answer; when it carries `text`, that is stored before the
    // promise resolves, so nothing is acknowledged before it is on disk.
    async updateMemberState(uid, work) {
      return withLock(uid, async () => {
        const cur = readStateStrict(uid);
        if (cur === UNREADABLE) throw new StateUnreadableError(uid);
        const result = await work(cur);
        if (typeof result?.text === 'string') {
          atomicWrite(stateFile(uid), result.text);
          // The stat cache cannot see this write on its own: mtime granularity is 4 ms here (ext4
          // on this kernel — 3901 of 3999 back-to-back same-size writes shared one timestamp), and
          // a `_rev` going from 7 to 8 does not change the file's size, so two writes inside one
          // 4 ms tick are the same (mtimeMs, size) key. This is the only writer of a state file in
          // the tree, so evicting here is the whole fix.
          stateCache.delete(uid);
        }
        return result;
      });
    },
  };
}
