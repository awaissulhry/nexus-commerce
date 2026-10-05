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
6. Failure: Redis down, a timeout, no workers, or a job that fails. The kick logs and returns, and the minute sweep
   runs the receipt. Nothing can change or delay the 200.
7. Retries: the BullMQ job has `attempts: 1`. The receipt's own backoff decides retries, and a kick cannot jump it.

Files changed outside the new ones:
- `routes/ebay-notification.routes.ts`: only the POST receiver (+5/-1 lines) and one import.
- `lib/queue.ts`: the new queue, and it is closed in `closeQueue`.
- `runtime/worker.ts`: the worker is registered.
- `scripts/run-real-postgres-tests.mjs`: one new suite.

This PR does not edit `cx/ingress/*` (PR A) or `cx/connectors/ebay/notifications.ts`, the reconcile job or the STATUS
route (PR B). It adds no event type.

## Commits

| Commit | What |
|---|---|
| `9d4aeb834` feat(ebay) | The queue, the kick, the worker, the runtime registration and the receiver's kick after the 200. Also the kick unit test (16 cases). |
| `2586350ff` test(ebay) | Route test (6 cases): the 200 never waits for the kick. Real-PostgreSQL suite (5 cases), added to `run-real-postgres-tests.mjs`. |
| `cf2f9ffb3` test(ebay) | Real-Redis test (2 cases, opt-in): BullMQ jobId dedupe and the real WorkspaceWorker. |
| `819565fc8` test(ebay) | The kick test uses a synthetic receipt id. |
| this commit docs(ebay) | This hand-over. |

## Checks (local, 2026-10-06)

| Check | Command | Result |
|---|---|---|
| Typecheck api | `npx tsc --noEmit -p apps/api/tsconfig.json` | pass |
| Area tests, profiles OFF | `cd apps/api && DATABASE_URL=…127.0.0.1:5432/nexus_development REDIS_URL=redis://127.0.0.1:1 npx vitest run` with 15 files: the kick unit test; the 4 receiver route tests + KMS formats + write-account guard; `jobs/inbound-retry-{ebay,deferred,trust}`; `lib/bullmq-job-ids`; `runtime/registrations`; ebay-order-notice/-processing unit tests; the Redis test | pass, 180/180 |
| Area tests, profiles ON | same, with `NEXUS_WORKSPACES_ENABLED=1` | pass, 180/180 |
| Real PostgreSQL (throwaway Docker pg17) | `node scripts/run-real-postgres-tests.mjs --suites …` with 5 suites: the new one (5), `ebay-order-processing-postgres` (13), `ebay-processing-postgres` (17), `ebay-rollout-postgres` (9), `ebay-erasure-review-postgres` (119; it goes through the receiver) | pass, 163/163 |
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
| M6 the worker no longer filters by `workspaceIdForQuery()` | real PostgreSQL | **survived.** The business-scoped Prisma client already keeps the read in the job's business. The explicit filter is a second layer, and the other-business test still holds without it. |
| M7 the receiver awaits the kick before the 200 | route test | killed (the hanging-queue case times out) |
| M8 the jobId is not deterministic | real Redis | killed (3 jobs instead of 1) |
| M9 control: the receipt claim ignores the lease and the due time (`ebay-claims.ts`, never committed) | real PostgreSQL | killed. The race test and the late-kick test fail. So the race test does depend on the claim. |

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
6. **Not measured: the real seconds from a sale to the pool.** That needs a real eBay sale after Phase 3. Proof is a
   `WebhookEvent` `ORDER_CONFIRMATION` marked done a few seconds after `createdAt`, and a stock movement with actor
   `ebay-order-notice`.
