-- Web Push subscriptions (upstream db.json `subs`).
CREATE TABLE push_subscriptions (
  endpoint text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  keys jsonb NOT NULL,
  device_id text,
  created text NOT NULL,
  seq bigserial NOT NULL
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id, seq);

-- Sign-in and administration events (upstream data/audit.log). No foreign key: the trail outlives
-- a deleted account.
CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL,
  ev text NOT NULL,
  ok boolean NOT NULL,
  user_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_events_at ON audit_events (at);
