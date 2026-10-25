# Pilot upstream workflow

How the gym pilot fork tracks the original openGym project. Customised upstream files are
listed in `PILOT_CUSTOMISATIONS.md`.

## Recorded state (25 Oct 2026)

| Item | Value |
| --- | --- |
| Product branch | `pilot/gym-platform` |
| `origin` | `git@github.com:guptaakashgupta/openGym.git` (the fork) |
| `upstream` | `https://github.com/DuarteSantos8/openGym.git` (added 25 Oct 2026, fetch only) |
| Inspected baseline | `7a3ace53` |
| Fetched `upstream/main` | `7a3ace53c5e910c2185f22df803726c5838a99ae` (identical to the baseline; no newer upstream commit yet) |
| Working tree at start | clean apart from an untracked root `AGENTS.md` that belongs to a separate task |

## Branches

- `upstream/main` is a remote-tracking ref only. Never commit to it, rewrite it, or deploy its tip.
- `pilot/gym-platform` is the product branch. Product work lands here as small, revertible commits.
- `integration/upstream-YYYY-MM-DD` is created from the product branch for each upstream update.

## Updating from upstream

1. `git fetch upstream` and record the candidate SHA.
2. `git switch -c integration/upstream-YYYY-MM-DD pilot/gym-platform`, then `git merge <sha>`.
3. For each changed file in `PILOT_CUSTOMISATIONS.md` (authentication, state, plan import,
   native configuration), resolve the semantic change. Never resolve a conflict by taking
   "ours" without reading upstream's intent.
4. Run the upstream and product checks (plan Task 25 command list) on Node 22.
5. Rehearse mobile compatibility with the current and previous supported pilot builds.
6. Review the diff, merge into the product branch, and release a pinned build whose manifest
   records the product SHA, upstream SHA and schema version.

Review upstream weekly during the pilot; assess security fixes promptly.

## Inherited publication workflows

| Workflow | Trigger | Destination | Fork risk |
| --- | --- | --- | --- |
| `.github/workflows/mirror.yml` | push `main`, `v*` tags | GitLab mirror | Guarded: `if: github.repository == 'DuarteSantos8/openGym'`; does not run on the fork |
| `.github/workflows/docker-publish.yml` | push `main` | `ghcr.io/<repository_owner>/opengym-*` | **Unguarded**: on the fork it publishes under the fork owner. Keep product releases off `main` or add a guard before enabling |
| `.github/workflows/ios.yml` | push `main`, `stores`; PRs | iOS build, publish steps when not a PR | Uses upstream signing secrets if present; audit before any product signing |
| `.github/workflows/pages.yml` | push `main` (website paths) | GitHub Pages | Would publish the upstream site from the fork |
| `.github/workflows/test.yml` | PRs; push `main`, `coach` | none | Does not run on `pilot/**` pushes or new product paths; extended in plan Task 25 |
| `.gitlab-ci.yml` | GitLab mirror pipelines, `v*` tags | Signed APK, multi-arch images, SBOMs | Runs only on the GitLab mirror; product must not push there |

Release actions stay gated until product destinations are explicit (plan Task 25).

## Baseline verification (25 Oct 2026, commit `7f098f45`)

Run under Docker `node:22-alpine` (Node 22.23.4, npm 10.9.9) with lockfile installs
(`npm ci`; api with `--omit=optional`).

| Check | Result |
| --- | --- |
| `frontend` `npm test` | pass (448 files) |
| `frontend` `npm run build` | pass |
| `frontend` `node scripts/check-locales.mjs` | pass |
| `frontend` `node scripts/check-source-strings.mjs` | pass (report-only) |
| `frontend` `npm run test:fatigue-probe` | pass |
| `api` `npm test` | pass: 650 pass, 0 fail, 3 skipped (root-only skips because the container runs as root) |
| `mcp` `npm test`, `npm run check:node-loadable` | pass |
| `node scripts/build-coach-assets.mjs --check` | pass |
| `node api/scripts/check-core-loadable.mjs` | pass |
| `node scripts/build-api-docs.mjs --check` | **fail**: `website/api.html` is out of date. Upstream commit `7a3ace53` bumped the site asset query to `?v=28` by hand; the generator still emits `?v=27`. Inherited from upstream, not a pilot change |
| API Docker image build/boot | not run locally; covered by CI |
