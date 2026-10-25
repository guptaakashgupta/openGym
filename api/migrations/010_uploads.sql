-- Private uploads (platform/uploads.js): which object in the object store holds which of a
-- user's files. The key is random; knowing a hash grants nothing, every read looks up the
-- caller's own row. A row is 'pending' from before its object is written until the upload is
-- finalised; only 'final' rows are read.
CREATE TABLE media_objects (
  object_key text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_hash text NOT NULL CHECK (media_hash ~ '^[0-9a-f]{64}$'),
  ext text NOT NULL,
  mime text NOT NULL,
  size bigint NOT NULL CHECK (size > 0),
  status text NOT NULL CHECK (status IN ('pending', 'final')),
  -- When the user's stored state stopped naming this file; NULL while it does. Swept after the grace.
  unreferenced_since timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX media_objects_final ON media_objects (user_id, media_hash) WHERE status = 'final';
CREATE INDEX media_objects_pending ON media_objects (created_at) WHERE status = 'pending';
CREATE INDEX media_objects_unreferenced ON media_objects (unreferenced_since) WHERE unreferenced_since IS NOT NULL;

-- Objects to remove from the store. SQL and the object store share no transaction, so whatever
-- removes a row — a sweep, a replaced or failed upload, a deleted account's cascade — queues its
-- key here, and the cleanup job deletes the object, then the queue row: interrupted, it resumes.
CREATE TABLE media_object_deletions (
  object_key text PRIMARY KEY,
  queued_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION queue_media_object_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO media_object_deletions (object_key) VALUES (OLD.object_key) ON CONFLICT DO NOTHING;
  RETURN OLD;
END $$;

CREATE TRIGGER media_objects_deleted AFTER DELETE ON media_objects
  FOR EACH ROW EXECUTE FUNCTION queue_media_object_deletion();
