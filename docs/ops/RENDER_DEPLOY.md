# Render production deployment

The root render.yaml deploys pilot/gym-platform to Singapore: a public nginx web
service, a private API, and a 10 GB persistent disk. Render terminates HTTPS.
The two services use paid 512 MB plans; increase API memory if metrics warrant it.
Automatic deployments are disabled so API/schema and web releases can be coordinated.

## Initial deployment

1. Connect Render to guptaakashgupta/openGym. Push the reviewed changes to
   pilot/gym-platform before creating the Blueprint from that branch.
2. Create paid Render PostgreSQL in Singapore (1 GB RAM, PostgreSQL 17, 15 GB
   storage is a starting point). Database creation is separate because the API
   requires its external, certificate-verified URL during Blueprint setup.
3. Create the Blueprint using render.yaml. Set DATABASE_URL to the database's
   external URL with `?sslmode=verify-full` (or append `&sslmode=verify-full` if
   there are other parameters). Keep credentials only in Render. Restrict the
   database's external access to the API service's outbound IP ranges from
   Render's Connect menu. Never disable certificate verification to fix a failure.
4. The API pre-deploy command runs migrations, without needing the mounted disk.
   Confirm migrations and API startup succeed, then deploy the web service.
   Its build receives RENDER_GIT_COMMIT automatically; this pins the source offer
   to the actual build revision. The source repository/revision must be publicly
   accessible before launch. The product retains the current Pilot Gym name and
   icon and uses placeholder exercise media.
5. In Render's custom-domain settings, obtain the exact DNS target. Add a CNAME
   for `gym` at the existing askpocket.in DNS provider to that target. Wait for
   domain verification and Render's HTTPS certificate.
6. Check https://gym.askpocket.in/api/health and /api/config, then register a test
   account on the final hostname. Test sign-in, gym invitation, workout save and
   readback, upload, and persistence after an API redeploy. Bootstrap the owner
   with api/scripts/pilot-gym.mjs as described in the pilot runbook; do not assume
   the first registrant is automatically the product-mode gym owner.

## Releases and operations

Deploy the API first (migrations must remain backward compatible), verify health,
then deploy the web service from the same revision. Roll back application images
only when the schema remains compatible; never blindly reverse migrations.
The API is intentionally single-instance. Its persistent disk causes a brief
interruption during deployments. Web health checks pass through to API health.

Accounts and workouts live in managed PostgreSQL. Uploads and VAPID keys live
under /var/gym and must survive redeployment. Enable/verify database recovery,
arrange off-service file backups and perform a restore drill following
PILOT_DATA_RECOVERY.md. Disk snapshots alone are not a coordinated database/file
backup. Monitor health and disk usage, and keep SESSION_SECRET stable.

The nginx startup script reads the platform resolver from /etc/resolv.conf when
RESOLVER=system. Other hosts retain their existing resolver configuration. Both
nginx and the API use port 10000 on Render; BACKEND is the private service host.
Nginx overwrites forwarded client IP headers for safety. Until Render ingress
trust is explicitly configured, audit/rate-limit IPs can reflect the proxy rather
than individual visitors; verify this before opening registration broadly.

No database, services, DNS records or paid resources are created by these files
alone. Review actual Render prices at provisioning; staging is separate.

## Provisioned production resources (2026-11-09)

- Web: https://dashboard.render.com/web/srv-dbonab95efls73edv2u0
- API: https://dashboard.render.com/pserv/srv-dbona53m8hqs73ef6m4g
- PostgreSQL: https://dashboard.render.com/d/dpg-dbon86psrm7s73ch4sm0-a
- DNS: `gym` CNAME `askpocket-gym-web.onrender.com` at Porkbun.
- PostgreSQL external access: Render Singapore outbound ranges
  `74.220.52.0/24` and `74.220.60.0/24` (recheck via the outbound-ips API if changed).

These resources were created with the Render API, not linked as a Blueprint.
The YAML describes the equivalent service configuration for review and future setup.
The API's initial migrations applied 001 through 011 successfully. Secrets remain
in Render and are not recorded here. The database is a single-node 1 GB plan with
15 GB storage. Do not recreate it to update application services.

The pilot image uses sharp 0.34.5, whose native binaries come from npm optional
packages. Keep npm ci --ignore-scripts: rebuilding all sharp copies also runs the
older transitive Capacitor dependency, whose GitHub download can time out.
