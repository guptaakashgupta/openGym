/* The account lifecycle beside the identity store (docs/ops/PILOT_DATA_RECOVERY.md).

   Export: the member's own data in a documented, versioned format — their account fields, their
   personal document, their memberships, the plans they received and which of their workouts a
   gym was allowed to see. Never a password, passkey, session version or anyone else's name.

   Deletion itself is the identity store's (users row, cascading to memberships, assignments,
   visibility and upload rows, whose objects are queued for the cleanup job). What is left here is
   the audit trail: it keeps what happened and the account id, not the person's name.

   Retention: audit events older than AUDIT_DAYS are deleted (server.js runs it hourly). */

export async function exportAccount(db, user) {
  const [state, memberships, received, shared] = await Promise.all([
    db.query('SELECT document FROM member_states WHERE user_id = $1', [user.id]),
    db.query(
      `SELECT m.id, m.gym_id, g.name AS gym_name, m.role, m.started_at, m.ended_at
         FROM gym_memberships m JOIN gyms g ON g.id = m.gym_id WHERE m.user_id = $1 ORDER BY m.started_at, m.id`, [user.id]),
    db.query(
      `SELECT p.id, p.gym_id, p.status, p.bundle, p.previous_version_id, p.created_at, p.decided_at
         FROM plan_proposal_versions p JOIN gym_memberships m ON m.id = p.recipient_membership_id
        WHERE m.user_id = $1 ORDER BY p.created_at, p.id`, [user.id]),
    db.query('SELECT workout_id, membership_id, granted_at FROM workout_visibility WHERE user_id = $1 ORDER BY granted_at', [user.id]),
  ]);
  return {
    format: 'opengym-pilot-export/1',
    exportedAt: new Date().toISOString(),
    account: { id: user.id, name: user.name ?? null, email: user.email ?? null, created: user.created ?? null },
    state: state.rows[0]?.document ?? null,
    memberships: memberships.rows.map(r => ({ membershipId: r.id, gymId: r.gym_id, gymName: r.gym_name, role: r.role, startedAt: r.started_at, endedAt: r.ended_at })),
    proposals: {
      received: received.rows.map(r => ({ id: r.id, gymId: r.gym_id, status: r.status, previousVersionId: r.previous_version_id, createdAt: r.created_at, decidedAt: r.decided_at, bundle: r.bundle })),
    },
    sharedWorkouts: shared.rows.map(r => ({ workoutId: r.workout_id, membershipId: r.membership_id, grantedAt: r.granted_at })),
  };
}

// After the account is gone: its events keep their kind, outcome, time and account id; the
// display names (theirs, or theirs as the target of someone else's action) and addresses go.
export async function scrubAudit(db, userId) {
  await db.query("UPDATE audit_events SET detail = detail - 'name' - 'tname' - 'ip' WHERE user_id = $1", [userId]);
  await db.query("UPDATE audit_events SET detail = detail - 'tname' WHERE detail->>'tgt' = $1", [userId]);
}

// Returns how many events were removed. `days` 0 keeps everything.
export async function pruneAudit(db, { days }) {
  if (!(days > 0)) return 0;
  const r = await db.query('DELETE FROM audit_events WHERE at < now() - make_interval(days => $1)', [Math.floor(days)]);
  return r.rowCount;
}
