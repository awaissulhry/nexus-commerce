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
2026-09-26) with no source: only the deploy workflow deploys them, with `railway up` or
from the API image (see "Image deploys and rollback").
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
Both push and manual dispatch follow this dependency. Railway then builds (or pulls the
commit's image, see below), executes
`npm run db:migrate:deploy` as pre-deploy, starts the API, and waits for the readiness
endpoint and expected build SHA. Ordinary restart/replica scale-up does not migrate.

A push ships only the services whose files differ from the commit each one runs now
(read from its latest successful Railway deployment, `scripts/ci/release-changes.sh`).
CI-only and docs-only pushes start no deploy. A hand run (`gh workflow run
deploy-api.yml`) compares the same way, so it ships what a failed or skipped release
left behind; `-f ship=all` ships every service. A service whose way of deploying changed
(`RAILWAY_IMAGE_SERVICES`, next section) ships too. A service that already runs a newer
commit is not rolled back when an older run is re-run in full ("Re-run all jobs").
"Re-run failed jobs" reuses the old run's decision and CAN roll back, so after a
newer release shipped, start a hand run instead. If only `Images` failed (a `railway up` release
still ships without them), use "Re-run all jobs": it rebuilds this commit's images, and `changes`
sees every service already on this commit and ships nothing.

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
The images of every release are those artifacts (next section).

Event consumers accept only supported type/version/payload contracts. Invalid durable
messages remain pending and are reported; that is retry retention, not a dead-letter
archive. Consumers must be idempotent and tolerate reordering even within a subject.

## Image deploys and rollback

Every Deploy API run builds two images of its commit, beside CI: `ghcr.io/<owner>/nexus-api:<sha>`
(API, worker and scheduler) and `ghcr.io/<owner>/nexus-web:<sha>`. The GitHub repository variable
`RAILWAY_IMAGE_SERVICES` lists the services that deploy from them: a comma list of `api`, `worker`,
`scheduler` and `web`. Railway then builds nothing. Every other service keeps `railway up`.
Empty means none. An unknown name fails the run.

### Move a service to image deploys

The Owner sets the variable (GitHub → Settings → Secrets and variables → Actions → Variables).
One service per deploy, in this order (the Owner, 2026-09-30: the web has users, so it goes last).
Before the next step, check that the service is healthy on the right commit, and its logs and timings.

1. `scheduler`
2. `scheduler,worker`
3. `scheduler,worker,api`
4. `scheduler,worker,api,web`

Then run Deploy API by hand (`gh workflow run deploy-api.yml`). It ships the service whose way of
deploying changed, and nothing else that is current: `release-changes.sh` sees that the service
runs a `railway up` build while the variable names it. The deploy points the service at its image
in the project token's environment and starts a deployment, through Railway's GraphQL API
(`serviceInstanceUpdate` with `source.image`, then `serviceInstanceDeployV2`, which returns the
deployment id); Settings → Source then shows the image. The commit each
service runs: the API reports it at `/api/health/ready` (`build`); for all four,
`railway deployment list -s <service> --limit 1 --json` shows `meta.image`
(`…/nexus-api:<sha>`) or, for a `railway up` build, `meta.cliMessage` (`<role> GitHub <sha>`).
After the first switch of each service, read its deploy log. It ends
with `✓ Railway runs ghcr.io/<owner>/nexus-…:<sha>` when Railway's record of the deployment names
that image. A `::warning::` that the image is not confirmed means the record names none: check the
deployment on Railway once, and report it. A deployment that runs another image fails the job.
The log also names the deployment Railway started: `✓ Railway started deployment …`. A
`::notice::` that Railway answered with the deployment that already serves means it started none:
report it.

The web image carries the `NEXT_PUBLIC_*` and `NEXUS_API_PROXY_TARGET` values that `nexus-web` had
when the image was built. Once the web deploys by image, a change to one of them on `nexus-web`
reaches the web only with its next image: the next release that ships the web. A hand run of Deploy
API rebuilds the image of the same commit under the same tag; that Railway then pulls the rebuilt
image is not yet proven.

Not yet proven: that the project token may change a service's source and deploy it (plan §7).
2026-09-30, run 36697739589: the first try used `railway service source connect --image`, which
changes the service in every environment. Railway answered the project token "Unauthorized" and
nothing changed: a project token acts on one environment. The deploy now sends the per-environment
mutations above; the next switch proves whether Railway lets the token send them. If Railway refuses
the source change (`✗ Railway refused the change of the service's source …`), nothing changed: the
service keeps running its `railway up` build. Remove its name from the variable (no deploy is
needed; later releases ship it with `railway up`), and report it. Do not set the image by hand in
Settings → Source instead: the workflow sets the image on every deploy, so it fails again there.

Also not yet proven: that Railway applies the source change rather than staging it. If it only
stages it, the deployment runs the old image and the job fails with `✗ deployment … succeeded, but
it runs …, not …`; report it. The schema marks the mutation's environment "[Experimental]": for an
environment that is not a fork, the change reaches every environment that is not a fork.

If the source change works but the image deployment fails (or Railway refuses to start it), the
service keeps serving its last `railway up` build while Settings → Source already names the image.
Before the next deploy of that service,
either fix the cause and run Deploy API by hand again (the name still in the variable), or remove the
name and disconnect the image in Settings → Source: a hand run would not ship it then, because it
already runs a current `railway up` build.

Check first that the service's start command works in the image:

- web: `node apps/web/scripts/start.mjs` (set so, read 2026-09-30), or none (the image starts it).
  The web image has no root `package.json`, so a root `npm run …` start command would fail.
- worker, scheduler: `npm run start:worker` and `npm run start:scheduler` (set so, read 2026-09-30)
  work. `node
  apps/api/dist/background.js worker` (or `scheduler`) also stops with exit 0 instead of 1.
- API: start `node apps/api/dist/index.js`, pre-deploy `npm run db:migrate:deploy`, health check
  `/api/health/ready`. These stay.

Railway ignores the build command, watch paths and `RAILPACK_`/`NIXPACKS_` node versions for an image
source. A failed image deployment never takes traffic: the previous build keeps serving.
To move a service back, remove its name and run Deploy API by hand: that service ships with `railway
up` (it runs an image while the variable no longer names it). Not yet tried: `railway up` on a
service whose source is an image. If Railway refuses it, disconnect the image in Settings → Source
first.

### Roll back

    gh workflow run rollback.yml -f sha=<commit>
    gh workflow run rollback.yml -f sha=<commit> -f skip_api=true   # the API keeps its build

The commit must be on main (a full SHA or a prefix of 7 or more characters), and its Deploy API run
must have succeeded: that run passed CI and built the images. The workflow runs in GitHub, not on this
machine. It:

- checks the commit, its Deploy API run and both of its images;
- moves only the services in `RAILWAY_IMAGE_SERVICES`, and names the others in its summary;
- moves the API first (Railway SUCCESS, then readiness shows that commit), then the worker, scheduler
  and web side by side, then runs the web's production smoke;
- adds a ✓ or ✗ line per service to its summary once that service's job ends.

**Migrations do not roll back.** The API goes back only to a commit with the same migration folders
as main. Its pre-deploy (`npm run db:migrate:deploy`) refuses to run when the database holds a
migration that the image has no folder for, so that deployment would fail. The workflow checks this
first and stops with the list of migrations. Then run it again with `-f skip_api=true`, or fix
forward with a new commit. The worker, scheduler and web have no pre-deploy and can go further back.
Their old code then runs on today's schema: do it only when every migration since that commit is
additive. The run's summary lists the migrations added since then.

Railway variables stay as they are now: the workflow changes only the image. One exception: the web
image carries the `NEXT_PUBLIC_*` and `NEXUS_API_PROXY_TARGET` values of its own build, so rolling
the web back past a change of those values brings the old ones back.

The next Deploy API run compares each service with the commit it runs, so it ships every moved
service whose files differ on main: **the code you rolled back from comes back with it.** Land the
fix (or a revert) before anything else merges. To put main back without a new commit, run Deploy API
by hand. Re-running the failed jobs of a Deploy API run that began before the rollback ships only
what that run chose back then; run Deploy API by hand instead.

A rollback waits in the same queue as deploys (`deploy-api`). GitHub keeps one waiting run per queue: a
push that lands while the rollback waits cancels it, and a rollback cancels a deploy that is still
waiting. Run the cancelled one again, as a new run or a re-run: the next deploy sees either. Re-run
a deploy that a rollback cancelled only after the fix or a revert is on main, or it ships the code
the rollback took away.

Railway's own Rollback button on an older deployment also works for image deploys, one service at a
time. The button also puts back that deployment's variables (Railway's docs: "Both the Docker image
and custom variables are restored"). After a rotated secret or any changed variable, it brings the
old value back: use rollback.yml, which changes only the image. For the API the same migration limit
applies: Railway's docs do not say that a rollback skips the pre-deploy command, so expect it to
fail when main has a migration the old deployment lacks. The deploy workflow sees such a rollback too
(it reads what each service runs), so the next release ships that service again when its files
differ on main.

## Remaining rollout evidence

- [ ] Runtime and migration role identity verified against the target database.
- [ ] Split service configuration, startup, shutdown and cutover verified.
- [ ] Required CI/branch protection and native deploy path restrictions verified.
- [ ] Exact deployed build passes readiness and critical authenticated user flows.
- [ ] Inbox/outbox age, failure counts and worker activity checked after cutover.
- [ ] Webhook rows left `pending` with no retry time before this release are not
      replayed automatically (a weeks-old delivery could overwrite newer data). Review
      them in Sync Logs and replay the ones still relevant.
