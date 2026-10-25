# Repository Guidelines

## Project Structure & Module Organization

`frontend/` contains the React/Vite app: screens in `src/views/`, shared UI in `src/components/`, Zustand state in `src/store/`, and domain helpers in `src/lib/`. Its `android/` and `ios/` directories are Capacitor shells. `api/` is the Node HTTP server; `api/test/` holds tests and `api/openapi.yaml` documents routes. `mcp/` is an optional read-only server. `catalogue/` owns exercise JSON and translations; `website/` is the static site. Deployment files live in `web/`, `helm/`, and `kubernetes/`; guides live in `docs/`.

## Build, Test, and Development Commands

- `cp .env.example .env && docker compose up -d --build`: start the local API and web stack.
- `cd frontend && npm install && npm run dev`: run Vite with hot reload and an `/api` proxy.
- `cd frontend && npm run build`: create the production web bundle.
- `cd frontend && npm test`: run frontend Vitest tests; `npm run test:watch` keeps them running.
- `cd api && npm test`: run Node's built-in test runner.
- `cd mcp && npm test`: run MCP Vitest tests.
- `node scripts/check-locales.mjs`: check translated UI keys and placeholders.

Install dependencies in each package before running its commands.

## Coding Style & Naming Conventions

Use the surrounding JavaScript/JSX style, including two-space indentation and descriptive camelCase names. There is no configured linter or formatter. Keep components small, put persistent client state in `src/store/`, and keep training rules as pure functions in `src/lib/`. Prefer existing dependencies. Name tests `*.test.js` or `*.test.jsx` beside frontend code; API tests belong in `api/test/`.

## Testing Guidelines

Add a nearby unit test for any training decision or logged-session readback. Run the affected package's suite and click through changed UI flows before a pull request. New UI text needs entries in every `frontend/src/locales/` translation; English is the source language. CI also builds and boots API images.

## Commit & Pull Request Guidelines

Recent commits use short, descriptive subjects, often prefixed with the area, such as `Android:` or `ROADMAP:`. Describe the change and reason in the pull request, link relevant issues, include screenshots for visual changes, and mention when a mobile APK is needed for review. First-time contributors must complete the CLA check.

## Security & Generated Content

Keep secrets and user data out of commits: `.env` and `data/` are local. Edit exercise source files in `catalogue/`, not generated `frontend/src/lib/exercises-data.js`; do not add or replace licensed `catalogue/media/` assets. Report vulnerabilities privately as directed in `SECURITY.md`.
