# eBay Trading listings get no stock updates — HANDOFF (2026-10-06)

Owner (10-06): "B. launch multiple sub agents and make sure that the stock updates in real time across profiles etc."
Incident: the second business's eBay IT family (a main listing + 2 aliases, created by the studio Trading publish) sells
from the first business's lent pool. QUANTITY_UPDATE jobs for red/yellow died: Inventory API `bulk_update_price_quantity`
400 errorId 25604 "SKU not found" — the listings are Trading listings. eBay shows red 10 / yellow 10; pool 0 / 1.
Cause (first look): outbound-sync.service.ts syncToEbay sends to Trading (ReviseInventoryStatus) only when
`payload.pushVia === 'TRADING'`; every other eBay stock push uses the Inventory API.
Owner chose B: build the fix first (eBay keeps the wrong numbers until it is live).

## Steps
1. Research (running): eBay push routing; cross-business pool propagation (real time, aliases, all channels).
2. Build. 3. Review + test sweep. 4. PR, merge on "merge #N". 5. After deploy: re-push red/yellow, verify live.
Worktree /private/tmp/fix-ebay-trading-stock-sync (branch fix/ebay-trading-stock-sync from 63ad79dbf). COMMIT WIP EARLY
(/private/tmp is wiped on a Mac restart).
## Research 1 (routing) done
- Root cause: studio Trading publish writes no model marker; usesEbayInventory (pim/ebay-listing-model.ts) = Inventory iff
  `__offerIds` non-empty or `offerId`; syncToEbay never checks it → every QUANTITY/PRICE row → Inventory API → 25604.
  Prices to studio Trading listings never land either (pickEbayPriceOffer).
- Trap: a recascade will NOT repair it (cl.quantity already 0/1) — re-push via Matrix Push now / MCP set-listing-stock
  push-now or retry-sync after deploy (6 coordinates: red + yellow × 3 ItemIDs).
- Fix (builder running): syncToEbay routes Trading families to new syncTradingListingRow (ReviseInventoryStatus via
  callTradingApi, ItemID+SKU, StartPrice for price rows; membership-owned SKUs skipped; content refused); fixtures of
  Inventory-path tests get __offerIds.
- Follow-ups (not this PR): saveOfferIds lookup not scoped by account/marketplace; retryQueueItem keeps isDead; failing-
  listings retry rows have cl=null; batching 4 per ItemID.
- Risk to tell the Owner: business A Trading listings without membership will START receiving real stock (today they die).
## Research 2 (cross-business propagation) done
- Propagation works ~1–2 s (StockLevel trigger → StockPoolTask → notify → worker → recascade → queue per listing, aliases
  included; tests stock-pool-sku-e2e test 5).
- Gaps: (1) routing = PR 1 here; (2) eBay orders arrive by 5-min poll (Owner decision: schedule/notifications cost);
  (3) failed push never healed while pool static; (4) Trading fan-out rows name no account (multi-account only);
  (5) Trading readback primary account only; (6) lent warehouse deactivation queues no task; (7) failed pool task waits
  2 min; (8) claims rollback (conditional); (9) lender 30 s hold by design.
- PR 2 building in /private/tmp/fix-stock-heal-and-pool-triggers (branch fix/stock-heal-and-pool-triggers): gaps 3, 6, 7
  (+5 if small). Merge PR 1 first.

## Build status (step 2 done, 2026-10-06)
- `syncToEbay` decides the item's API once (`ebayTradingItemOf`: `usesEbayInventory` over this listing + every listing of
  its ItemID on the same account; no ItemID → Inventory as before) and, at step 4b (after every guard), sends a Trading
  item's row through `syncTradingListingRow` → `callTradingApi('ReviseInventoryStatus')` with its own ItemID + SKU
  (+ `<StartPrice currencyID>` for a price). Content rows / SKUs held by an ACTIVE shared membership → SKIPPED.
- Tests: `apps/api/src/services/outbound-sync.ebay-trading-listing.vitest.test.ts` (28), builder StartPrice tests,
  channel-sku fixtures now name an Inventory item.
- Not done (out of scope): offer-id cache scoping by account+market, `retryQueueItem` not clearing isDead, failing-listing
  retry rows with no listing, a price read-back for Trading listings.

## Session hand-over (2026-10-06, context full) — NEXT SESSION STARTS HERE
- PR 1 build DONE: commits 9c2c9c72a (fix), ecea8d81b + 8c9011b68 (tests), d6093d079 (handoff). 28 new tests in
  `apps/api/src/services/outbound-sync.ebay-trading-listing.vitest.test.ts`. api + web typecheck pass; sweep 55 files /
  978 tests pass; profiles ON pass; gateway ratchet 0. Not pushed, no PR.
- Step 3 (review) was RUNNING when the old session ended. Two read-only reviewers write their reports to:
  - `~/nexus-archive/2026-10-06-stock-realtime/PR1-adversarial-review.md` (guards, SKU, errors, tests)
  - `~/nexus-archive/2026-10-06-stock-realtime/PR1-premise-check.md` (KEY: is every real Inventory-API listing marked
    with an offer id? If not, this PR re-routes working Inventory listings to Trading → they break. Fix = fallback.)
  If a file is missing, the reviewer did not finish: run that review again.
- Builder decisions to keep in mind: content rows + membership-owned SKUs end SKIPPED (not FAILED); no Trading price
  read-back; single-SKU items whose item SKU differs → terminal EBAY_VALIDATION.
- Next: fix findings → scan EVERY commit for real ids/business names → push `--no-verify` → PR with the check table →
  merge only on the Owner's "merge #N" (PR 1 before PR 2) → watch the deploy (a newer merge can cancel it; check a run
  exists for the merge SHA) → step 5: re-push red + yellow × 3 ItemIDs of the second business (Matrix "Push now" or MCP
  set-listing-stock push-now / retry-sync = approval request) → verify with listing-live-content: red 0, yellow 1.
- Tell the Owner: business A Trading listings with no membership will START getting real stock after PR 1.
- Ask the Owner (gap 2): eBay orders arrive by a 5-minute poll. Option: faster cron or eBay notifications (cost: calls).
- PR 2 (gaps 3, 6, 7): `/private/tmp/fix-stock-heal-and-pool-triggers`, own HANDOFF at
  `docs/stock-heal-and-pool-triggers/HANDOFF.md`; builder report → `~/nexus-archive/2026-10-06-stock-realtime/PR2-builder-report.md`.
  At hand-over it had 2 commits (e9fdf8fc0 pool triggers, 63a5eee83 pool-task retry) + an uncommitted heal job.
