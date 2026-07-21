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
