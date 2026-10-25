# Pilot compatibility and CI boundaries

What CI proves for the gym pilot's product, how supported client builds are kept working, and why
nothing on a pilot branch can publish, sign or mirror.

## Checks

| Workflow | Runs on | Proves |
| --- | --- | --- |
| `test.yml` (upstream) | PRs on product paths; pushes to `main`, `coach`, `pilot/**`, `integration/**` | Frontend, API (file mode), MCP, locales, coach assets, API docs, `check-core-loadable`, `check-platform-loadable`; both upstream API image targets boot |
| `pilot-test.yml` | PRs on product paths; pushes to `pilot/**`, `integration/**` | `test:storage` and `test:platform` against a disposable PostgreSQL 17; product modules load under plain node; `build:pilot` and its gates; the API image migrates and boots in product mode against PostgreSQL and still boots in file mode; the product web image carries its stamp and no exercise media; image labels name product SHA, upstream SHA and schema version |

The product-mode boot in CI sets `NODE_ENV=ci`, because the throwaway database has no TLS and
production refuses a `DATABASE_URL` without `sslmode=verify-full` or `verify-ca`
(`api/platform/config.js`, covered by `config.test.js`).

## Supported client builds

`api/test/fixtures/pilot-clients/` holds one fixture per supported client build:

- `current.json`: the current pilot client. Personal sync with `platformRecordings` and fields the
  server does not know, gym context, the trainer's client list and progress, plans, the revision
  check before accepting a plan, and export.
- `previous.json`: the previous supported pilot client. Personal sync without recordings (as an
  upstream client syncs), gym context and plans.

`api/test/platform/client-compat.test.js` replays each fixture against a product server and
fails when a status changes, a field the client reads disappears, or state fields the server does
not know are dropped. When a client build ships, add its fixture. When a build stops being
supported, remove its fixture in the same change that drops the support. Never edit an old
fixture to make an incompatible change pass.

## Publication boundaries

- Images (`docker-publish.yml`): the build job runs only on `refs/heads/main` and `v*` tags, so a
  manual run from a pilot branch publishes nothing. Product images are built only by
  `pilot-test.yml`, which never pushes them.
- Website (`pages.yml`): deploys only from `main`.
- iOS signing (`ios.yml` device archive): only `main` and `stores`; it signs with upstream's
  identity, which the pilot never uses.
- Mirror (`mirror.yml`): pushes `main` and `v*` tags to the GitLab mirror. Pilot releases must
  never be tagged `v*`; use `pilot-v*`. The GitLab pipeline builds release artifacts from what
  the mirror receives, so a `v*` tag on a pilot commit would publish it under upstream's name.
- The product's own publication (registry, signing identity, store accounts) is not configured
  yet and needs its own workflow, gated on the product's accounts (`docs/ops/PILOT_MOBILE_RELEASE.md`).

## Local equivalent

```sh
docker compose -p pilot-tests -f deploy/pilot/compose.test.yml up -d
export TEST_DATABASE_URL=postgres://pilot_test:pilot_test@127.0.0.1:55432/pilot_test
npm --prefix api run test:storage && npm --prefix api run test:platform
node api/scripts/check-platform-loadable.mjs
PILOT_PRODUCT=../deploy/pilot/product.example.json npm --prefix frontend run build:pilot
```
