# Pilot customisation map

Every upstream file the gym pilot changes, why, which pilot module owns the change, and the tests
that protect upstream behaviour there. Since 26 Nov 2026 the pilot runs upstream's trainer system
(`api/trainers/*`, docs/TRAINERS.md) on its PostgreSQL storage instead of its own gym module:
`docs/plans/2026-11-26-adopt-upstream-trainers.md`. The storage, product build and deployment
parts still follow `docs/plans/2026-10-25-gym-pilot-design.md` sections 1–3 and 7 onward.

Taken against the `main` merged in `dc56b5db0` with `git diff --diff-filter=M dc56b5db0^2 HEAD`.
Files only the pilot adds (`api/storage/`, `api/state/`, `api/platform/`, `api/migrations/`,
`deploy/pilot/`, `render.yaml`, `frontend/src/platform/`, the pilot scripts and tests) are not
listed. Update this table in the same commit that first touches a new upstream file.

## Pilot rules on top of upstream trainers

| Rule | Where | Tests |
| --- | --- | --- |
| A trainer gives the member a code; the member connects and consents. No admin assigns members | upstream as is | upstream trainer suites |
| Trainers may see the member's whole history, at the levels the member chose | upstream as is | upstream trainer suites |
| One active gym per member: `409 other-gym` from `joinGym` and from `connect` with a gym trainer's code; private trainers unaffected; OIDC claims for a second gym skipped | `api/trainers/org-store.js` (`otherGym`, `oneGym`) | `api/test/one-gym.test.js` |
| Sign-up only with a live `TR-`/`GY-` code whose owner may still invite; checked, not spent; then the connect screen | `api/server.js` (`signupCodeLive`, `refuseSignup`), `frontend/src/platform/signup-code.js` | `api/test/platform/trainers.test.js`, `frontend/src/platform/signup-code.test.js` |
| Gym leads see member names only (`TRAINERS_LEAD_ACCESS=none`) | `render.yaml`, `deploy/pilot/compose.yml` | deploy config |
| The operator (`ADMIN_UIDS`) runs gyms, staff and free trainers; every other admin route stays closed | `api/server.js` (`PRODUCT_ADMIN`), `frontend/src/views/Admin.jsx` (`ProductAdmin`) | `api/test/platform/trainers.test.js`, `legacy-surface.test.js` |

## Upstream files the pilot changes

| Upstream file | Reason | Owner module | Protecting tests |
| --- | --- | --- | --- |
| `api/server.js` | Storage seam (state, identity, subscriptions, transient auth in PostgreSQL), async `readSession`/`requireAdmin`; product route gate (`productUnavailable`, `PRODUCT_CLOSED`, `PRODUCT_ADMIN`); trainers on the seam (`accountById`, `withUsers`, `trainerState`, `writeStateAs`/`commitState` through `STATE.updateMemberState`); sign-up with a trainer or gym code; slim product `GET /api/admin/users` | `api/storage/`, `api/state/`, `api/platform/` | `api/test/storage/*`, `api/test/platform/*`, `server-session-required.test.js`, upstream `server-*` suites |
| `api/trainers/routes.js`, `api/coach/routes.js`, `api/library/routes.js`, `api/library/moderation.js`, `api/integrations/routes.js`, `api/oidc/routes.js` | `await` on the now-async `readSession`/`requireAdmin`: an unawaited Promise is truthy and would pass every auth check | `api/server.js` | `server-session-required.test.js`, `test/platform/session-required.test.js` (routes from `openapi.yaml`) |
| `api/trainers/dashboard-routes.js` | `state.read` awaited (8 places), `suggest` async, so member state can come from PostgreSQL | `api/storage/state-postgres.js` | upstream `server-trainer-dashboard`, `test/platform/trainers.test.js` |
| `api/trainers/notify.js` | `langOf` async for the same reason | as above | upstream `trainer-ops`, `server-trainers` |
| `api/trainers/org-store.js` | One gym per member (above) | — | `api/test/one-gym.test.js` |
| `api/media.js` | Upload validation after streaming extracted as `verifyUpload`; `streamToFile`, `drain`, `contentType`, `contentLength`, `capMB` exported for the object store | `api/platform/uploads.js` | `api/test/media-*.test.js`, `server-media.test.js`, `test/platform/uploads.test.js` |
| `api/package.json`, `api/package-lock.json` | `pg` (the one added dependency); `test:storage`, `test:platform`, `migrate` scripts | `api/storage/postgres.js` | CI |
| `api/Dockerfile` | Copies `state/`, `storage/`, `platform/`, `migrations/`, `scripts/migrate.mjs`, the importer; `org.opengym.pilot.*` labels | `api/` build | CI image build and boot |
| `api/test/server-state-read-cost.test.js` | Source-inspection assertions point at the member-state store seam; behaviour assertions unchanged | `api/storage/state-file.js` | itself, `test/storage/file-state.test.js` |
| `api/test/server-push-prune-save.test.js` | Expects the subscription store's error message instead of db.json's | `api/storage/subscriptions-file.js` | itself |
| `.gitignore` | Pilot build outputs and per-environment deploy copies | `frontend/scripts/build-pilot.mjs`, `deploy/pilot/` | — |
| `.github/workflows/test.yml` | `pilot/**` and `integration/**` pushes run upstream checks; `check-platform-loadable.mjs` | `.github/workflows/pilot-test.yml` | the workflow |
| `.github/workflows/docker-publish.yml`, `pages.yml`, `ios.yml` | Publishing, deploying and signing only from upstream refs, never a pilot branch | `docs/dev/PILOT_COMPATIBILITY.md` | the workflows |
| `web/Dockerfile` | `PILOT_PRODUCT` build arg builds the product; media copied into the build stage only for the upstream build | `frontend/scripts/build-pilot.mjs` | CI web build |
| `frontend/vite.config.js` | `dev:pilot` preview; the `pilotUpstream` rewrite drops upstream service addresses from the Coach core the app imports | `frontend/scripts/check-pilot-bundle.mjs` | `check-pilot-bundle.test.mjs`, `build:pilot` |
| `frontend/package.json`, `package-lock.json` | `build:pilot`, `build:mobile:pilot`, `dev:pilot`; `build:mobile` removes a leftover `android/pilot.properties` | `frontend/scripts/build-pilot.mjs` | `check-pilot-bundle.test.mjs` |
| `frontend/android/app/build.gradle`, `settings.gradle`, `src/main/AndroidManifest.xml` | Product `applicationId` and launcher label from the ignored `android/pilot.properties`; without it, upstream unchanged. iOS excluded | `frontend/scripts/build-pilot.mjs` | `check-pilot-bundle.test.mjs`; device checklist |
| `frontend/src/App.jsx` | Product phone onboarding; `/admin` is the gyms and trainers page in the product build | `frontend/src/platform/MobileOnboarding.jsx`, `views/Admin.jsx` | `mobile-onboarding.test.jsx`, `App.*.test.jsx` |
| `frontend/src/views/Admin.jsx` | `ProductAdmin`: upstream's gyms card and a free-trainer list, nothing else | `frontend/src/platform/config.js` | `test/platform/trainers.test.js` (server closes the rest) |
| `frontend/src/views/Settings.jsx` | Admin row only with trainers on in the product build; no upstream updater or APK row | `frontend/src/platform/config.js` | full frontend suite |
| `frontend/src/views/Login.jsx`, `frontend/src/components/PasswordAuth.jsx` | Sign-up code pre-filled from a trainer's QR link; the connect screen opens after sign-up | `frontend/src/platform/signup-code.js` | `signup-code.test.js` |
| `frontend/src/views/Home.jsx`, `AdminCoach.jsx`, `frontend/src/lib/gym-places.js`, `routine-link.js`, `update.js` | Product name instead of openGym; no upstream address in the bundle (OSM user agent, routine links on the pilot's own origin, no release check) | `frontend/src/platform/config.js` | `check-pilot-bundle.test.mjs`, full frontend suite |
| `scripts/catalogue/stage-media.mjs` | `--manifest`: stage exactly a licensed manifest's files, hash-verified | `frontend/scripts/build-pilot.mjs` | `check-pilot-bundle.test.mjs` |

Removed on 26 Nov 2026 (`7c116db91`), back to upstream: `frontend/src/store/useStore.js`,
`sheets.jsx`, `lib/plan-share.js` and the ten plan-rule helpers in `frontend/src/lib/`, together
with the pilot's gym module (`api/platform/` gyms, memberships, assignments, invitations,
proposals, workout visibility; migrations 005–009; `api/shared/`; `frontend/src/platform/` gym
screens and `join-token.js`).
