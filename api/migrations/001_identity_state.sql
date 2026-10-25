-- Identity root. Account fields, credentials and member state arrive in later migrations
-- (member_states in Task 5, credentials in 002).
CREATE TABLE users (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
