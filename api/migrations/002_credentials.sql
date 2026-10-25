-- Accounts: upstream's user object in `account`, with the looked-up and revocation fields in their
-- own columns (NULL = the field is absent on the upstream object).
ALTER TABLE users
  ADD COLUMN name text,
  ADD COLUMN email text,
  ADD COLUMN disabled boolean,
  ADD COLUMN sv bigint,
  ADD COLUMN account jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Sign-in identifiers (folded names of password holders, e-mail addresses) in one namespace.
CREATE TABLE login_identifiers (
  key text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  as_name boolean NOT NULL,
  as_email boolean NOT NULL,
  CHECK (as_name OR as_email)
);
CREATE INDEX login_identifiers_user ON login_identifiers (user_id);

-- Passkey credentials: upstream's record (public key, counter, transports, backup flags, dates)
-- kept whole in `record`; `seq` keeps registration order.
CREATE TABLE credentials (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  record jsonb NOT NULL,
  seq bigserial NOT NULL
);
CREATE INDEX credentials_user ON credentials (user_id, seq);
