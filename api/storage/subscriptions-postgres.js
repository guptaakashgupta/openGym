/* Web Push subscriptions in PostgreSQL (product mode). Same rows as db.json's `subs`, keyed by
   endpoint; they go with the account (ON DELETE CASCADE). */
const fromRow = r => ({ userId: r.user_id, endpoint: r.endpoint, keys: r.keys, ...(r.device_id ? { deviceId: r.device_id } : {}), created: r.created });
const COLS = 'endpoint, user_id, keys, device_id, created';

export function postgresSubscriptionStore(pool) {
  return {
    async forUser(uid) {
      const { rows } = await pool.query(`SELECT ${COLS} FROM push_subscriptions WHERE user_id = $1 ORDER BY seq`, [uid]);
      return rows.map(fromRow);
    },
    async byEndpoint(endpoint) {
      const { rows } = await pool.query(`SELECT ${COLS} FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
      return rows[0] ? fromRow(rows[0]) : null;
    },
    async userIds() {
      const { rows } = await pool.query('SELECT DISTINCT user_id FROM push_subscriptions');
      return rows.map(r => r.user_id);
    },
    async has(uid) {
      const { rows } = await pool.query('SELECT 1 FROM push_subscriptions WHERE user_id = $1 LIMIT 1', [uid]);
      return rows.length > 0;
    },
    async put(sub) {
      await pool.query(`INSERT INTO push_subscriptions (${COLS}) VALUES ($1, $2, $3::jsonb, $4, $5)
        ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, keys = EXCLUDED.keys, device_id = EXCLUDED.device_id, created = EXCLUDED.created`,
        [sub.endpoint, sub.userId, JSON.stringify(sub.keys), sub.deviceId || null, sub.created]);
    },
    async remove(endpoint, uid) {
      if (uid === undefined) await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
      else await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, uid]);
    },
    async removeUser(uid) { await pool.query('DELETE FROM push_subscriptions WHERE user_id = $1', [uid]); },
  };
}
