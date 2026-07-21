# Sync Control — product-first control surface (SCV series) — ✅ COMPLETE + PROD-VERIFIED 2026-07-21

**All phases shipped and verified live.** Commits: SCV.1 13a085d81 · SCV.1b de1f3e8c2 · SCV.2 d19e233e3 · SCV.2b 4b11df127 · SCV.3 2ae39f5b5. Prod walkthrough (GALE-JACKET, 41 var / 263 lst): products view showed 37 master rows with real thumbnails, rollup "Follow 171 · FBA 92", stock "675 u · 36/41", drift ● 7, adaptive Open↗/chevron; per-product page rendered the full 263-listing tree; a net-zero Set-Follow returned "updated 0, unchanged 1, FBA skipped 0"; drift ticked 7→5→4 live (polling); Excel export downloaded clean; import preview/apply endpoints live + service round-trip verified on real data. **Runbook: docs/SYNC-CONTROL.md.**

---

# (Original proposal, for reference) Sync Control — product-first control surface (SCV series) — PROPOSAL v2

**Owner (2026-07-21):** the grid alone isn't the point — make it *work* like /products/next (product images, chevrons, grouped rows). "Just reading the SKU list is not really wise." **And** (v2 correction): the product view must carry the FULL control model we built — bulk, import, export, override, Excel round-trip. "I should have proper control over each and everything: Excel imports, exports, all the stuff." Do not lose control; do not forget what the page is for (100% fidelity over what syncs where; FBA untouchable).

## The core problem

Today's grid is **listing-flat**: 1,760 rows for 359 products — every product repeats 4–6× (channel × market × shared listing). You scan SKUs, not products. /products/next already solved this: parent rows (thumbnail + name + chevron), children interleaved on expand, manual sort so groups never scatter. We reuse that shell and change the columns — but the page stays a **control surface**, now product-first.

## Data reality (probed live 2026-07-21 — this shapes the hierarchy)

The 359 productIds behind the rows are **37 masters + 322 variants**. Rolled up to their master (`parentId ?? id`), the whole page becomes **37 master rows**. Distribution is bimodal: ~10 big families carry hundreds of rows (VENTRA = 291 rows across 40 variants; xracing 49 variants; GALE/AIREON/REGAL 40 each), ~27 are simple products (gloves, knee-sliders) with 1–few rows. 66 channel-listing rows sit directly on a master (Amazon variation-parent ASINs). **Stock lives on variants, never the master** — so a single master "pool" number always reads 0; the honest signal is `poolTotal` + `variantsInStock/total` across the master's listed variants (e.g. GALE = 675 units, 36/41 variants in stock). **SCV.1 (server) is built and shipped on this master-grouping.**

## What it must do — three tiers of control (all reuse existing guarded primitives)

### 1. Per-listing (finest — unchanged)
Expand a product → today's listing/membership rows (channel · market · lane+itemId · mode · intended · live · buffer · routed). Select → the same actions (Follow · Pin · Pause · Resume · Zero-pin · Exclude · Include · Buffer) with the same confirms, FBA guards, audit, recascade. The per-listing truth stays authoritative.

### 2. Per-product (new bulk convenience)
Select product row(s) → apply an action to **all of that product's non-FBA listings** at once: "Pause AIREON everywhere," "Buffer 5 on all GALE listings," "Route AIREON to IT + all eBay." Reuses the SC.3 actions endpoint (expand product→listings, FBA excluded server-side). This is the "bulk over what I can see" the owner wants.

### 3. Excel round-trip (the emphasis — extends SC.4 to the full vocabulary)
- **Export** the current (filtered) view to a workbook keyed **per listing** (SKU × channel × market): Product · SKU · Channel · Market · Lane · **Sync mode** (Follow/Pinned/Paused/Excluded) · **Pinned qty** · **Buffer** · Pool available · Intended · Live · Drift. FBA rows exported **locked/read-only** (mode = "Amazon-managed") so a re-import can never touch them. Optional second **Routes** sheet (location → markets) for routing control in Excel.
- **Import** the edited workbook → **preview/diff** (Follow→Paused here; Buffer 0→5 there; FBA rows ignored with a note; malformed cells flagged) → apply atomically → SyncControlAudit (actor `import:<jobId>`) → background recascade. Enforces the SC.4 guarantee: **a control sheet only touches control columns — it never writes pool quantity**, so Amazon/eBay export sheets can't corrupt the pool.
- **Override** = pin a manual quantity (Pin / Zero-pin) or override routing — exposed at all three levels (listing, product, Excel).

## The master row (Level 1 — 37 rows, not 1,760)

| Column | Content |
|---|---|
| **Product** (sticky) | chevron · thumbnail (master image, parent fallback) · name (editor link + "Open" new-tab) · master SKU · family tag — the `ProductCell` pattern |
| **Scope** | "40 variants · 96 listings · 2 channels" chip |
| **Sync** | rollup pill: uniform → one chip (`Follow`); mixed → `Follow ×4 · Pinned ×1`; `FBA` chip when Amazon-managed anywhere |
| **In stock** | `poolTotal` units · `variantsInStock/total` (family-level; the master holds none itself) |
| **Drift** | ● amber + count when any listing's live ≠ intended; green check when clean → scan for exceptions at a glance |
| **Buffer / Routed** | max buffer · routed locations |
| **⋯** | per-master bulk menu (tier 2) |

Master checkbox selects the master's non-FBA listing rows (tier-2 bulk in one click).

### Hierarchy depth — RESOLVED: adaptive by family size (owner, 2026-07-21)

"For 10, 15, 20 variants it's all right [inline]. For more, add a button to open the product-specific page in a new tab where only that product's data is shown — like Amazon." So:

- **Small master (≤ ~20 variants — the ~27 simple products):** chevron **expands inline** to its listing rows (grouped/sorted by variant). Fast, no navigation.
- **Big master (> ~20 variants — the ~10 jacket/suit families, 30–49 variants, up to 291 rows):** **no inline expand.** An **"Open ↗"** button opens a **dedicated per-product page** (`/fulfillment/stock/sync-control/product/[masterId]`) in a new tab — the full control surface scoped to that one product (variants → listings, bulk actions, and its own Excel export/import). Amazon's variation-page pattern.
- Threshold is a tunable constant (default 20 variants). Either way the **master row itself always shows the full rollup/drift/stock** (computed server-side, cheap) — only the *child rows* of big families are deferred to their page.

**Performance:** the list endpoint **omits child rows for big masters** (returns `childrenOmitted: true` + counts instead of 291 rows), so the page payload stays ~small even with the big families present. The dedicated page fetches one master's full tree via `?masterId=`.

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

- **SCV.1 — server. ✅ SHIPPED (13a085d81).** `GET /stock/sync-control/products` master-grouped (image/family/rollup/drift/poolTotal/variantsInStock; children in-payload; master-paginated). Pure `summarizeProductSync` + `marketMatches` unit-tested (7 cases).
- **SCV.1b — server, child-capping.** Add the big-family cap: omit children (return `childrenOmitted: true` + variant/listing counts) when `variantCount > THRESHOLD`; add `?masterId=` to return one master's FULL tree for the dedicated page. Small tweak; unit-test the cap predicate.
- **SCV.2 — main client.** 37 master rows on the DataGrid (manual sort, `initialSort` off), ProductCell (thumbnail/name/family/master-SKU), rollup + drift + in-stock columns, master-selects-children (FBA-excluded via `rowSelectable`), tier-2 per-master bulk actions, **adaptive expand** (inline for small, "Open ↗" for big), `Products | Listings` view toggle, drift filter, family facet, clickable KPI tiles. `usePolledList` for live. Densities/dark kept.
- **SCV.2b — dedicated per-product page.** `/fulfillment/stock/sync-control/product/[masterId]` — master header + variants → listings on the same DataGrid, full bulk actions, and this product's own Excel export/import. Reuses SCV.1 (`?masterId=`) + SC.3 actions. ≤291 rows/page renders fine (no virtualization needed).
- **SCV.3 — Excel round-trip.** Dedicated Sync Control export (locked FBA rows, Listings + Routes sheets — D1=dedicated, D2=incl. routing), page-level AND per-product-scoped; import with preview/diff → applier reusing SC.3 primitives + SyncControlAudit; "never writes pool" guarantee test battery.
- **SCV.4 — live + gate.** Polling+invalidation verified; local preview → both themes/densities → deploy → prod walkthrough incl. a big-family "Open ↗" round-trip, one net-zero master-level bulk action, AND one net-zero Excel round-trip; docs + memory.

## Guardrails (do not lose control)

Presentation + **reuse of existing guarded write primitives** — no change to the derivation core, action semantics, policies, or FBA guards. **FBA never written** anywhere (actions, per-product bulk, Excel — FBA rows locked). Every change audited + recascaded. **Control sheets never overwrite pool quantity.** Flat "Listings" view preserved. Policies / locations / history / upload-vs-pool cards untouched. Legacy flat-file + existing stock import untouched (Sync Control export/import is a new, dedicated surface).

## Open decisions for the gate

- **D1 — Excel architecture:** ✅ dedicated Sync Control import/export (self-contained on the page; stock wizard untouched).
- **D2 — Excel scope:** ✅ everything incl. routing (Listings sheet + Routes sheet in one workbook).
- **D3 — hierarchy depth (SCV.2):** ✅ **adaptive** — inline expand for small masters (≤ ~20 variants); big families get an "Open ↗" button to a dedicated per-product page in a new tab (Amazon variation-page pattern), with the list endpoint omitting their child rows for speed.

_All gate decisions resolved. SCV.1 shipped. Awaiting the owner's go to build SCV.1b → SCV.4._
