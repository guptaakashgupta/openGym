# Pilot endpoint and consumer matrix

What product mode (`OPENGYM_MODE=product`) offers of upstream's API, and where each consumer of
accounts or member state reads from. File mode (the self-hosted default) is unchanged.
Enforced by `api/test/platform/legacy-surface.test.js`; the gate is `productUnavailable` in
`api/server.js`, which answers `404 { code: 'unavailable' }` before any handler runs.

Inventory taken 25 Oct 2026 with
`rg -n 'db\.|readState|stateFile|fs\.|startCadence|startWarmup|setInterval' api/server.js api/coach mcp/src`.

## Routes

| Route(s) | Product mode | Store |
| --- | --- | --- |
| `GET/PUT /api/data`, `GET /api/data/rev` | Supported; PUT also takes `platformRecordings` (new-recording events) decided in the same transaction | `member_states`, `seen_workout_ids`, `workout_visibility`, `recording_events` |
| `GET /api/nudge-check` | Supported | `member_states` |
| `GET /api/me`, `POST /api/logout`, `POST /api/logout/all` | Supported | `users` (identity-postgres.js) |
| `POST /api/register/{options,verify}`, `POST /api/login/{options,verify}` | Supported. Signup (passkey or password) needs a gym invitation (`invite`) and redeems it; `PILOT_OPEN_SIGNUP=1` is the operator's bootstrap switch | `users`, `credentials`, `auth_challenges`, `gym_invitations` |
| `/api/platform/*` (me, members, assignments, memberships/end, clients, clients/:id/workouts, invitations, invitations/preview, invitations/redeem) | Product only; scoped by current membership (platform/routes.js) | `gyms`, `gym_memberships`, `trainer_assignments`, `gym_invitations` |
| `GET /api/platform/export` | Product only; the caller's own data, format `opengym-pilot-export/1` (platform/lifecycle.js, docs/ops/PILOT_DATA_RECOVERY.md) | `member_states`, `gym_memberships`, `plan_proposal_versions`, `workout_visibility` |
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
| Every other `/api/admin/*` (users, user detail, disable, delete, role, owner, invites, audit) | **Unavailable** | — |
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
| Coach cadence and warm-up | Not started |
| MCP server (`mcp/`) | Not offered: it reads a `DATA_DIR` that holds no state in product mode |

**Single owner.** Timers, presence and the reminder tick live in each API process. The pilot runs
one API process; a second replica would send duplicate reminders and miss presence held by the
other. Run more than one only after moving these to a single scheduled owner.

## db.json in product mode

Never an authority for accounts, credentials, subscriptions, codes or state. It is still loaded
for the upstream instance invites (`db.invites`), which product mode does not use: signup is gated
by gym invitations instead. Leave `INVITE_ONLY` off in product mode.
