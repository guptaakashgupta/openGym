-- One acceptance per member and proposal version, with the ids its routines and custom exercises got
-- in the member's document. A retry finds this row and answers with the same mapping.
CREATE TABLE plan_acceptances (
  member_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proposal_version_id text NOT NULL REFERENCES plan_proposal_versions(id) ON DELETE CASCADE,
  routine_map jsonb NOT NULL,
  custom_map jsonb NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_user_id, proposal_version_id)
);
