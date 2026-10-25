-- A trainer's plan for one member, one immutable row per version. The bundle is the normalised plan
-- (api/shared/plan-import.js parsePlan); only the status and decision time ever change.
CREATE TABLE plan_proposal_versions (
  id text PRIMARY KEY,
  gym_id text NOT NULL REFERENCES gyms(id),
  recipient_membership_id text NOT NULL,
  trainer_membership_id text NOT NULL,
  -- The accepted version this one updates (its routines are the ones it may replace), or NULL.
  previous_version_id text REFERENCES plan_proposal_versions(id),
  bundle jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined', 'superseded', 'invalidated')),
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  FOREIGN KEY (recipient_membership_id, gym_id) REFERENCES gym_memberships (id, gym_id) ON DELETE CASCADE,
  FOREIGN KEY (trainer_membership_id, gym_id) REFERENCES gym_memberships (id, gym_id) ON DELETE CASCADE
);
CREATE INDEX plan_proposal_versions_recipient ON plan_proposal_versions (recipient_membership_id, created_at);
CREATE INDEX plan_proposal_versions_trainer ON plan_proposal_versions (trainer_membership_id, created_at);

CREATE FUNCTION plan_proposal_bundle_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.bundle IS DISTINCT FROM OLD.bundle OR NEW.recipient_membership_id IS DISTINCT FROM OLD.recipient_membership_id
     OR NEW.trainer_membership_id IS DISTINCT FROM OLD.trainer_membership_id OR NEW.previous_version_id IS DISTINCT FROM OLD.previous_version_id THEN
    RAISE EXCEPTION 'a published proposal version is never changed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_proposal_versions_immutable BEFORE UPDATE ON plan_proposal_versions
FOR EACH ROW EXECUTE FUNCTION plan_proposal_bundle_immutable();
