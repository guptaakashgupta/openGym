-- Short-lived sign-in state shared by every API process. Only hashes of what the client holds.
CREATE TABLE auth_challenges (
  cid_hash text PRIMARY KEY,
  data jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX auth_challenges_expiry ON auth_challenges (expires_at);

-- One live pairing code per profile (the newest).
CREATE TABLE pairing_codes (
  code_hash text PRIMARY KEY,
  user_id text NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

-- One unused device link per profile.
CREATE TABLE device_links (
  code_hash text PRIMARY KEY,
  user_id text NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
