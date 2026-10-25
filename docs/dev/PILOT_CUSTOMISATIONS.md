# Pilot customisation map

Every upstream file the gym pilot changes, why, which pilot module owns the change, and the
tests that protect upstream behaviour there. Design: `docs/plans/2026-10-25-gym-pilot-design.md`;
plan: `docs/plans/2026-10-25-gym-pilot-implementation.md`. Update this table in the same commit
that first touches a new upstream file.

Status column: **planned** = named by the plan, not yet modified; **modified** = changed on
`pilot/gym-platform`.

| Upstream file | Reason | Owner module | Protecting tests | Status |
| --- | --- | --- | --- | --- |
| `api/server.js` | Storage extraction (state, identity, transient auth), product route dispatch, closing legacy admin/coach/share paths in product mode | `api/storage/`, `api/state/`, `api/platform/` | `api/test/server-data-*.test.js`, `server-state-cache-bounds`, `server-password`, `server-passkeys`, `server-pairing`, `server-token-refresh`, `server-csrf-bearer`, `server-login-csrf`, `server-account-delete`, `server-admin-*` | planned |
| `api/Dockerfile` | Copy new `state/`, `storage/`, `platform/`, `shared/`, `migrations/` into the image | `api/` build | CI image build + boot (`.github/workflows/test.yml` api-image job) | planned |
| `frontend/src/App.jsx` | One product route/navigation entry point, product mobile onboarding gate | `frontend/src/platform/Routes.jsx` | `frontend/src/App.*.test.jsx` | planned |
| `frontend/src/store/useStore.js` | Narrow method for adopting a server-side state mutation (proposal acceptance); outbox persistence hook | `frontend/src/platform/accept-plan.js`, `workout-outbox.js` | `frontend/src/store/useStore.sync*.test.jsx`, `useStore.adopt*.test.jsx`, `useStore.rev-rewind.test.jsx`, `useStore.signin-safety.test.jsx` | planned |
| `frontend/src/sheets.jsx` | Capture membership context when a new recording starts | `frontend/src/platform/workout-context.js` | `frontend/src/sheets.*.test.jsx` (finish/session tests) | planned |
| `frontend/src/lib/plan-share.js` | Extract parse/normalise/merge into runtime-neutral `api/shared/plan-import.js`; keep public exports | `api/shared/plan-import.js` | `frontend/src/lib/plan-share.test.js`, `sheets.plan-import-toast.test.jsx` | planned |
| `web/Dockerfile` | Copy `api/shared` into the web build context; product build/asset manifest selection | `frontend/scripts/build-pilot.mjs` | CI web build | planned |
| Native build configuration (`frontend/capacitor.config.json`, `frontend/android/app/build.gradle`, `AndroidManifest.xml`, `res/values/strings.xml`, `frontend/ios/App/App.xcodeproj/project.pbxproj`, `Info.plist`, `App.entitlements`) | Product app identifiers, signing, extension/app-group IDs, restricted-media exclusion | `frontend/scripts/build-pilot.mjs`, `check-pilot-bundle.mjs` | `frontend/scripts/check-pilot-bundle.test.mjs` (Task 24); physical-device checklist (Task 27) | planned |
