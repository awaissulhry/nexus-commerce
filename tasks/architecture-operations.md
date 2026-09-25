# Architecture operational cutover

Repository changes are not proof that production has been configured or deployed.
This cutover has not been executed.

## Credentials before the first release

1. Provision a dedicated LOGIN in the same PostgreSQL database, with
   `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`.
   Grant `nexus_workspace_runtime` with SET permission and **without ADMIN OPTION**.
   Grant CONNECT to the database. Do not transfer schema, function, type or table
   ownership to this login. No database/schema CREATE, TRUNCATE, REFERENCES or
   TRIGGER privileges are needed. Preserve existing narrowly authorized SECURITY
   DEFINER functions and their migration-owner ownership.
2. Set the application's `DATABASE_URL` to this login, in every API/worker/web
   environment that accesses commerce PostgreSQL. Keep the pooled endpoint for
   runtime traffic. Provision a password using the deployment secret manager, not
   SQL checked into the repository or a command visible in logs.
3. Set `MIGRATION_DATABASE_URL` to an administrative credential for that **same
   database** in the service which runs the release migration. Verify database name
   and Neon endpoint identity; different usernames are expected. The runner
   converts only a Neon pooled hostname to its direct endpoint.
4. With deployment variables supplied securely, run:
   `npx --no-install tsx packages/database/scripts/check-runtime-role.mts`.
   This reads catalog metadata only. Mandatory production pool checks reject an
   owner/BYPASSRLS login before lending the connection to Prisma. Local tests can
   enable the same check with `NEXUS_ENFORCE_RUNTIME_ROLE=1`.

The new release intentionally refuses unsafe/missing credentials; provision them
before deploying it. Do not use the migration URL as a fallback runtime credential.
Separate inputs are an access-control boundary, not a promise that deployment
platform administrators or the release service cannot see both secret values.

## Release behavior

The GitHub deployment workflow calls CI for its own checkout and depends on success.
Both push and manual dispatch follow this dependency. Railway then builds, executes
`npm run db:migrate:deploy` as pre-deploy, starts the API, and waits for the readiness
endpoint and expected build SHA. Ordinary restart/replica scale-up does not migrate.

Disable/restrict any parallel native Railway autodeploy path before relying on the
GitHub gate. Verify branch protection separately; local YAML cannot establish it.
The history check has 10-second connection and 30-second query deadlines. The Prisma
child has a 5-minute deadline. Also set a Railway pre-deploy timeout with headroom.

## Compatibility and rollback

Pre-deploy runs while the previous application may still serve traffic. Every schema
change must be additive for that release. Add fields/capabilities first, deploy
readers/writers second, remove old contracts only in a later explicitly reviewed
release after clients and queued work no longer need them. Unknown optional response
fields must be tolerated; new required request fields require an overlap period.

An application rollback does not undo migrations. Keep an old artifact that tolerates
the expanded schema, and use the appropriate credential for its connection behavior.
Never revert the new runtime back to an owner login just to pass its health check.

Event consumers accept only supported type/version/payload contracts. Invalid durable
messages remain pending and are reported; that is retry retention, not a dead-letter
archive. Consumers must be idempotent and tolerate reordering even within a subject.

## Remaining rollout evidence

- [ ] Runtime and migration role identity verified against the target database.
- [ ] Split service configuration, startup, shutdown and cutover verified.
- [ ] Required CI/branch protection and native deploy path restrictions verified.
- [ ] Exact deployed build passes readiness and critical authenticated user flows.
- [ ] Inbox/outbox age, failure counts and worker activity checked after cutover.
