# Shared stock — technical contract and build record

Plan (plain English, the Owner's decisions): [`2026-09-19-shared-stock-plan.md`](2026-09-19-shared-stock-plan.md).
Research: [`2026-09-16-assortment-engine-plan.md`](2026-09-16-assortment-engine-plan.md) (§3.5–3.7, §5.4–5.5, §12.4, §12.8).
Owner's go-ahead (2026-09-19): **"All steps, in order"** — build steps 1 to 6, each tested before the next; nothing committed or pushed; step 7 (production) is the Owner's decision.

**Status (2026-09-19, night): steps 1–6 built and proven; step 7's local full test done; step 7b (reordering knows the pool) built and proven** (§1–§8; decisions D-1…D-49). Four additive migrations, none applied anywhere but throwaway databases: `20260919a_stock_pool`, `20260919b_listing_end_times`, `20260919c_shared_warehouses`, `20260919d_ae4_live_sync`. Real-PostgreSQL runner: 7 suites, 95 of 95, as the superuser and as production's owner shape. The whole story on two test profiles passed; two defects it found are fixed (D-44, D-45). Open for the Owner (§7.6): the read-only production facts (the guard refused this session) and the push blockers. Reordering and the pool (§7.4 item 3): built in §8, the Owner's option 1. **Committed locally** (2026-09-19, the Owner: "Option 1, the sharing page and the channels fix may go too") on branch `shared-stock` in the worktree, on top of the current `main` (the channels session's fixes P0.1–P0.4 included): the sharing page (AE UI lane), its grid fix, then this work as database, API, screens and docs. **Not pushed** — the Owner runs the read-only production check and the push (§7.6).

**Where the code is.** A separate git worktree, `.claude/worktrees/shared-stock` (branch `shared-stock`, from `94bd71380`), so half-built work — and above all an unreviewed migration — can never reach production through a sibling session's push or `railway up` from the shared tree. It carries the uncommitted UI-lane work of 2026-09-17 (`apps/web/src/app/settings/sharing/` and its backend edits) as its starting point. The worktree has its own `node_modules/@nexus/*` links and its own generated Prisma client (`node_modules/.prisma`), so the main checkout's client is untouched.

---

## 0. Decisions made inside the plan (with the reason)

| # | Decision | Why |
| --- | --- | --- |
| D-1 | **Five doors, not four.** Door 5 "put back" (`nexus_pool_put_back`) returns units for a return or a cancelled sale that was already taken. | Without it a return restocks into the borrower's own ledger — a second counter for the same physical unit, which the research forbids (§6 rule 1). |
| D-2 | **Take out = two functions.** `nexus_pool_consume` settles a hold (Amazon ships); `nexus_pool_take` takes at once (eBay deducts when the order arrives, with no hold). | Today's order paths do both (agent map of order paths, 2026-09-19). One function switching on "is there a hold?" would turn a missed hold into a silent second deduction. |
| D-3 | **One hold per borrower order and product, ever** (open, released or consumed). One take per order and product, ever. | Measured today: `reserveOpenOrder` is idempotent only against OPEN holds, so a re-polled order whose hold was consumed gets a new hold and is deducted twice (Amazon `LastUpdatedAfter` re-poll, Shopify re-poll). The pool path must not inherit that. |
| D-4 | **A hold comes from ONE lent warehouse** (the one with the most available, then by code). A take may split (most available first). | A hold is later consumed as one unit of work; splitting it would need several reservations per order line. A take is immediate, so splitting is safe. |
| D-5 | **Put back goes to the lent warehouse the order took the most from** (then by code). Never more than the order took. | The movements of one take share a timestamp, so "the last one" is not a rule. Capping prevents a second restock from inventing stock. |
| D-6 | **New sales use the pool only while it is on; orders already made never get stranded.** Hold and take need an active link, grant and catalog link. Give back, take out a hold and put back work after a pause or an end. | A paused pool shows 0 or own stock on the listings, so new sales must not draw from it; an order that already holds pool stock ships from the lender's warehouse whatever happens later. |
| D-7 | **"Pause" works like "End" for listing numbers.** The links stay, so "Resume" needs no new consent. | The plan's first safety rule: a listing never keeps an old number. |
| D-8 | **No chains.** A product that lends cannot borrow and a borrowed product cannot lend. Checked in the link guard under an advisory lock. | Research §3.2 rule "no chains in v1"; a chain would make one physical unit reachable through two doors with two different locks. |
| D-9 | **Lots and serial numbers are refused at link time.** | The doors are SQL and do not pick FEFO lots or serials; `consumeWithFefo` does. Refusing is honest; silently consuming non-lot stock would break recall traceability. |
| D-10 | **Only an OWNER of the borrower can switch a product** (create or end a link). Offers need an OWNER of the lender who is a member of the borrower. | The plan's table (§4). Also enforced in the database guards, not only in services. |
| D-11 | **The lent warehouses are fixed at offer time.** To change them: end and offer again. One OPEN grant per pair. | Same rule as product shares (research §15.3): the borrower consented to exactly those warehouses. |
| D-12 | **The listing work is a per-business queue (`StockPoolTask`) written by the database** (triggers on `StockLevel`, `StockPoolLink`, `StockPoolGrant`, `CatalogLink`, and the doors). Each business processes only its own tasks, in its own context. | Research F2/F3: code paths forget signals, and one transaction cannot touch two businesses. A task row is written in the same transaction as the change it describes. |
| D-13 | **The lender's own bookkeeping for a door write runs later, in the lender's context** ("settle" task): cost of goods, the `inventory.*` event, the stockout check, the read cache and the lender's own listings. | Research §3.6: keep the SQL small — lock, check, change the numbers, write the movement. The cascade and events stay in the app. |

---

## 1. Step 1 — the lending permission, product links, work queue and the five doors

### 1.1 Contract

**Tables** (`packages/database/prisma/schema.prisma`; rules in `packages/database/workspaces/stock-pool.sql`; migration `20260919a_stock_pool`, additive):

| Table | Owner | Rules |
| --- | --- | --- |
| `StockPoolGrant` | global (links two businesses) | lender = `ownerWorkspaceId`, borrower = `workspaceId`; `locationIds` (1–50 distinct active WAREHOUSE locations of the lender, fixed); `status` pending → active ⇄ paused → revoked, pending → declined; `version` +1 on every change; never deleted; one open grant per pair |
| `StockPoolLink` | borrower | borrower product ↔ lender product through an active grant AND an active `CatalogLink` naming both; one active link per product; `active` → `ended` only, never deleted; no chains; no lot/serial products |
| `StockPoolTask` | the business that does the work | `recascade` (a product of its own) or `settle` (a pool movement in its ledger); written only by triggers and doors |
| `StockReservation`, `StockMovement` (existing) | lender | + `poolGrantId`, `consumerWorkspaceId`, `consumerOrderRef` (and `StockMovement.poolSettledAt`): set only on rows a door wrote |

**Who may do what** (enforced in the database; the services add nothing weaker):

| Action | Who | Where checked |
| --- | --- | --- |
| Offer | an OWNER of the lender who is an active member of the borrower | `nexus_stock_pool_grant_guard` (INSERT) + the lender's row policy |
| Pause, resume, end (withdraw a pending offer) | an OWNER of the lender | guard (UPDATE, side = lender) |
| Accept, decline, leave | an OWNER of the borrower | `nexus_stock_pool_grant_respond` (SECURITY DEFINER; re-checks owner and version) + guard |
| Switch a product to the pool / back | an OWNER of the borrower | `nexus_stock_pool_link_guard` |
| Read a grant | lender (FOR ALL policy) and borrower (separate FOR SELECT policy); nobody else | row security |
| Read or write the lender's stock rows | the lender only; the borrower only through the doors | row security + doors |

**The doors** (SECURITY DEFINER, run in the borrower's context; no lender, product, location or grant parameter — all come from the borrower's own link; every write takes the lender product's `FOR NO KEY UPDATE` row lock first, the same lock as `lockProductStock`):

| Door | Function | Needs the pool on? | Idempotency |
| --- | --- | --- | --- |
| 1 Check | `nexus_pool_available(product_ids[])` → one row per lent location (0 for a location no longer an active warehouse) | yes | read only |
| 2 Hold | `nexus_pool_reserve(product, qty, order, actor)` | yes | one hold per order and product, ever |
| 3 Give back | `nexus_pool_release(order, product?, actor, reason)` | no | settled holds skipped, re-checked under the lock |
| 4a Take out a hold | `nexus_pool_consume(order, product?, actor)` | no | same |
| 4b Take out at once | `nexus_pool_take(product, qty, order, actor)` | yes | one take per order and product, ever; all or nothing |
| 5 Put back | `nexus_pool_put_back(product, qty, order, ref, reason, actor)` | no | one per reason and ref; capped at what the order took |

Refusals are returned, not raised: `{ error, code, status }` — codes `workspace_required`, `invalid_quantity`, `order_required`, `not_pooled`, `insufficient`, `not_from_pool`, `more_than_sold`, `invalid_reason`. TypeScript wrappers: `apps/api/src/services/stock-pool/pool-doors.ts`.

**The queue** (who writes a task):

| Event | Task |
| --- | --- |
| Any `StockLevel` insert/update/delete that changes quantity, reserved or available, for a lender product with an active link, at a location lent by an ACTIVE grant | `recascade` for each borrower product linked to it (`reason: stock`) |
| A link starts or ends | `recascade` for that borrower product (`link`) |
| A grant is paused or resumed | `recascade` for every active link of it (`grant`) |
| A grant ends (revoked, declined) | its active links end (→ `link` tasks) |
| A `CatalogLink` is detached (product share ended, either side) | the pool links that relied on it end (→ `link` tasks) |
| A door writes a movement | `settle` for the lender (`door`) |

### 1.2 Build record (2026-09-19)

| Part | File |
| --- | --- |
| Schema: 3 tables, 7 columns, back-relations | `packages/database/prisma/schema.prisma` |
| Ownership (1 global, 2 business-owned) and scoped keys | `packages/database/workspaces/model-ownership.json`, `scoped-keys.json` |
| Database rules (constraints, indexes, policies, 3 guards, 4 triggers, respond function, 5 doors) | `packages/database/workspaces/stock-pool.sql`, `policy-migrations.json`, `scripts/workspace-policies.mjs` |
| Migration (additive; ends with the rules file byte for byte) | `packages/database/prisma/migrations/20260919a_stock_pool/migration.sql` |
| Door wrappers | `apps/api/src/services/stock-pool/pool-doors.ts` |
| Push check: database functions that write stock must take the lock first | `scripts/check-stock-writer-lock.mjs`, `scripts/stock-writer-lock.json` (`sqlFunctions`) |
| Push check: the race suite runs on a throwaway PostgreSQL | `scripts/run-real-postgres-tests.mjs` |

### 1.3 Proof

1. **Rules: 18 of 18** (`stock-pool-rules.vitest.test.ts`, disposable PostgreSQL with the generated policies, profiles ON). Consent (who may offer, accept, pause; stale versions; one open grant; immutable terms), **the guard allows exactly the 9 planned transitions out of all 40 (side, from, to) combinations**, row security (the borrower reads but cannot update or delete a grant; a third business sees nothing; the lender reads none of the borrower's links), the link rules (owner only, catalog link must match, lots refused, **no chains** — tested with a real third business borrowing from the borrower), every queue trigger with its negative cases (unlent warehouse, a product nobody borrows, a threshold-only write, a paused grant), and every door with its refusals and idempotency. Ledger check at the end: each lender level equals its start plus its movements; `reserved` equals the open holds.
2. **Races: 6 of 6** on a real multi-connection PostgreSQL (`stock-pool-concurrency.vitest.test.ts`). The last unit, 100 times, lender sale vs borrower pool sale: exactly one winner every round (**lender won 15, borrower 85** — both sides won, so it was a real race); the last unit, 100 times, lender hold vs borrower hold: exactly one; a crowd of 20 + 20 sales on 25 units: exactly 25; a crowd of 12 + 12 holds on 20 units, 5 times: exactly 20 and `reserved` = open holds; the same order given back twice or taken out twice at the same moment, 50 times: counted once. Every refusal in these arms is a stock refusal — no deadlock, no timeout.
3. **The lock is what makes it safe (control).** A copy of the take door with its lock line removed, racing the lender's own sales: it breaks within the first rounds (deadlock `40P01`, or a lost sale). Measured on the first run: 234 deadlocks in the control arm, 0 in the real arms.
4. **The tests catch what they exist for: 17 of 17 mutations of the rules file caught**, each by the arm aimed at it (script in the session scratchpad; every mutation hash-checked as applied, the file restored and re-hashed): owner can activate; borrower policy widened to FOR ALL (the DELETE trap); chain check removed; lot check removed; trigger ignores which warehouse is lent; a paused grant still sells; hold not one per order; put back not capped; take not one per order; lender bookkeeping never queued; ending a grant leaves links on; an ended share leaves links on; the guard lets the lender write a borrower link; release and consume skip the re-check under the lock (caught only by the race suite, as designed); respond skips its owner check; the hold door's lock removed (caught by the hold races after the crowd-of-holds arm was added — the first mutation run found that gap).
5. **The migration builds exactly what the tests test.** Two throwaway databases: A = yesterday's schema + yesterday's generated policies + migration `20260919a`; B = today's schema + today's generator. Columns, constraints (with validation state), indexes, policies, RLS flags, triggers, grants and every `nexus*` function (definition hash, SECURITY DEFINER, settings, ACL): **12,508 catalogue lines each, identical.** Control: the same migration without the borrower's read policy differs by exactly that 1 line.
6. **Push checks.** `check-stock-writer-lock.mjs` now also scans the rules files: 5 door functions, 6 write sites, each lock-first. Mutation arms on scratch copies: unchanged → pass; lock removed from `take` → fail; a new unlisted writer → fail; an extra write in a listed door → fail; a write only in a comment → pass; lock moved after the first write → fail. `run-real-postgres-tests.mjs` runs the race suite (6) beside AE.1 (10) and AE.3 (8): all pass, about 50 s, and the AE.1 and AE.3 suites pass with the new `StockLevel` trigger live.
7. **Typecheck:** `apps/api` `tsc --noEmit` (fresh, not incremental) exit 0; `pool-doors.ts` and the worktree's Prisma client are in the program.

### 1.4 Limits (said plainly)

1. **The doors run with the database owner's rights.** On the disposable databases the owner is a superuser, so row security does not apply to it. In production the migration role must bypass row security too (Neon's owner role normally does). Not measured: the product-share functions live since 2026-09-16 depend on the same thing and have never run in production. Step 7 checks it before any real use (plan risk 8).
2. **A door write is visible to the lender's own listings only after its settle task runs** (step 2 builds the worker). The lender's own writers are unchanged and still cascade at once.
3. **The trigger fires on every `StockLevel` write in every business.** Its cost when nobody borrows the product is one probe of a partial index (`StockPoolLink_active_by_source`). Not measured under production load.

---

## 2. Step 2 — the switches, one ledger for every listing number, the worker, the alarm

### 2.1 Contract

**One ledger.** `loadSyncLedgers(db, productIds)` (`apps/api/src/services/stock-pool/sync-ledgers.ts`) is the only source of the ledger a listing follows: this business's own WAREHOUSE rows, or — for a product that sells from a pool right now — the pool's lent warehouses (door 1). The derivation core takes a branded `SyncLedger`, so a plain array is a type error; `scripts/check-sync-ledger-source.mjs` (pre-push) keeps `syncLedgerOf(` and `as SyncLedger` to the loader, the stock import's own planned rows (used only for a product that is not pooled) and tests. Helpers for the paths that do not run the core: `sellableAvailable` (Σ available on the ledger — every send-time limit and "in stock" check) and `sellableQuantity` (the older publish paths that send `Product.totalStock`: unchanged for every product that never used a pool).

**Leaving a pool.** A product with any pool link in its history that is not pooled now has `uncountedIsZero`: an own stock never counted means 0 (FOLLOW 0), never UNCOUNTED — the P0 guard keeps a positive number for a never-counted product, and here that number would be the pool's last one (plan §4, first safety rule). Every precedence rule above FOLLOW (FBA, closed, policy, paused, fixed) is unchanged.

**The worker** (`pool-tasks.ts`). Per business, in its own context: claims its tasks (`FOR UPDATE SKIP LOCKED`, stale after 2 minutes), settles door movements first (cost of goods for units that left, the `inventory.*` event, then the stockout check and the read cache — the same work `applyStockMovementInTx` does for the lender's own writers), then one recascade per product on the instant lane, then the pool oversell check. After 10 failed attempts the owners are told (bell). Runs: after every stock movement commit (`afterStockMovementCommit` kicks it), after every pool change our services commit, and a poller (2 s busy, 10 s quiet) for writers that do not pass through there (the stock import, reservations). `NEXUS_ENABLE_STOCK_POOL_WORKER=0` turns the poller off.

**The switches (API).** `apps/api/src/routes/stock-pool.routes.ts`, permissions in `permissions-manifest.ts`:

| Route | Who (route permission; the database adds OWNER) |
| --- | --- |
| `GET /api/stock-pool/grants`, `GET /api/stock-pool/lendable-warehouses`, `GET /api/stock-pool/grants/:id/impact`, `GET /api/stock-pool/products?grantId=` | `inventory.view` |
| `POST /api/stock-pool/grants` (offer), `POST /api/stock-pool/grants/:id/:action` (pause, resume, end · accept, decline, leave) | `settings.workspace.edit` |
| `POST /api/stock-pool/products/preview`, `POST /api/stock-pool/products/switch` (to `pool` or `own`, with variations) | `inventory.adjust` |

Every grant change is audited in BOTH businesses (`WorkspaceAudit`) and the other business's owners get a notice (bell). The product switch is all or nothing; a refusal names the SKU and the reason. Previews: the lender's pause/end preview counts the borrower's listings by what will happen (to 0, to own stock, fixed, paused, closed, Amazon-managed; shared eBay variants to 0 / to own / excluded) through `nexus_pool_grant_impact` — counts only, never the other business's rows; the borrower's switch preview runs the derivation core on the ledger the product would follow (`nexus_pool_preview` before a link exists) and shows the exact number per listing.

**The oversell alarm.** The watchdog listens to a business's own stock events; a pool changes in another business. After each pool recascade the worker runs the same assessment (`evaluateOversellRisk`) against the pool and publishes the same event, once per distinct state.

**Every path that works out, sends or checks a listing number** (census by the agent map of 2026-09-19, 50 files):

| Class | Path | Now |
| --- | --- | --- |
| Core callers (8) | cascade, recascade guard, stock import cascade, listing activation, shared eBay fan-out, eBay read-back and heal, send-step re-read (shared eBay), Sync Control view, matrix view | the loader (compile-time) |
| Send-time limits | Amazon, eBay (Inventory API), Shopify (legacy) lanes of `outbound-sync.service.ts`; native Shopify offers | `sellableAvailable` / the loader |
| Direct writers | Follow / Fixed number / Hold back (`follow-master.service.ts`) | `sellableAvailable`, read per chunk in its transaction |
| Feeds and publish | Amazon flat-file feed clamp, eBay flat-file cap, studio publication (Amazon, eBay) | the loader |
| `totalStock` publishers | eBay draft publish, listing wizard (Amazon children, Shopify family), Shopify content publisher, bulk channel batches, Amazon variation mapper, new drafts; the catalog PATCH no longer sends its own total for a pooled product | `sellableQuantity` |
| Heal | drift detection (`sync-drift-detection.job.ts`), eBay read-back heal | the loader; the removed "uniform capped" fan-out path (which also pushed Excluded variants) is gone |
| Channel reports | `recordChannelStockEvent`: a pooled product is compared with the pool and never auto-applied; the operator's apply refuses | new rule |
| Alarms | oversell watchdog (pool), ads retail readiness ("in stock") | the loader |
| Unchanged on purpose | Amazon quantity read-back (sends the listing's own number, then the send-time limit applies), dashboard drift resync (`masterQuantity` is the pool snapshot for a pooled listing), FBA gates (FBA is never pooled), stock operations and analytics (they are about this business's own shelves), the stock pages and product list (step 5 shows the pool there) | — |

### 2.2 Build record (2026-09-19)

New: `services/stock-pool/{sync-ledgers,pool-tasks,pool-grants.service,pool-links.service,pool-notify,grant-rules}.ts`, `routes/stock-pool.routes.ts`, `scripts/check-sync-ledger-source.mjs`; four definer functions added to `stock-pool.sql` (`nexus_pool_pending_workspaces`, `nexus_pool_grant_details`, `nexus_pool_grant_impact`, `nexus_pool_preview`). Changed: the 25 files in the census above, `index.ts` (routes, worker), `permissions-manifest.ts`, `.githooks/pre-push`, `run-real-postgres-tests.mjs`.

### 2.3 Proof

1. **End to end: 9 of 9** (`stock-pool-e2e.vitest.test.ts`, real PostgreSQL, the real services, cascade and worker). Offer → the borrower is told → accept → the lender is told, both audited; the switch preview's exact numbers (eBay 10 − 1 = 9; Amazon-managed, fixed and paused listings and an excluded shared variant untouched); switching moves only the following listings; a lender sale reaches the borrower; a pool sale in the borrower is settled in the lender (movement, event, the lender's own listing), and settling twice changes nothing; the lender's pause preview counts; pause → 0 and resume → back; the borrower's own stock arriving does not move a pooled listing, switching to own stock does (own 3 − 1 = 2), and back to the pool; ending the grant ends the links, the listing falls back to its own stock, and an order already held still ships. Also: the pool oversell alarm fires on a paused listing that shows 7 against a pool of 5 (excess 2), a channel's number is never written into the borrower's own ledger, and every limit reads the pool.
2. **Latency, measured:** a lender's sale → the borrower's listing updated, with no manual worker run: **50 ms, three runs out of three** (local Docker PostgreSQL, load average 2–3, polled every 25 ms). Control: without the post-commit wake-up the same step fails at 10 s and the other 8 pass. Production adds its network round trips; not measured there.
3. **The send-time limit reads the pool** (`outbound-sync.pool-limit.vitest.test.ts`, 2 of 2): a pooled product with 50 own units and a pool of 3 is capped to 3; control: the same product on its own stock lets 9 through.
4. **Mutations of the new code: 9 of 9 caught** — the loader ignoring the pool; leaving the pool keeping the old number; the eBay limit reading own shelves; the settle step publishing no event; the worker never recascading; the cascade snapshotting own stock; a channel report auto-applied into own stock; the pool oversell watch off; the switch preview ignoring the pool. Each hash-checked applied and restored.
5. **Rules: 19 of 19** (one new arm: who may call the four new functions) and **grant rules 4 of 4**; the rules suite now takes the allowed transitions from `grant-rules.ts` itself, so the TypeScript table and the database guard cannot drift.
6. **No regressions.** Every existing test that imports a changed file (`vitest related`): 236 files, 3,111 tests. The only failures are 9 that fail identically on a baseline copy of the code without this work (variation suites that need a live database, a flat-file suite and two listing-wizard suites). Seven test files needed their database fakes taught the pool reads; one (`ebay-shared-fanout`) exercised the removed uniform path and now passes the ledger — plus a new arm: an Excluded variant is never pushed.
7. **Real-PostgreSQL runner: 4 suites, 33 of 33** (stock race 10, copy 8, pool race 6, pool end to end 9), about 50 s.
8. **Database:** the rehearsal repeated for the final rules file — **12,512 catalogue lines each, identical**; control (the borrower's read policy removed) differs by exactly that line. Parity (9 files), model ownership (445), stock-writer lock (5 door functions lock-first), sync-ledger source — all pass. `apps/api` `tsc --noEmit` exit 0.

### 2.4 Limits (said plainly)

1. **The stock pages and the product list still show a pooled product's OWN stock** (the read cache, `/fulfillment/stock`, the control tower). Step 5 shows the pool there. Nothing sends those numbers to a channel.
2. **The pause preview's "to own stock" counts a listing whose product has own warehouse stock available;** it does not apply the listing's routing. The borrower's switch preview is exact.
3. **Several API instances each run a poller.** Safe (claims skip locked rows), not measured.
4. **The oversell event is still consumed by nobody** (pre-existing, "Found while mapping" 4). The pool check publishes it like the watchdog does.

---

## 3. Step 3 — end times, and a fixed number for shared eBay variants

### 3.1 Contract

**Columns** (migration `20260919b_listing_end_times`, additive: five nullable columns, one CHECK, two triggers, four partial indexes; rules in `packages/database/workspaces/listing-end-times.sql`, which the migration ends with byte for byte):

| Column | Meaning |
| --- | --- |
| `ChannelListing.pinnedUntil` | "Fixed number until …": at that time the listing follows again |
| `ChannelListing.pausedUntil` | "Paused until …": at that time the listing is resumed (it goes back to Follow or Fixed number, whichever it had) |
| `SharedListingMembership.pinnedQuantity` | "Fixed number" for one shared eBay variant in one eBay listing (null = follows the pool). CHECK ≥ 0 |
| `SharedListingMembership.pinnedUntil` / `.pausedUntil` | the end of that fixed number / of Excluded (`followPool = false`) |

**The database rule** (triggers `nexus_listing_end_times`, `nexus_membership_end_times`): **an end time never outlives its mode.** Follow clears `pinnedUntil`; Resume clears `pausedUntil`; a variant that follows the pool loses `pinnedUntil`; Include clears `pausedUntil`; an end time cannot be stored on a row that is not in that mode. Changing only the fixed number keeps its end. 18 code paths write listing modes and most know nothing about end times; without the rule, a stale end time would flip a state someone chose later, at a time nobody chose for it.

**Precedence for a shared variant** is the listing's: FBA → closed → channel policy → Excluded → Fixed number → Follow (`resolveMembershipIntended`, `sync-control-core.ts`). Every path that sends or checks a shared variant's number uses it: the fan-out (`ebay-shared-fanout.service.ts`), the send step's re-check (`outbound-sync.service.ts`), and the eBay read-back, which compares a fixed variant with its own number and heals it to that number (`ebay-inventory-readback.service.ts`).

**Sync Control API** (`POST /api/stock/sync-control/actions`, `apps/api/src/routes/sync-control.routes.ts`):

| Field | Rule |
| --- | --- |
| `until` | With `PIN`, `ZERO_PIN`, `PAUSE` (listings) and `PIN`, `EXCLUDE` (shared variants) only. ISO date-time, at least 1 minute and at most 1 year (366 days) ahead; `null` = no end; absent = keep the current end. Stored in UTC; the page shows it in the person's own time zone (step 5). A `PIN` with `until` on a listing that is already fixed sets its end. |
| `quantity` | With `PIN` on shared variants only: a whole number ≥ 0. Absent = what eBay shows now (`lastQtyPushed`; 0 if never sent). Refused (400, nothing written) when the action also targets listings: a listing's Fixed number keeps the number it shows now, and a number that applies to some rows and is silently ignored on others is not honest. |
| `PIN` / `FOLLOW` on shared variants | New: Fixed number / back to the pool. `EXCLUDE` / `INCLUDE` unchanged. |
| rows (`GET …/listings`, product view) | carry `endsAt` (ISO or null) for the current Fixed number, Paused or Excluded |
| history | every change in `SyncControlAudit` with the signed-in person as actor (`request.authUser`; it was always "sync-control" before — found while mapping, 5) |

**Excel** (`/import/preview`, `/import/apply`): a shared variant can be set to Pinned with the number in the PinnedQty column (without the number the preview refuses the row and names why); Follow clears the fixed number.

**The job** (`apps/api/src/jobs/listing-end-times.job.ts`, `services/listing-end-times.service.ts`): every minute, per business (clustered, under that business's lease and context). One probe on the partial indexes; nothing is recorded when nothing is due. `NEXUS_ENABLE_LISTING_END_TIMES_CRON=0` turns it off.

| Due | What the job does | History (`actor: system:end-time`, with a `reason`) |
| --- | --- | --- |
| a listing's fixed number (`pinnedUntil ≤ now`, fixed, listing not ENDED) | Follow, through the one writer (`setFollowMasterQuantity`): it works out the number from the product's ledger (own or pool) minus Hold back, and queues the push | `followMasterQuantity` with the number before and after |
| the same on an Amazon-managed (FBA) listing | nothing is sent to it; its end time ends | `pinnedUntil` |
| a listing's pause (`pausedUntil ≤ now`, paused) | resume, then recascade (as Sync Control's Resume does) | `syncPaused`, in the same transaction as the resume |
| a shared variant's fixed number | it follows the pool, recascade | `pinnedQuantity`, same transaction |
| a shared variant's exclusion | included, recascade | `followPool`, same transaction |

### 3.2 Decisions made in this step

| # | Decision | Why |
| --- | --- | --- |
| D-14 | **The end time is consumed by the mode change, never before it.** The job only changes the mode; the trigger clears the end time in the same row write. | The first draft cleared the end time first ("claimed" it) and then called the writer; a writer that threw left the listing fixed forever with no end time. Now a failed or half-done write leaves the end time, and the next minute tries again. |
| D-15 | **An end time never outlives its mode** (database triggers, not code). | 18 writers set listing modes; only Sync Control knows end times. |
| D-16 | **A chosen number is for shared variants only.** A listing's Fixed number keeps "the number it shows now". | That is today's meaning of PIN for listings, and Amazon keeps one quantity per SKU across EU markets (the 409 expand rule). Choosing a number for a listing from Sync Control is a step 5 question. |
| D-17 | **An ENDED listing's end waits** until the listing is live again; **an FBA listing's end just ends** (audited). | The writer does not touch ended listings (so "due" would repeat every minute); nothing is ever sent to an FBA listing. |
| D-18 | **The same "due" predicate in the probe and in every write.** | A probe wider than the writes would record a run every minute for rows nothing acts on. |

### 3.3 Build record (2026-09-19)

| Part | File |
| --- | --- |
| Columns | `packages/database/prisma/schema.prisma` |
| Rules: triggers, CHECK, partial indexes | `packages/database/workspaces/listing-end-times.sql`, `policy-migrations.json`, `scripts/workspace-policies.mjs` |
| Migration | `packages/database/prisma/migrations/20260919b_listing_end_times/migration.sql` |
| Derivation core (shared fixed number) | `apps/api/src/services/sync-control-core.ts` |
| Send, check, heal | `ebay-shared-fanout.service.ts`, `outbound-sync.service.ts`, `ebay-inventory-readback.service.ts` |
| Sync Control API and Excel | `apps/api/src/routes/sync-control.routes.ts` |
| The job | `apps/api/src/services/listing-end-times.service.ts`, `apps/api/src/jobs/listing-end-times.job.ts`, registered in `apps/api/src/index.ts` |
| Push check | `scripts/run-real-postgres-tests.mjs` runs the new real-PostgreSQL suite |

### 3.4 Proof

1. **End to end: 25 of 25** (`apps/api/src/services/listing-end-times.vitest.test.ts`, real PostgreSQL with the generated rules, profiles ON, through the real Sync Control route and Excel import, the real writer, cascade and fan-out, and the real job). The story: the route refuses a bad end time or number (not a date, under one minute, over one year, with Resume, a number with Follow, negative, not whole, a number with listings) and writes nothing; Fixed number, Zero & Pin, Pause and Exclude set their ends, a shared variant gets a chosen number (sent at once: 3) or keeps what eBay shows (5); the history names the signed-in person; the page shows every `endsAt`; "no end" and a later end replace an earlier one. Stock moves 8 → 6 while everything is held; at the end time the job ends exactly 2 fixed numbers, 1 pause, 1 shared fixed number and 1 exclusion, and sends 5 (6 − Hold back 1), 6, 6, 6 and 6; the history holds the number before and after and the reason; a second run finds nothing. Also: the later end the operator chose is kept to (ends at +11 min, not +5); an operator change after the end time passed is never overruled; an FBA listing's end just ends (audited, nothing sent); an ENDED listing waits and ends the moment it is live; a writer that throws leaves both end times, and a writer that stops after one row leaves the other — the next runs end them (never fixed forever); one business's run never touches another's rows; the probe can use the partial indexes; the database rule on both tables and the CHECK; a change forced into the gap between the job's read and its write (pause, shared fixed number, exclusion) is never overruled; each kind of end, alone, sends the stock of now (3).
2. **Unit arms:** the derivation core (4 new: a shared fixed number is exact whatever the pool and buffer; 0 is a real number; policy and Excluded beat it; "left a pool" does not touch it), the fan-out (3 new), the send step's re-check with `NEXUS_SYNC_ORDERING_V2` on (2 new: a fixed variant is sent its number and a following one the pool; no revise is spent when it already shows its number; an Excluded variant is never sent), the read-back comparison (1 new, 5 cases). 36 of 36 in those three files, 31 of 31 in the core file.
3. **The tests catch what they exist for: 33 of 33 mutations caught** (`.shared-stock-tools/mutate-endtimes.py`; each applied and hash-checked, the aimed suites run, the file restored and re-hashed): each of the four trigger clauses, the trigger's WHEN clause, the CHECK, the probe index; an ENDED listing due; each of the three "still due" re-checks at the write; FBA ends never ending; the fixed-number history not written; the probe never waking the job; each of the three "re-work after the end" steps; the route accepting an end under a minute, a number with listings, setting an end only on newly fixed listings, hiding pause ends, ignoring the chosen number, ignoring the end with Exclude, Pause, Zero & Pin, the history's actor going back to "sync-control"; Excel keeping a shared number on Follow, writing none on Pinned, accepting Pinned without its number; the core, the fan-out, the send step and the read-back each ignoring a shared fixed number. The first run caught 30 of 32: two "re-work" mutations survived because every end in the story was on the same product, so one end's recascade covered another's; the four "alone" arms were added and caught them (and a third of the same kind).
4. **The migrations build exactly what the tests test.** A = yesterday's schema + yesterday's generated rules + migration a, then b; B = today's schema + today's generator: **12,526 catalogue lines each, identical**. Control: migration b without one partial index differs by exactly that 1 line.
5. **Real-PostgreSQL runner: 5 suites, 58 of 58** (stock race 10, copy 8, pool race 6, pool end to end 9, end times 25), about 2 minutes. The step 1–2 rules suite (19), grant rules (4) and pool limit (2) pass with the new rules file.
6. **No regressions.** `vitest related` on every file this step changed: 227 files, 2,979 tests; the only failures are the same 9 in the same 5 baseline files (§2.3 item 6).
7. **Gates:** policy ⇄ migration parity (10 files), model ownership (445), schema drift, stock-writer lock, sync-ledger source, clustered cron — all pass. `apps/api` `tsc --noEmit` (fresh) exit 0.

### 3.5 Limits (said plainly)

1. **A listing's fixed number has a gap of milliseconds** between the job's read and the writer's transaction: an operator change made inside that gap is overwritten by Follow (the writer does not re-check the mode). Pauses and shared variants have no such gap: their write re-checks "still due" in the same statement (tested with a change forced into the gap).
2. **An override ends within about a minute** of its end time. With business profiles ON the job needs its Redis lease; without it, nothing ends until the lease works again (the end times wait; nothing is lost).
3. **Only Sync Control sets end times.** The flat files, the product editor, bulk operations and the stock import cannot; when they change a listing's mode, the database clears the end time (D-15).
4. **The eBay read-back job itself has no test** (it had none before). Its comparison is tested at the pure function (`diffTradingReadback`); the two lines that pass `pinnedQuantity` to it are typed but untested.
5. **A shared PIN without a number takes what eBay shows now**: the last number sent (`lastQtyPushed`), 0 if nothing was ever sent.
6. **The screen for end times is step 5.** Until then the API and Excel are the only way.

---

## 4. Step 4 — orders, cancellations, returns and shipping through the doors

### 4.1 Contract

**The rule.** Where an order line's stock comes from is decided once, when the sale or the hold is made, and everything after goes back to that same place (`apps/api/src/services/stock-pool/order-routing.ts`):

| Moment | Product sells from a pool right now | Otherwise |
| --- | --- | --- |
| A sale with no hold (eBay ingest; the manual/mock ingest) | door 4b **take** (`takeForOrder`), one take per order and product, ever | own ledger, as before |
| A hold for an open order at a WAREHOUSE (`reserveOpenOrder`: Amazon FBM, Shopify webhook and poll) | door 2 **hold** (`holdForOrder`), one hold per order and product, ever | own ledger, as before |
| A hold at an Amazon FBA location (MCF) | own (FBA is never pooled) | own |
| The order ships (`consumeOpenOrder`: Amazon, Shopify, MCF, the repair job) | its own holds **and** its pool holds are taken out (door 4a finds only this order's) | — |
| The order is cancelled before shipping (`releaseOpenOrder`: the cancellation handler, MCF rollback, the repair job) | its own holds **and** its pool holds are given back (door 3); the count includes both, so the cancellation never also "restores" | — |
| A sale that was taken is cancelled (cancellation handler, no hold released) | door 5 **put back** `ORDER_CANCELLED` when the order took the product from a pool (capped at what it took, once per order) | own restore as before — but for a product that ever sold from a pool, only with proof that this order took it from own stock |
| A return is put back on the shelf (`POST /fulfillment/returns/:id/restock`, a return with an order) | door 5 **put back** `RETURN_RESTOCKED` when the order took it from a pool (to the lent warehouse it took the most from; once per return; never more than the order took) | own restock as before |

**"Pooled right now"** is the doors' own predicate (`nexus_pool_effective_link`, read through door 1 in `stock-pool/pool-guard.ts`): an active link, an active grant, an active catalog link, both businesses active. A paused or ended pool answers `not_pooled`, so new sales use own stock (D-6), while orders already made are settled wherever they took from.

**Refusals and failures.** `insufficient` is an oversell: nothing is taken anywhere, B's owners get a bell notice (`stock-pool-order-refused`, linking the order), and the caller logs it as it logs an own-stock oversell today (the own path throws on a negative level; the eBay ingest logs and goes on). A door that throws is an unknown outcome (it may have committed): the owners are told to check the order; the door is idempotent, so a retry is safe.

**The guard** (`pool-guard.ts`), under the own-ledger primitives, for paths nobody routed: `applyStockMovementInTx` refuses an `ORDER_PLACED` deduction at a WAREHOUSE for a product that sells from a pool right now; `reserveStockInTx` refuses an `OPEN_ORDER` hold at a WAREHOUSE for one. Both throw `PooledProductError` (`code: pooled_product`, 409). `POST /stock/reserve` (manual holds) refuses a pooled product with a sentence: its listings follow the pool, so a hold on own stock holds nothing a buyer can see.

**The repair job** (`reconcileOpenOrderReservations`, hourly): also lists this business's orders that still hold stock in a pool — through the new door `nexus_pool_open_hold_orders(max)` (order references of the calling business only; nothing about the lender) — and takes them out (shipped) or gives them back (cancelled) like its own.

**Cost of goods.** The lender's cost of the units is booked in the lender when its settle task runs (step 2). The borrower's profit reports count `OrderItem.quantity × Product.costPrice` — the borrower's own cost price, by the existing rule "cost belongs to each business" (a product share never copies `costPrice`). Nothing about the lender's costs reaches the borrower. The product list and the switch preview carry `costPriceMissing` so step 5 can warn before a product's pool sales count at zero cost.

**One sale per order and product.** The pool takes, holds and puts back once per order and product (D-3). An eBay order can hold two lines of one product (one variant in two eBay listings), so every caller adds up the lines of a product first: the eBay ingest, the manual ingest, the cancellation handler (one put-back per product), the returns route (one put-back per product and return). Own stock keeps its line-by-line writes.

**The ship-from** (`services/stock-pool/shared-warehouses.ts`, migration `20260919c_shared_warehouses`). A pool order's units are in the lender's warehouse, and a shipment can only name a warehouse of its own business, so the borrower keeps a **copy of the address**: one `Warehouse` row per lent location, marked by the new column `sharedFromLocationId` (unique per business), code `SHARED-<code>`, name "<location> — <lender> (shared stock)", `kind = SHARED_STOCK`, never default.

| Rule | Where |
| --- | --- |
| The copies are made on accept and brought up to date (address, on/off) whenever an order needs one; a location no longer lent keeps its row (old shipments point at it) but goes inactive | `syncSharedWarehouses`, door `nexus_pool_lent_addresses()` (the calling borrower's grants that are on or paused; codes, names and the lender warehouse's address, nothing else) |
| An order whose units came from a pool ships from the copy of the lent warehouse it took the most from — also after a pause or an end | `sharedWarehouseForOrder`, door `nexus_pool_order_locations(order)` (the calling business's own order only) |
| Routing: the copy comes before any rule; the scored fallback never picks a copy for any other order | `resolveWarehouseForOrder({ orderId })`, bulk create; `POST /fulfillment/shipments` (unless the operator names a warehouse) |
| A copy is an address, never stock: a stock write naming it is refused (it would otherwise land on the default location) | `resolveLocationId` in `stock-movement.service.ts` |

### 4.2 Decisions made in this step

| # | Decision | Why |
| --- | --- | --- |
| D-19 | **An order line's source is decided once, at the sale or the hold; what follows goes back there.** | The switch can change between the sale and the cancellation. Asking both the pool doors and the own-ledger functions is safe: each finds only what is its own. |
| D-20 | **Lines of one product are added up before the door.** | One sale per order and product (D-3) would otherwise skip the second line of a product in an order — a unit sold and never taken. Found while testing this step. |
| D-21 | **An oversell takes nothing anywhere and tells the owners.** Never "take what is there", never fall back to own stock. | The own path refuses a negative level too; the difference is that a person is now told. Own stock is not what the listings showed, so taking it would hide the oversell in the wrong ledger. |
| D-22 | **A guard under the own-ledger primitives** refuses an unrouted sale or order hold of a pooled product. | Research F2: code paths forget. A missed path now fails loudly instead of selling stock no listing shows. |
| D-23 | **The borrower's cost of goods is its own cost price.** | The existing rule "cost belongs to each business" (a share never copies `costPrice`); the lender's real costs stay the lender's. A missing price is flagged, not guessed. |
| D-24 | **The ship-from is a copy of an address, not a warehouse of stock.** | A shipment needs a warehouse of its own business; a copy with stock would be a second counter for the same units (research §6 rule 1). |
| D-25 | **Products that never used a pool keep today's behaviour exactly**, including the defects "found while mapping" 1–3. For pooled products the doors fix them (one hold / one take per order ever; a cancellation puts back only what was taken; a refusal reaches a person). | Changing every business's order handling is outside this plan; each defect is listed below with its owner. |

### 4.3 Build record (2026-09-19)

| Part | File |
| --- | --- |
| Routing layer | `apps/api/src/services/stock-pool/order-routing.ts` (new) |
| Guard | `apps/api/src/services/stock-pool/pool-guard.ts` (new); `stock-movement.service.ts` (`applyStockMovementInTx`, `resolveLocationId`); `stock-level.service.ts` (`reserveStockInTx`) |
| Holds, take out, give back | `stock-level.service.ts` (`reserveOpenOrder`, `consumeOpenOrder`, `releaseOpenOrder`) |
| Sales | `ebay-orders.service.ts` (`processOrder`), `order-ingestion.service.ts` |
| Cancellations, returns, manual holds | `order-cancellation/index.ts`, `routes/returns.routes.ts`, `routes/stock.routes.ts` |
| Repair job | `reservation-reconcile.ts`; door wrapper `poolOpenHoldOrders` in `pool-doors.ts` (+ `refusalOf`) |
| Ship-from copy | `stock-pool/shared-warehouses.ts` (new), `order-routing.service.ts`, `routes/fulfillment.routes.ts`, `pool-grants.service.ts` (sync on accept or leave) |
| Cost flag | `pool-links.service.ts` (`costPriceMissing`) |
| Doors (+3) | `stock-pool.sql`: `nexus_pool_open_hold_orders`, `nexus_pool_lent_addresses`, `nexus_pool_order_locations` (+ grants); migration `20260919a` rebuilt |
| Column | `schema.prisma` `Warehouse.sharedFromLocationId`; migration `20260919c_shared_warehouses` |

### 4.4 Proof

1. **End to end: 18 of 18** (`apps/api/src/services/stock-pool/stock-pool-orders.vitest.test.ts`, real PostgreSQL, profiles ON, through the REAL eBay ingest (`processOrder`), `reserveOpenOrder` / `consumeOpenOrder` / `releaseOpenOrder`, the cancellation handler, the returns route, the manual hold route, the create-shipment route and the repair job). A lends IT-MAIN (10); B's own shelf holds 3 jackets and 6 caps throughout, moving only for what is B's own. An eBay sale takes 2 jackets from the pool and 1 cap from B's shelf; a re-poll takes nothing; two lines of one product take, return and cancel as one (3 out, 3 back; 2 out, 2 back); a sale of 9 against 8 is refused — nothing taken anywhere, both owners of B get the bell; an Amazon hold is held in the pool, a re-poll holds nothing more, shipping takes it out, a re-poll after shipping never holds again (the "found while mapping" 1 defect, closed for pooled products); a cancellation before shipping gives the hold back and restores nothing else; a cancelled pool sale puts back exactly what it took, once, and the cap goes back to B's own shelf; a cancelled refused sale restores nothing; a return puts back once per return and never more than the order took; the guard refuses an own-shelf sale or order hold of the pooled jacket, the manual hold route answers 409, the cap and an inbound receipt are unchanged, an MCF (FBA) hold stays B's own; the order held before the switch ships from B's own shelf; the repair job takes out a shipped order's pool hold and gives back a cancelled one's, and leaves an open one; while A pauses, a new sale uses B's own stock and a held order still ships from the pool; every level equals its start plus its movements and `reserved` equals the open holds. The ship-from: accepting made B a copy of IT-MAIN's address (not of the unlent outlet), with no stock location; a pool order routes to the copy and its shipment is created there; an own order ships from B's own warehouse even though the copy is in the buyer's country; a refused sale is not a pool order; a stock write naming the copy is refused; the lender's new address reaches the copy; after the grant ends the copy is off and an order already made still ships from it.
2. **Rules: 21 of 21** (two new arms: the repair list shows a business only its own order references; the ship-from doors answer only the borrower — C, which borrows from B, sees exactly B's lent warehouse and nothing of A's). **Door failure: 3 of 3** (`order-routing.vitest.test.ts`): a door that throws leaves a never-pooled product on its own-stock path with no notice; a pooled product's outcome stays unknown, nothing falls to own stock, and the owners are told; a failing check stays unknown too.
3. **The tests catch what they exist for: 30 of 30 mutations caught** (`.shared-stock-tools/mutate-orders.py`, each hash-checked applied and restored): each routing call removed (eBay, holds, take out, give back, put back on cancel and on return, repair list, ship-from on routing and on shipment creation); each guard removed (sale, hold, manual hold, stock write to a copy); an FBA hold sent to the pool; "not pooled" treated as a refusal; a refusal telling nobody; own restores without proof; "more than sold" falling to own stock; each of the three "add up the lines" removed; scored routing picking a copy; the copy never switched off, never following the address, or kept on for an ended grant; each new door answering any business; accepting making no copy; a door failure taking own stock off a never-pooled product. The first run of the first 16 caught 15: the survivor (the cancellation branch) showed the suite never checked the restored count, and the count assertion was added; building that arm found the two-lines-of-one-product defect (D-20).
4. **The migrations build exactly what the tests test.** A = yesterday's schema + generated rules + migrations a, b, c; B = today's schema + generator: **12,531 catalogue lines each, identical**. Control: migration c without its unique index differs by exactly that line. The new column-drift gate passes, and fails when the column's ALTER is hidden (control).
5. **Real-PostgreSQL runner: 6 suites, 76 of 76** (stock race 10, copy 8, pool race 6, pool end to end 9, end times 25, orders 18).
6. **No regressions.** `vitest related` on every file this step changed: 224 files, 2,951 tests; the only failures are the same 9 in the same 5 baseline files.
7. **Gates:** parity (10), model ownership (445), schema drift, column drift, stock-writer lock, sync-ledger source, clustered cron — all pass. `apps/api` `tsc --noEmit` (fresh) exit 0.

### 4.5 Limits (said plainly)

1. **A door that fails during an eBay ingest is not retried by itself.** The owners are told to check the order; the ingest never revisits a booked line (as for an own-stock failure today, "found while mapping" 3). The door is idempotent, so a retry by hand is safe.
2. **Two lines of one product in one Amazon or Shopify order share one hold** (`reserveOpenOrder` is per order and product, for own stock and pool alike, as before this work).
3. **A line added to an order after its product was taken is not taken** (one take per order and product). Orders do not gain lines in the channels we ingest.
4. **A return goes back to the lent warehouse the order took the most from** (D-5), wherever the parcel physically arrived. A return with no order restocks own stock.
5. **The copies appear in other warehouse pickers** (purchase orders, inbound), labelled "(shared stock)"; any stock write naming them is refused. Step 5 hides them there.
6. **Sendcloud:** a copy has no Sendcloud sender, and Sendcloud still serves only the first business profile (plan risk 1).
7. **An eBay order fulfilled by Amazon MCF** takes the sale from the pool at ingest and also holds FBA stock for MCF — the same double as for own stock today.
8. **The copy's address follows the lender's** when the borrower accepts or ships, not at the moment the lender edits it.

## 5. Step 5 — the screens (Nexus design system)

### 5.1 Contract

**The sharing page** (`apps/web/src/app/settings/sharing/`, Settings › Shared products). Two tabs join the product-sharing tabs: **Stock you lend** and **Stock you borrow**. Each grant is a card: who, its state in words (`stockWords.ts`, one place for every sentence), the lent warehouses, how many products use it. The lender can pause, resume or end; the borrower can accept, decline or stop using it. Every one of these opens a dialog that first says what happens — for pause, end and leave it lists the effect on the borrower's listings from `GET /stock-pool/grants/:id/impact` ("2 listings go to 0", "1 listing keeps its Fixed number"). The borrower's card lists the products that can use the stock (own or shared now, own and shared available, cost price) on the AG-backed DS `DataGrid`; choosing products and **Use shared stock** / **Use own stock** opens the per-listing preview from `POST /stock-pool/products/preview` ("Shows 10", "Keeps its Fixed number", "Paused: nothing is sent") and switches only after it. A product with no cost price is flagged in the table and the preview (D-23).

**Pool numbers beside own numbers, never added** (D-26). `GET /stock/products`, `/stock/by-product`, `/stock/product/:id` and the product list (`listProducts`) carry `poolSource` = `{ lenderName, grantId, quantity, reserved, available }` for a product that sells from a pool right now; a parent row adds up its pooled variations (children and grandchildren) and says how many (`products`). The stock table's Available column shows the pool as a labelled tag ("10 · Shared · Lender A", a compact form in the narrow column); the drawer adds a sentence ("Sells from Lender A's shared stock: 10 available there. Its listings follow that stock, not this business's own numbers."); the product list's Available cell adds a third line "10 SHARED", with the sentence in the button's accessible name.

**The drawer's per-channel number** (`resolveAtpAcrossChannels`, also read by the product editor's Inventory tab). For a pooled product, a non-Amazon listing's on-hand is the pool's free units (every hold, this business's orders included, is already taken from them), less the listing's buffer; the row says `source: SHARED_POOL` and names the lender ("shared from Lender A 10 = 10 available"). Before this, it compared the listing with this business's own shelf and showed a false drift (−8 on the jacket in the local check). Amazon listings keep the existing own/FBA rule (D-27).

**Sync Control end times.** Pin, Zero & Pin, Pause and Exclude ask in a dialog: **No end** or **At a date and time** (`DateTimeField`: a date, a time in 15-minute steps, the viewer's zone named, e.g. "Europe/Rome (CEST)"; sent as a UTC instant, D-28). Pin on shared eBay variants only can also take the number to fix. Rows show "until 21 Sept, 09:00" in the viewer's zone. Rows now carry the listing's full coordinate (`channelConnectionId`, `aliasKey`), so a row action addresses exactly that listing. Every end-time history row keeps the end it replaced (`before`).

**Who sold what, for the lender** (plan §7 step 5; research §7 "sales split by profile"). The doors write every take, hold and put-back in the LENDER's own ledger with the business that used the units and its order reference. The lender's stock drawer now reads them back (`stock-pool/lent-usage.ts`): a "Lent stock" line per borrowing business ("Borrower B: 1 held for its open orders, 2 sold in the last 30 days"), each movement made for another business names it and its order, and each hold made for another business's order names it — **with no Release button**: such a hold ends only through that order (shipped or cancelled there), and the release route refuses it (`409 pool_hold`, D-43). **A fixed number warns on screen** (plan §5 warning 1): the Pin dialog says "A fixed number is not real stock. If fewer are left, the channel can sell more than you have."

**Ship-from copies stay out of the pickers** (D-29). `GET /fulfillment/warehouses` leaves out the copies of lent addresses unless the page asks (`?shared=include` — only the carrier settings, where a copy can get its own sender); the routing-rule picker leaves them out; a routing rule cannot name one (`400 shared_stock_address`, on create and on change); a rule saved earlier that names one is skipped by routing; the purchase-order AI draft and file import cannot resolve a copy's code.

**Design system.** New `DateTimeField`. `DateField`'s calendar is portalled (it was cut to a 4 px strip inside a Modal), takes focus on open, keeps Tab inside, closes on Escape without closing the host Modal, names each day by its full date, and carries `ag-custom-component-popup` so it works inside an AG Grid cell editor. Mirrored in Factory; CHANGELOG, READMEs, catalog specimen, DS-GAPS.

### 5.2 Decisions made in this step

| # | Decision | Why |
| --- | --- | --- |
| D-26 | **Pool numbers are shown beside the own numbers, labelled, never added.** Sort, filters and totals stay on own numbers. | A product sells from one source at a time; a sum would count units that no listing sells. |
| D-27 | **The drawer's number for a pooled product's non-Amazon listing is the pool's free units, less its buffer; own holds are not taken off again.** | That is exactly what the listing follows (the step 2 ledger). Own holds hold own stock, not pool stock. |
| D-28 | **End times are chosen in the viewer's zone, stored as UTC instants, and the zone is named beside the field.** | The stored moment never depends on who reads it; the person sees which clock they are setting. |
| D-29 | **Copies of lent addresses are hidden unless a page asks for them.** | Fail-safe: a picker written later cannot offer a copy by accident. A stock write naming a copy is already refused (step 4). |
| D-30 | **Route files gain no database calls.** Sync Control's end-time and shared-variant writes live in `sync-control-overrides.service.ts`; the stock page's product-tree read in `loadPagePoolSources`. | The route-prisma ratchet: logic in a handler cannot be reused or tested alone. |
| D-31 | **New tables use the AG-backed `DataGrid`** (`@/design-system/grid/datagrid`, same props). | The grid-kit ratchet: the `<table>` DataGrid is retiring. |
| D-42 | **The lender's "who sold what" is read from its own ledger**, named through its own grants; nothing is read from the borrower. | The doors already write the business and its order on the lender's rows; the lender needs no view into the borrower. |
| D-43 | **A hold made for another business's order cannot be released by the lender** (service guard `PoolHoldError`, route 409, no button). | Found on screen while building: the drawer offered "Release" on a borrower's hold. Released there, the borrower's order would still count on units no longer held for it. |

### 5.3 Build record (2026-09-19)

| Part | File |
| --- | --- |
| Pool numbers | `apps/api/src/services/stock-pool/pool-sources.ts` (new: `borrowsStock`, `loadPoolSources`, `loadPagePoolSources`, `summarizePoolSources`); `routes/stock.routes.ts`; `services/products/list-products.service.ts` |
| Drawer per-channel number | `services/atp-channel.service.ts` (`pool` argument, `SHARED_POOL`) |
| Sync Control | `routes/sync-control.routes.ts` (rows: `endsAt`, coordinates; history `before`); `services/sync-control-overrides.service.ts` (new) |
| Ship-from pickers | `stock-pool/shared-warehouses.ts` (`OWN_WAREHOUSES`, `isSharedStockAddress`, `SHARED_ADDRESS_REFUSED`); `order-routing.service.ts`; `routes/fulfillment.routes.ts`; web `fulfillment/carriers/CarrierConfigDrawer.tsx` |
| Sharing page | `apps/web/src/app/settings/sharing/`: `stockPoolApi.ts`, `stockWords.ts` (+ test), `StockPanels.tsx`, `PoolProductsSection.tsx` (new); `SharingClient.tsx`, `sharing.css` (tabs, styles) |
| Stock pages and product list | `app/_shared/stock-pool/PoolSourceTag.tsx` (+ module CSS, new); `fulfillment/stock/StockWorkspace.tsx`; `products/_types.ts`; `products/next/InventoryCell.tsx`, `styles.module.css`; i18n `stock.atpPerChannel.shared` (en, it) |
| Sync Control screens | `fulfillment/stock/sync-control/SyncActionDialog.tsx` (new), `SyncControlClient.tsx`, `SyncProductsGrid.tsx`, `product/[masterId]/ProductDetailClient.tsx`, `sync-control-shared.ts`, `styles.module.css` |
| Who sold what; the hold guard; the warning | `stock-pool/lent-usage.ts` (new), `stock-pool/pool-guard.ts` (`PoolHoldError`), `stock-level.service.ts` (`releaseReservation`), `routes/stock.routes.ts` (`lentUsage`, `usedBy`, 409); web `_shared/stock-pool/PoolSourceTag.tsx` (`LentUsageNote`, `MovementUsedBy`, `HeldForNote`), `StockWorkspace.tsx`, `SyncActionDialog.tsx` |
| Design system (web + Factory) | `components/DateTimeField.tsx` (+ test, new), `components/DateField.tsx`, `components/index.ts`, `styles/components.css`, `catalog/DateTimeFieldExample.tsx` (new), `catalog/TokenCatalog.tsx`, `CHANGELOG.md`, `components/README.md`, `catalog/README.md`; `.claude/DS-GAPS.md` (2 entries) |

### 5.4 Proof

1. **Orders suite: 22 of 22** (real PostgreSQL). New: **12d** — the lender's drawer names Borrower B with what it holds and sold; one more sale and one more hold in B show as exactly one more of each; B cancelling the sale shows one put back and no extra sale; every pool movement and the hold name B and the order; the lender's release of B's hold is refused (409) and the hold stays open; a business that lends nothing sees no "lent stock". **12b** — the stock table, the drawer, the by-product list and `listProducts` show the pool beside B's own numbers (own 6, pool 4 — apart); the drawer's eBay listing reads "shared from Lender A", 4 less its buffer 1 = 3 = what it shows (no drift), where B's own shelf would have read −2; the Amazon listing keeps the own rule. **12c** — with an open pool hold the pool reads 4 / 1 held / 3 free, and 4 free again after it is given back; a family row adds up the jacket as a child and as a grandchild, on the stock page and in the product list. **14b** — the warehouse list and the routing-rule picker leave out the copy (the carrier settings see it); a rule cannot be made or moved to the copy; a rule saved earlier on the copy is skipped (control: the same rule on B's own warehouse is used).
2. **End-times suite: 25 of 25.** New: every end-time history row keeps the end it replaced (none; then replaced twice and put back); the pin-end write leaves a following listing without an end.
3. **Real-PostgreSQL runner: 6 suites, 80 of 80** (stock race 10, copy 8, pool race 6, pool end to end 9, end times 25, orders 22). Rules 21 of 21. (With step 6: 7 suites, 94 of 94.)
4. **The tests catch what they exist for.** Step 5 set, 18 of 18 caught (`mutate-orders.py` S1–S18; S15–S18: the lender not seeing a hold, a movement not naming its business, a put-back counted as a sale — first survived, until 12d added a cancellation — and the lender releasing a borrower's hold): the drawer comparing with own stock, ignoring the buffer, or putting FBA on the pool; the product list or the stock page dropping the pool; free units replaced by units (caught only after 12c added a hold — the first run survived, because every earlier test had 0 held); a parent missing its children or its grandchildren (survived until 12c added a family); the product list dropping a parent's variation; each copy guard removed. Step 3 additions: R13, R15, R16 caught; R14 (the pin-end write's own "only pinned listings" filter) survives by design — the database rule in `listing-end-times.sql` clears the end of any listing that follows, so no test can see the code filter alone; it stays as a second lock. **Full rerun after every step 5 change:** `mutate-orders.py` 44 of 44 (steps 4 and 5), `mutate-endtimes.py` 36 of 37 (the one survivor is R14, above) — every file hash-checked restored.
5. **Web:** `tsc` exit 0; vitest 368 files, 4,571 tests pass (13 skipped as before); `DateTimeField` helpers pass in UTC, New York, Kolkata and Rome. **API:** `tsc` exit 0; `vitest related` on this step's files: 20 files, 210 pass, 0 fail (59 real-PG cases skipped there and run by the runner).
6. **Guards:** 30 of the 31 pre-push guards pass, including the route-prisma ratchet (it failed first: +1 in `stock.routes.ts`, +5 in `sync-control.routes.ts`; fixed by D-30). The grid-kit ratchet fails by 3 importers that are **not this work**: `AssortmentProductsModal.tsx`, `CopyDrawer.tsx`, `SharesPanels.tsx` — the uncommitted AE sharing page, byte-identical to the main tree's copies. This step's own table was moved to the AG DataGrid (D-31).
7. **In the browser** (headless Chromium; later, the lender's drawer with real rows written by the doors as Borrower B — a sale of 2 and a hold of 1 — in light and dark: the "Lent stock" line, the named movements, the named hold with no Release button; and the Pin dialog's warning, light and dark at 390 px; a local API and web on a throwaway PostgreSQL with two seeded businesses; a session from the local sign-in, no password typed in a browser): the borrow tab light, dark and 390 px (no page overflow); the switch preview and the switch; the lender's pause impact; keyboard focus trap and Escape in the dialogs; Sync Control "until" labels; a pin with an end time end to end (database row and history row read back); a shared variant fixed at 3 with no end (row, history `before`/`after` read back); the Pause dialog dark at 390 px; the stock table and drawer dark (the false drift found here and fixed); the product list at all three densities, measured: three lines fit with 1.5 px to spare in the 51 px compact row (they overflowed by 0.5 px before the gaps were removed) and nothing is cut sideways; the calendar by keyboard inside a Modal (open → focus on today, Tab and Shift+Tab stay inside, Escape closes only the calendar, Enter picks, Tab goes on to the time, Escape then closes the Modal); the catalog specimen.

### 5.5 Limits (said plainly)

1. **The browser checks ran on a local stack**, not on production. Production is step 7.
2. **Routes that take a warehouse id** (purchase-order create and change, inbound) still accept a copy's id when it is sent by hand; only the pickers hide it. Receiving stock into a copy is refused by the step 4 guard, so nothing is counted there.
3. **Amazon rows in the drawer's per-channel list** keep the existing rule (every Amazon listing read as FBA, own stock). An Amazon FBM listing of a pooled product follows the pool in the sync (step 2) but shows own numbers in that drawer list.
4. **Sort, filters and totals use own numbers only** (D-26). Filtering by "Stock units" does not see pool units.
5. **A lot recall's bulk release skips holds made for another business** (the guard refuses them, and that path goes on to the next). The borrower's order keeps its hold on a recalled lot until it ships or is cancelled; the lender must tell that business.
6. **"Who sold what" covers the last 30 days and open holds**, per product (a parent: with its variations), in the drawer; there is no report across products yet.
7. **The stock drawer and the product editor's Inventory tab are older Tailwind screens.** Only their numbers and one label changed here; they are not moved to the design system in this step.

## 6. Step 6 — live product details (research AE.4)

### 6.1 Contract

**What follows.** For every active `CatalogLink` of an **active** share, the follower's product follows the source product in the field groups the share offers (research §3.4): identity (GTIN/EAN/UPC, brand, manufacturer, and the SKU by its own rule below), content, translations, attributes (product type, variation theme and axes, category attributes, categories by path), physical, compliance, structure (family by code, parent, variations), media (images), and price and status when they were offered. Channel listings, stock, cost and everything `field-groups.ts` marks "never" are never touched.

**How a change travels** (research §3.2, §12.6):

1. **Capture, in the owner's transaction.** Triggers on `Product`, `ProductTranslation`, `ProductImage` and `ProductCategory` call one SECURITY DEFINER function. It writes nothing unless the product is the source of an active link of an active share — one indexed lookup, and a `Product` update that changes no followed column (a stock count, a sync stamp) never calls it at all (the trigger's `WHEN` lists the followed columns). It then writes **one pending `AssortmentChange` per link** (a second change before the worker runs is folded into the pending one) and `pg_notify('nexus_assortment_sync', <follower business>)`, both committed with the edit or not at all.
2. **No loops, no chains.** A write made by the sync sets the transaction flag `nexus.assortment_sync`; capture ignores it. A product that itself follows another business's product never passes changes on (v1: no chains).
3. **The worker** runs in the follower's own business. It claims pending changes (`FOR UPDATE SKIP LOCKED`, one claim per link at a time; a claim older than 10 minutes is taken again) and, per link, **re-reads the current state** of both products — it never replays a remembered value, so an old or repeated change can never write old data, and a crash between claim and apply only means the next run does the same work.
4. **The read across the wall.** A new door `nexus_assortment_sync_source(link)` (follower context) answers only for an active link of an active share between two active businesses, and names the product ids that may be read: the source product and, for a parent, its variations the assortment covers. The owner's data is then read in the owner's context for exactly those ids, by the same module as the first copy (`copy-source.service.ts`), with the same field-group filter.
5. **Apply** through the catalog transfer engine, one product at a time, **without a staged job**: the engine's own plan and `applyTransferTarget` run in one database transaction with the sync flag set, so the follower's field contracts, translation store, readiness and read cache run as for an import. Owner-managed fields (type, price, status) go through their services, as in the first copy. Definitions a followed value needs and the follower lacks (a family, an attribute or option, a category path) are created by natural key, as the first copy creates them (R-AE-13), and the owners are told what was created.

**Field states: measured, not guessed** (research §3.4, §7.1 rule 7). The link keeps a fingerprint of every followed field as it was last applied (`appliedState`). For each field:

| Follower value vs last applied | Source value vs last applied | Result |
| --- | --- | --- |
| same | same | nothing to do |
| same | changed | **apply** the source value; record its fingerprint |
| changed | any | **OVERRIDE**: the follower edited it. Kept, recorded on the link (`overrides`), never written again until someone chooses "Follow again" |

The first copy records the baseline when it finishes. A link with no baseline for a field (made before this step) never overwrites a differing value: it is recorded as an override. **Follow again** (per field or all) clears the override and applies the source value on the next run.

**Media.** The link maps each source image to the follower's own copy. A new source image is copied (the first copy's rules: stored files copied into the follower's storage, outside addresses carried); a changed one (alt text, type, main, order) updates its copy; a removed one removes its copy. If the follower changed its images itself, media is an override as a whole.

**SKU (R-AE-2).** A source rename reaches the follower when the follower's SKU follows. Where the follower product, or one of its variations, is **live** (a listing `ACTIVE` and published — the bulk editor's definition) the rename is **held** on the link (`heldSku`, `heldReason`), the owners are told with the steps (end or unpublish the listing, then the rename applies by itself), and the next run after the product is no longer live applies it. A rename to a SKU this business already uses is held too, with that reason.

**Structure.** A variation added under a linked parent is created in the follower (through the engine, under the follower's parent) and linked, with its images; one whose SKU already exists in the follower is not linked automatically — the owners are told, and the next copy review offers link or skip. A variation deleted or moved away at the source, and a source product deleted, **detach** their links; the follower's products stay (research rule 4). A follower product deleted in the follower detaches its link.

**Pause, resume, end.** A paused share captures nothing; resuming it queues every one of its links. Ending it detaches the links (AE.3 trigger).

**Failures reach a person.** A failed sync is retried with a growing delay (1, 2, 4 … 60 minutes); after 8 attempts the change is marked failed and the follower's owners are told which product and why. Held renames, SKU collisions, created definitions and detached links are told too (hard rule 8).

**Wake-up** (research §12.6): the worker LISTENs on `nexus_assortment_sync` on a direct connection; a poll backs it up (every 2 s while there was work in the last minute, backing off to 60 s). **The repair job** (nightly per business, and on demand) queues every active link whose source changed after its last sync, or whose rename is held, and deletes finished changes older than 7 days; the worker's compare heals or records each.

**API.** `GET /api/catalog-links?productId=` (the follower product's link: source business, state, held rename, every field's FOLLOW/OVERRIDE state measured now, last sync and error) — `products.view`; `POST /api/catalog-links/:id/follow-again` (`{ fields: [...] | "all" }`) — `products.edit`; `POST /api/assortment-shares/:id/resync` (queue every link of an incoming share) — `settings.workspace.edit`, owner of the follower.

### 6.2 Decisions made in this step

| # | Decision | Why |
| --- | --- | --- |
| D-32 | **State, not replay.** A note means "this link may be behind"; the worker reads both products as they are now and applies the difference. | Order-proof and retry-proof by construction: an old or repeated note can never write old data, and a crash between claim and apply only repeats harmless work (research §3.2 "version order"). |
| D-33 | **Field states are measured: each field keeps a PAIR of fingerprints** (the source value applied, the follower value right after). | The follower's field contracts may store a value in their own form; one fingerprint would read every such field as an edit. The pair makes "Override" a reading, not a guess (research §7.1 rule 7), with no trigger on the follower's tables and no flag in every writer. |
| D-34 | **Never overwrite without evidence.** A field with no fingerprint is recorded when equal, filled when the follower's is blank, and otherwise kept as an override. | Links made before this step have no fingerprints; a difference then may be the follower's own choice. |
| D-35 | **The first copy records the fingerprints** from the rows it actually copied, and queues one catch-up sync. | A source edited during the copy's review is caught at once, and nothing the copy did reads as a follower edit. |
| D-36 | **The sync applies through the transfer engine without a staged job or a review.** | The share's consent is the review for a product that already follows; the engine keeps the follower's contracts, translation store, readiness and read cache exactly as for an import. |
| D-37 | **No chains, enforced at capture**: a product that follows another business's product passes nothing on. The sync's own transaction flag is a second lock (`nexus_assortment_sync_write()`, because application SQL may not call `set_config`: `workspace-sql.ts`). | Loops and chains are refused by the database, whoever writes. |
| D-38 | **A new variation is created only when the share offers "structure"**, and a SKU that already exists in the follower is left for a person (the copy review offers link or skip). | Linking an existing product on a guess could merge two different products. |
| D-39 | **An emptied list is not followed** (every category, bullet or keyword removed at the source): the field is refused with its reason and the owners are told, never marked done. | The export leaves an empty list out, and the field contracts refuse one; claiming it applied would be a lie. |
| D-40 | **A fresh change makes a note waiting on a retry delay ready now.** | The new state may apply where the old one failed; the attempt count still rises, so a lasting fault still ends in "failed" and a notice. |
| D-41 | **Four lanes, one family per lane:** different parents sync in parallel; the variations of one parent one after another. A write conflict is tried again at once (three times), not after the retry delay. | Measured: in parallel, siblings collided on the family's readiness rows. Across families, four lanes were 1.6 times faster (§6.4 item 6). |

### 6.3 Build record (2026-09-19)

| Part | File |
| --- | --- |
| Table `AssortmentChange`; eight `CatalogLink` columns (`appliedState`, `overrides`, `heldSku`, `heldReason`, `heldAt`, `syncMarket`, `lastSyncedAt`, `lastSyncError`) | `packages/database/prisma/schema.prisma`; `workspaces/model-ownership.json` (global) |
| Database rules: capture triggers (Product insert and update with the followed columns in the `WHEN`, translations, images, categories), the resume trigger, the change guard and row security, the worker's door, the single-product coverage check, the poller's and the repair's questions, the sync flag | `packages/database/workspaces/assortment-sync.sql` (+ `policy-migrations.json`, generator) |
| Migration (additive: one empty table, eight columns, the rules file byte for byte at the end) | `packages/database/prisma/migrations/20260919d_ae4_live_sync/migration.sql` (built by `.shared-stock-tools/build-sync-migration.mjs`) |
| The rule, pure | `apps/api/src/services/assortment/sync-fields.ts` |
| The sync of one link; the link's state; the baseline | `apps/api/src/services/assortment/sync.service.ts` |
| The worker, the listener and poll, the follower's notes (resync, repair, Follow again) | `apps/api/src/services/assortment/sync-worker.ts` |
| The door-checked read of a link's source | `copy-source.service.ts` (`linkSource`, `readLinkedCatalog`; the first copy's read shares `readFromOwner`) |
| The first copy: fingerprints at finish, the image map, the reference marketplace, one catch-up sync | `copy-run.service.ts`, `copy-media.service.ts` (`pairs`), `copy-preview.service.ts` (`missingDefinitions` exported) |
| Job (worker + nightly repair) | `apps/api/src/jobs/assortment-sync.job.ts`, `apps/api/src/index.ts` (`NEXUS_ENABLE_ASSORTMENT_SYNC=0` turns it off) |
| Routes and permissions | `apps/api/src/routes/assortments.routes.ts`, `apps/api/src/lib/auth/permissions-manifest.ts` |
| Tests | `sync.vitest.test.ts` (real PostgreSQL, in the push runner), `sync-fields.vitest.test.ts`, `sync-load.vitest.test.ts` (opt-in), `copy-media.vitest.test.ts` (pairs) |

### 6.4 Proof

1. **End to end: 14 of 14** (`apps/api/src/services/assortment/sync.vitest.test.ts`, real PostgreSQL, profiles ON, in the push runner). A first copy through the real transfer engine (AE.3), then edits saved in business A with plain SQL, as any code path would: **1** the finish records the fingerprints of every link and queues one catch-up sync that writes nothing; **2** an edit to text, GTIN, weight, an attribute, the German title and the price reaches B — one folded note for five saves, A untouched, B's write not noted back, a product event in B; **3** a stock count or a sync stamp is not noted at all; **4** a description edited in B is kept (override, shown by the link state) and "Follow again" brings A's value; **5** images: a new file copied, new alt text on the copy, a removed image removes the copy (its file cleaned), and B's own image change turns media into an override; **6** SKU: renamed where B is not live; held with a notice to both owners while B's listing is live, applied once it is not; a SKU B already uses is held with that reason; **7** a variation added in A is created and linked in B with its price, status and fingerprints; one whose SKU B already has is left for a person (notice); one deleted in A is detached and B keeps it; **7b** every category removed in A is not followed: refused with its reason and a notice, never marked done; **8** a paused share notes nothing, the door refuses it, and resuming catches every link up; **9** a failing sync is retried after a delay, a fresh change makes it ready at once, and the eighth failure marks it failed and tells the owners; **10** two workers at once sync each link once, and a link being worked on is not claimed again; **11** no chains: B editing its follower product notes nothing for the business it shares onward to, while B's own product is noted — in an offered group only; **12** the door answers only the follower for its own active link, the poller's question only outside a business, and a note naming the wrong business is refused; **13** the delay with the real LISTEN/NOTIFY (item 5).
2. **Unit: 10 of 10** (`sync-fields.vitest.test.ts`): the decision table, the pair of fingerprints, "Follow again", the no-fingerprint rule, category paths, image plans; and the capture trigger's column lists — in its function AND in its `WHEN` — equal the groups of `field-groups.ts`.
3. **The tests catch what they exist for: 33 mutations** (`.shared-stock-tools/mutate-sync.py`, each hash-checked applied and restored). **30 caught by a test.** Q6 (no folding index) is caught at setup: the suite cannot start, because the capture's `ON CONFLICT` needs the index. Two survive by design, and say why in their names: Q15 (capture ignores the sync flag — every sync write lands on a follower product, which the chain rule already ignores) and T5 (no taken-SKU check — the database's unique SKU refuses it too, and that refusal holds the rename with the same words). The first run also found a test gap: Q12 survived because the poller's question was asked while nothing waited; the arm now asks while a note waits (with a control), and it is caught.
4. **The migration builds what the tests test.** A = yesterday's schema and rules + migrations a, b, c, d; B = today's schema and generator: **12,586 catalogue lines each, identical**, every new function with its body fingerprint and its grants, every new trigger. Control: migration d without the one-pending index differs by exactly that line. Applied again on the local database built before this step (for the screens): it applied cleanly, additive.
5. **Delay, with the real listener** (one link, one worker, 20 edits one after another, a disposable PostgreSQL, machine load about 2): **p50 103 ms, p95 124–147 ms, max 162 ms** over three runs. Control — the same run with the listener off: p50 2,192 ms (the poll). The target was p95 under 5 s.
6. **Under a bulk edit** (`sync-load.vitest.test.ts`, opt-in `AE4_LOAD`; one worker, 4 lanes): 40 products in 8 families — 1 lane 11.0 products/s (last 3.6 s), 4 lanes 17.9/s (last 2.2 s); 200 variations of one parent — 7.2/s, the last after 27.8 s (p50 12.8 s, p95 26.4 s); 1,000 products in 50 families — 8.4/s, the last after 119.7 s (p50 66.9 s, p95 114.7 s), at machine load 9.6. No retries in any. Before D-41, four lanes on siblings collided in `readinessIndex` (write conflicts) and waited the one-minute retry (p95 63 s).
7. **No regressions.** The first copy end to end 8 of 8; the assortment unit suites 70 pass (the 21 real-PostgreSQL cases run in the runner); the real-PostgreSQL runner **7 suites, 94 of 94**; `apps/api` and `apps/web` `tsc` exit 0; policy ⇄ migration parity (11 files), model ownership (446), schema and column drift (446 tables), route-prisma ratchet, clustered cron, and 30 of the 31 static push guards (the grid-kit ratchet: the 3 AE files, §5.4 item 6).

### 6.5 Limits (said plainly)

1. **No screens for the sync yet.** Field states, "Follow again", a held rename and the last sync are in the API (`GET /api/catalog-links`) and the bell; the products-grid "Source" column and the studio badges (research §7) wait for the UI lane.
2. **Throughput:** one worker per API process syncs about 7–18 products a second here. A single edit reaches the follower in about a tenth of a second; a bulk edit of 1,000 products takes about 2 minutes to reach it in full. Variations of one parent go one after another (D-41).
3. **Not followed:** an emptied list (D-39); the order of images; videos, 3D models and documents (as in the first copy); changes to definitions at the source (a family's attributes, an option's label) — only product values follow, and a definition a value needs is created by natural key.
4. **The listener needs a direct connection.** It uses `DIRECT_URL`, else `DATABASE_URL` without Neon's `-pooler` (D-44, step 7). Through a pooled URL only the poll runs: about 2 s after work, up to 60 s after a quiet spell.
5. **A link made before this step has no fingerprints** (none exist in production): a differing value is kept as an override until someone chooses "Follow again".
6. **Not run here:** a real image upload, and LISTEN on the production database (step 7).
7. **Every API process runs a worker.** Two replicas both listen; claims are safe (SKIP LOCKED, one claim per link), and both share the work.
8. **Without the "structure" group** a new variation is not created live; the next copy review offers it.

## 7. Step 7 — the full test on two test profiles (before the production decision)

The Owner, 2026-09-19: **"go with option 1, run the full test"** (option 1: the full test first, then the decision; a push migrates production). Plan §7 step 7 = research AE.9: "End-to-end proof on two local profiles", plus risk 7 (the stock lock under a production-sized rush) and risk 8 (the doors' rights in production). Nothing is committed or pushed; nothing is written to production.

### 7.1 What is tested, and how

| # | Arm | Where | What would fail it |
|---|---|---|---|
| 7.1.1 | **Production facts, read-only** (`.shared-stock-tools/step7/prod-facts.mjs`): the migration role's rights (superuser? bypasses row security?), the owners of the live AE doors, the runtime role, RLS behaviour (the owner sees rows; the runtime role without a business sees none), migrations applied vs this branch, the busiest minute of stock writes (all products, one product) and of orders, and a LISTEN/NOTIFY probe on the URL the sync worker would use. Every query inside `BEGIN TRANSACTION READ ONLY`. | production, read-only | a migration role without BYPASSRLS; a migration in production that this branch lacks; a peak near the lock's measured ceiling (7.1.3) |
| 7.1.2 | **Rights under a production-shaped owner** (risk 8): a throwaway PostgreSQL where a non-superuser role with production's measured attributes owns and runs everything — the real-PostgreSQL suites and the catalogue rehearsal of migrations a–d run as that role. Control: the same door with its owner lacking BYPASSRLS must see nothing. | local | a door, trigger or migration that needs a superuser |
| 7.1.3 | **The stock lock under a rush** (risk 7; `stock-pool-rush.vitest.test.ts`, opt-in): open-loop orders from both businesses on ONE product (the worst case) — B's holds, ships, give-backs, takes and put-backs through the doors, A's own sales, holds, ships, releases and restocks through its own writers, with the pool worker running. 20 → 400 orders/s, and a burst of 500 at one instant. | local | any failed step; a lost unit (the writers' books, the movements, the holds, the lender total, B's listing); a deadlock |
| 7.1.4 | **The whole story on two test profiles**, in one production-shaped database (7.1.2's owner), through the real API process with its workers: share and first copy (AE.3) → lend and switch (steps 1–2) → orders, cancellations, returns and ship-from (step 4) → who sold what and the hold guard (step 5) → end times (step 3) → live edits, overrides, "Follow again", a held SKU, a new variation (step 6) → pause, resume, end. Then the screens of both profiles on that data. | local | any step's check; a screen that shows a wrong number |
| 7.1.5 | **No regressions** after any fix made here: the runner, `tsc`, `vitest related`, the gates. | local | a new failure outside the 9 known baseline cases |

### 7.2 Decisions made in this step

- **D-44 — the live-sync listener derives its direct URL** (`listenUrlFrom` in `sync-worker.ts`): `DIRECT_URL`, else `DATABASE_URL` with Neon's `-pooler` taken off the host — the rule `packages/database/scripts/migrate-direct.mjs` already uses for migrations (one credential, so it follows a rotation). Found while planning 7.1.1: nothing else in the repo reads `DIRECT_URL`, and the migration runner's header names only `DIRECT_DATABASE_URL` on Railway, so production would most likely have listened through the pooler, where a notify does not arrive (PgBouncer in transaction mode): the sync would have waited for its poll (up to 60 s when quiet) instead of about 0.1 s. Proof: `sync-worker.vitest.test.ts` 4 of 4; control — the old rule put back fails the pooled case. The worker now logs `assortment-sync: listening` with `pooled: true|false`.
- **D-45 — a pooled product's stock state is the pool's** on the stock page's cards, its "stockout risk" list and the drawer's days of stock (`unitsForState`, `pooledStockRisk` in `stock-pool/pool-sources.ts`; `/stock/kpis`, `/stock/insights`, `/stock/product/:id`). Found on the screen in 7.1.4: the borrower's page said "Stockouts 5 — 83% of 6 SKUs, restock urgently", listed every pooled product at 0, and the drawer said "0 days of stock" in red, while its listings sold 20 units from the pool. Units and value stay the business's own; only the state (out / critical / low / healthy, days of cover) reads the pool, and the risk list says "shared from Lender A". With no pool behind a product right now (a paused lender) its own total counts, which is what its listings then show. Proof: orders suite arm 12e (a product with no own stock: stockout, 0 days → switched: critical, 4 in the pool, 4 days → switched back), three controls (each old rule put back fails it).
- **D-46 — the push runner can run as production's owner shape** (`node scripts/run-real-postgres-tests.mjs --owner production`): a role `nexus_owner` NOSUPERUSER BYPASSRLS CREATEDB CREATEROLE creates and runs everything. The default stays the superuser; making `production` the default is one line and is offered to the Owner (7.6).

### 7.3 Proof (2026-09-19)

1. **The whole story on two test profiles — PASSED, twice** (`.shared-stock-tools/step7/story.mts`; the second run with `STORY_KEEP_POOL=1` for the screens). The database: built as `nexus_owner` exactly as production will be after a push — the base commit's schema and policies, then migrations a → b → c → d; all 44 SECURITY DEFINER functions owned by that role. The real API process on it (`story-api.sh`: TZ UTC, no `DIRECT_URL`, like production), signed in as one owner of both profiles, every action over HTTP with the profile header and CSRF; orders through the order imports' own functions. Steps, each on the output of the one before:
   0 sign-in, both profiles listed · 1 A offers 5 products, B accepts, reviews and applies the first copy (links, text, the image address arrive) · 2 A lends IT-MAIN, B accepts (B gets the ship-from copy `SHARED-IT-MAIN`, Milano), previews and switches 4 products: B's listings show S 10, M 10, L 5, helmet 3 — not A's outlet — **245 ms** after the switch · 3 an eBay sale (take), an Amazon hold → ship, an Amazon hold → cancel, an eBay sale → return → back in A's pool (not on a shelf of B), A's own eBay sale on the same number: B's listing followed a sale in **203 ms**, A's own listing in the same transaction · 4 A's drawer: "Borrower B: 1 held, 2 sold"; A's release of B's hold refused (409 `pool_hold`); B's drawer shows the pool · 5 "Fixed number until …" on a pooled listing ended by the API's minute job 18–55 s after its time, then followed the pool again · 6 A's description edit reached B in **249–253 ms** (LISTEN on the derived URL); B's own text kept, the link said "override", "Follow again" brought A's text; A's SKU rename (the grid's bulk PATCH) held while B's listing is live, with its reason; a new variation XL arrived linked · 7 A saw the impact, paused (B's listings to 0 in 206 ms), resumed (204 ms), ended (to B's own stock, 207 ms) · 8 the books: every lender level = its seed + its movements, reserved = open holds, the read cache = the stock, the lender's ledger names B on each pool movement.
2. **The screens, on that data** (`story-web.sh`, `shot.mjs`; light and dark, 1440 and 390 px): A's stock table (jacket family 25 on hand, 1 held for B, 24 free); A's M drawer ("Lent stock — Borrower B: 1 held for its open orders, 2 sold in the last 30 days", the hold "For Borrower B … released when that order ships or is cancelled there", no Release button, movements naming B); B's table (0 own, "20 shared", helmet "3 shared", the cap 9 own); B's M drawer ("Shared stock — 6 available · Lender A", the eBay listing "shared from Lender A 6 = 6", no drift); A's lend tab (On, IT-MAIN, 4 products, Pause / End); B's borrow tab in dark (On, 4 products shared, XL own, cost price missing — honest). No horizontal overflow at 390 px. They found D-45 (fixed and re-shot) and 7.4 items 3–6. The final class swap in D-45's list line (to `nds-type-xs` and `--nds-text-muted`, for the DS guard) was checked by the guards, not re-shot.
3. **Risk 7 — the stock lock under a rush** (`stock-pool-rush.vitest.test.ts`, opt-in; one API process = 8 connections, the API's pool; open-loop arrivals; the pool worker running; the mix of B's doors and A's own writers in the file header). **No unit was lost in any run** — the writers' own books, the movements, the open holds, the lender total, B's listing and the lender's ledger all agreed after every run; a control that changes a level behind the writers' backs is caught.

   | Load (1 product = the worst case) | Steps | Result |
   |---|---|---|
   | 20 orders/s, 30 s | 857 | all done, p50 11 ms, p95 40 ms, max 68 ms |
   | 50 orders/s, 30 s | 2,159 | all done, p50 28 ms, p95 73 ms, max 133 ms |
   | 100 orders/s, 30 s | 4,436 | all done, but saturated: p50 2.2 s, p95 5.0 s (≈ 125 steps/s) |
   | 150 orders/s, 30 s | 5,266 | 1,193 of A's own steps timed out (5 s interactive transaction), rolled back; the doors never failed |
   | 200 orders/s, 30 s | 5,982 | 2,278 failed (A's own writers; at this rate also 10 s connection waits, B's doors included) |
   | 100 orders at one instant | 145 | all done in 2.7 s (p95 1.4 s) |
   | 500 orders at one instant | 724 | done in 8.9 s; 19 of A's own steps timed out |
   | 200 orders/s over 20 products | 8,816 | all done, 256 steps/s, p95 3.2 s (the 8 connections, not the lock) |

   **The ceiling:** about 130 stock steps a second on ONE product per API process (the product lock), about 256 across products (the connections). Production's own peak is 7.1.1's number (not yet read, 7.6).
4. **Risk 8 — the doors without a superuser:** the story database and the catalogue rehearsal built by `nexus_owner` (**12,586 lines each, identical**); the real-PostgreSQL runner **as `nexus_owner`: 7 suites, 95 of 95**; control — the same "check stock" door, the same data, only its owner's BYPASSRLS removed (same table and function rights): B sees **0** instead of **6**, with no error. The doors need exactly that right; without it the pool shows 0 (it sells nothing; it never oversells). Production's migration role had it on 2026-09-12 (`neondb_owner`: rolsuper false, rolbypassrls true — `docs/audits/2026-09-12-language-axis/production-baseline.json`); 7.1.1 reads it again.
5. **No regressions:** the runner as the superuser 7 suites **95 of 95** (orders 23 with arm 12e); `apps/api` and `apps/web` `tsc` exit 0; `vitest related` for today's API files 219 pass, 0 fail; `apps/web` vitest 4,571 pass; unit `sync-worker.vitest.test.ts` 4 of 4; policy parity, model ownership, schema drift; 30 of the 31 static push guards — the grid-kit ratchet still fails only on the 3 AE files (§5.4 item 6).

### 7.4 Found in step 7

Fixed here: **1.** the listener through the pooler (D-44); **2.** the borrower's stock cards, risk list and days of stock (D-45).

Not fixed:

3. ✅ **Reordering did not know about the pool — fixed in §8 (the Owner's option 1).** (Not in the plan or the research.) The lender's replenishment counts only its own sales: in the story A's M showed 1 sold in 30 days while B sold 2 of A's units from the pool, so A would reorder too little. The borrower's replenishment suggests reordering every pooled product ("JACKET-M: CRITICAL, reorder 2" with 6 in the pool). The auto-PO job needs a supplier with auto-ordering on, and copies never carry a supplier, so nothing is bought by itself. An Owner decision (7.6).
4. **Under overload the lender's own writers fail first.** Above about 130 steps a second on one product, A's own stock writes (interactive transactions, 5 s timeout) time out and roll back; the doors are single statements and keep going. Nothing is lost. The timeout is older than this work; the pool adds load to the same lock.
5. **The stock drawer's per-channel check uses the default warehouse only** (IT-MAIN, `atp-channel.service.ts`, older than this work) while listings count every warehouse: a business with two warehouses sees a false drift (A's M: "on-hand 6 … drift −4" beside 10 shown).
6. **The stock page's search does not find a variation's SKU** (parent rows only; older than this work), and its status chips read the business's own location rows, so a pooled product never matches one (the cards and the risk list read the pool since D-45).
7. **A variation that arrives by the live sync while its family borrows joins as own stock** (0); the borrow tab lists it for a switch.
8. **Two processes refreshing one product's read cache at once can lose a write conflict** (seen 3–4 times per story run, logged by Prisma); the cache matched the stock at the end of every run.
9. Known, still open: the drawer shows a far-future hold expiry as "expires now" (Found while building 7).

### 7.5 Not done in step 7

- **7.1.1, the production facts, did not run.** Reading production is refused to this session by the permission guard ("Production Reads"); nothing was tried around it. The script is ready and read-only: `.shared-stock-tools/step7/prod-facts.mjs`.
- Not local: real channel APIs (eBay / Amazon answers are written by the test), real image storage, Neon's pooler itself (no PgBouncer image here; Neon documents that LISTEN does not work through it).

### 7.6 What is left for the Owner

1. Run the production facts (read-only): `railway run --no-local -e production -s @nexus/api -- node .shared-stock-tools/step7/prod-facts.mjs` from the worktree. It answers risk 8 (the migration role still bypasses row security), gives production's busiest minute for risk 7 (compare with 7.3 item 3), shows whether production has migrations this branch lacks, and whether a notify arrives on the URL the sync worker will use.
2. ~~Decide 7.4 item 3~~ — the Owner chose option 1; built in §8.
3. Before any push: the grid-kit ratchet (3 AE files, one import each) and the pre-push gate's signed-in studio session.
4. Optional: make `--owner production` the runner's default (D-46), so every push proves the doors need no superuser.

## 8. Step 7b — reordering knows the shared pool

The Owner, 2026-09-19: option 1 — make reordering pool-aware first, then one push. Found in step 7 (§7.4 item 3): the lender's reorder numbers counted only its own sales, and the borrower was told to reorder products the pool covers.

### 8.1 Contract

1. **Pool demand** (`stock-pool/pool-demand.ts`) — what the lender's pool gave to borrowers' orders, read from the LENDER's own ledger (the doors write each movement there with `consumerWorkspaceId` / `consumerOrderRef`; no read crosses into another business). Per borrower order and product: units taken (`ORDER_PLACED`, `RESERVATION_CONSUMED`) minus units put back for a cancellation (`ORDER_CANCELLED`), on the UTC day of the first take. The same rule as the business's own sales (`sales-aggregate.service.ts`): a cancelled order is not a sale; a return does not unsell. Holds count when they ship.
2. **The lender's reorder page** (`/fulfillment/replenishment`): pool demand is added to each SKU's units sold, its daily series (one value per day, so the spread stays right) and, as its own row, to the per-channel cover: channel `SHARED_POOL`, named for the borrower. With a channel or marketplace filter set, pool demand is left out (it is neither).
3. **The forecast** (`forecast.service.ts`, nightly per business): one more series per lender SKU and borrower — channel `SHARED_POOL`, marketplace = the borrower's business id — with its history read from pool demand, the same cold-start rule (7 days with demand), and no external signals (no marketplace calendar belongs to it). The reorder page sums a SKU's forecasts, so this series is in the lender's forecast demand. The accuracy job starts from real sales rows, so it does not score this series (a limit).
4. **The borrower**: a product with an active pool link is not a reorder suggestion; the page says how many products sell from shared stock and whose. The auto-PO sweep skips an ACTIVE recommendation for such a product (one made before the switch).
5. Nothing is written to `DailySalesAggregate`: analytics, dashboards and advertising read it, and those sales belong to the borrower.

### 8.2 Decisions made in this step

- **D-47 — pool demand is read, never stored.** A separate read (`lenderPoolDemand`) in the reorder consumers, not rows in the sales table: that table is rewritten by its own job (`refreshSalesAggregates` deletes and re-aggregates a window) and read by analytics, dashboards and advertising, for which these are the borrower's sales.
- **D-48 — the pool row sells from the lent warehouses.** On the reorder page and the forecast drawer, a `SHARED_POOL` row's free units are the lender's available in the warehouses of its grant to that borrower (`poolCoverStock`, source `SHARED_POOL`, "lent warehouses" on screen) — not the default warehouse a channel row would fall back to. The row is named "Shared stock · Borrower B" wherever a channel key is shown (`channelLabel.ts`).
- **D-49 — the borrower's auto-PO skip is noted, not counted.** The sweep's counters are columns of `AutoPoRunLog`; a new counter would need a migration. The skip is a note in the run log, naming the products and the lender.

### 8.3 Build record

| What | Where |
|---|---|
| Pool demand, lent warehouses, pooled products | `apps/api/src/services/stock-pool/pool-demand.ts` (new) |
| Reorder page and forecast drawer | `apps/api/src/routes/fulfillment.routes.ts` (`/fulfillment/replenishment`, `/fulfillment/replenishment/:productId/forecast-detail`) |
| Forecast series | `apps/api/src/services/forecast.service.ts` |
| Auto-PO skip | `apps/api/src/services/auto-po.service.ts` |
| Screens | `apps/web/src/app/fulfillment/replenishment/ReplenishmentWorkspace.tsx` (DS `Banner`), `_shared/channelLabel.ts` (+ test), `_shared/DrawerPanels.tsx`, `_shared/SuggestionRow.tsx`, `_shared/MobileSuggestionCard.tsx`, `_shared/ForecastDetailDrawer.tsx` |
| Tests | orders suite arm 12f; the story's step 6b; `.shared-stock-tools/mutate-reorder.py` |

### 8.4 Proof (2026-09-19)

1. **Orders suite arm 12f** (real PostgreSQL, real routes): a new pool sale of 2 in B adds 2 to the lender's units sold, with a "Shared stock · Borrower B" row whose free units are the lent warehouse's; its cancellation takes them away again; a sale that is returned still counts; the borrower gets no suggestion for its pooled jacket and the note `{ products: 1, lenders: ['Lender A'] }`; the forecast drawer's past days add up to the reorder page's units sold, with the same pool row; the nightly forecast writes a 90-day `SHARED_POOL` series with demand in it; the auto-PO dry run orders B's own cap and skips the pooled jacket with its note.
2. **The controls: 10 of 10 caught** (`mutate-reorder.py`, each hash-checked applied and restored): pool demand not added; a cancellation kept; a return unsold; the pool row on a channel location; the borrower told to reorder; no pool series; the pool series reading the sales table; the drawer history or its cover without pool demand; auto-PO ordering a pooled product.
3. **The story, step 6b**, through the real API on the production-shaped database: the lender's units sold — M 3 (2 by B from the pool + 1 own), helmet 1 (sold, returned), L 0 (cancelled), S 1 (a hold that shipped); the M row "Shared stock · Borrower B"; the borrower: no suggestion for its 4 pooled products, the note naming Lender A. The whole story passed again (96 s).
4. **The screens**: the borrower's reorder page shows the note ("4 products sell from shared stock. Lender A restocks them, so they are not suggested here.") and suggests only its own products; the lender's M row shows 0.1 a day (3 in 30 days) and its drawer "Raw velocity 0.10/d". The drawer's chart and per-channel panel read days up to yesterday, as for the business's own sales, so the story's same-day sales are not drawn there (arm 12f checks them on moved days).
5. **No regressions:** the real-PostgreSQL runner **7 suites, 96 of 96, as the superuser and as `nexus_owner`** (orders 24 with arm 12f); `apps/api` and `apps/web` `tsc` exit 0; the related vitest files pass; the reorder unit tests (`auto-po`, `replenishment-urgency`, `replenishment-math`, `replenishment-recommendation`, `fba-restock`) pass — `__tests__/effective-lead-time.test.ts` is a vitest file that `tsx` cannot run and imports only `replenishment-math` (untouched); `apps/web` vitest 4,572 pass; 30 of 31 push guards (grid-kit: the 3 AE files); policy parity, model ownership, schema drift.

### 8.5 Limits (said plainly)

1. **The forecast accuracy job does not score the pool series** (it starts from real sales rows).
2. **ABC classes and the stockout detector** still read the lender's own sales only.
3. **Pool demand is dated when the stock left the pool** (the take or the shipped hold), not the borrower's order date.
4. A borrower's product that stops using a pool (the lender ends it) is a suggestion again at once, from its own stock.

## Found while building (2026-09-19)

Fixed here:

1. **The stock drawer's per-channel list showed a false drift for pooled products** (it compared a listing that follows the pool with the business's own shelf; −8 on the local jacket). §5, D-27.
2. **The Sync Control Listings view sent row actions without the listing's full coordinate** (a 500: `LISTING_COORDINATE_MISSING_LEVEL`). Rows carry `channelConnectionId` and `aliasKey` now. §5.
3. **`DateField`'s calendar was cut to a 4 px strip inside a dialog**, and — once moved out of it — unreachable by keyboard there; its days had no names. §5, DS-GAPS.
4. **The product list cut "10 SHARED" off** in its Available column. Its own line now, measured to fit all three row heights. §5.
5. **The lender's stock drawer offered "Release" on a borrower's hold.** Refused now, with its reason. D-43.
6. **Parallel writers of sibling variations collide on the family's readiness rows** (`readinessIndex`, write conflicts). The sync keeps siblings in one lane (D-41); other parallel writers of one family may still meet it.

Not fixed (not caused by this work):

7. **The stock drawer shows a far-future hold expiry as "expires now"**, for every order hold (the date format reads a future date as "now").
8. **Three files of the uncommitted AE sharing page raise the grid-kit ratchet** (`AssortmentProductsModal.tsx`, `CopyDrawer.tsx`, `SharesPanels.tsx`: the retiring `<table>` DataGrid). Moving each to `@/design-system/grid/datagrid` is one import line.
9. **The oversell watchdog still tells nobody** ("found while mapping" 4). The Pin warning therefore does not point to it.

## Found while mapping, not caused by this work (not fixed here)

1. **Double deduction on re-ingest.** `reserveOpenOrder` (`stock-level.service.ts`) is idempotent only against OPEN holds. A re-polled Amazon or Shopify order whose hold was already consumed gets a new hold, which the hourly reconcile then consumes: the stock is taken twice. (The pool doors do not have this: D-3.)
2. **Cancellation restores stock that was never taken.** `order-cancellation/index.ts` step 2 adds `+qty` whenever no hold was released, without checking that the order ever deducted (Amazon FBA orders, FBM orders whose hold failed, Shopify orders whose reserve failed).
3. **A failed eBay deduction is only logged** and never retried (`ebay-orders.service.ts`), so an oversold eBay unit is never deducted.
4. **The oversell watchdog tells nobody.** It publishes `inventory.oversell_risk_detected`, which nothing consumes, and logs a warning. It counts every ACTIVE listing whatever its mode and ignores shared eBay variants.
5. **Most listing-mode writers leave no history.** Of 18 writers of Follow / Fixed number / Paused / Hold back, only the Sync Control page and three others write `SyncControlAudit`; the flat files, the product editor, bulk operations and the stock import (except Paused) do not. And Sync Control's actor is always `sync-control`, because the route reads `request.user`, which nothing sets (auth sets `request.authUser`).
6. **Relabelling a shared eBay variant resets its controls** (`ebay-variation-relabel.service.ts` deletes and recreates the membership without copying `followPool` or `stockBuffer`).
