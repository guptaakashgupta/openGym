-- Gyms, membership role rows and trainer assignments. Authority is read from these, never from a
-- member's state document.
CREATE TABLE gyms (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per (person, gym, role, period): an owner who also coaches has two rows. Ending a
-- membership sets ended_at; the row stays as history. Account deletion removes it.
CREATE TABLE gym_memberships (
  id text PRIMARY KEY,
  gym_id text NOT NULL REFERENCES gyms(id),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'trainer', 'member')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  UNIQUE (id, gym_id)
);

CREATE UNIQUE INDEX one_active_member_gym
ON gym_memberships (user_id)
WHERE role = 'member' AND ended_at IS NULL;

CREATE UNIQUE INDEX one_active_gym_role
ON gym_memberships (gym_id, user_id, role)
WHERE ended_at IS NULL;

-- Both sides reference a membership of the assignment's own gym (composite keys), so a trainer of
-- one gym can never be attached to a member of another. Roles are checked by the service.
CREATE TABLE trainer_assignments (
  id text PRIMARY KEY,
  gym_id text NOT NULL REFERENCES gyms(id),
  member_membership_id text NOT NULL,
  trainer_membership_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  FOREIGN KEY (member_membership_id, gym_id) REFERENCES gym_memberships (id, gym_id) ON DELETE CASCADE,
  FOREIGN KEY (trainer_membership_id, gym_id) REFERENCES gym_memberships (id, gym_id) ON DELETE CASCADE,
  CHECK (member_membership_id <> trainer_membership_id)
);

CREATE UNIQUE INDEX one_active_assignment_per_member
ON trainer_assignments (member_membership_id)
WHERE ended_at IS NULL;
CREATE INDEX trainer_assignments_trainer ON trainer_assignments (trainer_membership_id) WHERE ended_at IS NULL;
