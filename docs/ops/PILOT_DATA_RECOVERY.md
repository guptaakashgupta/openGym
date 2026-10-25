# Pilot data: migration, export, deletion and recovery

Operator runbook for the product (`OPENGYM_MODE=product`) service. It covers what holds data,
how a file-mode instance moves in, what a member can export, what deleting an account does, how
long the audit trail is kept, and how to recover from a backup without making things worse.

Two rules apply to every step below:

- Never overwrite the only production copy. Restore into a new, isolated target first.
- Never restore into a live, writable service. Stop writes (or point traffic away) before a
  restored target takes over.

## What holds the service's data

| Store | Holds | Backed up by |
| --- | --- | --- |
| PostgreSQL | Accounts, credentials, session versions, personal documents, gyms, memberships, assignments, invitations, visibility, proposals, acceptances, upload ownership, deletion queue, audit trail, import runs | Database backup (for example `pg_dump`, or the provider's point-in-time recovery) |
| Object store (`OBJECT_STORE`) | Uploaded photos and videos, under random keys | Object-store snapshot or copy, taken with the database backup |
| Configuration | `DATABASE_URL`, `SESSION_SECRET`, `OBJECT_STORE`, `RP_ID`, `ORIGIN`, VAPID keys, `ADMIN_UIDS`, limits | The secure configuration channel only, never a data backup |

Secrets (`SESSION_SECRET`, database credentials, VAPID private key) are restored through the
secure configuration channel. They are not in any database dump, export or ticket.

## Moving a file-mode instance in (`api/scripts/import-file-store.mjs`)

The importer reads a file-mode `DATA_DIR` (`db.json`, `state-<uid>.json`) and never writes it.

1. Migrate a fresh, empty database: `node scripts/migrate.mjs`.
2. Copy the source `DATA_DIR` to the machine running the import, then run a dry run:
   `DATABASE_URL=… node scripts/import-file-store.mjs --source <DATA_DIR>`.
   It prints counts (users, credentials, states, workouts, and what is not imported), the source
   fingerprint and a checksum, and lists problems by position (`state #2 …`), never by name.
   Fix every reported problem in the source before continuing.
3. Start the maintenance window: stop the file-mode service so nothing writes the source, and
   take a final copy of `DATA_DIR`.
4. Apply: `… import-file-store.mjs --source <DATA_DIR> --apply --maintenance-window`.
   - Everything is written in one transaction. An interrupted run leaves nothing; run it again.
   - Running it again on the same source reports `already-imported` and changes nothing.
   - A changed source, or a database that already holds accounts, is refused.
5. Compare the apply report's counts and checksum with a dry run of the same final copy.
6. Point the clients at the product service.

What arrives: account ids, names, e-mails, password hashes, passkeys, session versions, and every
document with all its fields, its revision (`_rev`) and write id (`_wid`), so devices continue to
sync without a conflict. Nothing becomes visible to a gym: there are no memberships after the
import, and joining a gym later marks all existing history private.

What does not arrive: push subscriptions (devices subscribe again), file-mode invite codes, and
uploaded media (devices upload the files the server reports as missing).

Passkeys keep working only if the product service uses the same relying-party identity
(`RP_ID`, the exact hostname) as the file-mode instance. See "Passkeys and domains".

## Member export (`GET /api/platform/export`)

A signed-in member downloads their own data as JSON, format `opengym-pilot-export/1`:

| Field | Content |
| --- | --- |
| `format`, `exportedAt` | Format version and time of export |
| `account` | `id`, `name`, `email`, `created` of the caller |
| `state` | The caller's personal document, as stored |
| `memberships[]` | `membershipId`, `gymId`, `gymName`, `role`, `startedAt`, `endedAt` |
| `proposals.received[]` | Plans sent to the caller: `id`, `gymId`, `status`, `previousVersionId`, `createdAt`, `decidedAt`, `bundle` |
| `sharedWorkouts[]` | Which of the caller's workouts a gym may see: `workoutId`, `membershipId`, `grantedAt` |

Never included: passwords, passkeys, session versions, tokens, other people's names, or any
other account's documents. A trainer's export holds their own document, not their clients'.

## Account deletion

`POST /api/account/delete` (with the owner's proof) does, in the database:

- deletes the account, its credentials, claims, push subscriptions, pairing codes and device
  links. Every session and bearer token of the account stops working at once, because each
  request looks the account up. A device that comes back offline with an old token gets `401`
  and restores nothing;
- deletes the personal document, memberships, trainer assignments, workout visibility, plan
  acceptances, and the proposal versions sent or received through the deleted memberships. A
  plan a member already accepted stays in that member's own document;
- deletes the upload rows. Each queues its object key in `media_object_deletions`, and the
  hourly media pass deletes the objects;
- removes display names and addresses from the account's audit events (see below).

## Audit trail retention

- Events record what happened (`ev`, `ok`, time), the account id and a short message. Never a
  password, code or token.
- Events older than `AUDIT_DAYS` (default 90) are deleted by the API every hour.
- When an account is deleted, its events keep the account id but lose the display name, target
  name and address.
- Set `AUDIT_DAYS` to the period your policy requires. `0` keeps events indefinitely and needs a
  separate retention process.

## Backups

Take the database backup and the object-store copy together, as close to the same moment as the
tools allow, and record both times. Keep the configuration in the secure channel, versioned.

Test a restore regularly using the procedure below. A backup that has never been restored is not
known to work.

## Restoring from a backup

1. Create a new, isolated database and object store (or prefix). Do not touch production.
2. Restore the database backup into it, then run `node scripts/migrate.mjs` (it applies only
   migrations newer than the backup).
3. Restore the object-store copy into the new store.
4. Start one API against the restored stores, with configuration from the secure channel and no
   public traffic. Check `GET /api/health`, sign in with a test account and read one upload.
5. Stop writes on the old service (maintenance window), then switch traffic to the restored one.
   Keep the old database and objects, read-only, until the restored service is confirmed.

### What happens to writes made after the backup

- **Personal documents**: a device that synced after the backup holds a newer revision. The
  restored server refuses its write (`409`, revision mismatch) and sends its own copy; the app
  merges and pushes the result. Work that is still on a device comes back. Work that existed
  only on the server, or only on a device that has since been reset, is lost.
- **Server-only records**: gyms, memberships, assignments, invitations, proposals, acceptances,
  visibility decisions and account changes made after the backup are lost and must be redone.
  Invitations sent after the backup no longer work.
- **Accounts created after the backup** do not exist. Their devices get `401`; the member signs
  up again, and the device keeps its unsynced work aside for them.
- **Deleted accounts**: an account deleted after the backup reappears. Delete it again and
  record why.
- **Uploads**: a row whose object is gone reads as missing. Devices that still hold the file
  upload it again on their next media check.

## Passkeys and domains

A passkey is bound to the relying-party identity (`RP_ID`, the exact hostname) it was created
for. Copying credentials to a service on another hostname does not make them work there.

- Restores and migrations that keep the same `RP_ID` keep passkeys working.
- Moving to a new hostname needs a planned re-enrolment: members sign in with a password (or an
  operator-issued reset, `POST /api/admin/user/password-reset`) on the new hostname and add a
  new passkey there. Tell members before the move, and remove the old passkeys afterwards.
