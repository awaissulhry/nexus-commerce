# Sync Control — operator runbook

**Where:** Stock → Sync Control (`/fulfillment/stock/sync-control`)
**What it governs:** which quantities the shared pool pushes, to which channel and market, for every listing and every shared eBay variant. Everything on this tab derives from the same resolver the sync engine uses (`resolveIntendedQuantity`), so what you see is exactly what the engine will do.

## The precedence ladder (highest wins)

1. **FBA — Amazon-managed.** Never pushed, by anything, ever. Shown as “—”. No control on this page (or any import) can override it.
2. **Channel policy kill-switch** (`pushes PAUSED` for a channel:market, `*` = channel-wide).
3. **Listing paused** (per listing / per shared variant “Exclude”).
4. **Pinned** — listing holds a manual quantity; pool changes don’t touch it.
5. **Follow** — listing tracks the routed pool total minus its buffer.
6. **Uncounted** — a product with an empty ledger pushes **nothing** (never zero).

## Two views: Products (default) and Listings

- **Products** — one row per product family (37 masters, not 1,760 listings): thumbnail, name, family, a **sync rollup** (Follow ×N · Pinned ×M…), **family stock** (units + variants-in-stock), and a **drift** dot (● = a listing's live quantity ≠ intended; ✓ = clean). Small families **expand inline** to their listings; big families (>20 variants) show **"Open ↗"** to a dedicated per-product page in a new tab. Select master rows → a bulk action applies to their non-FBA listings — **narrowed to the active filters** (SCT.3 act-on-what-you-see): with *Market = IT* set, Set Follow touches only IT rows and reports the rest as "outside filters untouched". With no filters it means the whole family, and the confirm dialog says which.
- **Listings** — every listing flat: the finest per-row control (select individual listings).
- **Per-product page** (`/sync-control/product/<id>`) — one product's full variant→listing tree with per-listing selection + its own Excel export/import.

Use the **Drift only** filter and the family facet to scan for exceptions. The page is live (polls + refreshes on orders/cascades).

## Excel round-trip (dedicated)

On the Products view and per-product page: **Export** downloads a two-sheet workbook —
- **Listings** sheet: `Mode` (Follow/Pinned/Paused/Excluded — EN or IT), `PinnedQty`, `Buffer` are editable; Product/Pool/Intended/Live/Drift are read-only context. **FBA rows are locked** (greyed, "Amazon-managed") and ignored on import.
- **Routes** sheet: `Feeds` per location (comma-separated, e.g. `AMAZON:IT, EBAY`).

Edit in Excel → **Import** the file → a **preview** shows exactly what will change (and what's skipped: FBA, invalid mode, unmatched) → **Apply**. Every change is audited and recascaded. Export respects the current filters ("export what you see"). **A control sheet never writes pool quantity** — Amazon/eBay export sheets can't corrupt the pool.

## Common jobs

### Route a location to specific markets
Locations card → Edit routes → enter tokens, comma-separated:
`AMAZON:IT, EBAY` = this location’s stock counts only toward Amazon-IT and all eBay markets. Empty = counts everywhere. Saving recascades every product stocked there.

### Stop syncing one product/variant (everything else stays real-time)
Filter to the SKU → select the row(s) → **Pause** (freeze as-is) or **Pin** (hold a manual number). Shared eBay variants: **Exclude**. Undo with Resume / Set Follow / Include — resume recascades immediately.

### Emergency: stop all pushes to a market
Channel policies card → pick channel + market (or All markets) → **Pause pushes**. Amber banner shows while active. **Resume** recascades the whole scope back to pool truth.

### Keep a safety margin on a market
Select rows → **Buffer** with N units: the push is `pool − N`, floored at 0.

### New listings born dark
Channel policies card → **New listings born paused**: listings created *after* this moment start sync-paused (existing ones untouched; sweep runs at policy-set and hourly). Resuming a listing yourself always sticks — the sweep never re-pauses it.

## Spreadsheets

- **Import wizard** accepts optional `follow` (`Follow`/`Pinned`/`Paused`, EN or IT) and `buffer` columns; they apply through the same primitives (FBA skipped, audited as `import:<jobId>`).
- **Stock export** carries `follow` + `buffer` state columns (Paused > Pinned > Mixed > Follow).
- **Plain quantity sheets — e.g. Amazon exports — never change controls and never overwrite the pool.** The pool is authoritative: if a marketplace quantity diverges, the sync restores pool truth and the difference appears in “Your upload vs pool”.

## Guarantees

- Every mutation lands in **History** (SyncControlAudit) with actor and before/after.
- Every control is enforced in **all lanes**: cascade, instant lane, eBay fan-out, read-back heals, imports, recascades.
- FBA quantity is untouchable in every lane — fail-closed, guard-monitored.
- Controls changed here converge the marketplace immediately (background recascade), not on the next order.

Scenario battery: `sync-control-scenarios.vitest.test.ts` (owner examples, permanent). API: `GET/POST /api/stock/sync-control/*`.

## Bulk-write contract (SCT.3, 2026-07-26)

- **Chunked transactions.** `setFollowMasterQuantity` / `setStockBuffer` process bulk targets in
  chunks of 25, each its own transaction with an explicit 15s timeout. The old single giant
  interactive tx hit Prisma's 5s P2028 timeout above ~10 products — every large FOLLOW from the
  500/page UI died with a bare "Internal Server Error" (incident 2026-07-26).
- **Partial honesty.** A chunk failing mid-bulk keeps the committed chunks and the response says
  exactly how far it got (`error` + `remaining`); the UI shows "PARTIAL — … re-run to continue".
  Re-running is safe: already-written rows are no-ops. A first-chunk failure is a clean 500 with
  the real message — never Fastify's naked "Internal Server Error".
- **Rolled-back chunks leak nothing** — counts and BullMQ enqueues merge only after commit.
- **Act-on-what-you-see.** One predicate (`rowMatchesScope`) decides what the filtered Products
  view displays *and* what a bulk action touches; the flat Listings view always sends explicit
  row targets. 500/page + select-all + one action = one call (target cap 2000, master-bulk 3000).

## Amazon EU shared quantity (SCT.4, 2026-07-26)

**Amazon keeps ONE merchant-fulfilled quantity per SKU across the EU marketplaces**
(IT/DE/FR/ES…). Proved twice on 2026-07-26: the single-SKU DE pilot (zeroing DE
zeroed IT live within a minute) and the 18:42 incident (302 market-scoped
Zero & Pins on DE/ES/FR blanked the whole IT storefront; restored 302→Follow).

Two guards now make contradictory per-market intents unrepresentable:
- **Pre-write (route, SCT.5b consent flow):** a FOLLOW/PIN/ZERO_PIN that covers
  only SOME EU markets of a SKU answers **409 + the true scope** (nothing
  written); the UI shows ONE confirm ("this covers all Amazon EU markets…")
  and resends with `expandEuAligned: true`, which expands the action to every
  EU row of the affected SKUs. No refusals — but no silently half-done writes
  either: platform state always equals what Amazon will actually hold.
- **Push belt (outbound sync):** any quantity push for a SKU whose EU rows
  currently disagree is SKIPPED and logged as `EU_SHARED_QTY_CONFLICT` in sync
  health — imports, heals, cascades and stale queue rows can't sneak past.
  Kill-switch: `NEXUS_EU_SHARED_QTY_GUARD=0`.

Per-market suppression is a **Seller Central offer-close**, never a quantity.
