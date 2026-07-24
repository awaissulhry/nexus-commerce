# Sync Control — canonical product grouping (SCD series) — SHIPPING

**Status (2026-07-25):** SCD.1 pool-derived grouping (b130f6207) + SCD.1b unpooled-duplicate stem fallback (9b8b97953) + SCD.3 group bulk + SCD.4 tooltips + SCD.5 live-creation (091525b43, 41d0f3bd4) all shipped. **37 masters → 15 logical products, prod-verified.** SCD.1b was surfaced by the live grid: pool-derivation folds only inventory-POOLED copies; VENTRA/REGAL ALTs are unpooled duplicate listings, so a safe childless-only SKU-stem fallback folds them (a genuinely-different product owns its own children → never childless → never stem-merged). SCD.6 (materialize canonicalMasterId) deferred. Verification + memory pending below.

---

# (original proposal) Sync Control — canonical product grouping (SCD series) — PROPOSAL v2

**Owner (2026-07-22→25):** the products view shows the same physical product as several rows (GALE-JACKET, GALE-JACKET-ALT1/2/3, IT-GALE-JACKET) because each is a separate product record. Collapse the duplicate family into ONE logical row. **Properly wired to the database** (a real relationship, not a render-time regex), **real time** whenever a product is listed on a market/channel or a family is duplicated. Plus **proper tooltips** on every column/element.

**Owner's decisive insight (verified 2026-07-25):** *"only the parent SKUs are different; every other copy of a group shares the same child SKUs."* The data confirms this exactly and it changes the whole design for the better.

## 1. The grouping IS an existing database relationship — the shared-inventory pool

I traced it end to end. A duplicate copy has **no child products of its own** — its eBay listing pools the **canonical's** child SKUs via `SharedListingMembership`:

```
GALE-JACKET-ALT1 (master, 0 children)
  → its ChannelListing.externalListingId = item 256566101420
    → SharedListingMembership(itemId=256566101420, sku=GALE-JACKET-BLACK-MEN-XL)
      → productId = the product GALE-JACKET-BLACK-MEN-XL
        → parentId = GALE-JACKET   ← the canonical master
```

Measured across all **40 masters**: **15 own their children (canonical or standalone) · 19 duplicates resolve to their canonical with certainty via this pool chain · 6 empty orphans** (no listings — never shown in the grid). GALE's 4 duplicates share **20/20** child SKUs with the canonical; AIRMESH's `-ALT1` shares 20/20 — while `AIR-MESH-JACKET-MEN` (its own 6 distinct children, **0 shared**) is correctly a *different* product. **The pool decides, and it's never ambiguous.**

**⇒ Grouping key = the canonical master, derived from the shared pool:**
`canonicalMasterOf(M) = ` if M owns children (or is standalone) → M; else resolve M's listing item-ids → `SharedListingMembership.productId` → that product's `parentId`. Fallback for the rare pool-less duplicate → self (harmless; those have no listings). No regex, no name/ASIN matching, no operator confirmation. This supersedes the v1 stem-regex + operator-review design entirely — the shared pool is a stronger, self-evident signal.

## 2. What exists — how the grid groups today (code map)

- **`GET /stock/sync-control/products`** (sync-control.routes.ts): flat `computeRows()` → per-listing rows carrying the **variant** `productId`; grouped by `masterOf = parentId ?? id`; one row per master with `summarizeProductSync(children)` rollup + variant-derived `poolTotal`/`variantsInStock`/`variantCount`.
- **Aggregation already folds across masters** — `summarizeProductSync`, `poolTotal`, `variantsInStock`, `variantCount`, `children` all fold *whatever rows land in the bucket*. Only the **metadata + identity** assume one master per bucket: `masterId`, `sku`, `name`, `family`, `imageUrl`, the `/products/{id}/edit` links, the `masterIds` bulk expansion (`POST /actions`), and `filterExportRows` (`GET /export`).
- **computeRows already loads all memberships** (the SHARED lane) and the products for `masterOf` — so the canonical-master map can be built in the same pass, cheaply, with no extra round-trips.
- Note: a duplicate master's own listing shows today as a childless "Uncounted · 1 lst" row (what the owner sees); the canonical's variants' memberships already roll up under the canonical. So folding = attach the duplicate's own listing row into the canonical group.
- **Per-product page mutation path is already master-agnostic** (`runAction` sends explicit `listings[]`/`memberships[]`, not `masterId`). Only two editor links + the export are id-coupled.
- **`omitChildrenInList(variantCount>20)`** → big groups show "Open ↗"; merged groups hit it more often (design implication).

## 3. What exists — real-time (audited)

The Sync Control grid is **not** wired for live *creation*: `usePolledList` refreshes on 30s poll + focus + its `invalidationTypes` (`stock.adjusted`/`listing.updated`/`product.updated`) — but **not** `product.created`/`listing.created`, and the page **doesn't mount `useListingEvents`** (the SSE→invalidation bridge other workspaces mount). So a newly-pooled duplicate reaches the grid only on the next 30s poll. **⇒ add those subscriptions + mount the bridge on `SyncControlClient`, and confirm the server emits `listing.created`/`product.created` on the pool-write path** (memberships are the trigger — a duplicate joins its group the moment its listing is pooled).

## 4. The model (properly wired, minimal)

- **Grouping is derived from the live pool relationship** — no fragile field to seed or keep in sync. The endpoint resolves `canonicalMasterId` from `SharedListingMembership` (which already expresses the shared inventory).
- **Optional materialization** — a nullable `Product.canonicalMasterId` (FK, indexed), recomputed when a master's memberships change (pool write), if we later want the relationship queryable outside this endpoint or want to avoid the per-request derivation. **Not required for v1** — deriving live is accurate and self-maintaining. This keeps "properly wired to the database" true (it reads the real pool FKs) while staying additive/reversible.
- **`isCanonicalMaster`** is unnecessary — the canonical is simply the master that owns the child products (has `children`); duplicates have none. The display name/image come from that owning master.

**Endpoint payload** (`ProductMaster` type): row identity = the **canonical master id** (already a real, URL-safe cuid — no encoding gymnastics); add `memberMasterIds: string[]` (the duplicate masters folded in) for bulk/export expansion. `canonicalProductId` = the canonical master id itself (for `/products/{id}/edit`). Rollup/pool/children need **no aggregation change**.

## 5. Phases

- **SCD.1 — pool-derived grouping (server).** In the `/products` endpoint, build `canonicalMasterOf(masterId)` from the membership pool (reuse the memberships computeRows already loaded; one extra `product.findMany({parentId})` pass to know which masters own children). Group by it; canonical master supplies name/image/family; payload gains `memberMasterIds`. Unit-test the pure resolver (owns-children→self; pooled-duplicate→canonical; orphan→self). No schema change.
- **SCD.2 — bulk + export expansion (server).** `POST /actions` and `filterExportRows` accept the canonical master id and expand to **all member masters + their variants** (union the folded duplicates' listings). Raise the action cap. Regression tests (a GALE bulk action must hit the canonical's variants AND the duplicate listings).
- **SCD.3 — the grouped grid (client).** `SyncProductsGrid` + per-product page: identity/selection/detail-URL on the canonical id, `memberMasterIds` for bulk. ~17 rows instead of 37. Densities/dark/truncation kept; screenshot self-verify.
- **SCD.4 — tooltips.** Portal `@/components/ui/Tooltip` (the DS primitive only opens *above* and clips on top grid rows). `DataGrid` `Column.label` is `ReactNode` → tooltips drop into each column's `label` with no DataGrid change; wrap the mode `Pill`s, Open-↗, drift dot. Plain operator-English for every column/element.
- **SCD.5 — real-time.** Add `product.created`/`listing.created`/`*.deleted` to the grid's `invalidationTypes`; mount `useListingEvents()` on `SyncControlClient`; confirm the pool-write path emits a listing/product event. Prove: pool a duplicate family → the grid re-groups live, no manual step.
- **SCD.6 (optional) — materialize `canonicalMasterId`.** Only if per-request derivation proves heavy or another surface needs the relationship: additive FK + recompute-on-membership-write + backfill. Deferred by default.

## 6. Guardrails

Derivation reads the real shared-pool FKs — no heuristic, no auto-merge of distinct products (a different product shares no pool, so it can never be folded in). Additive/reversible only; no product records deleted or merged — the grid *displays* the group as one row while the products stay intact. FBA untouchable everywhere. Flat "Listings" view, policies, routing, Excel round-trip, derivation core untouched.

## 7. Open decisions for the gate

- **D1** — derive the grouping live from the pool (recommended: no migration, self-maintaining, always accurate) vs. materialize `canonicalMasterId` now (SCD.6). Recommend live first.
- **D2** — the 6 pool-less orphans (empty products, no listings, e.g. `GALE-JACKET-FBM`): leave as their own (invisible) groups — they never render in the grid. Confirm that's fine (recommend yes).
- **D3** — canonical display = the child-owning master. Confirm (there's exactly one per group by construction).
