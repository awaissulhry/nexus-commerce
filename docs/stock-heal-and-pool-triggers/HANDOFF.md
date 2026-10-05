# HANDOFF — stock heal and pool triggers (branch fix/stock-heal-and-pool-triggers)

Worktree: `/private/tmp/fix-stock-heal-and-pool-triggers` (from origin/main 63ad79dbf). Owner goal (2026-10-06):
"make sure that the stock updates in real time across profiles". Do NOT edit `outbound-sync.service.ts` or
`ebay-trading-api.service.ts` (another builder owns eBay Trading routing).

## Status
| Gap | What | State |
|---|---|---|
| 6 | Lent warehouse switched off/on/retyped, or lending business not active → borrowers queued | DONE, committed (e9fdf8fc0) |
| 7 | Failed pool task released at once with back-off (5 s doubling, max 5 min) | DONE, committed (63a5eee83) |
| 3 | Stock push heal job (`apps/api/src/jobs/stock-push-heal.job.ts`) | CODE committed (b34bc256c); test + scheduler wiring IN PROGRESS |
| 5 | Trading read-back per account | SKIPPED — not small (see below) |

## Commits
- e9fdf8fc0 feat(stock-pool): a lent warehouse or a lending business switched off queues the borrowers
  (schema `StockPoolTask.retryAt`, baseline.sql regenerated, stock-pool.sql triggers + pending_workspaces,
  migration `20261006a_stock_pool_heal_triggers`, policy-migrations.json, 2 tests in stock-pool-rules)
- 63a5eee83 fix(stock-pool): a failed pool task is retried within seconds, with a bounded back-off (+ pool-tasks.vitest.test.ts)
- b34bc256c feat(stock): stock push heal job (not yet scheduled)

## Checks run so far
| Check | Command | Result |
|---|---|---|
| policy parity | `node packages/database/scripts/check-policy-migration-parity.mjs` | pass |
| drift | `npm run check:drift` | pass |
| model ownership | `node packages/database/scripts/check-model-ownership.mjs` | pass |
| stock writer lock | `node scripts/check-stock-writer-lock.mjs` | pass |
| definer search_path | `cd packages/database && npx vitest run scripts/definer-search-path.vitest.test.ts` | pass |
| rules suite (PGlite) | `cd apps/api && npx vitest run src/services/stock-pool/stock-pool-rules.vitest.test.ts` | 23/23 pass; mutation (triggers moved to `name`) fails them |
| pool tasks (PGlite) | `npx vitest run src/services/stock-pool/pool-tasks.vitest.test.ts` | 4/4 pass |
| API typecheck | `npx tsc --noEmit -p apps/api/tsconfig.json` | pass (after the job file) |

(API tests: run from `apps/api` with `DATABASE_URL='postgresql://nexus:nexus@127.0.0.1:5432/nexus_development' REDIS_URL='redis://127.0.0.1:1'`.)

## Open items
1. Test for the heal job (`apps/api/src/jobs/stock-push-heal.vitest.test.ts`, PGlite, profiles ON): failed → re-queued
   once; newer success → nothing; budget respected; paused → nothing; borrower (pooled) listing included.
2. Wire it: `startStockPushHealCron()` in `apps/api/src/runtime/scheduler.ts` (next to the drift cron),
   `'stock-push-heal'` in `jobs/cron-registry.ts`, and the name in `routes/inventory-sync-diagnostics.routes.ts` CRON_NAMES.
3. Run: profiles ON and OFF for the new tests; real-PG stock-pool suites via
   `node scripts/run-real-postgres-tests.mjs --suites '[...]'` (Docker + postgres:17 image are present);
   `npm run typecheck -w @nexus/database`; baseline test with a throwaway container
   (`NEXUS_TEST_LOCAL_PG_URL=… npx vitest run scripts/baseline.vitest.test.ts` in packages/database).
4. GAP 5 (skipped): the Trading read-back reads with the primary account only. Doing it per account changes pinned
   behaviour in `ebay-trading-price-readback.p44.vitest.test.ts` ("reads with ONE account's token", "another account's
   membership is never compared"), needs the channel policy per (product, account) and the price arm per account, and
   overlaps the other builder's eBay Trading lane. Not small — left for a decision.
