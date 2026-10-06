# PR C — run a stored eBay order notice within seconds (Phase 4)

Branch `feat/ebay-order-notice-instant` (worktree `/private/tmp/feat-ebay-order-notice-instant`), from `origin/main`
1d207cf19. Not pushed. Plan: `GAP2-ebay-order-notifications-plan.md` §4 "Phase 4" (in the Owner's archive, not in the repo).

## What it does

Before: a stored, verified `ORDER_CONFIRMATION` waited for the minute sweep (`jobs/inbound-retry.job.ts`, worker),
so up to about 60 seconds.

Now:

1. The receiver (`POST /api/webhooks/ebay-notification`) stores the notice and sends eBay its 200 first.
2. Only then it calls `kickStoredEbayOrderNotice` (`services/cx/ebay-order-notice-kick.ts`). The receiver does not
   await it, and the call never rejects.
3. The kick asks for ONE job on the new `ebay-order-notice` queue (`lib/queue.ts`):
   - jobId `ebay-order-notice-<receiptId>`. WorkspaceQueue makes it `w_<business>_ebay-order-notice-<receiptId>`;
   - the job runs in the receipt's business (`withIngressWorkspace`, the same context the sweep uses);
   - it goes through `addJobSafely`, which has a timeout and a circuit breaker and skips when workers are off.
4. A kick is asked only when the sweep would also run the receipt:
   - admission routed the notice to a business (`accepted`), not `quarantined` or `rejected`;
   - the verified body's topic is `ORDER_CONFIRMATION`;
   - `ebayInboundProcessingReady()` (`NEXUS_ENABLE_EBAY_INBOUND_PROCESSING=1` and the token service on) AND
     `ebayOrderNoticesEnabled()` (`NEXUS_ENABLE_EBAY_ORDER_NOTICES=1`).
5. The worker (`workers/ebay-order-notice.worker.ts`, registered in `runtime/worker.ts`, concurrency 2) re-reads the
   STORED receipt. It runs only an `ORDER_CONFIRMATION` of the job's business, and calls `processEbayInbound`, the
   function the minute sweep calls. That means:
   - the same switches hold it;
   - the same claim (`claimEbayInbound`) decides who runs it;
   - the same executor (`processEbayOrderClaim`) reads the order and writes it.
   Row-level security on `WebhookEvent` keeps both the read and the claim in the job's business. The adapter sets the
   runtime role and `nexus.workspace_id` from the business that `runWorkspaceJob` binds. The worker's explicit
   `workspaceId` filter is a second layer. The business-scoped Prisma client adds `workspaceId` only to unique
   `where`s, so it is not what confines this read.
6. Failure: Redis down, a timeout, no workers, or a job that fails. The kick logs and returns, and the minute sweep
   runs the receipt. Nothing can change or delay the 200. A lost job costs time, never the order. That time is up to
   the sweep's pace: 4 eBay receipts per business per minute, so a burst of sales during a Redis outage drains at
   about 4 a minute.
7. A path that is switched off is visible. The first kick held by each missing switch is logged once per process, at
   info, naming the switch:
   - `NEXUS_ENABLE_EBAY_INBOUND_PROCESSING=1`;
   - the token service;
   - `NEXUS_ENABLE_EBAY_ORDER_NOTICES=1`;
   - `ENABLE_QUEUE_WORKERS=1`.
   The worker logs Redis errors through a structured `error` listener.
8. Retries: the BullMQ job has `attempts: 1`. The receipt's own backoff decides retries, and a kick cannot jump it.

Files changed outside the new ones:
- `routes/ebay-notification.routes.ts`: only the POST receiver (+5/-1 lines) and one import.
- `lib/queue.ts`: the new queue, and it is closed in `closeQueue`.
- `runtime/worker.ts`: the worker is registered. `runtime/registrations.vitest.test.ts` fails if it is dropped.
- `scripts/run-real-postgres-tests.mjs`: one new suite (6 cases).

This PR does not edit `cx/ingress/*` (PR A) or `cx/connectors/ebay/notifications.ts`, the reconcile job or the STATUS
route (PR B). It adds no event type.

## Commits

| Commit | What |
|---|---|
| `9d4aeb834` feat(ebay) | The queue, the kick, the worker, the runtime registration and the receiver's kick after the 200. Also the kick unit test (16 cases). |
| `2586350ff` test(ebay) | Route test (6 cases): the 200 never waits for the kick. Real-PostgreSQL suite (5 cases), added to `run-real-postgres-tests.mjs`. |
| `cf2f9ffb3` test(ebay) | Real-Redis test (2 cases, opt-in): BullMQ jobId dedupe and the real WorkspaceWorker. |
| `819565fc8` test(ebay) | The kick test uses a synthetic receipt id. |
| `aaf60e851` docs(ebay) | This hand-over, first version. Its commit message credits the business-scoped client for M6; that is wrong, see M6 below. |
| `58c65baab` fix(ebay) | Review: the worker gets an `error` listener. Corrected the queue comment (it named a missing file and said "seconds"). Corrected the worker comment (row-level security comes first). |
| `ab8cc4b26` feat(ebay) | Review: a kick that is held or has workers off is logged once per process, naming the switch (kick test: 17 cases). |
| `e29912be6` test(runtime) | Review: a static check that `runtime/worker.ts` starts the order-notice worker. |
| `adb14965e` test(ebay) | Review: a real-PostgreSQL case through `scopeJobData` → `runWorkspaceJob` → the claim under row-level security (the suite now has 6 cases). |
| this commit docs(ebay) | This hand-over, updated after the review. |

## Checks (local, 2026-10-06)

| Check | Command | Result |
|---|---|---|
| Typecheck api | `npx tsc --noEmit -p apps/api/tsconfig.json` | pass |
| Area tests, profiles OFF | `cd apps/api && DATABASE_URL=…127.0.0.1:5432/nexus_development REDIS_URL=redis://127.0.0.1:1 npx vitest run` with 15 files: the kick unit test; the 4 receiver route tests + KMS formats + write-account guard; `jobs/inbound-retry-{ebay,deferred,trust}`; `lib/bullmq-job-ids`; `runtime/registrations`; ebay-order-notice/-processing unit tests; the Redis test | pass, 182/182 |
| Area tests, profiles ON | same, with `NEXUS_WORKSPACES_ENABLED=1` | pass, 182/182 |
| Real PostgreSQL (throwaway Docker pg17) | `node scripts/run-real-postgres-tests.mjs --suites …` with 5 suites: the new one (6), `ebay-order-processing-postgres` (13), `ebay-processing-postgres` (17), `ebay-rollout-postgres` (9), `ebay-erasure-review-postgres` (119; it goes through the receiver) | pass, 164/164 |
| Real Redis (throwaway `redis:7-alpine` on 127.0.0.1) | `NEXUS_TEST_REDIS_URL=redis://127.0.0.1:<port> npx vitest run src/workers/ebay-order-notice-redis.vitest.test.ts` | pass, 2/2 |
| Gateway ratchet | `cd apps/api && npx tsx scripts/channel-gateway-ratchet.mts --check` | pass (all channels 0) |
| Static guards | `check-inbound-ledger`, `check-route-prisma-ratchet --check`, `check-cron-clustered`, `check-context-boundary --check`, `check-stock-writer-lock --check`, `map0-connection-resolution-audit --ratchet` | pass |
| Split self-test | `node scripts/run-real-postgres-tests.mjs --self-test` | pass (80 suites) |
| Browser check | — | not run: no screen change |

## Mutation checks

Each mutation was applied by hand, the named test was run, and the file was restored with `git checkout`.

| Mutation | Test | Result |
|---|---|---|
| M1 the kick no longer requires an `accepted` (routed) outcome | kick unit test | killed |
| M2 the kick no longer requires `ORDER_CONFIRMATION` | kick unit test | killed |
| M3 the kick ignores "processing ready" | kick unit test | killed |
| M4 the kick ignores the order-notices switch | kick unit test | killed |
| M5 the worker no longer checks the stored event type | real PostgreSQL | killed (a revocation receipt was run) |
| M6 the worker no longer filters by `workspaceIdForQuery()` | real PostgreSQL | **survived.** Row-level security on `WebhookEvent` already keeps the read in the job's business, so the explicit filter is a second layer. The first version of this file said the business-scoped Prisma client did this; it does not (it scopes only unique `where`s). |
| M7 the receiver awaits the kick before the 200 | route test | killed (the hanging-queue case times out) |
| M8 the jobId is not deterministic | real Redis | killed (3 jobs instead of 1) |
| M9 control: the receipt claim ignores the lease and the due time (`ebay-claims.ts`, never committed) | real PostgreSQL | killed. The race test and the late-kick test fail. So the race test does depend on the claim. |
| M10 `initializeEbayOrderNoticeWorker` is dropped from the worker list | runtime registrations test | killed |
| M11 the switch-off log is no longer once per process | kick unit test | killed |
| M12 a held kick is no longer logged | kick unit test | killed |
| Control: row-level security disabled on `WebhookEvent` (test database only, never committed) | real PostgreSQL, the `runWorkspaceJob` case | killed. Another business's claim then takes the receipt. So that case depends on row-level security, not on the worker's filter. |

After the review fixes, M1–M4, M7 and M8 were run again: all killed.

## Open points

1. **Inert until PR A merges.** Today admission quarantines every `ORDER_CONFIRMATION`, so the outcome is never
   `accepted` and nothing is kicked. The PRs can merge in any order.
2. **Switches on the API service too.** The kick reads `NEXUS_ENABLE_EBAY_INBOUND_PROCESSING` and
   `NEXUS_ENABLE_EBAY_ORDER_NOTICES` in the API process. The plan's Phase 3 table already lists them for "API +
   worker". The API also needs `ENABLE_QUEUE_WORKERS=1` to produce jobs. If the API and the worker disagree, the
   worker holds the job (`held`).
3. **Rolling deploy.** An old worker has no consumer for `ebay-order-notice`, so jobs wait in Redis while the sweep
   runs the receipts. When the new worker starts, a stale job finds the receipt done (`not_claimed`).
4. **PR A and `readEbayNoticeIdentity`.** The kick reads only `metadata.topic` through it. If PR A makes it refuse an
   order notice without `data.user.userId`, admission would not route that notice either, so the two stay consistent.
5. **The Redis test is opt-in.** It skips unless `NEXUS_TEST_REDIS_URL` names a loopback Redis. It is not in the
   real-PostgreSQL runner, because that runner sets `REDIS_URL` to a dead port. Run it by hand with a throwaway
   container; the command is in the test's header.
6. **The circuit breaker is shared, and left as it is (decision).** A kick that hits `addJobSafely`'s 2.5 s timeout
   opens its 30 s circuit for the whole API process. During those 30 s, the outbound-sync instant pushes also fall
   back to the 60 s drain. This coupling already existed (same Redis); the kick adds one more trigger.
7. **Both test suites force profiles ON.** The real-PostgreSQL and Redis suites set `NEXUS_WORKSPACES_ENABLED=1` in
   `beforeAll`, so their "profiles OFF" run is really ON. The kick, route and registration tests do run in both modes.
8. **PR A is changing the sweep order** in `cx/ingress/ebay-processing.ts` (new receipts first).
   `processEbayInbound`'s signature stays, and this PR does not edit that file. "4 receipts per business per minute"
   stays true.
9. **Not measured: the real seconds from a sale to the pool.** That needs a real eBay sale after Phase 3. Proof is a
   `WebhookEvent` `ORDER_CONFIRMATION` marked done a few seconds after `createdAt`, and a stock movement with actor
   `ebay-order-notice`.
