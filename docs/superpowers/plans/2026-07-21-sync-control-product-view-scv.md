# Sync Control — product-first control surface (SCV series) — PROPOSAL v2

**Owner (2026-07-21):** the grid alone isn't the point — make it *work* like /products/next (product images, chevrons, grouped rows). "Just reading the SKU list is not really wise." **And** (v2 correction): the product view must carry the FULL control model we built — bulk, import, export, override, Excel round-trip. "I should have proper control over each and everything: Excel imports, exports, all the stuff." Do not lose control; do not forget what the page is for (100% fidelity over what syncs where; FBA untouchable).

## The core problem

Today's grid is **listing-flat**: 1,760 rows for 359 products — every product repeats 4–6× (channel × market × shared listing). You scan SKUs, not products. /products/next already solved this: parent rows (thumbnail + name + chevron), children interleaved on expand, manual sort so groups never scatter. We reuse that shell and change the columns — but the page stays a **control surface**, now product-first.

## What it must do — three tiers of control (all reuse existing guarded primitives)

### 1. Per-listing (finest — unchanged)
Expand a product → today's listing/membership rows (channel · market · lane+itemId · mode · intended · live · buffer · routed). Select → the same actions (Follow · Pin · Pause · Resume · Zero-pin · Exclude · Include · Buffer) with the same confirms, FBA guards, audit, recascade. The per-listing truth stays authoritative.

### 2. Per-product (new bulk convenience)
Select product row(s) → apply an action to **all of that product's non-FBA listings** at once: "Pause AIREON everywhere," "Buffer 5 on all GALE listings," "Route AIREON to IT + all eBay." Reuses the SC.3 actions endpoint (expand product→listings, FBA excluded server-side). This is the "bulk over what I can see" the owner wants.

### 3. Excel round-trip (the emphasis — extends SC.4 to the full vocabulary)
- **Export** the current (filtered) view to a workbook keyed **per listing** (SKU × channel × market): Product · SKU · Channel · Market · Lane · **Sync mode** (Follow/Pinned/Paused/Excluded) · **Pinned qty** · **Buffer** · Pool available · Intended · Live · Drift. FBA rows exported **locked/read-only** (mode = "Amazon-managed") so a re-import can never touch them. Optional second **Routes** sheet (location → markets) for routing control in Excel.
- **Import** the edited workbook → **preview/diff** (Follow→Paused here; Buffer 0→5 there; FBA rows ignored with a note; malformed cells flagged) → apply atomically → SyncControlAudit (actor `import:<jobId>`) → background recascade. Enforces the SC.4 guarantee: **a control sheet only touches control columns — it never writes pool quantity**, so Amazon/eBay export sheets can't corrupt the pool.
- **Override** = pin a manual quantity (Pin / Zero-pin) or override routing — exposed at all three levels (listing, product, Excel).

## The product row (Level 1 — ~359 rows, not 1,760)

| Column | Content |
|---|---|
| **Product** (sticky) | chevron · thumbnail (`Thumbnail`, parent-image fallback) · name (editor link + "Open" new-tab) · SKU tag · family tag — the `ProductCell` pattern |
| **Listings** | "5 listings · 2 channels" chip |
| **Sync** | rollup pill: uniform → one chip (`Follow`); mixed → `Follow ×4 · Pinned ×1`; `FBA` chip when Amazon-managed anywhere |
| **Pool** | warehouse available — the number the cascade uses (never shown here today) |
| **Drift** | ● amber + count when any listing's live ≠ intended; green check when clean → scan for exceptions at a glance |
| **Buffer / Routed** | max buffer · routed locations |
| **⋯** | per-product bulk menu (tier 2) |

Parent checkbox selects the product's non-FBA listings (tier-2 bulk in one click).

## Toolbar / filters

- **View toggle `Products | Listings`** — the flat control grid stays one tap away (power filtering; keeps the page's identity explicit). Products is the default.
- **Export** and **Import** buttons in the toolbar (tier 3).
- Search hits **name OR SKU** (server-side). Filters: channel/market/mode + **family** facet + **Drift-only** toggle. KPI tiles become **click-to-filter**. Pagination **by product** (children never split a page).

## Research adds (what was missed)

1. **Drift inline** (live≠intended) — the readback story in the grid, not only the upload-vs-pool card.
2. **Live page** — adopt `usePolledList` (30s + invalidation on `stock.adjusted`/`listing.updated`); today it only refreshes after your own actions.
3. **Pool column** — the engine's source number, finally visible.
4. **Per-product all-green check** — exception-scanning, not row-reading.
5. Excel export/import promoted to first-class toolbar actions on the control surface itself (not a separate page you have to remember).

## Phases

- **SCV.1 — server.** `GET /stock/sync-control/products` (grouped: name/image/family/pool/rollup/drift; product-paginated; children in-page ~250 rows so no lazy fetch). Rollup + drift reducers unit-tested.
- **SCV.2 — client.** Product rows + interleaved children on the DataGrid (manual sort, `initialSort` off), ProductCell, rollup chips, parent-selects-children (FBA-excluded via `rowSelectable`), tier-2 per-product actions, view toggle, drift filter, family facet, clickable tiles. Densities/dark kept.
- **SCV.3 — Excel round-trip.** Sync Control export (locked FBA, optional Routes sheet) + import with preview/diff → applier reusing SC.3 primitives + SyncControlAudit; "never writes pool" guarantee test battery.
- **SCV.4 — live + gate.** Polling+invalidation; local preview → both themes/densities → deploy → prod walkthrough incl. one net-zero product-level bulk action AND one net-zero Excel round-trip; docs + memory.

## Guardrails (do not lose control)

Presentation + **reuse of existing guarded write primitives** — no change to the derivation core, action semantics, policies, or FBA guards. **FBA never written** anywhere (actions, per-product bulk, Excel — FBA rows locked). Every change audited + recascaded. **Control sheets never overwrite pool quantity.** Flat "Listings" view preserved. Policies / locations / history / upload-vs-pool cards untouched. Legacy flat-file + existing stock import untouched (Sync Control export/import is a new, dedicated surface).

## Open decisions for the gate

- **D1 — Excel architecture:** dedicated Sync Control import/export (own template + preview, self-contained, leaves the stock wizard alone) vs. extend the existing stock-import wizard's SC.4 columns.
- **D2 — Excel scope:** per-listing mode+pin+buffer only, vs. also routing (a Routes sheet in the same workbook) for full "each and everything" control.
