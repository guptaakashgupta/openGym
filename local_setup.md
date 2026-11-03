# Run the multi-gym pilot locally

These steps run the `pilot/gym-platform` product mode with PostgreSQL. The root
`docker-compose.yml` runs the original file-backed mode and does not enable the
gym features.

You need Docker with Compose and Node.js with npm. Run the commands below from
the repository root unless a step says otherwise.

## 1. Start PostgreSQL and migrate

The repository provides a local PostgreSQL 17 container on port `55432`. Its
database is intended for disposable development and tests.

```sh
docker compose -p pilot-tests -f deploy/pilot/compose.test.yml up -d --wait
export DATABASE_URL=postgres://pilot_test:pilot_test@127.0.0.1:55432/pilot_test
npm --prefix api install
npm --prefix frontend install
npm --prefix api run migrate
```

Run the migration command again after pulling changes that add migrations.

## 2. Create a gym and owner invitation

```sh
node api/scripts/pilot-gym.mjs --name "My Gym" --owner-invite
```

The command prints an invitation token once. Copy it for the owner signup flow.
You can run it again with a different name to create another gym. If the owner
already has an account, use `--owner <user-id>` in place of `--owner-invite`.

## 3. Start the API

In a terminal at the repository root:

```sh
export DATABASE_URL=postgres://pilot_test:pilot_test@127.0.0.1:55432/pilot_test
OPENGYM_MODE=product \
SESSION_SECRET=local-development-secret-at-least-32-characters \
DATA_DIR="$PWD/data/pilot-local" \
ORIGIN=http://localhost:5173 \
npm --prefix api start
```

Product mode requires the database and a session secret of at least 32
characters. Signup requires a gym invitation by default. The local `DATA_DIR`
holds runtime files; accounts and workout state are stored in PostgreSQL.

## 4. Start the pilot UI

In a second terminal at the repository root:

```sh
VITE_PILOT=1 API_ORIGIN=http://localhost:5173 npm --prefix frontend run dev
```

Open <http://localhost:5173>, click **Create new profile**, and enter the owner
invitation token in **Invite code**. Check <http://localhost:5173/api/health>; it should return
`{"ok":true,"database":true}`.

For a member or trainer invitation, send the link shown on the gym owner's
**Invitations** screen. The recipient sees the gym name and role, then can create
a profile or sign in. A new profile joins the gym as part of signup; an existing
profile confirms the join after signing in.

If **Invite code** is missing, check <http://localhost:5173/api/config>. An
`"invite_only":false` response means open signup is enabled, usually through
`PILOT_OPEN_SIGNUP=1`. You can create the profile without a token, then open
`http://localhost:5173/#/gym/join?token=YOUR_TOKEN` while signed in and confirm
the join. Alternatively, restart the API without `PILOT_OPEN_SIGNUP=1` and
refresh the page to use the token during signup.

## Stop and verify

Stop the API and Vite with `Ctrl+C`. Stop PostgreSQL with:

```sh
docker compose -p pilot-tests -f deploy/pilot/compose.test.yml down
```

`down` keeps the PostgreSQL volume. To discard the local database, use `down -v`
instead.

To run the PostgreSQL storage and platform tests, start the database again and
run:

```sh
export TEST_DATABASE_URL=postgres://pilot_test:pilot_test@127.0.0.1:55432/pilot_test
npm --prefix api run test:storage
npm --prefix api run test:platform
```
