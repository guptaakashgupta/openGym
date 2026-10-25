/* Web Push subscriptions in db.json's `subs` array (file mode), behind the interface
   subscriptions-postgres.js shares. Rows are upstream's: { userId, endpoint, keys, deviceId?, created }. */
const copy = x => structuredClone(x);

export function fileSubscriptionStore({ db, save }) {
  return {
    async forUser(uid) { return copy(db.subs.filter(s => s.userId === uid)); },
    async byEndpoint(endpoint) { return copy(db.subs.find(s => s.endpoint === endpoint) || null); },
    async userIds() { return [...new Set(db.subs.map(s => s.userId))]; },
    async has(uid) { return db.subs.some(s => s.userId === uid); },
    // Replaces any row for the same endpoint.
    async put(sub) { db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint); db.subs.push(copy(sub)); save(); },
    async remove(endpoint, uid) {
      const before = db.subs.length;
      db.subs = db.subs.filter(s => !(s.endpoint === endpoint && (uid === undefined || s.userId === uid)));
      if (db.subs.length !== before) save();
    },
    async removeUser(uid) { db.subs = db.subs.filter(s => s.userId !== uid); save(); },
  };
}
