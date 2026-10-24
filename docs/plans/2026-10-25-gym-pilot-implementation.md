# Shared Gym Pilot Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Launch the approved gym pilot on shared infrastructure with scoped trainer access, member-accepted plans, Android/iOS pilot builds, and a maintainable relationship with upstream openGym.

**Architecture:** A modular fork preserves upstream's workout documents and sync protocol while PostgreSQL stores identity, gym management, and JSONB member state. Gym permissions and trainer projections are separate from upstream administration. Shared plan-import logic and explicit storage interfaces minimise duplicated behaviour.

**Tech Stack:** Existing Node 22 ES modules and `node:http`, React, Zustand, Vite, Capacitor, Node test runner and Vitest; add PostgreSQL with `pg`, and an object-storage adapter. Use PostgreSQL 17 for the initial local test fixture; pin production versions after provider selection.

---

## Approved Inputs and Execution Rules

Read [the approved design](2026-10-25-gym-pilot-design.md) first. Its privacy boundaries and launch gates are requirements, not optional improvements.

- Planning branch: `pilot/gym-platform`; approved design commit: `3cd7dd32`; inspected upstream-derived baseline: `7a3ace53`.
- One active gym per member, one paying gym initially, approximately 20–30 adult members, plus a second test organisation.
- Trainers see only assigned members' eligible current-membership workouts. No historical imports, body measurements, photos, private settings, or lifetime statistics.
- Plans require member acceptance. Completed history is immutable through proposal operations.
- Native pilot apps use fixed-backend browser sign-in and existing pairing codes. Public store launch and verified invitation deep links are deferred.
- Invoices are manual. Provider, domain, branding, media licence, signing accounts, dates and recovery objectives remain launch inputs.

This plan does not authorise production purchases, publication, customer communication, or starting implementation before the execution handoff. Prepare implementation in a dedicated worktree on a task branch rooted at `pilot/gym-platform`; the design and plan were written in the user's requested checkout. Do not move or discard unrelated work. In particular, the existing untracked root `AGENTS.md` belongs to the earlier contributor-guide task.

All paths below are repository-relative. New file names describe intended locations; they do not claim those files already exist. Keep JavaScript/JSX and existing style. Use only the dependencies justified here; select and lock the object-storage SDK when the provider is known.

For each behaviour task, execute the five numbered steps in order: failing test, targeted failing run, implementation, passing run, focused commit. Small tests/refactors should take minutes; do not turn a migration of many authentication routes into one unreviewable commit. Split the explicitly listed route groups into successive commits while keeping each step testable. Do not add implementation-mirroring tests for documentation or configuration-only edits.

## Delivery Sequence

| Milestone | Tasks | Exit condition |
| --- | --- | --- |
| Baseline and persistence | 1–9 | File mode still passes upstream checks; PostgreSQL state/auth survives restart and conflicts correctly |
| Gym boundaries | 10–13 | Membership, invitations and trainer projections resist cross-gym access |
| Plan workflow | 14–16 | Shared import behaviour, versioned proposals and atomic acceptance |
| Web and mobile | 17–21 | Owner/trainer/member flows and account-safe offline native behaviour |
| Operational readiness | 22–25 | Uploads, migration, rights/branding and CI gates are ready |
| Release rehearsal | 26–27 | Restore, upstream integration and physical-device pilot checks pass |

These are dependency gates, not calendar estimates. Do not promise a launch date until storage/authentication extraction and account/signing prerequisites are understood.

## Task 1: Record the Fork Boundary and Upstream Workflow

**Files:** Create `docs/dev/PILOT_CUSTOMISATIONS.md`, `docs/dev/PILOT_UPSTREAM.md`; read `.github/workflows/test.yml`, `.github/workflows/mirror.yml`, `.github/workflows/docker-publish.yml`, `.github/workflows/ios.yml`, `.gitlab-ci.yml`.

1. Record `git status --short`, `git remote -v`, and `git log -1 --oneline`. Inventory modified upstream touchpoints rather than guessing a plugin boundary.
2. Add an `upstream` remote for `https://github.com/DuarteSantos8/openGym.git` if absent. If already present, verify its destination before fetching. Fetch without merging or pushing. Record the actual fetched SHA separately from the inspected baseline.
3. Document the product branch and integration-branch workflow. Audit inherited publication destinations: the mirror job already has an upstream-repository guard; Docker publishing can publish under the fork owner. Keep release actions gated until product destinations are explicit.
4. Establish the baseline using Node 22 and lockfiles: `npm --prefix frontend ci`, `npm --prefix api ci --omit=optional`, `npm --prefix mcp ci`, then the existing suites and frontend build. Record failures with their environment and commit; do not label unrun tests green. Run the locale check as `(cd frontend && node scripts/check-locales.mjs)`.
5. Commit only the new documentation: `Docs: record pilot boundaries and upstream update procedure`.

The customisation map must list `api/server.js`, `api/Dockerfile`, `frontend/src/App.jsx`, `frontend/src/store/useStore.js`, `frontend/src/sheets.jsx`, `frontend/src/lib/plan-share.js`, `web/Dockerfile`, and native build configuration, with reason, owner module and protecting tests. Expand it whenever a new upstream file is touched.

## Task 2: Add Product Configuration and Isolated PostgreSQL Tests

**Files:** Create `api/platform/config.js`, `api/storage/postgres.js`, `api/scripts/migrate.mjs`, `api/migrations/001_identity_state.sql`, `api/test/platform/config.test.js`, `api/test/storage/helpers.mjs`, `api/test/storage/migrations.test.js`, `deploy/pilot/compose.test.yml`; modify `api/package.json`, `api/package-lock.json`.

1. Write tests that product mode rejects missing database/session configuration, that a missing test database fails loudly, and that running migrations twice applies each migration once.
2. Run `node --test api/test/platform/config.test.js api/test/storage/migrations.test.js`. Expected: failure from missing modules before implementation, never a silent database-test skip.
3. Add `pg` through the package manager, then lock it. Create a PostgreSQL 17 test container on `127.0.0.1:55432`, database/user/password `pilot_test`, with a health check and a disposable test volume. Use per-test random schemas with identifier validation and drop only the schema created by that test. Require the test database name to be `pilot_test` to avoid pointing teardown at production. Migration bookkeeping stores filename and checksum; changed applied migrations fail.
4. Start with `docker compose -p pilot-tests -f deploy/pilot/compose.test.yml up -d --wait`. Set `TEST_DATABASE_URL=postgres://pilot_test:pilot_test@127.0.0.1:55432/pilot_test` locally, then rerun the two tests. Expected: PASS; migrations leave the second run unchanged.
5. Commit: `Pilot: add configuration and PostgreSQL test harness`.

Add package scripts explicitly: `test:storage` runs `node --test test/storage/*.test.js`; `test:platform` runs `node --test test/platform/*.test.js`; `migrate` runs `node scripts/migrate.mjs`. Existing `npm test` remains the upstream suite. New directories are not matched by its current `test/*.test.js` glob.

Use the same checked-out client for every statement in a transaction, as required by [node-postgres](https://node-postgres.com/features/transactions). The transaction helper starts with this complete implementation:

```js
export async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch { /* Preserve the original operation error. */ }
    throw error;
  } finally {
    client.release();
  }
}
```

No `pool.query` inside transaction bodies. Validate connection configuration and require proper TLS verification for the eventual production database.

## Task 3: Extract the Existing State-Write Rules Without Changing Them

**Files:** Create `api/state/prepare-write.js`, `api/test/storage/state-contract.test.js`; modify `api/server.js`, `api/Dockerfile`; use existing `api/sync-stamps.js`, `api/test/server-data-rev.test.js`, `api/test/server-data-wid.test.js`, `api/test/server-state-cache-bounds.test.js`.

1. Add contract cases for `active` removal, unknown fields, reset markers, stale revision, stale write ancestry, legacy writes without revisions, and the extra revision increment used when server stamps change a legacy document. Use fixed clock/write-ID dependencies for determinism.
2. Run `node --test api/test/storage/state-contract.test.js`; expect failure until the extracted function exists.
3. Move the current validation/stamping body into `prepareWrite(current, request, { nextWriteId })`. Preserve the current status/response fields, including `forClient` filtering. Move code, do not rewrite it from this summary. Return a prepared document or structured conflict/validation result; persistence occurs in its caller. Add `COPY state ./state` to the API image.
4. Rerun the new contract and named upstream tests. Expected: equivalent states and wire responses. Do not change the legacy unconditional-write contract as a side effect; gym endpoints independently enforce strict preconditions.
5. Commit: `Storage: extract upstream state-write semantics`.

Contract examples: a request with `baseRev: '4'` does not equal numeric revision `4`; equal revision with an unrelated `baseWid` returns 409; a malformed state does not erase stored workouts. Never acknowledge persistence until the store commits.

## Task 4: Put File State Access Behind an Async Interface

**Files:** Create `api/storage/state-file.js`, `api/storage/index.js`, `api/test/storage/file-state.test.js`; modify `api/server.js`, `api/Dockerfile`.

1. Write file-adapter tests for read/missing/unreadable distinctions, atomic compare-and-write, durable persistence and cache invalidation after same-size writes.
2. Run `node --test api/test/storage/file-state.test.js`; expect missing adapter failure.
3. Implement `readMemberState(uid)`, `readMemberRevision(uid)`, and `updateMemberState(uid, work)` using existing durable-write and cache semantics. `work` receives the current document and returns the prepared replacement/result; it must execute under the adapter's per-user write serialisation. Convert state endpoint callers to `await` without weakening errors. Keep production file mode restricted to one process.
4. Run file tests, all `api/test/server-data*.test.js`, state-cache tests and the complete API suite. Expected: the default self-hosted behaviour remains intact.
5. Commit: `Storage: route member state through the file adapter`.

## Task 5: Implement Transactional PostgreSQL Member State

**Files:** Create `api/storage/state-postgres.js`, `api/test/storage/postgres-state.test.js`, `api/test/storage/postgres-sync-http.test.js`; modify `api/storage/index.js`, `api/migrations/001_identity_state.sql` if still unapplied outside test, otherwise add a migration.

1. Use real database tests for two writers at the same revision, two first writes to an absent document, restart persistence, and restored ancestry conflicts. Include a full HTTP contract comparison with file mode.
2. Run `npm --prefix api run test:storage`; expect missing PostgreSQL adapter failures, not connection-error assertions mistaken for success.
3. Create `member_states(user_id text PRIMARY KEY REFERENCES users(id), document jsonb, revision bigint NOT NULL DEFAULT 0, write_id text)`. Null document means no saved state. Lock the existing user row before creating/locking the state row so first-write races serialize. Run `prepareWrite` and the SQL update in one transaction. Preserve the JSON revision and SQL revision consistently; validate numeric values before converting PostgreSQL bigint strings to JavaScript numbers. Do not use an authoritative process-local state cache in product mode.
4. Rerun both adapters' contract tests and the HTTP tests. Exactly one concurrent conditional write succeeds; the other receives current state in a 409. Compare parsed structures rather than raw JSON bytes: [JSONB changes object-key ordering and whitespace](https://www.postgresql.org/docs/17/datatype-json.html). Explicitly test unsupported JSONB strings such as embedded NUL; reject safely and report migration incompatibility rather than silently sanitising data.
5. Commit: `Storage: persist member state with PostgreSQL transactions`.

## Task 6: Extract Account and Credential Storage

**Files:** Create `api/storage/identity-file.js`, `api/storage/identity-postgres.js`, `api/test/storage/identity.test.js`; modify `api/storage/index.js`, `api/server.js`, `api/Dockerfile`; add `api/migrations/002_credentials.sql`.

1. Test canonical name/email uniqueness, duplicate credential IDs, password-record round trips, unknown account fields, disabled status, session version changes, and account deletion with credential cleanup.
2. Run `node --test api/test/storage/identity.test.js`; expect repository contract failures before implementations exist.
3. Replace the global `db.users`/`db.creds` authority with explicit lookups and transactional mutations. Preserve opaque upstream account fields in JSONB while defining one authoritative location for indexed/revocation fields. Retain upstream credential bytes, counters, transports and backup metadata without lossy conversion. Add uniqueness constraints at the database boundary. Never reload and rewrite an entire JSON-shaped account database per request.
4. Run identity tests against both adapters. Two concurrent registrations for the same canonical identity must not both succeed. A read after a revocation must observe the new database value.
5. Commit each coherent repository slice, then final commit: `Storage: add database-backed identity repositories`.

## Task 7: Adapt Password, Passkey and Account Lifecycle Routes

**Files:** Modify `api/server.js`, `api/password.js` only if an interface requires it; create `api/test/storage/postgres-auth.test.js`, `api/test/platform/account-recovery.test.js`; use upstream password/passkey/account-delete tests as regression references.

1. Add real HTTP flows for registration, login, password change, credential add/remove, reset and account deletion against PostgreSQL. Test changes racing with a password verification or passkey challenge.
2. Run `node --test api/test/storage/postgres-auth.test.js api/test/platform/account-recovery.test.js`; expect current file-specific paths to fail.
3. Convert route groups in separate commits: password registration/login; password/email updates and recovery; passkey registration/login/management; account deletion/export. Perform expensive verification outside locks, then re-read and compare credential/session versions under the transaction before committing. Existing checks such as `readSession(req) !== user` rely on object identity and must become explicit stable ID/version checks when records are freshly loaded.
4. Run each route group's existing tests and new database tests before moving to the next group. Ensure unreadable/unavailable storage fails closed and users retain access after server restart.
5. Commit: `Auth: use transactional identity operations in account routes`.

Gym owners never receive platform password-reset authority. For the pilot, an operator-only recovery procedure verifies the member's identity, uses short-lived reset credentials, revokes prior sessions as appropriate, and writes an audit event. No recovery secrets in logs or URLs stored in analytics.

## Task 8: Preserve Sessions, Pairing and Authentication Challenges

**Files:** Create `api/storage/transient-postgres.js`, `api/test/storage/postgres-device-auth.test.js`; add `api/migrations/003_auth_challenges.sql`; modify session/challenge/pairing/device-link paths in `api/server.js` and `api/device-link.js` as required.

1. Test browser cookies and native bearer tokens, renewal, one-time pairing redemption, expiry, replay, revocation, and two processes attempting to consume the same challenge.
2. Run `node --test api/test/storage/postgres-device-auth.test.js`; expect replay/routing failures until shared storage is used.
3. Keep upstream token semantics and cookie/CSRF/CORS protections. Supply one managed session-signing secret across product instances. Store challenges, pairing codes and device links with expiry and atomic consumption; store hashes rather than reusable plaintext tokens where the exchange allows it. Do not grant a role because a token claims one: resolve current authority on each request. Preserve the distinction between browser and device sessions.
4. Run new tests plus `api/test/server-csrf-bearer.test.js`, `api/test/server-login-csrf.test.js`, `api/test/server-token-refresh.test.js`, `api/test/server-pairing.test.js`, and `api/test/device-link.test.js`. Two simultaneous redemptions yield one success.
5. Commit: `Auth: make pairing and revocation database-aware`.

## Task 9: Inventory and Adapt Remaining State Consumers

**Files:** Create `docs/dev/PILOT_ENDPOINT_MATRIX.md`, `api/test/platform/legacy-surface.test.js`, `api/storage/subscriptions-postgres.js`, `api/storage/audit-postgres.js`; modify `api/server.js`, `api/Dockerfile`; add `api/migrations/004_subscriptions_audit.sql`.

1. Enumerate every route and file reader using `rg -n 'db\.|readState|stateFile|fs\.|startCadence|startWarmup|setInterval' api/server.js api/coach mcp/src`. Mark each supported, platform-only, or unavailable in product mode. Test actual requests to each privileged surface, not only the new routes.
2. Run `node --test api/test/platform/legacy-surface.test.js`; expect legacy paths to expose incomplete product boundaries before adaptation.
3. Adapt user push subscriptions, notification state, nudge reads, health checks, exports, audit records and user deletion to repositories. Keep background work single-owner during the pilot; document process-local timers/presence explicitly. Prevent optional coach/MCP and legacy public-plan/admin routes from bypassing product policy. Disabled features must return an intentional response and be hidden in product UI. A gym role must never satisfy upstream `isAdmin`.
4. Run the route matrix against product mode plus the full upstream API suite in default mode. API health checks test database connectivity in product mode without leaking user counts or secrets. No enabled endpoint reads stale `db.json` as an authority.
5. Commit: `Pilot: close legacy access paths and adapt background consumers`.

**Milestone gate:** No gym UI work until authentication and state round trips work in PostgreSQL and the supported legacy surface is explicitly bounded. The single-process pilot is not a promise of horizontally scalable timers/jobs.

## Task 10: Add Gym, Membership and Assignment Records

**Files:** Create `api/platform/organisations.js`, `api/platform/memberships.js`, `api/platform/assignments.js`, `api/migrations/005_gyms.sql`, `api/test/platform/memberships.test.js`; create `api/scripts/pilot-gym.mjs` for operator provisioning.

1. Test one active member gym, two owners in different gyms, an owner also holding a trainer role, invalid cross-gym assignments, and simultaneous attempts to join two gyms.
2. Run `node --test api/test/platform/memberships.test.js`; expect missing tables/services failures.
3. Create gyms and membership rows with `id`, `gym_id`, `user_id`, `role`, `started_at`, `ended_at`. A person may have separate owner/trainer role rows. Invite records remain separate from active membership. Add these constraints:

```sql
CREATE UNIQUE INDEX one_active_member_gym
ON gym_memberships (user_id)
WHERE role = 'member' AND ended_at IS NULL;

CREATE UNIQUE INDEX one_active_gym_role
ON gym_memberships (gym_id, user_id, role)
WHERE ended_at IS NULL;
```

Assignments reference both membership IDs and the gym. Use composite foreign keys so referencing memberships from another gym is impossible; verify trainer/member roles in the service transaction. End membership by ending assignments and invalidating pending proposals in the same transaction. Provisioning creates no automatic workout access and no upstream administrator flag.

4. Rerun the tests with concurrent transactions and duplicate requests. Historical membership rows survive departure; personal state does not get deleted.
5. Commit: `Pilot: add gym memberships and scoped trainer assignments`.

## Task 11: Centralise Authorisation and Register Scoped Routes

**Files:** Create `api/platform/access.js`, `api/platform/routes.js`, `api/platform/errors.js`, `api/test/platform/access.test.js`, `api/test/platform/isolation-http.test.js`; modify `api/server.js`, `api/Dockerfile`.

1. Build HTTP fixtures for gym A owner/trainer/member, gym B owner/trainer/member, a reassigned trainer, and an authenticated outsider. Test every new route with another gym's identifiers, stale sessions and forged role fields.
2. Run `node --test api/test/platform/access.test.js api/test/platform/isolation-http.test.js`; expect absent routes/policies to fail.
3. Resolve principals from stored identity, then current membership and assignment. All resource lookup queries include ownership/gym conditions. Use 401 for absent authentication, 403 for known prohibited actions, and 404 for inaccessible cross-gym resources to avoid exposing existence. Preserve CSRF/origin checks for browser mutations. Initial route contract:

| Route | Permission/result |
| --- | --- |
| `GET /api/platform/me` | Authenticated member's roles, current gym and proposal summary; no private staff projection |
| `GET /api/platform/gyms/:gymId/members` | Owner's scoped member list |
| `POST /api/platform/gyms/:gymId/invitations` | Owner, validated intended role |
| `POST /api/platform/invitations/redeem` | Authenticated recipient, transactional invitation consumption |
| `POST /api/platform/gyms/:gymId/assignments` | Owner, same-gym active memberships |
| `DELETE /api/platform/gyms/:gymId/assignments/:id` | Owner, immediate revocation |
| `POST /api/platform/gyms/:gymId/memberships/:id/end` | Owner, end membership without deleting personal identity |
| `GET /api/platform/clients` | Trainer's current assignments only |
| `GET /api/platform/clients/:membershipId/workouts` | Filtered projection for a currently assigned member |

Keep route dispatch separate from the existing map while reusing request parsing, response helpers and security checks. Gym selection is never accepted as authorisation.

4. Run isolation tests plus the legacy-surface matrix. A member may update arbitrary unknown fields in their personal document, but fields named `admin`, `gym_id` or `roles` never affect server authority.
5. Commit: `Pilot: enforce gym and assignment boundaries at the API`.

## Task 12: Implement Single-Use Invitations

**Files:** Create `api/platform/invitations.js`, `api/migrations/006_invitations.sql`, `api/test/platform/invitations.test.js`; modify `api/platform/routes.js`, `api/platform/memberships.js`.

1. Test expired, revoked, consumed and cross-gym invitations, two simultaneous redemptions, wrong intended recipient where bound, and an existing member attempting to join another gym.
2. Run `node --test api/test/platform/invitations.test.js`; expect failure before implementation.
3. Generate high-entropy invitation tokens; store only their hashes. Bind each invite to gym, role, expiry and optional verified recipient identity. Display gym/role before confirmation. A possession-based invite must be explicitly described as such and revoked if forwarded unexpectedly; do not pretend an unverified email establishes identity. Consumption and membership creation use one transaction. For brand-new accounts, integrate token verification with the existing registration path without granting global signup or treating an upstream instance invite as a gym invitation. Preserve the token across authentication only in a short-lived local/session context, then clear it.
4. Rerun tests. An already-consumed token may show a safe success state only to its recorded redeemer; it cannot enrol a second account. Ending gym membership does not disable the user's personal account.
5. Commit: `Pilot: add transactional gym invitations`.

## Task 13: Record Workout Visibility and Return Restricted Projections

**Files:** Create `api/platform/workout-visibility.js`, `api/platform/workout-projection.js`, `api/migrations/007_workout_visibility.sql`, `api/test/platform/workout-visibility.test.js`, `api/test/platform/workout-projection.test.js`; modify product state-write integration in `api/server.js` and `api/platform/routes.js`.

1. Test pre-join workouts, imports with recent dates, editing an old workout, restore after reset, offline uploads after departure, forged membership IDs, and missing context. Seed private bodyweight/photos/settings and verify they never appear in trainer JSON or derived progress.
2. Run `node --test api/test/platform/workout-visibility.test.js api/test/platform/workout-projection.test.js`; expect missing boundary failures.
3. Implement `seen_workout_ids(user_id, workout_id)` and immutable membership associations outside the member document. Snapshot known IDs at membership join; normal personal sync also records IDs. Add optional `platformRecordings` metadata alongside `state` in the product PUT envelope, not inside the workout document. Only the authenticated member may submit a new-recording event with membership context captured when recording starts. In the same transaction as the state write, inspect existing IDs before recording new ones, validate the event and membership, then save the state, visibility decision and event result together. Require the membership to belong to that user and still be active when granting visibility; previously seen private IDs cannot be reclassified. An expired membership event may accompany a successful personal sync but grants no staff visibility. A referenced workout absent from the submitted state gets a deferred result; an event never creates a fabricated workout. Retries return the stored event result.

Historical imports/restore do not create recording events. Missing, stale or ambiguous events remain private. The server validates ownership and eligibility, but cannot prove a real-world workout date reported by an offline device; do not present this as protection against a member deliberately re-entering their own old data. It must prevent automatic import exposure and staff-authorised relabelling.

Projection reads join current active assignment, current membership and visibility records. Return explicit fields: workout identifier/date, exercise catalogue identifier, recorded set repetitions/load/time and completion state needed by the pilot. Do not spread `...workout` or `...entry`; exclude notes, photos, bodyweight, target profiles, private metadata and lifetime PR fields. Label unknown custom exercises generically until a safe exercise-label projection is specified. Progress is computed from these visible records, not upstream lifetime summaries. Deleted workouts stop appearing even if visibility records remain.

4. Run tests plus actual trainer HTTP requests. Revoking assignment in a second connection must deny the next request using the same session. Editing an old date or re-importing a previously private ID must not grant visibility.
5. Commit: `Pilot: project only eligible assigned-member workouts`.

## Task 14: Extract a Shared, Deterministic Plan-Import Core

**Files:** Create `api/shared/plan-import.js`, `api/test/platform/plan-import.test.js`, `frontend/src/platform/plan-import.test.js`; modify `frontend/src/lib/plan-share.js`, `frontend/src/lib/plan-share.test.js`, `web/Dockerfile`, `api/Dockerfile`.

1. Add round-trip cases for units, rest prescriptions, drop sets, rest-pause, warmups, custom exercise remapping and unrelated routines. Run the same fixtures in Node and Vitest. Verify importing with a supplied ID map is deterministic.
2. Run `node --test api/test/platform/plan-import.test.js` and `npm --prefix frontend test -- src/lib/plan-share.test.js src/platform/plan-import.test.js`; expect the new shared contract to fail.
3. Extract parser/normalisation/merge logic used by `parsePlan` and `mergePlan` into a runtime-neutral module. Keep printing and browser UI in the existing file, preserving its public exports. Pass translation, catalogue lookup and ID allocation as dependencies where needed; do not import browser-only JSX, navigator, DOM or Vite-only modules into the API. Move shared pure helpers as necessary, recording each additional upstream touchpoint. Existing callers retain random IDs by default. Product acceptance supplies stable IDs and receives routine/custom-exercise mappings. Copy `api/shared` into both image build contexts.

Use this complete server-side ID helper for proposal imports, with an explicit collision check against unrelated existing records:

```js
import { createHash } from 'node:crypto';

export function proposalEntityId(userId, versionId, kind, sourceId) {
  const bytes = JSON.stringify([userId, versionId, kind, sourceId]);
  return 'gp_' + createHash('sha256').update(bytes).digest('hex').slice(0, 24);
}
```

Do not copy a second progression engine or silently drop unsupported prescription fields. An unsupported plan must be refused with a specific compatibility error.

4. Rerun both suites and `node --input-type=module -e "await import('./api/shared/plan-import.js')"`. Expected: plain Node import succeeds, existing export/import tests still pass, completed workouts are byte-for-byte unchanged as parsed objects.
5. Commit: `Plans: share import rules and allow stable proposal identifiers`.

## Task 15: Persist Versioned Plan Proposals

**Files:** Create `api/platform/proposals.js`, `api/migrations/008_plan_proposals.sql`, `api/test/platform/proposals.test.js`; modify `api/platform/routes.js`.

1. Test assigned-trainer creation, unauthorised creation, malformed/oversized plan bundles, immutable versions, member decline, superseded versions and reassignment while pending.
2. Run `node --test api/test/platform/proposals.test.js`; expect missing service failures.
3. Store immutable normalised bundle versions with source trainer, gym and recipient membership. Use `POST /api/platform/clients/:membershipId/proposals`, `GET /api/platform/proposals`, `GET /api/platform/proposals/:versionId`, and `POST /api/platform/proposals/:versionId/decline`. Never mutate a published version. Tie updates to the previous accepted version's mapping. Pending versions from ended assignments are invalidated, and a new trainer must send their own proposal. Decisions are recipient-only.
4. Rerun tests, including accessing a valid proposal ID as another member. No proposal response contains unrelated personal state or media credentials.
5. Commit: `Pilot: add versioned trainer plan proposals`.

## Task 16: Make Acceptance Atomic, Idempotent and Conflict-Aware

**Files:** Create `api/platform/accept-proposal.js`, `api/test/platform/accept-proposal.test.js`; modify `api/platform/routes.js`, `api/shared/plan-import.js`; add `api/migrations/009_plan_acceptances.sql`.

1. Test simultaneous acceptance, timeout after commit followed by retry, stale member revision, membership termination racing acceptance, and proposal updates after the member edits an accepted routine. Verify untouched historical workouts and unrelated routines.
2. Run `node --test api/test/platform/accept-proposal.test.js`; expect missing transaction failures.
3. Add `POST /api/platform/proposals/:versionId/accept` accepting `baseRev`, `baseWid` and the explicit scheduling/replacement choice. In one transaction: lock affected user rows in stable ID order, then membership/assignment/proposal/state records in a documented order; revalidate authority; check for an existing acceptance; check revision; apply shared import with stable IDs; apply existing sync stamps; update state; write acceptance and mapping. Membership-ending and assignment-changing transactions follow the same lock order. No network calls or password hashing inside these locks.

The unique acceptance key is `(member_user_id, proposal_version_id)`. Retrying an accepted version returns its original mapping plus the latest personal state/revision, never a stale stored state snapshot that could roll the client back. Accepted status is not undone by later revocation, but revocation blocks new acceptance. An update explicitly replaces only routines mapped to its predecessor; if member edits differ from the preview, return a conflict and show a refreshed preview for consent. Never silently clear the entire weekly schedule: preserve unrelated slots and require confirmation for each changed slot. Active workouts keep their existing prescription snapshot.

4. Rerun tests across separate database connections. Expected: one acceptance row, one set of imported routines, unchanged history and no partial commits when a write fails.
5. Commit: `Pilot: accept plan proposals in one revision-checked transaction`.

## Task 17: Add Product API Context and Route Entry Points

**Files:** Create `frontend/src/platform/config.js`, `frontend/src/platform/api.js`, `frontend/src/platform/useGym.js`, `frontend/src/platform/Routes.jsx`, `frontend/src/platform/context.test.jsx`; modify `frontend/src/App.jsx`, `frontend/src/views/Settings.jsx`.

1. Test two accounts on the same browser, role changes on refresh, denied staff routes, and upstream mode without product configuration. Ensure gym roles are not read from `S` or persisted as authority.
2. Run `npm --prefix frontend test -- src/platform/context.test.jsx`; expect missing modules.
3. Fetch `/api/platform/me` through existing `api()` so browser cookie/native bearer handling is shared. Keep staff views and roles in a separate ephemeral store. Add one product route/navigation integration point, enabled only by product configuration. Reset context on sign-out, account/server changes, and auth rejection. Fail closed while revalidating a staff route. Hide product-disabled upstream admin/coach surfaces without treating hiding as security.
4. Rerun tests and `npm --prefix frontend run build`. Expected: upstream navigation remains unchanged when product mode is off; unauthorized users cannot navigate into cached staff views.
5. Commit: `Pilot UI: add server-backed gym context and routes`.

## Task 18: Build Owner and Trainer Web Workflows

**Files:** Create `frontend/src/platform/Owner.jsx`, `frontend/src/platform/Trainer.jsx`, `frontend/src/platform/ClientProgress.jsx`, `frontend/src/platform/owner.test.jsx`, `frontend/src/platform/trainer.test.jsx`; modify `frontend/src/platform/Routes.jsx`, relevant `frontend/src/locales/` files.

1. Test invite creation, assignment/reassignment, end-membership confirmation, empty client lists, denied access after reassignment and proposal creation from an existing routine. Test meaningful user outcomes, not component internals.
2. Run `npm --prefix frontend test -- src/platform/owner.test.jsx src/platform/trainer.test.jsx`; expect missing views.
3. Implement owner member/trainer lists and explicit assignment controls. Implement trainer assigned-client lists, online-only progress, and plan proposal creation using `buildPlanBundle` and the existing editor rather than duplicating it. Show unsent work separately from committed proposals. Handle 401, 403, 404, 409 and connectivity loss with specific UI states. Do not store staff projections in localStorage, native files, service-worker caches or general member exports.
4. Rerun tests, build, and locale checks from `frontend/`. Exercise owner and trainer flows in a browser using both gyms; losing connectivity hides staff data until access can be revalidated.
5. Commit: `Pilot UI: add gym administration and trainer workflows`.

## Task 19: Add Member Invitation and Proposal Acceptance Screens

**Files:** Create `frontend/src/platform/JoinGym.jsx`, `frontend/src/platform/Proposals.jsx`, `frontend/src/platform/accept-plan.js`, `frontend/src/platform/member.test.jsx`; modify `frontend/src/platform/Routes.jsx`, `frontend/src/store/useStore.js`, relevant locales.

1. Test auth-then-invite continuity, joining while already enrolled, proposal decline, explicit update preview, offline refusal, conflict retry and a response lost after successful acceptance.
2. Run `npm --prefix frontend test -- src/platform/member.test.jsx`; expect missing screens/orchestration.
3. Present gym and role before joining. Show proposed routines and schedule changes before acceptance. Flush/reconcile pending personal sync and capture the acknowledged revision; call acceptance; adopt/merge the authoritative result through the existing sync state machine. Do not set dirty flags or revision metadata by hand in the view. Add a narrow store method for an external server-side state mutation. If a local edit occurs during the request, preserve it and merge before the next push. Pause acceptance while an active workout would be affected, or explicitly defer changes until it finishes.
4. Run new tests plus existing store sync/conflict and plan-import suites. A failed request keeps the local workout and pending proposal intact. A second successful retry does not duplicate routines.
5. Commit: `Pilot UI: join gyms and accept proposals safely`.

## Task 20: Persist Membership Context for Newly Recorded Workouts

**Files:** Create `frontend/src/platform/workout-context.js`, `frontend/src/platform/workout-outbox.js`, `frontend/src/platform/workout-context.test.js`; modify `frontend/src/sheets.jsx`, `frontend/src/store/useStore.js`, `frontend/src/lib/mobile.js` only for the necessary persistence hook.

1. Test starting offline with known membership, starting before joining, completion after leaving, imported history, backup restore, edit-existing-workout, browser restart and native restart. Exercise account A signing out with pending work before account B signs in.
2. Run `npm --prefix frontend test -- src/platform/workout-context.test.js`; expect missing outbox/context integration.
3. Capture current account/server/membership context when a new recording starts. Persist it alongside the active session without placing authority inside the personal document. Only the new-session completion path enqueues a visibility event; imports and history edits do not. Keep a bounded, durable outbox keyed by account/server and workout ID, mirrored to native storage. Attach matching pending events as `platformRecordings` to the same personal-state PUT; consume its per-event results only after the transaction succeeds. Never send state first and attempt to reclassify a newly private ID afterwards. Unknown membership or an unrecoverable event means private logging, never guessed gym association. Stage the event before scheduling sync; crash tests must preserve personal workout data even when visibility cannot be established.
4. Rerun tests and existing finish-workout/account-switch tests. On reconnection after membership ends, personal history sync succeeds while staff visibility remains denied. Explicit account deletion cleans its context/outbox; normal logout preserves unsent personal work under the original account.
5. Commit: `Pilot: retain account-safe workout membership context offline`.

## Task 21: Adapt Native Onboarding to the Fixed Backend

**Files:** Create `frontend/src/platform/MobileOnboarding.jsx`, `frontend/src/platform/mobile-onboarding.test.jsx`; modify `frontend/src/App.jsx`, `frontend/src/views/MobileOnboarding.jsx` only for reusable exports if needed, `frontend/src/lib/remote.js` only where an integration seam is necessary.

1. Test fixed HTTPS backend, malformed configuration, external-browser sign-in link, expired/reused pairing code, native token persistence, token refresh and switching accounts with unsynced work.
2. Run `npm --prefix frontend test -- src/platform/mobile-onboarding.test.jsx`; expect missing product onboarding.
3. Select the product screen through the existing onboarding gate. Provide browser sign-in instructions and pairing-code entry; omit arbitrary server and Cloudflare credential fields in the product screen. Reuse `connect`, secure token persistence and existing renewal. Do not add a browser password field inside the native webview or invent native passkeys during this pilot. Invitation redemption occurs in the authenticated browser, followed by pairing the same identity.
4. Rerun the tests and mobile bundle checks after Task 24 supplies a safe build profile. Physical-device checks remain mandatory in Task 27; simulated browser tests are insufficient.
5. Commit: `Mobile: add fixed-service pilot pairing onboarding`.

## Task 22: Move Private Uploads Behind an Object-Storage Adapter

**Files:** Create `api/storage/objects.js`, `api/storage/objects-s3.js`, `api/platform/uploads.js`, `api/test/platform/uploads.test.js`; modify `api/media.js`, `api/server.js`, `api/Dockerfile`, `api/package.json`, `api/package-lock.json`; add `api/migrations/010_uploads.sql`.

1. Test guessed hashes/object keys from another account, reference to a private photo in trainer-visible data, failed upload finalisation, rejected MIME/size, account deletion, and missing objects after restore.
2. Run `node --test api/test/platform/uploads.test.js`; expect failure until the product object adapter exists.
3. Reuse existing sniffing, limits, sanitised media references and mobile URL behaviour. Add an ownership table mapping `(user_id, media_hash)` to private object keys; hash knowledge alone grants no access. Use an adapter with `put`, `get`, `delete` and `exists`. If the selected provider supports S3, add the pinned `@aws-sdk/client-s3` dependency and use parameterised configuration. Keep buckets private. Proxy authenticated reads through the API for the pilot so access is checked per request; do not publish permanent object URLs. Finalise references only after a successful upload; use a resumable cleanup job for orphaned or deleted objects because SQL and object storage cannot share one atomic transaction.
4. Run new tests plus existing media API suites. Verify uploaded media never appears in trainer projections and that switching accounts on native apps does not reuse another account's media access.
5. Commit: `Storage: isolate private uploads in object storage`.

## Task 23: Implement Migration, Export, Deletion and Recovery

**Files:** Create `api/scripts/import-file-store.mjs`, `api/test/storage/import-file-store.test.js`, `api/test/platform/account-lifecycle.test.js`, `docs/ops/PILOT_DATA_RECOVERY.md`; modify migration tooling and platform account lifecycle services.

1. Test dry-run validation, repeated import, interrupted import, malformed source files, unsupported JSONB values, unknown upstream fields, credential counts, state ancestry and private visibility defaults. Test deletion followed by stale offline sync, and restore followed by a newer device reconnecting.
2. Run `node --test api/test/storage/import-file-store.test.js api/test/platform/account-lifecycle.test.js`; expect missing importer/lifecycle guarantees.
3. Implement a source-read-only importer with `--dry-run` and explicit `--apply`. Produce counts/checksums without printing account data or secrets. Preserve user IDs, credentials and valid state fields. Use source fingerprints/checkpoints to refuse inconsistent reruns and require a maintenance window for final cutover. Import no gym visibility automatically. Make export include personal history plus applicable proposal/membership records through an explicit documented format; never include credentials or other users' data.

Account deletion revokes sessions, removes memberships/assignments, schedules object cleanup and prevents an old token restoring data. Define an audit retention policy without retaining unnecessary personal content. Secrets must be restored through the secure configuration channel. Existing passkeys remain usable only if their relying-party identity is preserved; changing domains requires an explicit re-enrolment/recovery path, not a promise that copying credentials is enough.

4. Run importer twice against a fixture backup and compare record counts and parsed state. Perform an isolated restore with database, objects and configuration. Document recovery steps and the effect on writes since the backup. No command may overwrite the only production copy or restore into a live writable service.
5. Commit: `Pilot: add validated migration and account recovery runbook`.

## Task 24: Create Product Build, Branding and Media-Rights Gates

**Files:** Create `frontend/scripts/build-pilot.mjs`, `frontend/scripts/check-pilot-bundle.mjs`, `frontend/scripts/check-pilot-bundle.test.mjs`, `deploy/pilot/product.example.json`, `docs/ops/PILOT_MOBILE_RELEASE.md`; modify `frontend/package.json`, `frontend/vite.config.js`, `frontend/capacitor.config.json` integration, `frontend/android/app/build.gradle`, `frontend/android/app/src/main/AndroidManifest.xml`, `frontend/android/app/src/main/res/values/strings.xml`, `frontend/ios/App/App.xcodeproj/project.pbxproj`, `frontend/ios/App/App/Info.plist`, `frontend/ios/App/App/App.entitlements`, `web/Dockerfile`, `scripts/catalogue/stage-media.mjs`.

1. Inventory identifiers and rights-sensitive assets across all native targets and build scripts. Test missing product identity, accidental upstream backend URLs, restricted-media inclusion without a licensed manifest, and incorrect extension/app-group identifiers. Product tests should inspect actual generated bundles/manifests, not just source strings.
2. Run `node --test frontend/scripts/check-pilot-bundle.test.mjs`; expect absent product-build checks.
3. Add `build:pilot` and `build:mobile:pilot` scripts. Generate product configuration from explicit inputs and keep upstream defaults intact. Android already has a `channel` flavor dimension; add a product identity configuration without blindly assuming `assemblePilotDebug` exists or renaming every Java package. Android application ID and Java namespace can be handled separately. For iOS, configure bundle IDs, signing, app groups and URL/capability references for each enabled target. Inventory `OpenGymWidgets`, `Watch`, `WatchWidgets` and `AnimationPacksDownloader` targets and entitlements; either configure them for this product or explicitly exclude unsupported targets from the pilot build. Use `xcodebuild -list -workspace frontend/ios/App/App.xcworkspace` to record the actual scheme.

Do not copy Gym visual assets into product artifacts until the commercial rights route is resolved. Product build must select an approved licensed asset manifest, owned replacements, or a text-only/placeholder mode that excludes restricted media from web images and native bundles. Turning off image display is insufficient. Check asset packs, compiled resources, downloads, default URLs and the web image's existing `COPY catalogue/media/` path. Include required upstream attribution and a working source offer for the exact distributed product version. No claims of legal clearance solely from passing a bundle test.

4. Run `npm --prefix frontend run build:pilot`, `npm --prefix frontend run build:mobile:pilot`, and the bundle checker with test identity/rights fixtures. Inspect Android/iOS outputs and record the selected build variant/scheme in the release runbook. Signed distribution waits for real developer accounts and identifiers.
5. Commit: `Build: add isolated pilot branding and asset checks`.

## Task 25: Extend CI for Product and Upstream Compatibility

**Files:** Create `.github/workflows/pilot-test.yml`, `api/scripts/check-platform-loadable.mjs`, `docs/dev/PILOT_COMPATIBILITY.md`; modify `.github/workflows/test.yml` branch/path coverage, `api/Dockerfile`, `web/Dockerfile`; review `.github/workflows/ios.yml`, `.github/workflows/docker-publish.yml`, `.github/workflows/pages.yml`, `.gitlab-ci.yml` before enabling product publication.

1. Add CI jobs with a disposable PostgreSQL service for `test:storage` and `test:platform`, and a product web build. Include triggers for `pilot/**`, integration branches, new platform/shared/storage/migration/deployment paths and the workflow itself. Verify the effective workflow configuration; documentation-only edits need no artificial unit test.
2. Preserve the current frontend/API/MCP jobs and required checks. Add `node api/scripts/check-platform-loadable.mjs` to import shared/product modules under plain Node. The public API image must copy all new imported directories and SQL migrations; boot it against PostgreSQL as well as file mode.
3. Keep publication separate and gated. Prevent integration branches from publishing mutable production tags, signing with upstream identities or sending mirrors. Product images carry the product SHA, upstream SHA and schema version; image builds alone are not proof of a runnable service.
4. Run the verification commands below in the intended CI environment and record results. Add two supported client-build fixtures: current pilot and previous supported pilot. Preserve unknown state fields and make incompatible API changes fail the compatibility job.
5. Commit: `CI: verify product boundaries alongside upstream behaviour`.

```bash
npm --prefix frontend test
npm --prefix frontend run build
(cd frontend && node scripts/check-locales.mjs)
(cd frontend && node scripts/check-source-strings.mjs)
npm --prefix frontend run test:fatigue-probe
npm --prefix api test
npm --prefix api run test:storage
npm --prefix api run test:platform
npm --prefix mcp test
npm --prefix mcp run check:node-loadable
node api/scripts/check-core-loadable.mjs
node api/scripts/check-platform-loadable.mjs
node scripts/build-coach-assets.mjs --check
node scripts/build-api-docs.mjs --check
npm --prefix frontend run build:pilot
```

The root API-doc generation check requires the root lockfile dependencies. New native bundle checks run only after product build configuration is supplied. Existing source-string checking is report-only; do not quietly change its global backlog policy while adding pilot strings.

## Task 26: Prepare Shared Deployment and Rehearse an Upstream Merge

**Files:** Create `deploy/pilot/compose.yml`, `deploy/pilot/Caddyfile.example`, `deploy/pilot/.env.example`, `docs/ops/PILOT_RUNBOOK.md`, `docs/ops/PILOT_RELEASE_MANIFEST.example.json`; update `docs/dev/PILOT_UPSTREAM.md` and `docs/dev/PILOT_CUSTOMISATIONS.md`.

1. Define one shared web/API deployment, managed PostgreSQL connection, private object-storage configuration, HTTPS ingress and secrets references. Example files contain placeholders only. Keep staging isolated from production identity, data, buckets and signing. Deploy no resources without actual account/domain inputs and authorisation.
2. Configure availability/database/failed-sync/failed-acceptance/backup alerts, bounded logs and a documented single-owner background-job process. Select recovery objectives with the gym, then configure backups and retention to meet them. Restore into an isolated service and verify authentication, personal history, proposal mappings and object references. Record the last successful restore and observed recovery time.
3. In an implementation worktree, fetch upstream and create `integration/upstream-YYYY-MM-DD` from the product branch. Merge the selected upstream SHA there, inspect changed authentication/state/import/native files against the customisation map, and run Task 25 checks. Resolve semantic changes instead of simply choosing our version in conflicts. If there is no newer commit, rehearse against an earlier baseline and document the limitation.
4. Exercise the release/rollback procedure with the current and previous supported mobile builds. Database migration recovery must be verified independently of container rollback. Capture the source commit, upstream commit, image digests, schema version, supported app build numbers and operational limitations in a release manifest.
5. Commit the reviewed deployment templates, runbooks and rehearsal record: `Ops: prepare shared pilot deployment and upstream rehearsal`.

## Task 27: Run the End-to-End Pilot Launch Checklist

**Files:** Create `docs/ops/PILOT_LAUNCH_CHECKLIST.md`; record results in `docs/ops/PILOT_RELEASE_MANIFEST.example.json` only as examples, and in a dated private operational record for real deployments without committing personal data.

1. Provision gym A and gym B in staging. Complete owner invitation, member signup, trainer assignment, proposal creation, acceptance, workout logging, progress viewing, reassignment and membership departure. Test malicious identifier substitutions against every resource type in the endpoint matrix. Confirm owner permissions cannot bypass trainer privacy rules.
2. On a physical Android phone and iPhone, test browser sign-in/pairing, force-close/relaunch, airplane-mode logging, reconnect, account switching with pending uploads, expired pairing, token renewal and installation of the next pilot build over the previous one. A native build that compiles but cannot complete these flows is not launch-ready.
3. Confirm source offer, notices and media rights/removal; resolve pilot agreement/privacy disclosure, operator contact, account recovery, developer accounts, distribution route, provider/domain and backup objectives. Check current official platform distribution requirements at execution time. Confirm invoices and renewal terms with the gym; do not automatically charge members.
4. Review evidence for every design launch gate. Agree business targets for activation, sustained logging, trainer usage, support effort and paid renewal with the owner. Record blockers as blockers; do not substitute a successful demo for isolation, restore or device tests.
5. Commit the non-sensitive checklist and release documentation: `Docs: record pilot launch verification`. Present the concrete release candidate and its evidence for deployment/distribution authorisation.

## Dependencies and Change Control

- Tasks 3–9 are the principal engineering risk: the backend has direct identity/state access and process-local assumptions. Do not hide incomplete routes behind a nominal storage interface.
- Tasks 13 and 20 are one protocol change: state and visibility metadata commit together. Test and release both ends together while keeping older clients private by default.
- Tasks 14–16 must preserve upstream prescription and sync behaviour; stable routine identifiers alone do not solve lost updates.
- Staff data is online-only for this pilot. In-flight responses already authorised and copies previously viewed cannot be remotely recalled; subsequent requests must be checked against current authority.
- A separate approval is needed for changes to the agreed product scope, such as direct trainer edits, full-history sharing, automated billing or public store launch. Routine implementation details within this plan do not require repeated approval.
- Update the customisation map and compatibility fixtures whenever an upstream integration point changes. Keep implementation commits small enough to revert individually, except where schema changes require a coordinated recovery procedure.

## Planning Verification Record

This document is a plan, not an implementation report. The planning work inspected source, package scripts, tests, native configuration and workflows. No application code, database, cloud deployment, native app or production setting was changed while preparing it. Test commands above are instructions for execution; their presence does not mean they have been run or passed.
