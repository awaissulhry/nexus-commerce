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
