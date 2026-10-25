-- Gym invitations: separate from memberships until redeemed. Only a SHA-256 of the token is kept.
CREATE TABLE gym_invitations (
  id text PRIMARY KEY,
  gym_id text NOT NULL REFERENCES gyms(id),
  role text NOT NULL CHECK (role IN ('owner', 'trainer', 'member')),
  token_hash text NOT NULL UNIQUE,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  -- Bound to one account when set; otherwise whoever holds the token (possession-based).
  recipient_user_id text REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  consumed_at timestamptz,
  consumed_by text REFERENCES users(id) ON DELETE SET NULL,
  membership_id text REFERENCES gym_memberships(id) ON DELETE SET NULL
);
CREATE INDEX gym_invitations_gym ON gym_invitations (gym_id, created_at);
