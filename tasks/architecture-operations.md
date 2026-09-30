# Architecture operational cutover

Repository changes are not proof that production has been configured or deployed.
This cutover has not been executed.

## Credentials before the first release

1. Provision a dedicated LOGIN in the same PostgreSQL database, with
   `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`.
   Grant it `nexus_workspace_runtime` **WITH INHERIT TRUE, SET TRUE** and
   **without ADMIN OPTION**. INHERIT is required: the web's session reader
   (`apps/web/src/lib/workspaces/server.ts`) queries without `SET ROLE`, so a
   NOINHERIT grant makes every signed-in page fail with "permission denied".
   Row-level security still applies to such queries, because PostgreSQL applies
   the `nexus_workspace_runtime` policies to every role that inherits it. The
   runtime pool refuses a login without the inherited grant at connection time.
   Grant CONNECT to the database. Do not transfer schema, function, type or table
   ownership to this login. No database/schema CREATE, TRUNCATE, REFERENCES or
   TRIGGER privileges are needed. Preserve existing narrowly authorized SECURITY
   DEFINER functions and their migration-owner ownership.
2. Set the application's `DATABASE_URL` to this login, in every API/worker/web
   environment that accesses commerce PostgreSQL — Vercel's Production included,
   **before** the merge: the web deploys from `main` too, and its pool refuses an
   owner login in production. Keep the pooled endpoint for
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

## Process cutover

Create the worker and scheduler services (`nexus-worker`, `nexus-scheduler`, created
2026-09-26) with no source: only the deploy workflow deploys them, with `railway up`.
Railway no longer lets a new service read a config file (Config as Code is deprecated),
so their settings live in Railway: the API's build command; start `npm run start:worker`
or `npm run start:scheduler`; health check `/health/ready`, 90 s; restart on failure;
one replica in `europe-west4`. Only the API service runs schema migrations. Its settings
live in Railway too, since `railway.toml` was removed (2026-09-26; Railway stops reading
such files on 2026-12-01): pre-deploy `npm run db:migrate:deploy`, start
`node apps/api/dist/index.js`, health check `/api/health/ready`, 300 s.
Their variables reference the API's (`${{@nexus/api.NAME}}`), except the two owner
database URLs, so a rotated key changes in one place.
Provide the required integration variables, restricted `DATABASE_URL`, and Redis
connection. Set `ENABLE_QUEUE_WORKERS=1` on all three services: the worker consumes
the queues, the API and the scheduler produce into them (with it off, every enqueue
is skipped and work waits for the 60-second drains). Both background services refuse
to start without it. Clear `NEXUS_DISABLE_BACKGROUND_JOBS` on both background services.

Configure GitHub `RAILWAY_WORKER_SERVICE` and `RAILWAY_SCHEDULER_SERVICE` before
enabling deployment. The workflow refuses an API-only rollout without these IDs.
For the first cutover, quiesce the old API's background jobs, then start the worker
and scheduler and replace the API. Expect a bounded pause while durable queues wait;
do not run old unleased consumers alongside the new services. Subsequent releases
expand schema/API first and update both services from the same SHA.

API serves HTTP and broadcast event intake. Worker owns BullMQ, the event relay,
durable consumers, SQS/inbox retries and continuous stock/media/assortment polling.
Scheduler owns the existing timed job bodies with renewable leases. These schedules
are still timer driven; arbitrary missed historical ticks are not replayed. Jobs
that require catch-up must query durable due state, as scheduled changes already do.
Replacing every schedule with BullMQ is a separate behavior migration, not required
to isolate API CPU or prevent concurrent tick ownership.

API writes no longer start inline cross-business pool/assortment drains; workers
discover the durable rows. Assortment LISTEN wakes promptly; stock-pool idle polling
can take up to ten seconds. Shutdown stops new work within a 30-second outer bound.
It waits for queue jobs, pollers and clustered cron ticks; interval timers
(`runProfileTimer`, plain `setInterval` jobs) are interrupted, which is safe because
every job is idempotent and its durable state is retried. The API ends open
event streams first, so browsers reconnect to another replica.

## Release behavior

The GitHub deployment workflow calls CI for its own checkout and depends on success.
Both push and manual dispatch follow this dependency. Railway then builds, executes
`npm run db:migrate:deploy` as pre-deploy, starts the API, and waits for the readiness
endpoint and expected build SHA. Ordinary restart/replica scale-up does not migrate.

A push ships only the services whose files differ from the commit each one runs now
(read from its latest successful Railway deployment, `scripts/ci/release-changes.sh`).
CI-only and docs-only pushes start no deploy. A hand run (`gh workflow run
deploy-api.yml`) compares the same way, so it ships what a failed or skipped release
left behind; `-f ship=all` ships every service. A service that already runs a newer
commit is not rolled back when an older run is re-run in full ("Re-run all jobs").
"Re-run failed jobs" reuses the old run's decision and CAN roll back, so after a
newer release shipped, start a hand run instead.

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
- [ ] Webhook rows left `pending` with no retry time before this release are not
      replayed automatically (a weeks-old delivery could overwrite newer data). Review
      them in Sync Logs and replay the ones still relevant.
