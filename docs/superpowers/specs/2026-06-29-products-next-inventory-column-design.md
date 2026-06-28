# Editable per-location "Available" column on `/products/next`

- **Date:** 2026-06-29
- **Status:** Approved design, pending spec review
- **Surface:** `/products/next` (the design-system rebuild of `/products`)
- **Scope rule:** Touch **only** the Available column + one additive backend route. No changes to existing columns, the old `/products` page, or `/fulfillment/stock`.

## 1. Goal

The Available column on `/products/next` currently shows a single read-only total
(`totalStock` + "units") with an FBA/FBM hover tooltip. We are replacing it with:

1. An inline **FBA / FBM split** cell (rebuilt in the design system), and
2. A click-to-open **per-location inventory editor modal** wired to the real
   `StockLevel` backbone, so operators can add/edit on-hand stock per location
   directly from the products grid — with FBA read-only.

This mirrors what the old `/products` page offered (the `StockSplit` inline FBM
edit) but goes further: instead of dumping a change into one auto-picked bucket
(`PATCH /api/products/:id/fbm-stock`), the operator edits **each location**
explicitly, against the same audited stock ledger used by `/fulfillment/stock`.

## 2. Current state (researched)

- **Cell:** `AvailableCell` in `apps/web/src/app/products/next/ProductsNextClient.tsx`
  (column def ~line 1153, renderer ~line 524). Shows `totalStock` colored by
  `getStockColor(totalStock, lowStockThreshold)`, with a DS `Tooltip`
  (`FBA x · FBM y`). Built on DS `DataGrid`.
- **Row data:** `ProductRow` (`apps/web/src/app/products/_types.ts`) carries
  `totalStock`, `lowStockThreshold`, optional `fbaStock`/`fbmStock`, plus
  `isParent`, `parentId`, `variantCount`, `childCount`. Supplied by
  `GET /api/products` (FBA/FBM computed from `StockLevel` aggregated by
  `location.type === 'AMAZON_FBA'` vs everything else).
- **Grid:** the new page already lazy-expands parents into child rows via
  `GET /api/products?parentId=...`. Stock is per-leaf.
- **Stock backbone:**
  - `StockLocation` (`WAREHOUSE` | `AMAZON_FBA` | `CHANNEL_RESERVED` | `SHOPIFY_LOCATION`).
  - `StockLevel` (per `productId` × `locationId` × `variationId`): `quantity`,
    `reserved`, `available` (`= quantity - reserved`, DB-enforced).
  - `applyStockMovement` (`apps/api/src/services/stock-movement.service.ts`)
    **upserts** the level (creates if absent), guards `quantity < 0`, writes an
    audited `StockMovement`, and accepts an outer `tx`.
  - `PATCH /api/stock/:id` adjusts one existing level by `change` (delta) with
    reason/notes, and **blocks FBA** with `code: 'FBA_READ_ONLY'`.
  - `GET /api/stock/product/:productId?family=true` returns, for a parent:
    `family.locations[]` (all active locations) and `family.children[]` (each
    child product with `stockLevels[]`: `locationId/locationCode/locationType/quantity/reserved/available`).
  - Locations are managed at **`/fulfillment/stock/locations`** (`GET/POST/PATCH /api/stock/locations`).

### 2.1 Variation model correction (important)

Variations are **child `Product` rows linked by `Product.parentId`** — *not*
`ProductVariation`. The `ProductVariation` table is deprecated and empty (see the
`P.1` note in `stock-movement.service.ts`; it warns and no-ops if a `variationId`
is passed). Therefore:

- Stock attaches to each child product's `productId` with `variationId = null`.
- The parent matrix = **child products (rows) × active locations (columns)**.
- All writes key on `productId` only; `variationId` is omitted everywhere.

## 3. Approved decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Cell display | **FBA + FBM split inline** — two compact color-coded lines (`12 FBA 🔒` / `8 FBM`), tabular-nums, low-stock coloring. Whole cell is a button → opens modal. Parent rows show aggregated FBA/FBM (read-only display). |
| 2 | Edit trigger | **Modal only** (no inline grid editing). |
| 3 | Edit semantics | **Set-to absolute value + reason + optional notes**; delta computed server-side; one audited `StockMovement` per commit. |
| 4 | Modal scope | **Quantity add/edit only.** Transfers/reservations/lots/serials link out to `/fulfillment/stock`. |
| 5 | Parent products | **Variation × location matrix** (variations = rows, locations = columns, non-FBA cells editable). |
| R1 | Shopify locations | **Read-only** (synced from Shopify), shown with a "synced" note. Editable = `WAREHOUSE` + `CHANNEL_RESERVED`. FBA read-only. |
| R2 | Out-of-scope items | As listed in §9 — none pulled into v1. |

## 4. Backend

### 4.1 Read (reuse, no changes)

- **List mode** (standalone product or a single expanded child):
  - `GET /api/stock/product/:productId` → `product.stockLevels[]` (current levels).
  - `GET /api/stock/locations` → active locations for the "+ Add at location" picker.
- **Matrix mode** (parent product):
  - `GET /api/stock/product/:parentId?family=true` → `family.locations[]` (columns)
    + `family.children[]` with `stockLevels[]` (rows + cells). Single request.

### 4.2 Write (new, additive — no schema change)

New route block in `apps/api/src/routes/stock.routes.ts`:

```
POST /api/stock/adjust-location
Body: {
  productId: string,          // the LEAF product id (standalone or child)
  locationId: string,
  value: number,              // absolute new on-hand (integer ≥ 0)
  reason?: string,            // canonical StockMovement reason; default MANUAL_ADJUSTMENT
  notes?: string
}
```

Behaviour (all inside one Prisma transaction for concurrency safety):

1. Load the location's `type`; load the current level for
   `(productId, locationId, variationId=null)` → `{ quantity, reserved }`
   (treat missing as `{ quantity: 0, reserved: 0 }`).
2. **Guards** (return `400` with a `code` + human message):
   - `AMAZON_FBA` → `FBA_READ_ONLY`.
   - `SHOPIFY_LOCATION` → `SHOPIFY_SYNCED_READ_ONLY`.
   - `value` not a finite integer `≥ 0` → `INVALID_VALUE`.
   - `value < reserved` → `BELOW_RESERVED` ("Can't set on-hand below reserved (N)").
3. `change = value - quantity`. If `change === 0` → return `{ ok: true, noop: true }`.
4. Call `applyStockMovement({ productId, locationId, change, reason ?? 'MANUAL_ADJUSTMENT', notes, actor: 'products-grid-location-edit', tx })`.
5. Return `{ ok: true, level: { locationId, quantity, reserved, available }, movement }`
   plus the recomputed product `totalStock`/`fbaStock`/`fbmStock` so the cell can
   reconcile without a full refetch.

The `reason` strings must be drawn from the same canonical set
`applyStockMovement` already accepts (the planner verifies the enum); user-facing
labels map to those values.

## 5. Frontend

All new files under `apps/web/src/app/products/next/`, built from `@/design-system`
(`Modal`, `Tooltip`, `Pill`/primitives, buttons, inputs, `Menu`). They do **not**
import or modify the old page's `_shared/grid-lens/StockSplit`.

### 5.1 `InventoryCell.tsx`

- Props: `{ row: ProductRow; onOpen: (row: ProductRow) => void }`.
- Renders two lines:
  - `fbaStock` + `FBA` + lock icon (read-only marker). Hidden if `fbaStock == null`.
  - `fbmStock` + `FBM`, colored by `getStockColor(fbmStock, lowStockThreshold)`.
  - If neither split is present yet (still loading), fall back to `totalStock` + "units".
- Whole cell is a `button` (keyboard focusable, `aria-label`) → `onOpen(row)`.
- Replaces `AvailableCell` in the column renderer; column width may grow modestly
  (to ~140px) to fit two lines — verified numerically, symmetric insets per the
  spacing rule.

### 5.2 `InventoryEditorModal.tsx`

DS `Modal`. Header: product thumb + name + SKU. Footer: "Manage in Stock →"
(`/fulfillment/stock`) + Close. Decides mode from the row:

- `row.isParent` → **matrix mode**.
- else → **list mode** (standalone product, or a single child opened from an
  expanded grid row).

Shared sub-pieces:

- **`useInventoryEditor(productId, isParent)`** hook: fetches the right endpoint(s),
  holds levels in local state, exposes `commit(productId, locationId, value, reason, notes)`
  which calls `POST /api/stock/adjust-location` with optimistic update + rollback.
- **`LocationQtyInput`**: a cell/row control that shows current on-hand, becomes a
  number input on click, commits on Enter/blur, cancels on Esc. Shows a reason
  `Menu` (default Manual adjustment) + optional notes; spinner while saving;
  error toast on failure. Read-only (lock / "synced") for FBA + Shopify.

#### List mode (standalone / single variation)

Table: `Location | Type badge | On hand (editable) | Reserved | Available`.
A trailing **"+ Add at location ▾"** menu lists active locations without a level;
selecting one adds an editable row initialized at 0 (commit creates the level via
the upserting endpoint). FBA/Shopify rows are read-only.

#### Matrix mode (parent)

- Columns = `family.locations` (location code header; FBA/Shopify columns marked
  read-only). Rows = `family.children` (variation label from SKU/name + thumb).
- Each non-FBA/non-Shopify cell = `LocationQtyInput` (on-hand). FBA/Shopify cells
  render read-only values with lock/synced marker.
- Per-cell hover surfaces `on hand · reserved · available` so the dense grid stays
  readable without three numbers per cell.
- Sticky first column (variation label) + sticky header row for wide matrices.

### 5.3 Wiring in `ProductsNextClient.tsx`

- Add `modalRow` state; `InventoryCell`'s `onOpen` sets it; render
  `<InventoryEditorModal>` when set.
- On successful commit, emit `emitInvalidation({ type: 'stock.adjusted', meta: { productId, source: 'products-next-location-edit' } })` so the grid (and any
  other surface listening, incl. `/fulfillment/stock`) refreshes. The page already
  invalidates on `stock.adjusted`.
- Optimistically patch the affected row's `fbaStock`/`fbmStock`/`totalStock` from
  the endpoint response; the 30s poll / event refresh reconciles.

## 6. Guards & validation (summary)

- FBA: read-only in UI **and** backend (`FBA_READ_ONLY`).
- Shopify locations: read-only in UI **and** backend (`SHOPIFY_SYNCED_READ_ONLY`),
  shown with a "synced from Shopify" note.
- On-hand must be integer ≥ 0 and ≥ that location's current `reserved`.
- All writes go through `applyStockMovement` → negative-quantity guard + audit row
  are inherited for free.

## 7. States & a11y

- Modal: skeleton while loading; error-with-retry; empty state (no active
  locations) → CTA link to `/fulfillment/stock/locations`.
- Optimistic cell update with rollback + DS toast on failure.
- DS `Modal` provides focus trap + Esc. Inputs are labelled; save status announced
  via `aria-live`. Matrix supports tab traversal across cells (arrow-key nav is a
  noted v1.1 nicety, not v1).

## 8. Files

**New (web):**
- `apps/web/src/app/products/next/InventoryCell.tsx`
- `apps/web/src/app/products/next/InventoryEditorModal.tsx`
- `apps/web/src/app/products/next/useInventoryEditor.ts`
- styles appended to `apps/web/src/app/products/next/styles.module.css`

**New (api):**
- `POST /api/stock/adjust-location` route block in
  `apps/api/src/routes/stock.routes.ts` (thin wrapper over `applyStockMovement`).

**Edited (web, surgical):**
- `apps/web/src/app/products/next/ProductsNextClient.tsx` — swap `AvailableCell`
  for `InventoryCell`, add modal state/render, emit `stock.adjusted`. No other
  column or the Product cell is touched.

## 9. Out of scope (v1)

Transfers, reservations, lots, serials, cost layers, channel buffers, bulk import,
Shopify push-back. All remain on `/fulfillment/stock`, reached via the modal's
"Manage in Stock →" link.

## 10. Isolation (concurrent session)

A second Claude session is committing to `main` in parallel. Our file set
(new `products/next` files + one route block) is disjoint. Commit with
`git commit --only <paths>` and watch for index collisions per the
concurrent-sessions playbook.

## 11. Testing

- **Backend:** unit tests for `POST /api/stock/adjust-location` — happy path
  (create-on-add via upsert, set-up, set-down), FBA blocked, Shopify blocked,
  `value < reserved` blocked, `value === quantity` no-op, negative/invalid value.
- **Frontend:** the cell renders FBA/FBM split + falls back to total; modal opens
  in list vs matrix mode by `isParent`; commit calls the endpoint with the right
  body and optimistically updates; FBA/Shopify rows are non-editable; emits
  `stock.adjusted`.
- **Manual (local server):** standalone product edit; parent matrix edit across
  two locations; add stock at a previously-empty location; FBA lock visible;
  cross-check the same numbers on `/fulfillment/stock`.

## 12. Risks / open items

- Reason enum: planner must confirm the exact canonical `StockMovement` reason
  values accepted by `applyStockMovement` and map UI labels to them.
- Matrix width with many locations: sticky first column + horizontal scroll;
  acceptable at the current location count (~handful active).
- Optimistic-update reconciliation relies on the endpoint returning recomputed
  product totals; if that proves heavy, fall back to event-driven refetch only.
