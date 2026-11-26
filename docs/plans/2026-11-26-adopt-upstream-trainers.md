# Adopt Upstream Trainers on the Pilot's PostgreSQL Storage

Date: 2026-11-26

Status: Decisions agreed in the planning conversation. Implementation not started. Replaces the
gym, membership, assignment, invitation, proposal and workout-visibility parts of
`2026-10-25-gym-pilot-design.md` (sections 4–6) and `2026-10-25-gym-pilot-implementation.md`.
The storage, identity, uploads, mobile onboarding, branding and hosting parts of those documents
still stand.

Baseline: `pilot/gym-platform` at `d78256972`; upstream `main` at `e4a68a94c` (v1.4.5,
15 Nov 2026), 1,756 commits ahead of the fork point `7a3ace53c`.

## 1. Decision

Upstream built its own trainer system between 05 and 06 Nov 2026 (`api/trainers/*`,
`api/permissions.js`, `api/share-log.js`, `api/consent.js`, `docs/TRAINERS.md`, switched on with
`TRAINERS=on`). The pilot adopts it instead of maintaining `api/platform/`'s parallel model, and
runs it on the pilot's PostgreSQL storage.

| Rule | Pilot design (25 Oct) | Now |
| --- | --- | --- |
| Connecting a member to a trainer | Owner invites and assigns | Trainer gives the member a code (`TR-…`); the member connects and picks what to share; the trainer confirms. A gym lead's code (`GY-…`) joins the gym without a trainer. Upstream as is. |
| History a trainer sees | Only workouts recorded during the membership | The member's whole history, at the level the member grants. Upstream as is. |
| What a trainer may do | Versioned proposals only; never photos or measurements | Upstream levels (Off, See, Suggest, Change directly) per category, chosen by the member, including photos and measurements. Upstream as is. |
| Gyms per member | One active gym | One active gym. **Pilot patch** (section 4). Private trainers without a gym are still allowed alongside it. |
| Gym owner's view of training data | None unless assigned as trainer | `TRAINERS_LEAD_ACCESS=none`: the lead sees names only. |

Nothing is live: no data migration, no re-consent, no second test organisation.

Before launch: the consent text on the sharing screen (`api/consent.js`) now covers full
history, body measurements and progress photos for a paid service. Have its wording reviewed.

## 2. Storage seam

Upstream's trainer code is synchronous: it reads `db.users`, keeps `org.json` in memory, writes
`share/<uid>.json` and member state through files. Product mode keeps identity and member state
in PostgreSQL behind asynchronous stores (`api/storage/index.js`). Every dependency the trainer
modules take from `server.js` becomes asynchronous; the modules `await` them.

| Dependency | Upstream | Product mode | Call sites (main) |
| --- | --- | --- | --- |
| User lookup `userById` | `db.users.find` | `IDENTITY.getUser` | 16 (`trainers/routes.js` 5, `dashboard-routes.js` 9, `permissions.js` 2) |
| Permission check `perms.can()` | sync | `async`, still reads fresh state on every call (no cached `disabled` flags) | 14 |
| Org store (`trainers/org-store.js`) | in-memory object, `mutate(fn)` then `atomicWrite(org.json)` | Same in-memory object, persisted as one JSONB row (`org_documents`, with a `version` column) in a transaction. `mutate` becomes `async` and resolves only after the commit; saves run one at a time through a queue. | 24 mutating calls (`routes.js` 15, `dashboard-routes.js` 6, `server.js` 3) |
| Sharing log (`share-log.js`) | `DATA_DIR/share/<uid>.json` | `share_logs (user_id PK, document jsonb)`, same read-change-write per member in a transaction | ~5 file operations |
| Member state write `writeStateAs(uid, fn)` | sync read, copy, `stampPut`, `_rev+1`, rename | `STATE.updateMemberState(uid, work)` (`api/storage/state-postgres.js`): row locked `FOR UPDATE`, same stamping and `_rev`/`_wid` steps inside `work` | 10 in `dashboard-routes.js` |
| Member state read `readStateCached(uid)` | file cache | `STATE.readMemberState(uid)` | projections, notices (`langOf`) |

File mode keeps upstream's behaviour unchanged: the file-backed implementations wrap the same
sync code in resolved promises.

Single API instance: the org store's in-memory copy is the authority between commits, which holds
for one process only (pilot design section 2 already limits the pilot to one instance). Several
instances would need the org data in tables, read per request. Upgrade path, not pilot scope.

Upstream friendliness: the async seam is a candidate to offer upstream (an injectable store for
`createOrgStore`, `createShareLog`, `createPermissions`). Until it is accepted, the patches to
`api/trainers/*`, `permissions.js` and `share-log.js` are pilot customisations and are listed in
`docs/dev/PILOT_CUSTOMISATIONS.md`.

## 3. Sign-up and gym administration

**Sign-up with a trainer or gym code.** Product mode already refuses sign-up without an invitation
(`refuseSignup` / `joinAfterSignup` in `api/server.js`, `PILOT_OPEN_SIGNUP` as the operator's
bootstrap switch). Those two functions change from gym invitations to upstream codes:

- `refuseSignup` accepts a `TR-…` or `GY-…` code that `org.findCode` finds unexpired, unrevoked
  and with uses left. It does not spend a use.
- `joinAfterSignup` does **not** connect or join. Consent stays explicit: the app opens the
  connect screen (`#/settings/trainer?code=…`) with the code filled in, and the member confirms
  there (`POST /api/sharing/code`, then `/api/sharing/connect`).
- `Login.jsx` keeps the code field; `join-token.js` accepts the upstream code format.

**Gyms and roles by the platform operator.** `productUnavailable` closes `/api/admin/*` except
password reset. Open only the admin routes for gyms and roles: `GET /api/admin/gyms`,
`POST /api/admin/gyms/new`, `/update`, `/staff`, `POST /api/admin/user/trainer`, plus the account
list the Trainer & gym page needs. `ADMIN_DATA_VIEW` stays off, so the list answers counts only.
The frontend opens only upstream's Trainer & gym admin page in the product build; the rest of
the Admin view stays closed. Exact route list to confirm against the merged code.

## 4. One gym per member

Upstream refuses only a second join of the **same** gym (`already-member`). Add one rule in
`org-store.js`: a member with an active membership (`until: null`) in another gym gets
`409 other-gym` from

- `joinGym` (a `GY-…` code), and
- `connect` with a gym trainer's code (it adds the membership).

A private trainer's code (no gym) is unaffected. Leaving a gym (`POST /api/sharing/leave`) ends the
membership, after which another gym can be joined. OIDC role sync (`syncClaimRoles`, `memberOf`)
gets the same check; OIDC is off in the pilot.

## 5. Removed and kept

Removed, since nothing is live and nothing depends on it once upstream's trainers are in:

- `api/platform/`: `access`, `assignments`, `accept-proposal`, `invitations`, `memberships`,
  `organisations`, `plan-catalogue`, `proposal-*`, `proposals`, `workout-projection`,
  `workout-visibility`, and their routes in `platform/routes.js`; their tests in `api/test/platform/`.
- Migrations `005_gyms` to `009_plan_acceptances`. They were never applied to a live database, so
  they are deleted, not reversed; `010_uploads` and `011_import_runs` are renumbered only if the
  migration runner requires contiguous numbers.
- The `platformRecordings` path in `PUT /api/data` (`recordingsProblem`, `recordWorkouts`).
- Frontend `src/platform/`: `Owner`, `Trainer`, `Proposals`, `JoinGym`, `ClientProgress`,
  `accept-plan`, `workout-context`, `workout-outbox`, `useGym`, `Routes` and their CSS and tests,
  and the hooks in `sheets.jsx`, `useStore.js`, `Home.jsx`, `Settings.jsx`, `App.jsx`.
- The plan-import move (T14): `api/shared/plan-import.js` and `plan-rules.js` serve only
  proposals. The 11 `frontend/src/lib/*` files that re-export from them (`plan-share`,
  `pyramid`, `backoff`, `dumbbells`, `units`, `routine-backups`, `media-refs`, `muscles`,
  `superset-meta`, `history`, `progression`) go back to their upstream versions, and `web/Dockerfile`
  stops copying `api/shared`. This removes 11 of the 53 files both branches changed.

Kept: PostgreSQL storage and identity (`api/storage/`, migrations 001–004), product config
(`platform/config.js`), private uploads in object storage (`platform/uploads.js`,
`storage/objects.js`, migration 010), audit retention (`platform/lifecycle.js`), error answers
(`platform/errors.js`), the JSON importer, mobile pairing onboarding (`MobileOnboarding.jsx`),
pilot branding and bundle checks, the Render and Compose deployment.

## 6. Order of work and tests

1. **Remove** (section 5) on `pilot/gym-platform`. Fewer pilot edits in the files upstream also
   changed means fewer merge conflicts. Full api, frontend and mcp suites pass.
2. **Merge** `origin/main` on a separate branch (`merge/main-into-pilot`) in its own worktree.
   Trainers off. Resolve conflicts; inventory every other new file `main` writes under `DATA_DIR`
   (watch relay `watch-<uid>.json`, shared library `shared/`, integrations) and record each as
   adapted, file-backed on the Render disk, or unavailable in product mode.
3. **Seam** (section 2) behind `TRAINERS=on`.
4. **Pilot rules**: one gym (section 4), sign-up with a code and admin gym routes (section 3),
   `TRAINERS_LEAD_ACCESS=none` in `deploy/pilot/`.
5. **Docs**: rewrite `docs/dev/PILOT_CUSTOMISATIONS.md` and `PILOT_ENDPOINT_MATRIX.md`; mark the
   25 Oct design and implementation plan as replaced in their sections 4–6.

Tests:

- Upstream's trainer suites (`server-trainers`, `server-trainer-dashboard`, `trainers-core`,
  `trainer-ops`, `permissions`, `trainer-copy`) pass unchanged in file mode, and run again in
  product mode against the PostgreSQL test harness.
- New: a second gym refused (`other-gym`) through both routes; a private trainer allowed alongside
  a gym; leaving then joining another gym.
- New: sign-up with a valid trainer code succeeds and creates no grant; an expired, used or revoked
  code is refused; a member's connect after sign-up spends the use.
- New: in product mode the gym and role admin routes answer, every other `/api/admin/*` route
  stays 404, and `ADMIN_DATA_VIEW` routes stay closed.
- New: two concurrent org mutations both land (save queue); a failed commit leaves the in-memory
  copy as it was and answers an error, never a success.
- New: a trainer's direct change in product mode raises `_rev` once and survives a concurrent
  `PUT /api/data` from the member's phone (merge, not overwrite).

## 7. Open items

- Whether the migration runner needs contiguous numbers (affects renumbering 010–011).
- The exact admin route list behind the Trainer & gym admin page, read from the merged code.
- Whether upstream would accept the async store seam (section 2); ask before step 3 so it can be
  written in a form they would take.
