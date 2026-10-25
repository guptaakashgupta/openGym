/* Accepting a trainer's proposal: one transaction, or nothing.

   Lock order (memberships.js): the member's users row; the recipient and trainer memberships in id
   order; the assignment between them; the proposal version; the member's state row. Then, with
   everything still held: authority rechecked, an earlier acceptance looked for, the plan merged
   with stable ids (proposal-ids.js), the write rules applied against the member's baseRev/baseWid
   (state/prepare-write.js, as for any push), the document stored, the acceptance and its mapping
   recorded. No network calls and no password hashing happen inside.

   The schedule changes only on the weekdays the member confirmed (`days`); `skipSchedule` leaves
   every day as it is. An update (a version with a predecessor) replaces only the routines the
   accepted predecessor added, and only if they are still what the member was shown
   (`replacedFingerprint`, from the preview); otherwise the member sees the refreshed preview. */
import crypto from 'node:crypto';
import { transaction } from '../storage/postgres.js';
import { storeMemberState } from '../storage/state-postgres.js';
import { prepareWrite, forClient } from '../state/prepare-write.js';
import { serverPlanImport } from './plan-catalogue.js';
import { proposalEntityId } from './proposal-ids.js';
import { PlatformError, notFound } from './errors.js';
import { WEEK_DAYS } from '../shared/plan-import.js';

const fingerprintOf = routines => crypto.createHash('sha256').update(JSON.stringify(routines)).digest('hex');

// The routines an update would replace: those the accepted predecessor added, as they are now.
async function replacedBy(db, userId, previousVersionId, doc) {
  if (!previousVersionId) return null;
  const { rows } = await db.query('SELECT routine_map FROM plan_acceptances WHERE member_user_id = $1 AND proposal_version_id = $2', [userId, previousVersionId]);
  const map = rows[0]?.routine_map || {};
  const ids = new Set(Object.values(map));
  const routines = (Array.isArray(doc?.routines) ? doc.routines : []).filter(r => r && ids.has(r.id));
  return { map, routineIds: routines.map(r => r.id), routines, fingerprint: fingerprintOf(routines) };
}

// For the recipient's preview of an update: which of their routines it would replace.
export async function previewReplacement(db, userId, versionId) {
  const { rows } = await db.query(
    `SELECT v.previous_version_id FROM plan_proposal_versions v JOIN gym_memberships rm ON rm.id = v.recipient_membership_id
      WHERE v.id = $1 AND rm.user_id = $2`, [versionId, userId]);
  if (!rows[0]?.previous_version_id) return null;
  const doc = (await db.query('SELECT document FROM member_states WHERE user_id = $1', [userId])).rows[0]?.document;
  const r = await replacedBy(db, userId, rows[0].previous_version_id, doc);
  return { routineIds: r.routineIds, fingerprint: r.fingerprint, routines: r.routines };
}

const latest = doc => ({ rev: doc?._rev || 0, ...(doc?._wid ? { wid: doc._wid } : {}), state: forClient(doc) });

export function acceptProposal(pool, { userId, versionId, body, nextWriteId }) {
  if (typeof body.baseRev !== 'number') return Promise.reject(new PlatformError(400, 'base-required', 'the revision the member last read is required'));
  return transaction(pool, async client => {
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const { rows: found } = await client.query(
      `SELECT v.id, v.recipient_membership_id, v.trainer_membership_id, v.previous_version_id
         FROM plan_proposal_versions v JOIN gym_memberships rm ON rm.id = v.recipient_membership_id
        WHERE v.id = $1 AND rm.user_id = $2`, [versionId, userId]);
    const v = found[0];
    if (!v) throw notFound();
    const { rows: ms } = await client.query(
      'SELECT id, ended_at FROM gym_memberships WHERE id = ANY($1) ORDER BY id FOR SHARE', [[v.recipient_membership_id, v.trainer_membership_id]]);
    const { rows: asg } = await client.query(
      'SELECT id FROM trainer_assignments WHERE member_membership_id = $1 AND trainer_membership_id = $2 AND ended_at IS NULL FOR SHARE',
      [v.recipient_membership_id, v.trainer_membership_id]);
    const { rows: [version] } = await client.query('SELECT status, bundle FROM plan_proposal_versions WHERE id = $1 FOR UPDATE', [versionId]);
    const { rows: st } = await client.query('SELECT document FROM member_states WHERE user_id = $1 FOR UPDATE', [userId]);
    const cur = st[0]?.document ?? null;

    // Accepted before (a response lost on the way): the same mapping, and the document as it is now.
    const before = await client.query('SELECT routine_map, custom_map FROM plan_acceptances WHERE member_user_id = $1 AND proposal_version_id = $2', [userId, versionId]);
    if (before.rows[0]) return { status: 200, body: { ok: true, alreadyAccepted: true, routineMap: before.rows[0].routine_map, customMap: before.rows[0].custom_map, ...latest(cur) } };

    if (version.status !== 'pending') throw new PlatformError(409, 'not-pending', `this plan is ${version.status}`);
    if (!asg[0] || ms.length !== 2 || ms.some(m => m.ended_at)) throw new PlatformError(409, 'not-eligible', 'this plan can no longer be accepted');

    const next = structuredClone(cur || {});
    const replaced = await replacedBy(client, userId, v.previous_version_id, cur);
    if (replaced) {
      if (body.replacedFingerprint !== replaced.fingerprint) {
        return { status: 409, body: { error: 'your routines changed since you looked', code: 'preview-changed', replaces: { routineIds: replaced.routineIds, fingerprint: replaced.fingerprint, routines: replaced.routines } } };
      }
      const gone = new Set(replaced.routineIds);
      next.routines = (next.routines || []).filter(r => !gone.has(r?.id));
    }
    const plan = serverPlanImport().parsePlan(version.bundle, next.unit === 'lb' ? 'lb' : 'kg');
    const taken = new Set([...(next.routines || []), ...(next.customEx || [])].map(x => x?.id));
    const ids = (kind, src) => {
      const id = proposalEntityId(userId, versionId, kind, src);
      if (taken.has(id)) throw new PlatformError(409, 'id-collision', 'this plan’s routines are already in the document');
      return id;
    };
    const merged = serverPlanImport().mergePlan(next, plan, { ids });

    // The week: an updated routine keeps its days (old id → its successor); the plan's own days
    // are added only where the member confirmed them.
    const swap = {};
    for (const [src, oldId] of Object.entries(replaced?.map || {})) swap[oldId] = merged.routineMap[src] || null;
    const week = {};
    const changed = [];
    for (const d of WEEK_DAYS) {
      const base = [].concat(cur?.week?.[d] ?? []).map(id => (id in swap ? swap[id] : id)).filter(Boolean);
      const add = [].concat(plan.week?.[d] ?? []).map(src => merged.routineMap[src]).filter(id => id && !base.includes(id));
      if (add.length) changed.push(d);
      const confirmed = !body.skipSchedule && Array.isArray(body.days) && body.days.includes(d);
      const day = confirmed ? [...base, ...add] : base;
      if (day.length) week[d] = day;
    }
    if (!body.skipSchedule && changed.some(d => !(Array.isArray(body.days) && body.days.includes(d)))) {
      return { status: 409, body: { error: 'confirm the days this plan changes', code: 'confirm-schedule', days: changed } };
    }
    next.week = { ...(cur?.week && typeof cur.week === 'object' ? Object.fromEntries(Object.entries(cur.week).filter(([k]) => !WEEK_DAYS.includes(Number(k)))) : {}), ...week };

    const prepared = prepareWrite(cur, { state: next, baseRev: body.baseRev, ...(typeof body.baseWid === 'string' ? { baseWid: body.baseWid } : {}) }, { nextWriteId });
    if (prepared.status === 409) return { status: 409, body: { ...prepared.body, code: 'conflict' } };
    if (prepared.status !== 200) return prepared;
    await storeMemberState(client, userId, prepared);
    await client.query('INSERT INTO plan_acceptances (member_user_id, proposal_version_id, routine_map, custom_map) VALUES ($1, $2, $3::jsonb, $4::jsonb)',
      [userId, versionId, JSON.stringify(merged.routineMap), JSON.stringify(merged.customMap)]);
    await client.query("UPDATE plan_proposal_versions SET status = 'accepted', decided_at = now() WHERE id = $1", [versionId]);
    return { status: 200, body: { ok: true, routineMap: merged.routineMap, customMap: merged.customMap, ...prepared.body, state: forClient(prepared.state) } };
  });
}
