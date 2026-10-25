/* Accounts and passkey credentials in PostgreSQL (product mode). Each account row keeps upstream's
   object in `account` (JSONB, so fields this code does not know survive) with the fields that are
   looked up or revoked by — name, email, disabled, sv — in their own columns, the one authoritative
   copy of each. Identifier uniqueness is the login_identifiers primary key, so two concurrent
   registrations cannot both claim a name: the second waits on the first's row and then fails.

   ponytail: claims are computed when a profile is written, so a reset code that expires unredeemed
   keeps its name claimed until the profile is next written (file mode re-checks on every read).
   Stricter, never looser; add an expiry sweep if it ever blocks a real signup. */
import { transaction } from './postgres.js';
import { IdentityConflictError, claimsOf, conflictField, hasPassword, assertSameId } from './identity.js';
import { nameKey } from '../password.js';

const UNIQUE = '23505';

function toRow(u) {
  const { id, name, email, disabled, sv, ...account } = u;
  if (typeof id !== 'string' || !id) throw new Error('an account needs an id');
  if (name !== undefined && typeof name !== 'string') throw new Error(`account ${id}: name must be text`);
  if (email !== undefined && typeof email !== 'string') throw new Error(`account ${id}: email must be text`);
  if (disabled !== undefined && typeof disabled !== 'boolean') throw new Error(`account ${id}: disabled must be true/false`);
  if (sv !== undefined && !Number.isSafeInteger(sv)) throw new Error(`account ${id}: sv must be an integer`);
  return [id, name ?? null, email ?? null, disabled ?? null, sv ?? null, JSON.stringify(account)];
}
function fromRow(r) {
  if (!r) return null;
  return {
    ...r.account, id: r.id,
    ...(r.name != null ? { name: r.name } : {}),
    ...(r.email != null ? { email: r.email } : {}),
    ...(r.disabled != null ? { disabled: r.disabled } : {}),
    ...(r.sv != null ? { sv: Number(r.sv) } : {}),
  };
}
const credFromRow = r => (r ? { id: r.id, userId: r.user_id, ...r.record } : null);
const credRecord = ({ id, userId, ...record }) => JSON.stringify(record);
const USER_COLS = 'id, name, email, disabled, sv, account';

async function writeClaims(client, u) {
  await client.query('DELETE FROM login_identifiers WHERE user_id = $1', [u.id]);
  for (const [key, c] of claimsOf(u)) {
    const r = await client.query(
      'INSERT INTO login_identifiers (key, user_id, as_name, as_email) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING RETURNING key',
      [key, u.id, c.name, c.email]);
    if (!r.rows[0]) throw new IdentityConflictError(conflictField(c));
  }
}

async function insertCredential(client, cred) {
  try {
    await client.query('INSERT INTO credentials (id, user_id, record) VALUES ($1, $2, $3::jsonb)', [cred.id, cred.userId, credRecord(cred)]);
  } catch (e) {
    if (e.code === UNIQUE) throw new IdentityConflictError('credential');
    throw e;
  }
}

export function postgresIdentityStore(pool) {
  async function holder(key, flag) {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.disabled, u.sv, u.account FROM login_identifiers li JOIN users u ON u.id = li.user_id
        WHERE li.key = $1 AND li.${flag}`, [key]);
    const u = fromRow(rows[0]);
    return hasPassword(u) ? u : null;
  }
  async function claimedByOther(key, exceptId) {
    const { rows } = await pool.query('SELECT 1 FROM login_identifiers WHERE key = $1 AND user_id IS DISTINCT FROM $2', [key, exceptId ?? null]);
    return rows.length > 0;
  }

  return {
    async getUser(id) {
      const { rows } = await pool.query(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id]);
      return fromRow(rows[0]);
    },
    async listUsers() {
      const { rows } = await pool.query(`SELECT ${USER_COLS} FROM users ORDER BY created_at, id`);
      return rows.map(fromRow);
    },
    findPasswordHolderByName: key => holder(key, 'as_name'),
    findPasswordHolderByEmail: email => holder(email, 'as_email'),
    isNameTaken: (name, exceptId) => claimedByOther(nameKey(name), exceptId),
    isEmailTaken: (email, exceptId) => claimedByOther(email, exceptId),

    createUser(user, { credential } = {}) {
      return transaction(pool, async client => {
        await client.query(`INSERT INTO users (${USER_COLS}) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`, toRow(user));
        await writeClaims(client, user);
        if (credential) await insertCredential(client, credential);
        return structuredClone(user);
      });
    },

    updateUser(id, mutate) {
      return transaction(pool, async client => {
        const { rows } = await client.query(`SELECT ${USER_COLS} FROM users WHERE id = $1 FOR UPDATE`, [id]);
        const before = fromRow(rows[0]);
        if (!before) return null;
        const draft = structuredClone(before);
        const next = (await mutate(draft)) ?? draft;
        assertSameId(before, next);
        const [, name, email, disabled, sv, account] = toRow(next);
        await client.query('UPDATE users SET name = $2, email = $3, disabled = $4, sv = $5, account = $6::jsonb, updated_at = now() WHERE id = $1',
          [id, name, email, disabled, sv, account]);
        await writeClaims(client, next);
        return next;
      });
    },

    // The member's state document goes with the account (file mode unlinks state-<uid>.json).
    deleteUser(id) {
      return transaction(pool, async client => {
        await client.query('DELETE FROM member_states WHERE user_id = $1', [id]);
        const r = await client.query('DELETE FROM users WHERE id = $1', [id]);
        return r.rowCount > 0;
      });
    },

    async findCredential(id) {
      const { rows } = await pool.query('SELECT id, user_id, record FROM credentials WHERE id = $1', [id]);
      return credFromRow(rows[0]);
    },
    async listCredentials(userId) {
      const { rows } = await pool.query('SELECT id, user_id, record FROM credentials WHERE user_id = $1 ORDER BY seq', [userId]);
      return rows.map(credFromRow);
    },
    addCredential(cred) {
      return transaction(pool, async client => { await insertCredential(client, cred); return structuredClone(cred); });
    },
    updateCredential(id, mutate) {
      return transaction(pool, async client => {
        const { rows } = await client.query('SELECT id, user_id, record FROM credentials WHERE id = $1 FOR UPDATE', [id]);
        const before = credFromRow(rows[0]);
        if (!before) return null;
        const draft = structuredClone(before);
        const next = (await mutate(draft)) ?? draft;
        if (next.id !== id || next.userId !== before.userId) throw new Error('an update cannot move a credential');
        await client.query('UPDATE credentials SET record = $2::jsonb WHERE id = $1', [id, credRecord(next)]);
        return next;
      });
    },
    // `refuse(credsOfTheAccount, account)` decides while the account row is locked, so two
    // removals (or a removal and a password removal, which locks the same row) cannot both pass.
    removeCredentialChecked(userId, credId, refuse) {
      return transaction(pool, async client => {
        const { rows: users } = await client.query(`SELECT ${USER_COLS} FROM users WHERE id = $1 FOR UPDATE`, [userId]);
        const u = fromRow(users[0]);
        const { rows } = await client.query('SELECT id, user_id, record FROM credentials WHERE user_id = $1 ORDER BY seq', [userId]);
        const mine = rows.map(credFromRow);
        const row = mine.find(c => c.id === credId);
        if (!u || !row) return { error: 'passkey not found', code: 'not-found' };
        const refused = refuse(mine, u);
        if (refused) return refused;
        await client.query('DELETE FROM credentials WHERE id = $1', [credId]);
        return { ok: true, row };
      });
    },

    async removeCredential(id) {
      const r = await pool.query('DELETE FROM credentials WHERE id = $1', [id]);
      return r.rowCount > 0;
    },
  };
}
