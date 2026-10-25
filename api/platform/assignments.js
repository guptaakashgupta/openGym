/* Which trainer coaches which member, inside one gym. At most one active assignment per member
   (index one_active_assignment_per_member); reassigning ends the previous one in the same
   transaction. Both memberships are locked in id order (memberships.js lock order). */
import { newId, inTx } from './organisations.js';
import { MembershipError } from './memberships.js';
import { invalidatePendingFor } from './proposal-invalidation.js';

const fromRow = r => ({ id: r.id, gymId: r.gym_id, memberMembershipId: r.member_membership_id, trainerMembershipId: r.trainer_membership_id, startedAt: r.started_at, endedAt: r.ended_at });
const COLS = 'id, gym_id, member_membership_id, trainer_membership_id, started_at, ended_at';

export function assignTrainer(db, { gymId, memberMembershipId, trainerMembershipId }) {
  return inTx(db, async client => {
    const ids = [memberMembershipId, trainerMembershipId].sort();
    const { rows } = await client.query(
      'SELECT id, role FROM gym_memberships WHERE id = ANY($1) AND gym_id = $2 AND ended_at IS NULL ORDER BY id FOR UPDATE',
      [ids, gymId]);
    const member = rows.find(r => r.id === memberMembershipId);
    const trainer = rows.find(r => r.id === trainerMembershipId);
    if (!member || !trainer) throw new MembershipError('not-found');
    if (member.role !== 'member' || trainer.role !== 'trainer') throw new MembershipError('wrong-role');
    const current = await client.query(`SELECT ${COLS} FROM trainer_assignments WHERE member_membership_id = $1 AND ended_at IS NULL`, [memberMembershipId]);
    if (current.rows[0]?.trainer_membership_id === trainerMembershipId) return fromRow(current.rows[0]);   // already so
    if (current.rows[0]) {
      await client.query('UPDATE trainer_assignments SET ended_at = now() WHERE id = $1', [current.rows[0].id]);
      await invalidatePendingFor(client, { memberMembershipId, trainerMembershipId: current.rows[0].trainer_membership_id });
    }
    const { rows: made } = await client.query(
      `INSERT INTO trainer_assignments (id, gym_id, member_membership_id, trainer_membership_id) VALUES ($1, $2, $3, $4) RETURNING ${COLS}`,
      [newId('a'), gymId, memberMembershipId, trainerMembershipId]);
    return fromRow(made[0]);
  });
}

export function endAssignment(db, { gymId, assignmentId }) {
  return inTx(db, async client => {
    const { rows } = await client.query(
      `UPDATE trainer_assignments SET ended_at = now() WHERE id = $1 AND gym_id = $2 AND ended_at IS NULL RETURNING ${COLS}`, [assignmentId, gymId]);
    if (!rows[0]) throw new MembershipError('not-found');
    await invalidatePendingFor(client, { memberMembershipId: rows[0].member_membership_id, trainerMembershipId: rows[0].trainer_membership_id });
    return fromRow(rows[0]);
  });
}

export async function activeAssignmentFor(db, memberMembershipId) {
  const { rows } = await db.query(`SELECT ${COLS} FROM trainer_assignments WHERE member_membership_id = $1 AND ended_at IS NULL`, [memberMembershipId]);
  return rows[0] ? fromRow(rows[0]) : null;
}
