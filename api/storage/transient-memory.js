/* Short-lived sign-in state for file mode, as upstream kept it: WebAuthn challenges and pairing
   codes in this process's memory (5 minutes, one use), one-time device links hashed in db.json
   (device-link.js). Moved out of server.js behind the interface transient-postgres.js shares.
   Single process only: a second process sees none of the challenges or codes. */
import crypto from 'node:crypto';
import { createDeviceLink, findDeviceLink, burnDeviceLink, dropDeviceLinks } from '../device-link.js';

const TTL_MS = 5 * 60000;
// POST /api/login/options is anonymous and unthrottled, and every call leaves a challenge here
// for five minutes, so the Map has a ceiling: past it the oldest goes. A ceremony takes seconds,
// so only a flood far beyond any real sign-in traffic reaches back far enough to cost one.
const MAX_CHALLENGES = 20000;
export const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — read off a screen
export const makePairCode = () => Array.from(crypto.randomBytes(8)).map(b => PAIR_CODE_ALPHABET[b % PAIR_CODE_ALPHABET.length]).join('');

export function memoryTransientStore({ db, save }) {
  const challenges = new Map(); // cid -> {kind, challenge, name?, uid?, exp}
  const pairings = new Map();   // code -> {uid, exp}
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k);
    for (const [k, v] of pairings) if (v.exp < now) pairings.delete(k);
  }, 60000).unref();

  return {
    async putChallenge(data) {
      while (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value);
      const cid = crypto.randomBytes(16).toString('base64url');
      challenges.set(cid, { ...data, exp: Date.now() + TTL_MS });
      return cid;
    },
    async takeChallenge(cid) {
      const c = challenges.get(cid);
      challenges.delete(cid);
      if (!c || c.exp < Date.now()) return null;
      return c;
    },

    // One live code per profile: the newest is the one on screen.
    async createPairing(uid) {
      for (const [k, v] of pairings) if (v.uid === uid) pairings.delete(k);
      let code;
      do code = makePairCode(); while (pairings.has(code));
      pairings.set(code, { uid, exp: Date.now() + TTL_MS });
      return code;
    },
    async redeemPairing(code) {
      const p = pairings.get(code);
      if (p) pairings.delete(code);
      return p && p.exp >= Date.now() ? p.uid : null;
    },
    async dropPairings(uid) { for (const [k, v] of pairings) if (v.uid === uid) pairings.delete(k); },

    async createDeviceLink(uid) { const r = createDeviceLink(db, uid); save(); return r; },
    async findDeviceLink(code) { return findDeviceLink(db, code); },
    // True only for the call that removed it.
    async burnDeviceLink(link) {
      const had = (db.deviceLinks || []).includes(link);
      burnDeviceLink(db, link);
      if (had) save();
      return had;
    },
    async restoreDeviceLink(link) {
      if ((db.deviceLinks || []).some(l => l.userId === link.userId)) return;
      db.deviceLinks.push(link);
      save();
    },
    async dropDeviceLinks(uid) { if (dropDeviceLinks(db, uid)) save(); },
  };
}
