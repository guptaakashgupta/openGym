# Pilot endpoint and consumer matrix

What product mode (`OPENGYM_MODE=product`) offers of upstream's API, and where each consumer of
accounts or member state reads from. File mode (the self-hosted default) is unchanged.
Enforced by `api/test/platform/legacy-surface.test.js` and `trainers.test.js`; the gate is `productUnavailable` in
`api/server.js`, which answers `404 { code: 'unavailable' }` before any handler runs.

Inventory taken 25 Oct 2026 with
`rg -n 'db\.|readState|stateFile|fs\.|startCadence|startWarmup|setInterval' api/server.js api/coach mcp/src`.

Status 26 Nov 2026: current after the merge of `main` (`dc56b5db0`) and upstream's trainers in
product mode (`docs/plans/2026-11-26-adopt-upstream-trainers.md` steps 3–4, `TRAINERS=on`,
`TRAINERS_LEAD_ACCESS=none`). The pilot's own gym module (`/api/platform/*`, gym invitations,
`platformRecordings`) was removed in `7c116db91`.

## DATA_DIR files after the merge of main

Every file or folder `api/` reads or writes under `DATA_DIR` (Render: `/var/gym/data` on the
`gym-files` disk, beside `OBJECT_STORE=fs:/var/gym/objects`). Taken 26 Nov 2026 with
`rg -n 'DATA_DIR|path\.join\(DATA' api --glob '!test/**'` plus the stores' constructors.

- **Adapted**: product mode keeps the data in PostgreSQL or the object store instead.
- **Disk**: product mode keeps the file on the Render disk, as upstream does.
- **Unavailable**: product mode closes the routes (`PRODUCT_CLOSED` / `productUnavailable` in
  `api/server.js`, `404 unavailable`) and does not start the background work.

| File under `DATA_DIR` | Written by | Product mode | Notes |
| --- | --- | --- | --- |
| `state-<uid>.json` | `storage/state-file.js` | Adapted | `member_states` (`state-postgres.js`). `removeAccount` still tries to unlink the file: a no-op |
| `db.json`, `db.json.bak` | `saveDb` | Disk | Loaded at boot in both modes. Holds no account, credential, subscription or code in product mode (`IDENTITY`, `SUBS`, `TRANSIENT` are PostgreSQL). Its `apiTokens`, `watchLinks`, `invites` and OIDC fields are reached only through closed routes. `removeAccount` still calls `saveDb` |
| `secret` | boot | Not used | File mode only; product mode signs with `SESSION_SECRET` |
| `vapid.json` | boot, both modes | Disk | Generated on first boot if missing. Losing it invalidates every push subscription, so it belongs in the disk backup |
| `audit.log` | `audit()` | Adapted | `audit_events` through `AUDIT_SINK`; `compactAudit` not run |
| `uploads/<uid>/` | `media.js` | Adapted | Object store (`platform/uploads.js`, `media_objects`). `uploads-tmp/` holds uploads in flight only |
| `.health-<pid>` | `dataWritable` | Disk | Health probe: one empty file written and removed |
| `watch-<uid>.json` (+ `db.watchLinks`, in-memory `watchCodes`) | watch relay | Unavailable | `/api/watch/*` closed. Upstream leaves these routes without a session check, so the closure is the only guard |
| `db.apiTokens`: scoped tokens, calendar feed tokens, MCP OAuth grants | `tokens.js`, `oauth.js`, calendar routes | Unavailable | `/api/tokens`, `/api/token`, `/api/oauth`, `/api/calendar`, `/.well-known/*` closed. `API_TOKENS` defaults on upstream; `/api/config` offers `api_tokens` in file mode only |
| `shared/items.json`, `shared/blocklist.json`, `shared/media/` | `library/store.js` | Unavailable | `/api/shared/*` closed; `sweepShared` file mode only. Read at boot (missing is empty). `removeAccount` calls `library.removeUser`, whose `store.batch` always saves: each account deletion writes an empty `shared/items.json`. No personal data; left as is |
| `integrations/u-<uid>.json`, `integrations/outbox.json` | `integrations/` | Unavailable | `/api/integrations/*` closed; `integrations.start()` file mode only; nothing is created unless `INTEGRATIONS` names a provider. Leave `INTEGRATIONS` unset in `deploy/pilot/` |
| OIDC | `oidc/routes.js` | Unavailable | No file of its own: it changes `db.json` user records in place, so it is wired in file mode only. `/api/oidc/*` and `/.well-known/*` closed (not on the 26 Nov approved list; flagged) |
| `org.json`, `org.json.bak` | `trainers/org-store.js` | Disk (with `TRAINERS` on) | Gyms, staff, free trainers, memberships, grants, consent records and codes (hashes only). Read at boot, held in memory, written through on every change. Back it up with the disk. `removeAccount` calls `org.removeUser` |
| `share/<uid>.json` | `share-log.js` | Disk (with `TRAINERS` on) | Each member's sharing log (`SHARE_LOG_DAYS`, default 365). `removeAccount` unlinks it |
| `coach.json`, `coach-auth-<uid>.json`, `coach/` | `coach/` | Unavailable | Unchanged from 25 Oct: `/api/coach/*` closed, cadence and warm-up not started |
| admin socket | `admin-socket.js` | Not started | File mode only (`startAdminSocket`) |

Background work added by `main`: check-in and Wrapped pushes in the reminder tick (file mode
only), the library sweep (file mode only), integrations delivery (file mode only), and the
trainers' hourly `org.expireOffers` (only with `TRAINERS` on).

## Routes

| Route(s) | Product mode | Store |
| --- | --- | --- |
| `GET/PUT /api/data`, `GET /api/data/rev` | Supported. A trainer's direct change goes through `STATE.updateMemberState`, so a stale phone gets `409` with the change, not an overwrite | `member_states` |
| `GET /api/nudge-check` | Supported | `member_states` |
| `GET /api/me`, `POST /api/logout`, `POST /api/logout/all` | Supported | `users` (identity-postgres.js) |
| `POST /api/register/{options,verify}`, `POST /api/login/{options,verify}` | Supported. Sign-up (passkey or password) needs a live trainer or gym code (`TR-`/`GY-`) whose owner may still invite; it is checked, not spent, and the app opens the connect screen next. `PILOT_OPEN_SIGNUP=1` is the operator's bootstrap switch | `users`, `credentials`, `auth_challenges`; codes in `org.json` |
| `/api/sharing/*` (the member: code, connect, update, disconnect, leave, inbox, log, export) | Supported with `TRAINERS` on, else **unavailable**. One active gym per member (`409 other-gym`) | `org.json`, `share/<uid>.json`, `member_states` |
| `/api/trainer/*` (codes, requests, members, member, ops, assign, comment, leave-gym) | Supported with `TRAINERS` on, else **unavailable**. Accounts read from `users` once per request (`withUsers`) | `org.json`, `share/`, `member_states`, `users` |
| `/api/gym`, `/api/gym/{code,staff}` (the gym lead) | Supported with `TRAINERS` on, else **unavailable**. With `TRAINERS_LEAD_ACCESS=none` a lead sees member names, not training | `org.json`, `users` |
| `POST /api/register/password`, `POST /api/login/password`, `POST /api/login/password-reset` | Supported when `PASSWORD_LOGIN` is on | `users`, `login_identifiers` |
| `GET/POST/DELETE /api/account/password`, `POST/DELETE /api/account/email` | Supported | `users`, `login_identifiers` |
| `GET/POST/DELETE /api/account/passkeys*`, `POST /api/account/device-link`, `POST /api/device-link/{options,verify}` | Supported | `credentials`, `device_links` |
| `POST /api/account/delete` | Supported | `users` cascade (credentials, identifiers, subscriptions, codes), `member_states` |
| `POST /api/pair/{create,redeem}` | Supported | `pairing_codes` |
| `GET /api/push/public-key`, `POST /api/push/{subscribe,unsubscribe,test,rest-timer,rest-timer/cancel}`, `GET /api/push/status` | Supported | `push_subscriptions` |
| `POST /api/activity` | Supported, process-local presence | memory |
| `GET /api/health` | Supported: `SELECT 1`, answers `{ ok, database }` with no account count | database |
| `GET /api/config` | Supported; never offers `coach`; offers `media` only with `OBJECT_STORE` set | — |
| `POST /api/admin/user/password-reset` | Platform operator (`ADMIN_UIDS`) only: account recovery | `users` |
| `GET /api/admin/gyms`, `POST /api/admin/gyms/{new,update,staff}`, `POST /api/admin/user/trainer` | Operator only, with `TRAINERS` on: gyms, their leads and trainers, free trainers (`PRODUCT_ADMIN`) | `org.json`, `users` |
| `GET /api/admin/users` | Operator only, with `TRAINERS` on: id, name, disabled and admin of each account, to pick staff from. No state, sync or presence, whatever `ADMIN_DATA_VIEW` says | `users` |
| Every other `/api/admin/*` (user detail and data view, disable, delete, role, owner, invites, audit) | **Unavailable** | — |
| `/api/coach/*` | **Unavailable**: reads state files and db.json directly; AI coaching is outside the pilot | — |
| `/api/media/*` | Supported only with `OBJECT_STORE` (`fs:<dir>`; no S3 adapter until a provider is chosen): bytes under random keys in a private object store, ownership per `(user, hash)`, reads proxied per request (`platform/uploads.js`). Unset: **unavailable** | `media_objects`, `media_object_deletions`, object store |

Authority: `isAdmin` in product mode is `ADMIN_UIDS` only; an `admin`, `owner`, `roles` or
`gym_id` field on an account record grants nothing, and there is no instance owner.

## Background consumers

| Consumer | Product mode |
| --- | --- |
| Reminder and nudge tick (`REMINDER_TICK_MS`) | Supported. Subscribed users from `push_subscriptions`, reminder summary from `member_states`, `lastReminder`/`lastNudge` written through the identity store. One pass at a time. |
| Rest timers (`scheduleRestTimer`) | Supported, process-local `setTimeout` |
| Live presence (`presence` map) | Supported, process-local |
| Challenge, pairing and device-link expiry | Database rows expire; expired rows pruned on insert |
| Audit compaction (`compactAudit`) | Not run. Events go to `audit_events`; hourly `pruneAudit` deletes events older than `AUDIT_DAYS`; account deletion scrubs names and addresses (`scrubAudit`) |
| Media sweep (`mediaSweepAll`) | With `OBJECT_STORE`: hourly grace sweep from `unreferenced_since`, then the resumable deletion queue and stale pending uploads (`cleanup()`). Without: not run |
| Trainer offers (`org.expireOffers`, hourly) | With `TRAINERS` on: studio grants whose trainer left a gym end after the offer to stay privately lapses |
| Coach cadence and warm-up | Not started |
| MCP server (`mcp/`) | Not offered: it reads a `DATA_DIR` that holds no state in product mode |

**Single owner.** Timers, presence and the reminder tick live in each API process. The pilot runs
one API process; a second replica would send duplicate reminders and miss presence held by the
other. Run more than one only after moving these to a single scheduled owner.

## db.json in product mode

Never an authority for accounts, credentials, subscriptions, codes or state. It is still loaded
for the upstream instance invites (`db.invites`), which product mode does not use: sign-up is
gated by trainer and gym codes in `org.json` instead. Leave `INVITE_ONLY` off in product mode.
