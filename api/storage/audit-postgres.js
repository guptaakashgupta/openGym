/* The audit trail in PostgreSQL (product mode), the same records server.js audit() writes to
   data/audit.log in file mode: event, outcome, account id and display name, target, a short
   message, the address when AUDIT_IP allows. Never a password, code or token. Retention is a
   scheduled DELETE (docs/ops/PILOT_DATA_RECOVERY.md). */
export function postgresAuditSink(pool) {
  return {
    async write(rec) {
      const { ts, ev, ok, uid, ...rest } = rec;
      delete rest.id;
      await pool.query('INSERT INTO audit_events (at, ev, ok, user_id, detail) VALUES (to_timestamp($1 / 1000.0), $2, $3, $4, $5::jsonb)',
        [ts, ev, ok, uid ?? null, JSON.stringify(rest)]);
    },
  };
}
