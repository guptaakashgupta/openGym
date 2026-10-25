# Pilot service runbook

Operating the gym pilot's shared service: environments, deployment, releases and rollback,
background jobs, logs and alerts, backups, and the upstream update rehearsal. Data recovery
details are in `PILOT_DATA_RECOVERY.md`; mobile builds in `PILOT_MOBILE_RELEASE.md`.

Items marked **Pending** need accounts, a domain or decisions that did not exist when this was
written. Nothing has been deployed.

## Environments

| | Staging | Production |
| --- | --- | --- |
| Domain (`PILOT_DOMAIN`, also the passkey `RP_ID`) | its own hostname | its own hostname |
| PostgreSQL | its own managed instance or database, TLS (`sslmode=verify-full`) | its own |
| Object storage | its own private volume or bucket | its own |
| Secrets (`DATABASE_URL`, `SESSION_SECRET`) | its own, from the secret manager | its own |
| App build | its own application id, never the production signing key | production signing key |

Staging never holds production data, credentials or buckets. A restore drill uses a third,
isolated target (see "Backups and restore").

**Pending**: hosts, managed database, secret manager, registry and domains.

## Deploying (`deploy/pilot/compose.yml`)

1. Copy `deploy/pilot/.env.example` to `.env` and `Caddyfile.example` to `Caddyfile` on the
   host; fill in the placeholders. The secrets file comes from the secret manager to the path in
   `SECRETS_FILE`, never through the repository or a ticket.
2. Pin `API_IMAGE` and `WEB_IMAGE` by digest from the release manifest.
3. `docker compose -f deploy/pilot/compose.yml --env-file deploy/pilot/.env run --rm migrate`
4. `docker compose -f deploy/pilot/compose.yml --env-file deploy/pilot/.env up -d`
5. Check `https://<domain>/api/health` answers `{ "ok": true, "database": … }`, sign in with a
   test account, and confirm `GET /api/config` offers `media` only if `OBJECT_STORE` is set.

## Background jobs

The API runs its hourly jobs in-process: media grace sweep, object deletion queue, stale upload
cleanup (`platform/uploads.js`), audit retention (`platform/lifecycle.js`), and reminder pushes.
The pilot runs **one API replica**, which is the single owner of these jobs. They are idempotent,
so an accidental second replica repeats work but corrupts nothing; it is still not a supported
configuration until the jobs move to an elected owner.

## Logs

Containers log to stdout; Docker keeps at most 5 × 10 MB per service (`json-file` rotation in
the compose file). Logs carry no passwords, codes or tokens. Ship them to the log store the
operator chooses, with a retention no longer than the audit retention (`AUDIT_DAYS`).

## Alerts

Configure these once a monitoring service is chosen (**Pending**):

| Alert | Signal | Threshold to agree |
| --- | --- | --- |
| Availability | `GET /api/health` from outside | 2 consecutive failures |
| Database | `/api/health` answers but reports the database unavailable, or the provider's alert | any |
| Failed sync | rate of `PUT /api/data` answering 5xx in the access log | above the agreed baseline |
| Failed acceptance | `POST /api/platform/proposals/{id}/accept` answering 5xx | any |
| Backups | the last successful database and object backup older than the RPO | RPO |
| Certificates | Caddy certificate renewal errors | any |

## Releases and rollback

A release is a manifest (`PILOT_RELEASE_MANIFEST.example.json`): product SHA, upstream SHA,
image digests, schema version, supported app builds and known limitations.

1. Back up the database and objects (see below), and record the backup time in the manifest.
2. Run `migrate`, then `up -d` with the new digests. Migrations only add; none rewrites or drops
   data the previous release reads.
3. Check health, sign-in, a sync from the current app build and one from the previous
   supported build (their requests are pinned by `api/test/fixtures/pilot-clients/`).

Rollback has two independent parts:

- **Containers**: redeploy the previous manifest's digests. Possible whenever the previous
  release can read the current schema, which additive migrations preserve.
- **Database**: a migration is never rolled back in place. If a migration itself must be undone,
  restore the pre-release backup into a **new** database, verify it, and point the previous
  release at it. Writes since the backup follow `PILOT_DATA_RECOVERY.md`. This is verified on
  its own in the restore drill, not by a container rollback.

**Pending**: exercising both with real current and previous app builds on staging (Task 27
covers the devices).

## Backups and restore

Recovery objectives are chosen with the gym (**Pending**: RPO and RTO). Then:

- Database: the managed provider's point-in-time recovery or scheduled dumps, retained at least
  as long as the agreed window.
- Objects: snapshot or copy at the same times as the database.
- Configuration: versioned in the secret manager.

Restore drill (procedure in `PILOT_DATA_RECOVERY.md`): restore into an isolated service, then
verify sign-in, a member's personal history, an accepted plan's routine mapping
(`plan_acceptances`) and that uploaded objects open. Record below.

| Last successful restore | Observed recovery time | Verified by |
| --- | --- | --- |
| **Pending**: not yet performed (no backups exist) | — | — |

## Upstream updates

Procedure: `docs/dev/PILOT_UPSTREAM.md`. Rehearsal record:

| Date | Upstream | Integration branch | Result |
| --- | --- | --- | --- |
| 26 Oct 2026 | `042c9ee` (one commit after the `7a3ace53` baseline: the bug report template) | `integration/upstream-2026-10-26` (local, not pushed) | Merged without conflicts. The changed file is not in `PILOT_CUSTOMISATIONS.md` and no check reads it; the Task 25 checks ran green on the product tip whose tree differs only by that file (`build-api-docs --check` fails as on the baseline). Limitation: the rehearsal exercised no authentication, state, import or native change, because upstream had none. |
