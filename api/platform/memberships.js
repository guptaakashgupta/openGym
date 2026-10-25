/* Gym membership role rows. One active member gym per person (index one_active_member_gym), one
   active row per (gym, person, role) (one_active_gym_role), checked here first for a clear answer
   and by the database for races.

   Lock order, for every transaction that touches more than one of these (memberships, assignments,
   proposals, acceptance): users rows in id order, then gym_memberships rows in id order, then
   trainer_assignments, then plan proposal rows, then member_states. Following it is what keeps two
   such transactions from deadlocking each other. */
import { newId, inTx } from './organisations.js';

export const ROLES = ['owner', 'trainer', 'member'];

export class MembershipError extends Error {
  constructor(code, message = code) { super(message); this.name = 'MembershipError'; this.code = code; }
}

const UNIQUE = '23505';
const fromRow = r => ({ id: r.id, gymId: r.gym_id, userId: r.user_id, role: r.role, startedAt: r.started_at, endedAt: r.ended_at });
const COLS = 'id, gym_id, user_id, role, started_at, ended_at';

export function addMembership(db, { gymId, userId, role }) {
  if (!ROLES.includes(role)) return Promise.reject(new MembershipError('bad-role'));
  return inTx(db, async client => {
    const gym = await client.query("SELECT id FROM gyms WHERE id = $1 AND status = 'active'", [gymId]);
    if (!gym.rows[0]) throw new MembershipError('not-found', 'no such gym');
    const user = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!user.rows[0]) throw new MembershipError('not-found', 'no such account');
    const { rows: active } = await client.query(`SELECT ${COLS} FROM gym_memberships WHERE user_id = $1 AND ended_at IS NULL`, [userId]);
    if (active.some(m => m.gym_id === gymId && m.role === role)) throw new MembershipError('already');
    if (role === 'member' && active.some(m => m.role === 'member')) throw new MembershipError('member-elsewhere');
    try {
      const { rows } = await client.query(
        `INSERT INTO gym_memberships (id, gym_id, user_id, role) VALUES ($1, $2, $3, $4) RETURNING ${COLS}`,
        [newId('m'), gymId, userId, role]);
      return fromRow(rows[0]);
    } catch (e) {
      if (e.code !== UNIQUE) throw e;
      throw new MembershipError(e.constraint === 'one_active_member_gym' ? 'member-elsewhere' : 'already');
    }
  });
}

/* Ends one membership of `gymId` and, in the same transaction, every assignment it is either side
   of. Personal data is untouched; the row stays as history. */
export function endMembership(db, { gymId, membershipId }) {
  return inTx(db, async client => {
    const { rows } = await client.query(
      `SELECT ${COLS} FROM gym_memberships WHERE id = $1 AND gym_id = $2 AND ended_at IS NULL FOR UPDATE`, [membershipId, gymId]);
    if (!rows[0]) throw new MembershipError('not-found');
    const ended = await client.query(`UPDATE gym_memberships SET ended_at = now() WHERE id = $1 RETURNING ${COLS}`, [membershipId]);
    await client.query(
      'UPDATE trainer_assignments SET ended_at = now() WHERE ended_at IS NULL AND (member_membership_id = $1 OR trainer_membership_id = $1)',
      [membershipId]);
    return fromRow(ended.rows[0]);
  });
}

export async function activeMemberships(db, userId) {
  const { rows } = await db.query(`SELECT ${COLS} FROM gym_memberships WHERE user_id = $1 AND ended_at IS NULL ORDER BY started_at`, [userId]);
  return rows.map(fromRow);
}

export async function getMembership(db, { gymId, membershipId }) {
  const { rows } = await db.query(`SELECT ${COLS} FROM gym_memberships WHERE id = $1 AND gym_id = $2`, [membershipId, gymId]);
  return rows[0] ? fromRow(rows[0]) : null;
}
