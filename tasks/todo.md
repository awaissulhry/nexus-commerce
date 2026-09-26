# Architecture remediation tasks

Status is evidence-based: checked means implemented AND verified locally;
production completion is tracked separately. See [plan.md](plan.md).

## A. Release lifecycle (no dependencies)
- [x] Move all API startup migration calls to Railway pre-deploy; preserve direct
  endpoint and applied-history validation. Test migration selection and start config.
- [x] Separate `MIGRATION_DATABASE_URL` from runtime `DATABASE_URL`; safely parse
  hostnames without modifying passwords/query values. Verify malformed/missing URLs.
- [x] Make API deployment wait for CI on the exact deployment SHA; promote existing
  architecture/security guards. Superseded by the CI programme: required checks are
  on main (#5); deploy-after-CI is PR #8.

## B. Tenant login and Prisma (after A)
- [x] Audit runtime login privileges/ownership/memberships with a read-only checker.
  Add a two-role real-Postgres fixture covering raw queries, rollback, pool reuse,
  cross-tenant read/write and deliberate service doors.
- [x] Require the runtime grant to be inherited (`WITH INHERIT TRUE, SET TRUE`): the
  web's session reader queries without SET ROLE. The pool refuses a NOINHERIT login
  with a clear error; a real-PG test proves RLS still holds without SET ROLE.
- [x] Upgrade commerce Prisma to stable 7 with matched packages and CLI config;
  validate schema, generate, build and pass real tenant/concurrency tests.

## C. Runtime roles (after A)
- [x] Extract scheduler startup and worker startup into explicit entry points; HTTP
  still receives cross-process SSE events. Verify no background consumer runs in API mode.
- [x] Implement bounded graceful shutdown/readiness; define separate Railway service
  configs and ordered cutover/rollback.
- [x] Remove fail-open cron behavior from split deployment; preserve scoped lease
  execution and document durable-scheduler migration boundaries. Test competing runners.
- [x] Every process loads the same in-process registries (channel specs, automation
  actions); background processes require the queue lane; the API ends event streams
  when it shuts down.

## D. Inbox (after B for new schema)
- [x] Add atomic claims, fencing and lease recovery; preserve verification,
  workspace/account ownership, archive state and attempt budget. Tested: competing
  claims, expired owner, stale completion, attempt budget, replay during a lease.
- [x] Trusted replayable arrivals are due the moment they are recorded, so a crashed
  receiver cannot strand them. Rows stranded before this release are NOT replayed
  automatically (a weeks-old delivery could write stale data); Sync Logs replays them.
- [x] Retain bounded exact bytes and signature headers under the retention policy.
  Retention keeps only claimed or scheduled rows past the window; rejected and
  stranded rows expire (before, a flood of bad signatures would have been kept forever).
- [x] Retry sweep claims each event at the database's current time (a slow batch
  used to hand later events an already-expired lease).

## E. Events and commands (existing outbox)
- [x] Validate known event type/version/payload at consumers; malformed events cannot
  execute domain logic. Test supported, unknown and malformed envelopes.
- [x] Make stockout state/event writes atomic; make watchdog dedupe atomic. The
  stockout insert no longer aborts its transaction when a concurrent open wins.
- [x] Propagate request/change correlation into events and record actual ordering
  guarantees.
- [x] Replace the memory-only command idempotency with durable receipts (IETF
  semantics: 409 while running, 422 on a different request, replay after 2xx, a failure
  releases the key, 10-minute window, keys of any length). Tested with real SQL.

## F. Clients and boundaries
- [x] TypeScript/AG Grid: installed TS 5.9.3 already meets AG Grid 36's floor
  (5.8.3), and both AG Grid packages pin 36.1.0 exactly. No manifest churn needed.
- [x] Align React/DOM/types: web and Factory run React 19.2 with 19 types, like the root
  (PR #28, 2026-09-26).
- [x] Browser/server shared-module boundary: `@nexus/shared`'s root entry is the
  server vault; no web or Factory code imports it, and a client import of `node:crypto`
  fails the Next build.
- [x] Document N/N−1 compatibility (tasks/architecture-operations.md), auth layers,
  media authority, secrets and Factory ownership (plan.md dispositions 15–22).
- [x] The web sends one Idempotency-Key per user intent (`apps/web/src/lib/command-key.ts`,
  PR #26).
- [x] Status endpoints read shared state: per-process heartbeats in Redis, cron runs from
  the database, circuit reset reaches every process; unknown is said, never guessed (PR #30).
- [x] `CategoryTreeService` takes its transaction and lock (PR #27). A read-only audit of
  production found the tree consistent (14 categories, 0 problems).
- [x] One-off scripts with an adapter-less `new PrismaClient()`: a ratchet holds the 404
  that remain and refuses new ones (PR #25). Fix each script when it is reused.
- [x] **Before 2026-12-01:** Railway stops reading `railway.toml` then. Done 2026-09-26: the
  API's pre-deploy migration, start command and health check are Railway service settings,
  and the file is removed.

## G. Final evidence and rollout
- [x] Focused suites, relevant builds, migration guards, real PG gates pass locally.
- [x] Independent review findings reconciled.
- [x] Production configuration verified (2026-09-26): dedicated login, migration credential,
  service roles, CI protection, deployed health/build SHA and business-flow smoke.
- [x] 220 pending AMAZON webhook rows stranded before the release were closed as dead
  letters with the reason (140/144 order notices name orders Nexus holds; the other 2
  orders are MCF fulfilment orders).
- [x] Redis moved to europe-west4, next to every other service (2026-09-26 19:18 UTC). The
  volume migrated with its data (1,746 keys); the apps lost Redis for about 3 seconds.

Repository implementation and production rollout remain separate until evidence
exists for both. Deferred product choices (Factory sync/SSO, removing GraphQL,
relocating all media) are intentionally not fake implementation checkboxes.
