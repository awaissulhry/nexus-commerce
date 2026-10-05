# HANDOFF — stock heal and pool triggers (branch fix/stock-heal-and-pool-triggers)

Worktree: `/private/tmp/fix-stock-heal-and-pool-triggers` (from origin/main 63ad79dbf). Owner goal (2026-10-06):
"make sure that the stock updates in real time across profiles". Do NOT edit `outbound-sync.service.ts` or
`ebay-trading-api.service.ts` (another builder owns eBay Trading routing). Not pushed; no PR yet.

## Status — build DONE, local checks green; next: push + PR (merge needs the Owner's word)
| Gap | What | State |
|---|---|---|
| 6 | Lent warehouse switched off/on/retyped, or lending business not active → borrowers queued | DONE |
| 7 | Failed pool task released at once with back-off (5 s doubling, max 5 min) | DONE |
| 3 | Stock push heal job, every 10 min per business | DONE, scheduled (opt out `NEXUS_STOCK_PUSH_HEAL=0`) |
| 5 | Trading read-back per account | SKIPPED — not small (below) |

## Commits
- e9fdf8fc0 feat(stock-pool): a lent warehouse or a lending business switched off queues the borrowers
  (schema `StockPoolTask.retryAt`, baseline.sql regenerated, stock-pool.sql: `nexus_stock_pool_location_changed`,
  `nexus_stock_pool_lender_changed`, `nexus_pool_pending_workspaces` reads retryAt; migration
  `20261006a_stock_pool_heal_triggers`; policy-migrations.json; 2 tests in stock-pool-rules)
- 63a5eee83 fix(stock-pool): a failed pool task is retried within seconds, with a bounded back-off (pool-tasks.ts + test)
- b34bc256c feat(stock): stock push heal job (`apps/api/src/jobs/stock-push-heal.job.ts`)
- 19e6fd4de docs: this handoff
- 139b3c1c7 test(stock): stock push heal (`apps/api/src/jobs/stock-push-heal.vitest.test.ts`)
- 58ae023b2 feat(stock): schedule it (runtime/scheduler.ts, jobs/cron-registry.ts, inventory-sync diagnostics list)

## Checks
| Check | Command | Result |
|---|---|---|
| API typecheck | `npx tsc --noEmit -p apps/api/tsconfig.json` | pass |
| database typecheck | `npm run typecheck -w @nexus/database` | pass |
| drift | `npm run check:drift` | pass (472 tables) |
| policy parity | `node packages/database/scripts/check-policy-migration-parity.mjs` | pass |
| model ownership / stock writer lock / clustered cron | the three `check-*.mjs` | pass |
| definer search_path + policy body | `cd packages/database && npx vitest run scripts/definer-search-path.vitest.test.ts scripts/policy-migration-body.vitest.test.ts` | pass |
| baseline.sql builds schema.prisma | throwaway postgres:17 container, `NEXUS_TEST_LOCAL_PG_URL=… npx vitest run scripts/baseline.vitest.test.ts` | 13/13 pass |
| area tests, profiles OFF and ON | `npx vitest run src/services/stock-pool src/jobs/sync-drift-detection.vitest.test.ts src/jobs/stock-push-heal.vitest.test.ts` (+ cron registry / runtime-status tests) | pass both ways |
| mutation | triggers moved to `UPDATE OF name` | the 2 new rules tests fail (as they must) |
| real PostgreSQL | `node scripts/run-real-postgres-tests.mjs --suites '[…6 stock suites…]'` | all tests pass; runner flags "stock model" 51 passed vs its SUITES expect 48 — pre-existing, file not touched here |
| `src/lib/cron/clustered.vitest.test.ts` profiles ON | alone | 5 fail vs baseline 4 — files unchanged on this branch (pre-existing / environment); passes profiles OFF |

(API tests: from `apps/api` with `DATABASE_URL='postgresql://nexus:nexus@127.0.0.1:5432/nexus_development' REDIS_URL='redis://127.0.0.1:1'`.)

## Decisions
- GAP 7 uses a new nullable column `retryAt` (claimedAt NULL on failure, as asked); back-off 5 s · 2^(n-1), cap 5 min.
- GAP 6 also covers "lender business not active" (same pattern, cheap): `AFTER UPDATE OF status ON "Workspace"`,
  only when active ↔ not active flips; borrower-side status changes queue nothing.
- GAP 3: latest quantity row per listing; DEAD / STUCK_FAILED (no retry time, retries spent and not AUTH_REQUIRED,
  or retry time > 2 h past) / STALE_PENDING (> 2 h due); 7-day look-back; 100 listings per business per run.
  Budget from the heal rows themselves (payload.source `STOCK_PUSH_HEAL`): REFUSED (died with retries left) 1/24 h;
  RETRYABLE 3/24 h, ≥ 1 h apart. Gates = the cascade's resolver + push lock + draft + account down; a FOLLOW listing
  whose Nexus number differs from its ledger is left to the drift job (it recascades). Pinned listings are healed.
  Shared eBay variants (no ChannelListing) are not covered (the Trading read-back heals them).

## Open items
1. Push the branch and open the PR (scan commits for real ids first — none used: test ids are random/fake).
2. GAP 5 (skipped): the Trading read-back reads with the primary account only. Per-account reads change pinned
   behaviour in `ebay-trading-price-readback.p44.vitest.test.ts` ("reads with ONE account's token", "another
   account's membership is never compared"), need the channel policy per (product, account) and the price arm per
   account, and overlap the other builder's eBay Trading lane. Needs a decision.
3. Not added to `services/automation/automation-adapters.ts` (the automation inventory); add if the Owner wants it listed.
