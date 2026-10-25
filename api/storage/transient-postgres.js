/* Short-lived sign-in state in PostgreSQL (product mode), shared by every API process: WebAuthn
   challenges, mobile pairing codes and one-time device links. Each is stored only as a SHA-256 of
   the value the client holds, expires, and is consumed by one DELETE … RETURNING, so of two
   processes redeeming the same value exactly one gets it.
   ponytail: expired rows are pruned on each insert, with no hard cap on unexpired challenges;
   add one if anonymous POST /api/login/options floods ever show up. */
import crypto from 'node:crypto';
import { makeLinkCode, hashLinkCode, DEVICE_LINK_TTL_MS } from '../device-link.js';
import { makePairCode } from './transient-memory.js';
import { transaction } from './postgres.js';

const TTL_MS = 5 * 60000;
const sha = (tag, v) => crypto.createHash('sha256').update(tag + ':' + v).digest('hex');
const UNIQUE = '23505';

export function postgresTransientStore(pool) {
  return {
    async putChallenge(data) {
      const cid = crypto.randomBytes(16).toString('base64url');
      await pool.query('DELETE FROM auth_challenges WHERE expires_at < now()');
      await pool.query(`INSERT INTO auth_challenges (cid_hash, data, expires_at) VALUES ($1, $2::jsonb, now() + $3 * interval '1 millisecond')`,
        [sha('challenge', cid), JSON.stringify(data), TTL_MS]);
      return cid;
    },
    async takeChallenge(cid) {
      if (typeof cid !== 'string' || !cid) return null;
      const { rows } = await pool.query('DELETE FROM auth_challenges WHERE cid_hash = $1 RETURNING data, expires_at > now() AS live', [sha('challenge', cid)]);
      return rows[0]?.live ? rows[0].data : null;
    },

    async createPairing(uid) {
      for (;;) {
        const code = makePairCode();
        try {
          await transaction(pool, async client => {
            await client.query('DELETE FROM pairing_codes WHERE user_id = $1 OR expires_at < now()', [uid]);
            await client.query(`INSERT INTO pairing_codes (code_hash, user_id, expires_at) VALUES ($1, $2, now() + $3 * interval '1 millisecond')`,
              [sha('pair', code), uid, TTL_MS]);
          });
          return code;
        } catch (e) { if (e.code !== UNIQUE) throw e; }   // a hash collision or a racing create: try again
      }
    },
    async redeemPairing(code) {
      if (typeof code !== 'string' || !code) return null;
      const { rows } = await pool.query('DELETE FROM pairing_codes WHERE code_hash = $1 RETURNING user_id, expires_at > now() AS live', [sha('pair', code)]);
      return rows[0]?.live ? rows[0].user_id : null;
    },
    async dropPairings(uid) { await pool.query('DELETE FROM pairing_codes WHERE user_id = $1', [uid]); },

    async createDeviceLink(uid) {
      const code = makeLinkCode();
      const link = { h: hashLinkCode(code), userId: uid, exp: Date.now() + DEVICE_LINK_TTL_MS, created: Date.now() };
      await transaction(pool, async client => {
        await client.query('DELETE FROM device_links WHERE user_id = $1 OR expires_at < now()', [uid]);
        await client.query('INSERT INTO device_links (code_hash, user_id, created_at, expires_at) VALUES ($1, $2, to_timestamp($3 / 1000.0), to_timestamp($4 / 1000.0))',
          [link.h, uid, link.created, link.exp]);
      });
      return { code, link };
    },
    async findDeviceLink(code) {
      const { rows } = await pool.query(
        `SELECT code_hash, user_id, (extract(epoch FROM expires_at) * 1000)::bigint AS exp, (extract(epoch FROM created_at) * 1000)::bigint AS created
           FROM device_links WHERE code_hash = $1 AND expires_at > now()`, [hashLinkCode(code)]);
      const r = rows[0];
      return r ? { h: r.code_hash, userId: r.user_id, exp: Number(r.exp), created: Number(r.created) } : null;
    },
    async burnDeviceLink(link) {
      const r = await pool.query('DELETE FROM device_links WHERE code_hash = $1 AND expires_at > now()', [link.h]);
      return r.rowCount > 0;
    },
    async restoreDeviceLink(link) {
      await pool.query(`INSERT INTO device_links (code_hash, user_id, created_at, expires_at)
        VALUES ($1, $2, to_timestamp($3 / 1000.0), to_timestamp($4 / 1000.0)) ON CONFLICT DO NOTHING`,
        [link.h, link.userId, link.created || Date.now(), link.exp]);
    },
    async dropDeviceLinks(uid) { await pool.query('DELETE FROM device_links WHERE user_id = $1', [uid]); },
  };
}
