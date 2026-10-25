-- Identity root and member state. Account fields and credentials arrive in 002.
CREATE TABLE users (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One personal workout document per user (upstream's state-<uid>.json). NULL document = no saved
-- state. `revision` and `write_id` mirror the document's `_rev`/`_wid` for cheap revision polls.
CREATE TABLE member_states (
  user_id text PRIMARY KEY REFERENCES users(id),
  document jsonb,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  write_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
