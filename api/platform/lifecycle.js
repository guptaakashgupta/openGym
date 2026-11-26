/* The account lifecycle beside the identity store (docs/ops/PILOT_DATA_RECOVERY.md).

   Deletion itself is the identity store's (users row, cascading to its document, credentials and
   upload rows, whose objects are queued for the cleanup job). What is left here is the audit
   trail: it keeps what happened and the account id, not the person's name.

   Retention: audit events older than AUDIT_DAYS are deleted (server.js runs it hourly). */

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
