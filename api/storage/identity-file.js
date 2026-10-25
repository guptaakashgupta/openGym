/* Accounts and passkey credentials in upstream's db.json arrays (file mode). Callers get copies,
   never the stored objects, so every change goes through an update and a save. One operation at a
   time across the whole store: the rules compare against every profile.
   ponytail: one store-wide lock; fine for a self-hosted instance, PostgreSQL in product mode. */
import { IdentityConflictError, claimsOf, conflictField, hasPassword, assertSameId } from './identity.js';
import { nameKey } from '../password.js';

const copy = x => (x == null ? null : structuredClone(x));

export function fileIdentityStore({ db, save }) {
  let tail = Promise.resolve();
  const serial = fn => { const run = tail.then(fn, fn); tail = run.catch(() => {}); return run; };

  const claimedByOther = (key, exceptId) => db.users.some(o => o.id !== exceptId && claimsOf(o).has(key));
  function checkClaims(u) {
    for (const [key, c] of claimsOf(u)) if (claimedByOther(key, u.id)) throw new IdentityConflictError(conflictField(c));
  }
  const holder = (key, kind) => copy(db.users.find(u => hasPassword(u) && claimsOf(u).get(key)?.[kind]) || null);

  return {
    async getUser(id) { return copy(db.users.find(u => u.id === id) || null); },
    async listUsers() { return copy(db.users); },
    async findPasswordHolderByName(key) { return holder(key, 'name'); },
    async findPasswordHolderByEmail(email) { return holder(email, 'email'); },
    async isNameTaken(name, exceptId) { return claimedByOther(nameKey(name), exceptId); },
    async isEmailTaken(email, exceptId) { return claimedByOther(email, exceptId); },

    createUser(user, { credential } = {}) {
      return serial(() => {
        if (db.users.some(u => u.id === user.id)) throw new Error(`account ${user.id} exists`);
        checkClaims(user);
        if (credential && db.creds.some(c => c.id === credential.id)) throw new IdentityConflictError('credential');
        db.users.push(copy(user));
        if (credential) db.creds.push(copy(credential));
        save();
        return copy(user);
      });
    },

    updateUser(id, mutate) {
      return serial(async () => {
        const at = db.users.findIndex(u => u.id === id);
        if (at === -1) return null;
        const draft = copy(db.users[at]);
        const next = (await mutate(draft)) ?? draft;
        assertSameId(db.users[at], next);
        checkClaims(next);
        db.users[at] = copy(next);
        save();
        return copy(next);
      });
    },

    deleteUser(id) {
      return serial(() => {
        if (!db.users.some(u => u.id === id)) return false;
        db.users = db.users.filter(u => u.id !== id);
        db.creds = db.creds.filter(c => c.userId !== id);
        save();
        return true;
      });
    },

    async findCredential(id) { return copy(db.creds.find(c => c.id === id) || null); },
    async listCredentials(userId) { return copy(db.creds.filter(c => c.userId === userId)); },

    addCredential(cred) {
      return serial(() => {
        if (!db.users.some(u => u.id === cred.userId)) throw new Error(`no account ${cred.userId}`);
        if (db.creds.some(c => c.id === cred.id)) throw new IdentityConflictError('credential');
        db.creds.push(copy(cred));
        save();
        return copy(cred);
      });
    },

    updateCredential(id, mutate) {
      return serial(async () => {
        const at = db.creds.findIndex(c => c.id === id);
        if (at === -1) return null;
        const draft = copy(db.creds[at]);
        const next = (await mutate(draft)) ?? draft;
        if (next.id !== id || next.userId !== db.creds[at].userId) throw new Error('an update cannot move a credential');
        db.creds[at] = copy(next);
        save();
        return copy(next);
      });
    },

    // `refuse(credsOfTheAccount, account)` decides under the same lock as the removal.
    removeCredentialChecked(userId, credId, refuse) {
      return serial(() => {
        const u = db.users.find(x => x.id === userId);
        const mine = db.creds.filter(c => c.userId === userId);
        const row = mine.find(c => c.id === credId);
        if (!u || !row) return { error: 'passkey not found', code: 'not-found' };
        const refused = refuse(copy(mine), copy(u));
        if (refused) return refused;
        db.creds = db.creds.filter(c => c.id !== credId);
        save();
        return { ok: true, row: copy(row) };
      });
    },

    removeCredential(id) {
      return serial(() => {
        const before = db.creds.length;
        db.creds = db.creds.filter(c => c.id !== id);
        if (db.creds.length === before) return false;
        save();
        return true;
      });
    },
  };
}
