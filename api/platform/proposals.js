/* Versioned plan proposals from a trainer to an assigned member. A version is the normalised plan
   (the shared import rules, api/shared/plan-import.js), stored once and never edited; a newer one
   from the same trainer supersedes a pending one; only the member decides. A plan the server
   cannot carry whole — an exercise it does not know — is refused, never trimmed: the trainer
   would otherwise send something other than what the member then trains. */
import { newId, inTx } from './organisations.js';
import { assignedClient } from './access.js';
import { PlatformError, notFound } from './errors.js';
import { serverPlanImport } from './plan-catalogue.js';
import { WEEK_DAYS } from '../shared/plan-import.js';

const MAX_BUNDLE_CHARS = 200_000;
const MAX_ROUTINES = 30;
const MAX_EXERCISES = 300;
const invalid = () => new PlatformError(400, 'plan-invalid', 'that is not a plan');
const tooLarge = () => new PlatformError(413, 'plan-too-large', 'that plan is too large');
const unsupported = n => new PlatformError(422, 'plan-unsupported', `the plan uses ${n} exercise(s) this service does not know`);

// The plan as stored: parsed in its own unit (so nothing is converted), every exercise resolved,
// the week reduced to days that name routines of this plan.
export function normaliseBundle(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid();
  if (JSON.stringify(raw).length > MAX_BUNDLE_CHARS) throw tooLarge();
  const unit = raw.unit === 'lb' || raw.unit === 'lbs' ? 'lb' : 'kg';
  let parsed;
  try { parsed = serverPlanImport().parsePlan(raw, unit); } catch { throw invalid(); }
  if (parsed.dropped) throw unsupported(parsed.dropped);
  if (!parsed.routineCount) throw invalid();
  if (parsed.routineCount > MAX_ROUTINES || parsed.exerciseCount > MAX_EXERCISES) throw tooLarge();
  const ids = new Set(parsed.routines.map(r => r.id));
  const week = {};
  for (const d of WEEK_DAYS) {
    const v = [].concat(parsed.week?.[d] ?? []).filter(id => typeof id === 'string' && ids.has(id));
    if (v.length) week[d] = v;
  }
  return { opengym_plan: 1, name: String(parsed.name || '').slice(0, 80), unit: parsed.unit, week, routines: parsed.routines, customEx: parsed.customEx };
}

const summary = r => ({
  id: r.id, status: r.status, gymId: r.gym_id, createdAt: r.created_at, decidedAt: r.decided_at || null,
  previousVersionId: r.previous_version_id || null, name: r.bundle?.name || '',
  routineCount: Array.isArray(r.bundle?.routines) ? r.bundle.routines.length : 0,
  recipientMembershipId: r.recipient_membership_id, trainerMembershipId: r.trainer_membership_id,
  trainerName: r.trainer_name ?? undefined, memberName: r.member_name ?? undefined,
});

export function createProposal(db, { trainerUserId, memberMembershipId, bundle, previousVersionId = null }) {
  const plan = normaliseBundle(bundle);
  return inTx(db, async client => {
    const c = await assignedClient(client, trainerUserId, memberMembershipId);
    const { rows: asg } = await client.query('SELECT trainer_membership_id FROM trainer_assignments WHERE id = $1 FOR SHARE', [c.assignmentId]);
    const trainerMembershipId = asg[0].trainer_membership_id;
    if (previousVersionId) {
      const prev = await client.query(
        "SELECT id FROM plan_proposal_versions WHERE id = $1 AND recipient_membership_id = $2 AND status = 'accepted'",
        [previousVersionId, memberMembershipId]);
      if (!prev.rows[0]) throw new PlatformError(409, 'previous-not-accepted', 'an update has to follow an accepted plan');
    }
    await client.query(
      `UPDATE plan_proposal_versions SET status = 'superseded', decided_at = now()
        WHERE status = 'pending' AND recipient_membership_id = $1 AND trainer_membership_id = $2`,
      [memberMembershipId, trainerMembershipId]);
    const { rows } = await client.query(
      `INSERT INTO plan_proposal_versions (id, gym_id, recipient_membership_id, trainer_membership_id, previous_version_id, bundle, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING *`,
      [newId('pv'), c.gymId, memberMembershipId, trainerMembershipId, previousVersionId, JSON.stringify(plan), trainerUserId]);
    return summary(rows[0]);
  });
}

// What the caller received (as a member) and sent (as a trainer), newest first, without bundles.
export async function listProposals(db, userId) {
  const q = side => db.query(
    `SELECT v.*, tu.name AS trainer_name, mu.name AS member_name
       FROM plan_proposal_versions v
       JOIN gym_memberships rm ON rm.id = v.recipient_membership_id JOIN users mu ON mu.id = rm.user_id
       JOIN gym_memberships tm ON tm.id = v.trainer_membership_id JOIN users tu ON tu.id = tm.user_id
      WHERE ${side}.user_id = $1 ORDER BY v.created_at DESC, v.id`, [userId]);
  const [received, sent] = await Promise.all([q('rm'), q('tm')]);
  return { received: received.rows.map(summary), sent: sent.rows.map(summary) };
}

// One version for its recipient or the trainer who sent it; 404 for anyone else.
export async function getProposal(db, userId, versionId) {
  const { rows } = await db.query(
    `SELECT v.*, rm.user_id AS recipient_user_id, tm.user_id AS trainer_user_id
       FROM plan_proposal_versions v
       JOIN gym_memberships rm ON rm.id = v.recipient_membership_id
       JOIN gym_memberships tm ON tm.id = v.trainer_membership_id
      WHERE v.id = $1`, [versionId]);
  const v = rows[0];
  if (!v || (v.recipient_user_id !== userId && v.trainer_user_id !== userId)) throw notFound();
  return { ...summary(v), bundle: v.bundle, role: v.recipient_user_id === userId ? 'recipient' : 'sender' };
}

export function declineProposal(db, userId, versionId) {
  return inTx(db, async client => {
    const { rows } = await client.query(
      `SELECT v.id, v.status FROM plan_proposal_versions v JOIN gym_memberships rm ON rm.id = v.recipient_membership_id
        WHERE v.id = $1 AND rm.user_id = $2 FOR UPDATE OF v`, [versionId, userId]);
    if (!rows[0]) throw notFound();
    if (rows[0].status !== 'pending') throw new PlatformError(409, 'not-pending', `this plan is ${rows[0].status}`);
    await client.query("UPDATE plan_proposal_versions SET status = 'declined', decided_at = now() WHERE id = $1", [versionId]);
    return { ok: true };
  });
}
