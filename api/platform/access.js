/* Who the caller is in the gym world, read fresh on every request: the authenticated account (the
   session, resolved by server.js) plus their current memberships and assignments in PostgreSQL.
   Nothing the client sends — a gym id in a path selects a context, it never grants one — and
   nothing in the member's own state document counts. */
import { notFound, forbidden } from './errors.js';

export async function resolvePrincipal(db, userId) {
  const { rows } = await db.query(
    `SELECT m.id, m.gym_id, m.role, g.name AS gym_name
       FROM gym_memberships m JOIN gyms g ON g.id = m.gym_id
      WHERE m.user_id = $1 AND m.ended_at IS NULL AND g.status = 'active'
      ORDER BY m.started_at, m.id`, [userId]);
  return { userId, memberships: rows.map(r => ({ id: r.id, gymId: r.gym_id, gymName: r.gym_name, role: r.role })) };
}

// The caller's membership in `gymId` with `role`: 404 when they have no role in that gym at all,
// 403 when they do but not this one.
export function requireGymRole(principal, gymId, role) {
  const inGym = principal.memberships.filter(m => m.gymId === gymId);
  if (!inGym.length) throw notFound();
  const m = inGym.find(x => x.role === role);
  if (!m) throw forbidden();
  return m;
}

// The member behind `memberMembershipId`, when `trainerUserId` is their currently assigned
// trainer and both memberships are active; 404 otherwise (another trainer's client, another
// gym's member and an ended membership look the same). Owning the gym is not coaching.
export async function assignedClient(db, trainerUserId, memberMembershipId) {
  const { rows } = await db.query(
    `SELECT mm.id AS membership_id, mm.user_id, mm.gym_id, a.id AS assignment_id
       FROM trainer_assignments a
       JOIN gym_memberships mm ON mm.id = a.member_membership_id AND mm.ended_at IS NULL
       JOIN gym_memberships tm ON tm.id = a.trainer_membership_id AND tm.ended_at IS NULL
      WHERE a.member_membership_id = $1 AND a.ended_at IS NULL AND tm.user_id = $2 AND tm.role = 'trainer'`,
    [memberMembershipId, trainerUserId]);
  if (!rows[0]) throw notFound();
  return { memberMembershipId: rows[0].membership_id, memberUserId: rows[0].user_id, gymId: rows[0].gym_id, assignmentId: rows[0].assignment_id };
}

export async function clientsOf(db, trainerUserId) {
  const { rows } = await db.query(
    `SELECT mm.id AS membership_id, mm.gym_id, u.name, a.started_at
       FROM trainer_assignments a
       JOIN gym_memberships mm ON mm.id = a.member_membership_id AND mm.ended_at IS NULL
       JOIN gym_memberships tm ON tm.id = a.trainer_membership_id AND tm.ended_at IS NULL
       JOIN users u ON u.id = mm.user_id
      WHERE a.ended_at IS NULL AND tm.user_id = $1 AND tm.role = 'trainer'
      ORDER BY u.name, mm.id`, [trainerUserId]);
  return rows.map(r => ({ membershipId: r.membership_id, gymId: r.gym_id, name: r.name, assignedAt: r.started_at }));
}
