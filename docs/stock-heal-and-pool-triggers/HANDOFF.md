# HANDOFF — stock heal and pool triggers (branch fix/stock-heal-and-pool-triggers)

Worktree: `/private/tmp/fix-stock-heal-and-pool-triggers`, rebased on origin/main a1393f12c. Owner goal (2026-10-06):
"make sure that the stock updates in real time across profiles". Do NOT edit `outbound-sync.service.ts` or
`ebay-trading-api.service.ts` (another builder owns eBay Trading routing). Not pushed; no PR yet.

## Status — review fixes DONE, local checks green; next: push + PR (merge needs the Owner's word)
| Item | What | State |
|---|---|---|
| GAP 6 | Lent warehouse switched off/on/retyped, or lending business not active → borrowers queued | DONE |
| GAP 7 | Failed pool task released at once with back-off (5 s doubling, max 5 min) | DONE |
| GAP 3 | Stock push heal job, every 10 min per business | DONE, scheduled, default ON (switch below) |
| GAP 5 | Trading read-back per account | SKIPPED — not small (open item 2) |
| Review 1 | Heal starvation: held rows filled the `max+1` window | FIXED (11fd09fbf) |
| Review 2 | Heal visible and switchable; count-only mode | FIXED (b65b6f7be) |
| Review 4 | Error code before retry count | FIXED (11fd09fbf) |
| Review 5 | Pool task failure release guarded by `attempts` | FIXED (4f9ebeb1d) |
| Review 6 | `lock_timeout` on the migration | FIXED (55002fc03), policy-migration pattern of 20260926s/t |
| Review 7 | Trigger fired from the lender's own runtime session | TEST ADDED (5613f5d00) |
| Review 8, 9, 10 | See follow-ups | OPEN (follow-ups) |

## How to switch the heal job
- One env var on the **scheduler** service: `NEXUS_STOCK_PUSH_HEAL`.
  - `1` / `on` — it sends (queues one fresh quantity push per listing whose last one failed for good).
  - `count` — count-only: same selection, same budget, sends nothing. Each run lists the listings it would heal in its
    log line (`[stock-push-heal] run`, field `wouldHeal`) and in its CronRun summary
    (`mode=count candidates=N wouldHeal=N listings=<up to 20 listing ids>`).
  - `0` / `off` — not scheduled; a manual run (`POST /api/sync-logs/cron/stock-push-heal/trigger`) does nothing.
  - Unset — the default, ONE constant: `STOCK_PUSH_HEAL_DEFAULT_MODE` in `apps/api/src/jobs/stock-push-heal-mode.ts`
    (now `'on'`). To ship it count-only or off, change that one line to `'count'` or `'off'`.
  - Any other value is read as off (an unreadable switch sends nothing).
- To hold it until the Owner's re-push of the red/yellow eBay rows is done: set `NEXUS_STOCK_PUSH_HEAL=count` on the
  scheduler before the deploy (or flip the constant in this PR), read the `wouldHeal` lists, then set `1`.
- **Visible like the drift job:** a row `stock-push-heal` of automation N17 (key `detectors`, now named "Detectors and the
  stock push heal", writes to `nexus` and `channels`). Level AUTO (on), OBSERVE (count), OFF (off), with its env flag and
  mode. `list-automations` / `automation-detail` show it; `automation-activity` reads its CronRun runs with the drift
  job's. Like the drift job, Claude cannot move it: `turn-down-automation` answers that the detectors and the heal are
  switched by the server env only (its message names `NEXUS_STOCK_PUSH_HEAL`).
- Other knobs: `NEXUS_STOCK_PUSH_HEAL_SCHEDULE` (default `*/10 * * * *`), `NEXUS_STOCK_PUSH_HEAL_MAX` (default 100 tries
  per business per run).

## What the review fixes changed
- **Starvation (finding 1).** The candidate SQL now leaves out every listing a column holds (paused, selling closed, ended,
  still-draft, FBA by its own method or its Amazon product's, empty fixed number, account inactive / needs sign-in,
  deleted product), every coordinate a channel/market policy pauses (decided by `policyFor` itself, so its market-then-
  account precedence is exact), and every listing whose heal budget is spent (the row's class computed in SQL,
  `healClassSql`, mirrors `healClassOf`). `listingGate` and `budgetAllows` still check every row read. What only the
  ledger knows (FBA stock on hand, uncounted, the Nexus number, a claim refusal) is decided in code; those rows no
  longer block newer ones: a run reads up to `SCAN_PAGES` (5) pages of `max` rows, oldest first, until it has tried
  `max` heals. Limit: more than 5 × max ledger-held rows in front of a healable one still delay it (capped = true).
- **Clock.** Row ages now compare against `CURRENT_TIMESTAMP AT TIME ZONE 'UTC'` (how Prisma stores times), not the
  session time zone. Same result on a UTC session; found because the test database runs at UTC+1.
- **Class (finding 4).** A dead row's error code decides first: the "kept failing" codes are RETRYABLE, any other code
  (EBAY_VALIDATION, NON_RETRYABLE, …) is REFUSED on whichever try; only a dead row with no code falls back on its count.
- **Claim (finding 5).** The failure release matches `attempts = <this run's>`; a run that lost its claim leaves the task.
- **Migration (finding 6).** `BEGIN; SET LOCAL lock_timeout='5s'; … COMMIT;` (policyMigrationBody strips it; parity holds).
  The migration is not applied anywhere yet.

## Commits (all on this branch, oldest first)
- cc8f544a5 feat(stock-pool): a lent warehouse or a lending business switched off queues the borrowers
- 4e37b0b5b fix(stock-pool): a failed pool task is retried within seconds, with a bounded back-off
- 42f037d57 feat(stock): a quantity push that failed for good is queued again (stock push heal job)
- f122fbe60 docs(stock): handoff for the stock heal and pool triggers branch
- 3a9b2992d test(stock): stock push heal — once per failure, budget, gates, pooled listing
- 0061f5d7e feat(stock): schedule the stock push heal every 10 minutes
- 1e28c9791 docs(stock): handoff — build done, checks green, GAP 5 skipped
- 11fd09fbf fix(stock): stock push heal — held rows can no longer hide healable ones; a refusal stays a refusal
- b65b6f7be feat(stock): stock push heal — one switch with a count-only mode, listed in the automation inventory
- 4f9ebeb1d fix(stock-pool): a failed task is released only while its run still holds the claim
- 5613f5d00 test(stock-pool): a lent warehouse switched off in the lender's own session queues the borrower
- 55002fc03 fix(database): the stock pool trigger migration runs in one transaction with a 5 s lock_timeout
- (this handoff)

## Checks (2026-10-06, after the review fixes)
| Check | Command | Result |
|---|---|---|
| API typecheck | `npx tsc --noEmit -p apps/api/tsconfig.json` | pass (after `npm run build -w @nexus/shared` / `@nexus/events`: the rebase brought new shared exports) |
| database typecheck | `npm run typecheck -w @nexus/database` | pass |
| drift | `npm run check:drift` | pass (472 tables) |
| policy parity | `node packages/database/scripts/check-policy-migration-parity.mjs` | pass (20 files) |
| model ownership | `node packages/database/scripts/check-model-ownership.mjs` | pass (472 models) |
| stock writer lock | `node scripts/check-stock-writer-lock.mjs` | pass |
| clustered cron | `node scripts/check-cron-clustered.mjs` | pass |
| definer search_path + policy body | `cd packages/database && npx vitest run scripts/definer-search-path.vitest.test.ts scripts/policy-migration-body.vitest.test.ts` | pass (10) |
| area tests, profiles OFF | heal, `src/services/stock-pool/*`, automation catalog/explain/preview, automation MCP tools, drift job (19 files) | 14 files pass, 120 tests; 5 real-PG files skip (run below) |
| same, `NEXUS_WORKSPACES_ENABLED=1` | same | same: 120 pass |
| mutations | SQL budget off; `syncPaused` gate off; policy coordinates empty; claim guard off; trigger without SECURITY DEFINER | each makes the new tests fail |
| real PostgreSQL | `node scripts/run-real-postgres-tests.mjs --suites '[6 stock suites]'` (source tool, stock model, pool race, pool e2e, pool SKU e2e, pool orders) | every test passes; runner exits 1 only because "stock model" passed 51 vs its pinned `expect: 48` |
| baseline.sql | not regenerated: schema.prisma unchanged by the review fixes (the migration only gained its transaction wrapper) | n/a |

(API tests: from `apps/api` with `DATABASE_URL='postgresql://nexus:nexus@127.0.0.1:5432/nexus_development' REDIS_URL='redis://127.0.0.1:1'`.)

**The two "red" marks, settled:**
- Real-PG "stock model" 51 vs 48: `stock-model-postgres.vitest.test.ts` and `scripts/run-real-postgres-tests.mjs` are
  byte-identical to origin/main a1393f12c; main's #340 (59e5c83f0) changed that test file and left the pin at 48. Not
  from this branch; the pin belongs to whoever owns #340 (or a one-line fix PR).
- `src/lib/cron/clustered.vitest.test.ts` profiles ON, 5 failures: all `connect ECONNREFUSED 127.0.0.1:5432` — with
  profiles ON, clustered.ts lists businesses from the real dev database, which is not running on this machine. Passes
  10/10 profiles OFF. File and imports unchanged on this branch. (The earlier "baseline 4" was the CI durations file,
  not a failure baseline.)

## Open items
1. Push the branch and open the PR (commits scanned: no real ids or business names). Merge needs the Owner's word.
   Tell the Owner the heal is ON by default and how to hold it (`NEXUS_STOCK_PUSH_HEAL=count`, above).
2. GAP 5 (skipped): the Trading read-back reads with the primary account only. Per-account reads change pinned
   behaviour in `ebay-trading-price-readback.p44.vitest.test.ts`, need the channel policy per (product, account) and
   the price arm per account, and overlap the other builder's eBay Trading lane. Needs a decision.
3. Review finding 8 (already on main): the lender's own ledger (`sync-ledgers.ts:59-80`) counts every WAREHOUSE row
   and never checks `isActive`, so after a lent warehouse is switched off the lender's listings still sell its units
   while the borrower's show 0. Decide whether an inactive warehouse counts for its owner.
4. Review finding 9: a borrower that is re-activated queues nothing; its listings catch up through the drift
   self-heal (every 30 min, at most 25 products a run). Accept, or add the borrower side to the lender trigger.
5. Review finding 10 (not measured): the heal's candidate query has no `(syncStatus, createdAt)` index, so it reads
   every FAILED/PENDING row of the business before the date filter. Watch Neon compute after deploy; add a partial
   index if it shows.
6. The heal still reads at most 5 × max ledger-held rows per run (see the limit above); raise `SCAN_PAGES` or move more
   gates to SQL if a run's summary shows `capped` with only skips.
