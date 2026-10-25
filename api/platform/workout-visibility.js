/* Which of a member's workouts their gym may see. Fail closed: a workout is visible only when the
   member's own device reports it as a new recording, with the membership it was started under,
   and the server finds that membership to be the member's own, a member role, and still active —
   and the workout id was never in their document before. Decided inside the state write's
   transaction (state-postgres.js `within`), so the document, the decision and the event's answer
   commit together, after the ids already seen are read and before the new ones are recorded.

   The server cannot prove when an offline workout really happened; a member who re-enters their
   own old session by hand as a new recording can share it. What this stops is everything else:
   imports, restores, edited history, upstream clients without the metadata, and anyone but the
   member choosing what becomes visible. */
const MAX_EVENTS = 50;
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
// A string id; RegExp.test would turn undefined into the text "undefined" and pass it.
const isId = v => typeof v === 'string' && ID_RE.test(v);

// The `platformRecordings` beside `state` in PUT /api/data, checked before anything is read.
// Returns an error message, or null.
export function recordingsProblem(raw) {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length > MAX_EVENTS) return 'platformRecordings must be a list of at most 50 events';
  for (const e of raw) {
    if (!e || typeof e !== 'object' || !isId(e.eventId) || !isId(e.workoutId) || !isId(e.membershipId))
      return 'each recording needs eventId, workoutId and membershipId';
  }
  return null;
}

const workoutIds = state => new Set((Array.isArray(state?.workouts) ? state.workouts : [])
  .map(w => w?.id).filter(id => typeof id === 'string' && id));

// Every workout id currently stored for `userId`, recorded as seen. Run when a member joins a gym,
// so history already on the server is private however it is synced later.
export async function snapshotSeen(client, userId) {
  await client.query(
    `INSERT INTO seen_workout_ids (user_id, workout_id)
     SELECT $1, w->>'id' FROM member_states, jsonb_array_elements(
       CASE WHEN jsonb_typeof(document->'workouts') = 'array' THEN document->'workouts' ELSE '[]'::jsonb END) w
      WHERE user_id = $1 AND jsonb_typeof(w->'id') = 'string'
     ON CONFLICT DO NOTHING`, [userId]);
}

/* Inside the state write's transaction, after the document is stored. `state` is what was
   stored; `events` the validated platformRecordings. Returns one { eventId, result } per event. */
export async function recordWorkouts(client, { userId, state, events = [] }) {
  const present = workoutIds(state);
  const asked = [...new Set(events.map(e => e.workoutId))];
  const { rows: seenRows } = await client.query(
    'SELECT workout_id FROM seen_workout_ids WHERE user_id = $1 AND workout_id = ANY($2)', [userId, asked]);
  const seenBefore = new Set(seenRows.map(r => r.workout_id));
  const results = [];
  for (const e of events) {
    const stored = await client.query('SELECT result FROM recording_events WHERE user_id = $1 AND event_id = $2', [userId, e.eventId]);
    if (stored.rows[0] && stored.rows[0].result !== 'deferred') { results.push({ eventId: e.eventId, result: stored.rows[0].result }); continue; }
    let result;
    if (!present.has(e.workoutId)) result = 'deferred';   // never a fabricated workout
    else {
      const granted = await client.query('SELECT membership_id FROM workout_visibility WHERE user_id = $1 AND workout_id = $2', [userId, e.workoutId]);
      if (granted.rows[0]) result = granted.rows[0].membership_id === e.membershipId ? 'granted' : 'private';
      else if (seenBefore.has(e.workoutId)) result = 'private';
      else {
        // Shared lock: a membership being ended waits for this decision, or this sees it ended.
        const m = await client.query(
          "SELECT id FROM gym_memberships WHERE id = $1 AND user_id = $2 AND role = 'member' AND ended_at IS NULL FOR SHARE",
          [e.membershipId, userId]);
        if (!m.rows[0]) result = 'denied';
        else {
          await client.query('INSERT INTO workout_visibility (user_id, workout_id, membership_id, event_id) VALUES ($1, $2, $3, $4)',
            [userId, e.workoutId, e.membershipId, e.eventId]);
          result = 'granted';
        }
      }
    }
    await client.query(
      `INSERT INTO recording_events (user_id, event_id, workout_id, membership_id, result) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, event_id) DO UPDATE SET result = EXCLUDED.result, decided_at = now()`,
      [userId, e.eventId, e.workoutId, e.membershipId, result]);
    results.push({ eventId: e.eventId, result });
  }
  if (present.size) {
    await client.query('INSERT INTO seen_workout_ids (user_id, workout_id) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING',
      [userId, [...present]]);
  }
  return results;
}
