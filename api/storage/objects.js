/* Object storage for private uploads (platform/uploads.js): put, get, delete and exists by key,
   nothing else. Keys are chosen by the caller (random, never a hash or an account id) and the
   store is private: nothing here publishes a URL, every read goes through the API.

   OBJECT_STORE selects the store. `fs:<absolute dir>` keeps the objects in a private directory
   (a mounted volume on a single API host). Unset: no store, and product mode offers no uploads.
   ponytail: no S3 adapter yet — the pilot's provider is not chosen; add objects-s3.js behind the
   same four methods (and the pinned @aws-sdk/client-s3) when it is. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { syncDir, syncFile } from '../durable.js';

const KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;
const checked = key => { if (typeof key !== 'string' || !KEY_RE.test(key)) throw new Error('objects: invalid key'); return key; };

export function fsObjects(dir) {
  const ensure = () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* a host filesystem that refuses chmod */ }
  };
  const at = key => path.join(dir, checked(key));
  return {
    // `file`: a local file holding the whole object. Copied, synced, then renamed into place, so a
    // reader never sees half an object.
    async put(key, file) {
      ensure();
      const dest = at(key), tmp = path.join(dir, `.${crypto.randomBytes(8).toString('hex')}.tmp`);
      try {
        await pipeline(fs.createReadStream(file), fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
        syncFile(tmp);
        fs.renameSync(tmp, dest);
        syncDir(dir);
      } finally { try { fs.unlinkSync(tmp); } catch { /* renamed, or never created */ } }
    },
    // { stream, size } or null when there is no such object.
    async get(key) {
      let fd;
      try { fd = fs.openSync(at(key), 'r'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      const size = fs.fstatSync(fd).size;
      return { stream: fs.createReadStream(null, { fd }), size };
    },
    async delete(key) { try { fs.unlinkSync(at(key)); } catch (e) { if (e.code !== 'ENOENT') throw e; } },
    async exists(key) { try { return fs.statSync(at(key)).isFile(); } catch { return false; } },
  };
}

// The store OBJECT_STORE names, or null when unset. Anything else refuses to boot.
export function objectStoreFrom(env = process.env) {
  const raw = String(env.OBJECT_STORE || '').trim();
  if (!raw) return null;
  const m = /^fs:(\/.+)$/.exec(raw);
  if (!m) throw new Error('OBJECT_STORE must be fs:<absolute directory>');
  return fsObjects(m[1]);
}
