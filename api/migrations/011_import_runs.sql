-- Completed imports of a file-mode instance (scripts/import-file-store.mjs). The fingerprint is a
-- hash of the source files as read: the same source again is a no-op, any other is refused.
CREATE TABLE import_runs (
  source_fingerprint text PRIMARY KEY CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  checksum text NOT NULL,
  counts jsonb NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now()
);
