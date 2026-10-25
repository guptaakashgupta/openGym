/* Member state in PostgreSQL (product mode): one JSONB document per user with its revision and
   write id alongside for cheap polls. Every write is one transaction: lock the user row (so two
   first writes to an absent document serialise), lock the state row, run the shared write rules
   (state/prepare-write.js) through `work`, store, commit — and only then answer. No process-local
   cache: several API processes may share the database. */
import { transaction } from './postgres.js';

export class StateUnsupportedError extends Error {
  constructor(uid) {
    super(`state for ${uid} holds text PostgreSQL JSONB cannot store (e.g. an embedded NUL)`);
    this.name = 'StateUnsupportedError';
  }
}
export class UnknownMemberError extends Error {
  constructor(uid) { super(`no user ${uid}`); this.name = 'UnknownMemberError'; }
}

// JSONB refuses \u0000 (22P05) and invalid encodings (22021). Refused, never sanitised: what the
// member sent is not silently changed.
const UNSUPPORTED_TEXT = new Set(['22P05', '22021']);

// bigint arrives as a string; anything beyond a JavaScript safe integer is a corrupt row.
function revisionOf(raw) {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`member_states.revision out of range: ${raw}`);
  return n;
}

// Stores a prepared write (state/prepare-write.js) inside a transaction the caller holds, with the
// state row already locked. Shared with plan acceptance, which writes the document in its own
// transaction after locking the gym records first.
export async function storeMemberState(client, uid, result) {
  const rev = result.state?._rev;
  if (!Number.isSafeInteger(rev) || rev < 1) throw new Error(`prepared state has no valid _rev for ${uid}`);
  try {
    await client.query(
      `INSERT INTO member_states (user_id, document, revision, write_id, updated_at)
       VALUES ($1, $2::jsonb, $3, $4, now())
       ON CONFLICT (user_id) DO UPDATE
         SET document = EXCLUDED.document, revision = EXCLUDED.revision,
             write_id = EXCLUDED.write_id, updated_at = now()`,
      [uid, result.text, rev, result.state._wid ?? null]);
  } catch (e) {
    if (UNSUPPORTED_TEXT.has(e.code)) throw new StateUnsupportedError(uid);
    throw e;
  }
}

export function postgresStateStore(pool) {
  return {
    async readMemberState(uid) {
      const { rows } = await pool.query('SELECT document FROM member_states WHERE user_id = $1', [uid]);
      return rows[0]?.document ?? null;
    },

    async readMemberRevision(uid) {
      const { rows } = await pool.query('SELECT revision, write_id FROM member_states WHERE user_id = $1 AND document IS NOT NULL', [uid]);
      if (!rows[0]) return { rev: 0 };
      return { rev: revisionOf(rows[0].revision), ...(rows[0].write_id ? { wid: rows[0].write_id } : {}) };
    },

    // What the reminder tick needs before it reads a whole document: the reminder settings and
    // whether the Coach was agreed to, plus the revision to key a cache on. Null with no document.
    async readSummary(uid) {
      const { rows } = await pool.query(
        `SELECT revision, document->'reminder' AS reminder, (document #> '{coach,consent,agreedAt}') IS NOT NULL AS consent
           FROM member_states WHERE user_id = $1 AND document IS NOT NULL`, [uid]);
      return rows[0] ? { rev: revisionOf(rows[0].revision), reminder: rows[0].reminder, consent: rows[0].consent } : null;
    },

    // `within(client, result)`, when given, runs after the document is stored and before the
    // commit, in the same transaction (platform/workout-visibility.js).
    async updateMemberState(uid, work, within) {
      return transaction(pool, async client => {
        const user = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [uid]);
        if (!user.rows[0]) throw new UnknownMemberError(uid);
        const { rows } = await client.query('SELECT document FROM member_states WHERE user_id = $1 FOR UPDATE', [uid]);
        const result = await work(rows[0]?.document ?? null);
        if (typeof result?.text !== 'string') return result;
        await storeMemberState(client, uid, result);
        if (within) await within(client, result);
        return result;
      });
    },
  };
}
