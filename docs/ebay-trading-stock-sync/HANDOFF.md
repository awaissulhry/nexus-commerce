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

## Session hand-over (2026-10-06, review fixes built) — NEXT SESSION STARTS HERE
- PR 1 = branch `fix/ebay-trading-stock-sync` (rebased on origin/main a1393f12c). The review findings (section below) are
  built. NOT pushed, no PR. After the rebase, `npm run build -w @nexus/shared && npm run build -w @nexus/events` was needed
  in the worktree (the dist was stale: typecheck failed on Etsy names until rebuilt).
- Commits this session: 6c7f90a0f (refactor: one Trading error-block reader + code-class lookup + 21919474 detector),
  f6a12951d (fix: the Trading lane rework), a3526c597 (tests), ee77b0a56 (tests: listing outcome, readers), 0c30f64b9
  (fix: the call census can read the operation), + this handoff.
- What changed (`apps/api/src/services/outbound-sync.service.ts` unless named):
  1. Fallback (premise): Trading first for an unmarked item; eBay 21919474 ("not allowed for inventory items", Italian
     "oggetti del magazzino") is no failure and no circuit outcome: `learnEbayInventoryOffer` reads `GET offer?sku=&
     marketplace_id=`, keeps the fixed-price offer whose `listing.listingId` = this ItemID, merges it into THIS listing's
     `__offerIds` (other keys kept, version-guarded, best effort), closes the 21919474 issue `callTradingApi` filed, and the
     same row continues on the Inventory path (`syncTradingListingRow` returns null). No matching offer → Inventory path,
     nothing stored. Detector: `isEbayInventoryManagedRefusal` (ebay-trading-api.service.ts).
  2. Membership skip narrowed (B1/S1/S3): only the QUANTITY is held, and only when the shared fan-out really sends it —
     `sharedLaneQuantityHold` calls `resolveMembershipIntended` like the fan-out (ACTIVE, productId = this product, FOLLOW or
     PINNED; ledger + policy as its dispatcher reads them) → SKIPPED `EBAY_SHARED_LISTING_OWNS_SKU`. A variant Excluded
     (followPool off) gets no quantity from either lane → `EBAY_SHARED_VARIANT_EXCLUDED`. Price always sent. No product /
     another product / UNCOUNTED → sent. Matrix/MCP "Push now" (`payload.source === 'MATRIX_PUSH_NOW'`) is sent whatever the
     membership. Every quantity this lane sends stamps the memberships (lastQtyPushed, lastPushedAt, lastError null).
  3. Error classes (S2): `tradingRowRefusalKind` reads eBay's error blocks (`tradingErrorBlocks`, moved unchanged from
     contract/channel-contracts.ts) through the gateway's one Trading code table (`ebayTradingCodeClass`, gateway/
     vocabulary.ts): 931/932/16110/17470/21917053 → `AUTH_REQUIRED` retryable (auth hold, no circuit); 10007/518/21919144/
     all-SystemError → `EBAY_TRANSIENT` retryable (circuit counts); ended unchanged; other → terminal `EBAY_VALIDATION`.
  4. Content + stock (S4): the quantity/price is sent; the message says the content goes through Publish. Content alone →
     SKIPPED as before.
  5. Pending forever (S5): existing skips record nothing on the listing (listing-sync-outcome.ts said so). New outcome
     `skipped` for the settling codes (`LISTING_SETTLING_SKIP_CODES`: shared owns SKU, Excluded, content via Publish, parent):
     a listing still PENDING with no other waiting row reads `lastSyncStatus: 'SKIPPED'`, `lastSyncError: '<code>: <reason>'`
     (the Amazon flat-file push-lock precedent). Wired in the BullMQ worker and both drain loops (`listingOutcomeOfCompletion`).
  6. Parent rows: a product with `isParent` → SKIPPED `EBAY_TRADING_PARENT_NO_STOCK`, no call (price/master cascades can
     queue rows for a parent's listing; the parent SKU on a variation item is refused by eBay).
  7. Drafts: no new guard needed. A still-draft (`isStillDraftListing`: DRAFT, unpublished, NO channel id) has no ItemID, so
     `ebayTradingItemOf` never routes it to Trading (test "a still-draft listing … keeps the Inventory path").
  8. Guard order (N1): tests for circuit open, no rate token, wrong account → no Trading call (mutation-checked).
  9. N5/N6: family query = account OR null; a family read failure → Inventory path; a membership or shared-ledger read
     failure → retryable `EBAY_TRANSIENT`, nothing sent, no circuit outcome.
  Also: the `__ebayTrading.callTradingApi` forwarder is gone (the call census `ebay-listing-rejection.p41` could not read
  its operation); the lane calls `callTradingApi('ReviseInventoryStatus', …)`.
- Decisions to tell the Owner:
  - Excluded variant: the review read it as "send"; built as "hold" (followPool off = "everything real-time except one
    variant" in the schema). Push now still sends it. Reverse in `sharedLaneQuantityHold` if he wants the listing lane to send.
  - Retry rows cannot be told apart: Matrix retry-sync, `POST /api/outbound-queue/:id/retry` and bulk-retry re-arm the old
    row with no marker. A retried quantity row on a membership the fan-out covers is SKIPPED (its price is sent). Use
    "Push now" for step 5 on shared SKUs. (Business B's incident family has no memberships: retry works there.)
  - The marker write bumps the listing `version` (as `saveLastPublishedAxes`): an open sheet on that listing sees
    "changed elsewhere" once.
  - DRAFT rows WITH an ItemID are not still-drafts by the repo rule (#91) and do get Trading sends (premise check: 15 rows
    of business A). His call whether the Trading lane should skip non-ACTIVE rows.
  - Business A Trading listings with no membership START receiving real stock after PR 1.
- Checks (2026-10-06, from the worktree; API tests from `apps/api` with a loopback DATABASE_URL, REDIS_URL=redis://127.0.0.1:1):

  | Check | Command | Result |
  |---|---|---|
  | typecheck api | `npx tsc --noEmit -p apps/api/tsconfig.json` | pass |
  | PR files | `npx vitest run src/services/outbound-sync.ebay-trading-listing.vitest.test.ts src/services/ebay-trading-api.service.vitest.test.ts src/services/outbound-sync.ebay-channel-sku.vitest.test.ts` | pass, 123/123 |
  | sweep | `npx vitest run src/services/outbound-sync*.vitest.test.ts src/services/ebay-*.vitest.test.ts src/services/*shared*.vitest.test.ts src/workers/*.vitest.test.ts src/services/listing-sync-outcome.vitest.test.ts src/services/gateway/vocabulary.p31.vitest.test.ts src/services/contract/` | 125 files pass, 4 skipped; 1 test fails PRE-EXISTING (below) |
  | profiles ON | `NEXUS_WORKSPACES_ENABLED=1 npx vitest run` the 3 PR files + listing-sync-outcome + bullmq-sync.listing-status | pass, 140/140 |
  | gateway ratchet | `cd apps/api && npx tsx scripts/channel-gateway-ratchet.mts --check` | pass (EBAY 0) |
  | guards | `node scripts/check-stock-writer-lock.mjs`, `check-context-boundary`, `check-route-prisma-ratchet`, `check-cron-clustered` | pass |
  | mutations | 4b above the circuit; no fallback; membership of any product | each caught by the new tests |

  Pre-existing: `ebay-listing-rejection.p41` "leaves ONE sender of a Trading listing write" — on origin/main,
  `services/comms/marketplace-messaging.service.ts` and `services/identity/channel-held.service.ts` set
  `X-EBAY-API-CALL-NAME` and the test's EXEMPT list names neither (read with `git show origin/main:…`). Not this PR.
- Follow-ups (not this PR):
  - Quantity 0 vs eBay's out-of-stock control (S6): the Inventory path and the shared lane also send 0.
  - N2: quantity and price in one InventoryStatus — a refused price loses the quantity too.
  - N3: no shared debounce / ≤4 batching per ItemID between the two lanes (the stamp is written; the debounce is not read).
  - N4: an ended item does not mark the listing ENDED.
  - Offer-id writer holes H1–H6 (premise report): group-publish `saveOfferIds` scope, flat-file single push and publish,
    the linkers, snapshot restore, the older publishers.
  - A retry marker on re-armed rows, so a retry counts as an explicit push.
  - A membership whose productId differs from its listing's product: both products' lanes send to one eBay variation (data fix).
- Next: push `--no-verify` → PR with the check table → merge only on the Owner's "merge #N" (PR 1 before PR 2) → watch the
  deploy (a run exists for the merge SHA) → step 5: re-push red + yellow × 3 ItemIDs of business B (Matrix "Push now" or MCP
  set-listing-stock push-now = approval request) → verify with listing-live-content: red 0, yellow 1. The aliases are
  sync-paused by the link rule: they must be resumed before any push reaches them (review "Real case").
- PR 2 (gaps 3, 6, 7): `/private/tmp/fix-stock-heal-and-pool-triggers`, own HANDOFF at
  `docs/stock-heal-and-pool-triggers/HANDOFF.md`; builder report → `~/nexus-archive/2026-10-06-stock-realtime/PR2-builder-report.md`.

## All 3 reports in (old session, end) — verdict (BUILT 2026-10-06, see the hand-over above)
- Premise check: the premise does NOT hold. Some paths store an ItemID for an Inventory-API item with no offer id
  (flat-file single push, link/relink/Item ID control, Inventory relist, snapshot restore). Today such a listing works
  (the Inventory path finds the offer by SKU); under PR 1 as built it goes to Trading → eBay refuses → terminal. MUST change.
- Required redesign of the routing: Inventory stays the default for an unmarked family. Go to Trading only when there is
  no marker AND eBay `GET /offer?sku=&marketplace_id=` has no offer whose listing id = this row's ItemID. When the lookup
  finds this ItemID's offer, merge it into `__offerIds` (marker heals itself). Do not switch on 25604 alone.
- Plus the review's should-fix items 1–5 (PR1-adversarial-review.md): classify eBay Failure codes (system/10007/518 →
  transient, 931/932 → auth); price rows on membership SKUs must not be skipped; content+quantity rows send the quantity;
  skipped rows must not leave the listing Pending forever.
- PR 2: see the "Lead notes" at the end of PR2-builder-report.md (2 red marks may be this branch's).
