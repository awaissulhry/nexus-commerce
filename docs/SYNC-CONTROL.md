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

- **Products** — one row per product family (37 masters, not 1,760 listings): thumbnail, name, family, a **sync rollup** (Follow ×N · Pinned ×M…), **family stock** (units + variants-in-stock), and a **drift** dot (● = a listing's live quantity ≠ intended; ✓ = clean). Small families **expand inline** to their listings; big families (>20 variants) show **"Open ↗"** to a dedicated per-product page in a new tab. Select master rows → a bulk action applies to **all their non-FBA listings**.
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
