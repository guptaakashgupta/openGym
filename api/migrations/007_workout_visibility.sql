-- Every workout id a member's personal document has ever held. An id seen here before a recording
-- event arrives is private for good: it can never be reclassified as a gym workout.
CREATE TABLE seen_workout_ids (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workout_id text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, workout_id)
);

-- The gym may see this workout, under this membership. Written once, never changed.
CREATE TABLE workout_visibility (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workout_id text NOT NULL,
  membership_id text NOT NULL REFERENCES gym_memberships(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, workout_id)
);
CREATE INDEX workout_visibility_membership ON workout_visibility (membership_id);

CREATE FUNCTION workout_visibility_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'workout_visibility rows are never changed'; END $$;
CREATE TRIGGER workout_visibility_no_update BEFORE UPDATE ON workout_visibility
FOR EACH ROW EXECUTE FUNCTION workout_visibility_immutable();

-- What each new-recording event from a member's device was answered, so a retry gets the same
-- answer. 'deferred' (its workout was not in the document yet) is decided again later.
CREATE TABLE recording_events (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  workout_id text NOT NULL,
  membership_id text NOT NULL,
  result text NOT NULL CHECK (result IN ('granted', 'private', 'denied', 'deferred')),
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_id)
);
