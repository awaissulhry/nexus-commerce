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

The worker and scheduler services (`nexus-worker`, `nexus-scheduler`, created
2026-09-26) run the API image. Only the deploy workflow changes their image tag
(see "Image deploys and rollback").
Railway no longer lets a new service read a config file (Config as Code is deprecated),
so their settings live in Railway: start `npm run start:worker`
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
Both push and manual dispatch follow this dependency. Railway pulls the commit's image, executes
`npm run db:migrate:deploy` as pre-deploy, starts the API, and waits for the readiness
endpoint and expected build SHA. Ordinary restart/replica scale-up does not migrate.

A push ships only the services whose files differ from the commit each one runs now
(read from its latest successful Railway deployment, `scripts/ci/release-changes.sh`).
CI-only and docs-only pushes start no deploy. A hand run (`gh workflow run
deploy-api.yml`) compares the same way, so it ships what a failed or skipped release
left behind; `-f ship=all` ships every service. All four services use images. If a service
was changed back to a source deployment outside this workflow, the next release restores its image
path, unless that service already runs a newer commit. An older release never moves a newer service
back, except when the operator explicitly uses `ship=all`.

Each selected service is checked again immediately before its forward deploy. A retry can reuse the
original `changes` outputs, so this second check skips services that have become current or newer.
It does not add a service the original run left out: start a fresh hand run from main after a rollback
or when the desired set of services has changed. Rollback has its own explicit target and guards.

**Do not replay deployment jobs from workflows before the image-only cutover.** Those versions can
reuse a cached source-build choice. On 2026-09-30, run 36721092871 demonstrated this: a retry began a
source build after the API had switched to an image. Refreshing the change-selection job restored the
current modes. Prefer a new Deploy API run from main. Cancelling GitHub does not stop a Railway
build already submitted; inspect Railway before retrying or removing that deployment.

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

Every Deploy API run builds two images of its commit beside the full CI:
`ghcr.io/<owner>/nexus-api:<sha>` for API, worker and scheduler, and
`ghcr.io/<owner>/nexus-web:<sha>` for web. Every selected service waits for both images and its required
checks. Railway pulls the image and runs its start and health commands; it builds no source.
There is no mode variable or `railway up` fallback in these workflows.

The four switches completed on 2026-09-30. Evidence and timings are in
[the fast-deploy plan](../docs/ci-fast-deploys/PLAN-2026-09-29.md#10-switches-measured-2026-09-30).
Keep the old `RAILWAY_IMAGE_SERVICES` variable set to all four names until this workflow change is
merged and any older queued or running release/rollback workflows have finished. Then delete it.
It is unused by the new workflows, but an old workflow can still read it.

### What a successful image deploy proves

The deploy uses the same project token. It reads the project's environments, changes the source
with `serviceInstanceUpdate`, reads the source back, then calls `serviceInstanceDeployV2` and follows
the returned deployment. These operations worked in the four live switches. The API's pre-deploy
migration command and readiness SHA check stay in place.

The job ends with `✓ Railway runs ghcr.io/<owner>/nexus-…:<sha>` when Railway reports SUCCESS and
its deployment record names the requested image. For all four services, read
`railway deployment list -s <service> --limit 1 --json` and check `meta.image`. The API also reports
its short commit in `/api/health/ready` as `build`. Old source deployments use `meta.cliMessage`;
the release selector still reads those so it can compare commits and restore image mode safely.

A record naming another image or a source build fails the job. A missing record can only warn if
the source read-back confirmed the image and the returned deployment is new; verify that case on
Railway. An existing deployment must name the requested image in its own record. A source setting
does not prove what an older deployment runs. A removed, failed or replaced deployment fails the
job. One never listed as latest fails when its recorded terminal state is seen or the wait expires.

The web image contains the `NEXT_PUBLIC_*` and `NEXUS_API_PROXY_TARGET` values that `nexus-web` had
at build time. Changing those values requires a new image and web deployment. A new commit gives a
new image tag. Rebuilding and pulling a changed image under the same commit tag remains unproved.

### When an image deploy stops

The schema marks `serviceInstanceUpdate`'s environment as experimental: a change to an environment
that is not a fork can reach every environment that is not a fork. The deploy writes nothing unless
it can read the whole list and exactly one active environment is not a fork. If the project gains
another such environment, or that list cannot be read, stop and resolve the scope before retrying.

- A refused environment query means no source request was sent. Check the project token and read
  permissions. Do not change to a broader token to bypass this guard.
- A refused source request leaves the prior source in place. Fix the cause before another release.
  There is no source-build fallback to enable.
- `nothing was sent` applies to the named request only. A failed deployment request can follow an
  already-applied source change. Check the source and deployment list.
- A timeout, HTTP 5xx, broken success reply or missing result leaves the mutation's outcome unknown.
  Check both Settings → Source and the deployments before retrying. The source update may have
  started a deployment itself, even when the script did not call the deploy mutation.
- A read-back showing an old or empty source stops before the explicit deploy call. Railway may have
  staged the change. Check the staged changes and report the cause; do not assume it applied.
- If the source changed but deployment failed, the source can still name the new image. Inspect it,
  fix the cause and start a fresh Deploy API run, or use the guarded rollback below.

The successful switches prove these behaviors for those runs. They do not establish that future
updates can never be staged or start a deployment of their own. Keep the read-back and image-record
checks. Do not infer the running image from Settings → Source alone.

### Service commands

- API: `node apps/api/dist/index.js`; pre-deploy `npm run db:migrate:deploy`; readiness
  `/api/health/ready`, 300 seconds.
- Worker and scheduler: `npm run start:worker` and `npm run start:scheduler`; readiness
  `/health/ready`, 90 seconds. Their existing npm wrapper can report SIGTERM as exit 1 on shutdown.
- Web: `node apps/web/scripts/start.mjs`; health `/login`, 120 seconds. Its image has no root
  `package.json`, so a root `npm run …` start command does not work.

Railway ignores build commands, watch paths and `RAILPACK_`/`NIXPACKS_` node versions for an image
source. Keep start, pre-deploy and health settings on Railway. An image that fails its pre-deploy or
health check does not take traffic from the previous healthy deployment.

### Roll back

    gh workflow run rollback.yml -f sha=<commit>
    gh workflow run rollback.yml -f sha=<commit> -f skip_api=true   # the API keeps its build

The commit must be on main (a full SHA or a prefix of 7 or more characters), and its Deploy API run
must have succeeded: that run passed CI and built the images. The workflow runs in GitHub, not on this
machine. It:

- checks the commit, its Deploy API run and both of its images;
- selects all four services; `skip_api=true` leaves only the API in place;
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
by hand. A retry rechecks only the services selected by that old run; start a new hand run to compare
all four services with main again.

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
