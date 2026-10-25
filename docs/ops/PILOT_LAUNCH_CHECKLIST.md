# Pilot launch checklist

The evidence for each launch gate of the design (`docs/plans/2026-10-25-gym-pilot-design.md`,
section 10), what is still open, and what blocks a launch. Automated evidence is a test that ran
green on the release candidate; it does not replace the staging, restore and device checks.
Record real deployments in a dated private operational record, never with personal data here.

## Release candidate

| Item | Value |
| --- | --- |
| Product branch | `pilot/gym-platform` |
| Upstream base | `7a3ace53`; `042c9ee` rehearsed on `integration/upstream-2026-10-26` |
| Schema version | `011` (`api/migrations/011_import_runs.sql`) |
| Images | Not built for release; no registry exists (`PILOT_RUNBOOK.md`) |
| App builds | Android: web bundle and `cap sync` only, no SDK build. iOS: excluded |

Status key: **Met** (evidence below), **Partial**, **Blocker** (must be resolved before launch),
**Pending input** (a decision or account from the operator or the gym).

## Launch gates

| # | Gate | Status | Evidence | Still needed |
| --- | --- | --- | --- | --- |
| 1 | A member joins, accepts a proposal, logs offline, and syncs without loss or duplication | Partial | `api/test/platform/invitations.test.js`, `accept-proposal.test.js`, `workout-visibility.test.js`; `frontend/src/platform/context.test.jsx`, `workout-context.test.js`, `workout-wiring.test.jsx`, `member.test.jsx` | The whole flow on staging and on physical phones (gate 6) |
| 2 | A trainer reviews an assigned member but not another trainer's clients or another gym's members | Met (automated) | `api/test/platform/isolation-http.test.js`, `access.test.js`, `workout-projection.test.js`, `uploads.test.js` (media per account) | Repeat the identifier-substitution pass on staging with gyms A and B |
| 3 | Privilege changes apply to subsequent requests, including existing sessions | Met (automated) | `memberships.test.js`, `proposals.test.js` (ended assignment), `account-recovery.test.js`, `account-lifecycle.test.js` (deleted account's cookie and token) | Repeat on staging |
| 4 | A complete backup restore is demonstrated in an isolated environment | **Blocker** | Procedure: `PILOT_DATA_RECOVERY.md`; restore semantics: `account-lifecycle.test.js` (restored revision, newer device merges) | Backups exist, a restore into an isolated service, and its recorded time (`PILOT_RUNBOOK.md`) |
| 5 | An upstream integration rehearsal passes the regression checks | Met (limited) | `PILOT_RUNBOOK.md` rehearsal record | A rehearsal that touches authentication, state, import or native files, when upstream changes them |
| 6 | Signed Android and iOS pilot builds pass the physical-device checklist | **Blocker** | Web and pairing behaviour: `mobile-onboarding.test.jsx`, `check-pilot-bundle.test.mjs` | Developer accounts, signing, an Android SDK build, an iOS configuration (`PILOT_MOBILE_RELEASE.md`), and the device checks below |
| 7 | Media rights and code-licence obligations are addressed; pilot agreement and privacy disclosures are ready | Partial | Placeholder media mode and the source-offer/notice gates (`check-pilot-bundle.mjs`) | A decision on media (licence or placeholder), a working source-offer URL, the pilot agreement, the privacy notice. Passing the bundle gates is not legal clearance |

## Staging walkthrough (gyms A and B) — Blocker until staging exists

- [ ] Owner of gym A invited and signed in; gym B provisioned separately.
- [ ] Member signs up from an invitation; trainer invited and assigned.
- [ ] Trainer sends a plan; member reviews, picks days, accepts; routines appear once.
- [ ] Member logs a workout; trainer sees it in progress; owner cannot see workout content.
- [ ] Reassignment to another trainer: the old trainer loses access on the next request.
- [ ] Member leaves the gym: their later workouts stay private; history sync still works.
- [ ] Identifier substitution against every resource in `docs/dev/PILOT_ENDPOINT_MATRIX.md`, across gyms A and B: every attempt answers 403/404 and leaks nothing.
- [ ] Browser walkthrough of the owner, trainer, join and proposal screens (not yet done in a browser).

## Physical devices — Blocker until signed builds exist

On one Android phone and one iPhone:

- [ ] Browser sign-in, then pairing with a code; an expired or used code is refused clearly.
- [ ] Force-close and relaunch: still paired, data intact.
- [ ] Airplane mode: log a workout, relaunch, reconnect: it syncs once, with its gym visibility.
- [ ] Account switch with pending work: account A's work stays with A; B sends none of it.
- [ ] Token renewal after half its lifetime; sign-in again after expiry.
- [ ] Install the next pilot build over the previous one: data and pairing survive.

## Open inputs (design section 11)

| Input | Status |
| --- | --- |
| Product name, domain, branding, operator identity | Pending input |
| Pilot gym, trainers, participants, fees, dates; invoices and renewal terms with the gym (no automatic member charges) | Pending input |
| Hosting, database, object storage (provider; an S3 adapter is needed for multi-host), budget, RPO/RTO | Pending input |
| Android/iOS developer accounts, signing, distribution route; the platforms' current distribution requirements checked at that time | Pending input |
| Exercise media: licence, replacement or removal (placeholder mode available) | Pending input |
| AGPL source offer for the distributed version, notices | Partial: generated per build; the offer URL must work |
| Privacy notice, access and removal support, pilot contract | Pending input (legal review) |
| Account recovery procedure | Met in software: operator-only reset, audited (`account-recovery.test.js`); operating procedure to be adopted |
| Business targets: activation, weekly logging, trainer usage, support effort, paid renewal | Pending input, agreed with the owner |

A successful demonstration does not replace gates 4 and 6 or the isolation checks on staging.
