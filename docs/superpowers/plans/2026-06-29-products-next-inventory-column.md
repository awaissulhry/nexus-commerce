# Products/Next Editable Per-Location Inventory Column — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the read-only "Available" column on `/products/next` with an inline FBA/FBM split cell that opens a design-system modal for editing on-hand stock per location (list view for standalone products, variation×location matrix for parents), wired to the real `StockLevel` ledger; FBA and Shopify locations stay read-only.

**Architecture:** One additive backend route (`POST /api/stock/adjust-location`) wraps the existing `applyStockMovement` upsert: it reads the location's current on-hand server-side, computes the delta from a requested absolute value, and writes one audited `StockMovement`. The frontend adds a cell component, a data hook, a shared editable quantity control, and a modal — all built from `@/design-system`. Pure logic (validation, view-model building, totals roll-up) is extracted into plain modules and unit-tested; glue/UI is gated on build + manual verification, matching this repo's test conventions.

**Tech Stack:** Fastify + Prisma (apps/api), Next.js 14 App Router + React 18 + CSS Modules + design-system (apps/web), Vitest (pure-logic tests), lucide-react icons.

## Global Constraints

- **Surgical scope:** Only the Available column + the one new backend route. Do **not** modify any other column, the Product cell, the old `/products` page, `/fulfillment/stock`, or the flat-file editors.
- **Design system mandatory:** Modal/grid/primitives come from `@/design-system`. Minor inline controls (number input, reason `<select>`, notes `<input>`) may be native but must use design tokens (`var(--…)`) in CSS — never raw hex/border classes (the `token-guard` P3 check rejects them).
- **Variations = child `Product` rows via `Product.parentId`.** `ProductVariation` is deprecated/empty. Every stock write keys on `productId` only; never pass `variationId`.
- **Read-only locations:** `AMAZON_FBA` and `SHOPIFY_LOCATION` are never editable (UI lock + backend guard). Editable types: `WAREHOUSE`, `CHANNEL_RESERVED`.
- **Canonical reason values:** only `MANUAL_ADJUSTMENT`, `INVENTORY_COUNT`, `WRITE_OFF` (subset of `MovementReason` in `stock-movement.service.ts`). Default `MANUAL_ADJUSTMENT`.
- **ESM imports in apps/api use `.js` extensions** (e.g. `from '../services/foo.js'`).
- **Concurrent session:** another Claude session commits to `main`. Commit only this plan's files with `git commit --only <paths>`; pull --rebase if push is rejected.
- **Emit `stock.adjusted`** after every successful commit so the grid and other surfaces refresh.

---

### Task 1: Backend — pure location-adjustment validator

**Files:**
- Create: `apps/api/src/services/location-adjustment.ts`
- Test: `apps/api/src/services/location-adjustment.vitest.test.ts`

**Interfaces:**
- Produces: `computeLocationAdjustment(input: { locationType: string; currentQuantity: number; currentReserved: number; value: number }): { change: number; noop: false } | { change: 0; noop: true }`; throws `LocationAdjustmentError` with `.code: 'FBA_READ_ONLY' | 'SHOPIFY_SYNCED_READ_ONLY' | 'INVALID_VALUE' | 'BELOW_RESERVED'`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/location-adjustment.vitest.test.ts
import { describe, it, expect } from 'vitest'
import { computeLocationAdjustment, LocationAdjustmentError } from './location-adjustment.js'

const base = { currentQuantity: 10, currentReserved: 2 }

describe('computeLocationAdjustment', () => {
  it('FBA location is read-only', () => {
    expect(() => computeLocationAdjustment({ ...base, locationType: 'AMAZON_FBA', value: 5 }))
      .toThrowError(expect.objectContaining({ code: 'FBA_READ_ONLY' }))
  })

  it('Shopify location is read-only', () => {
    expect(() => computeLocationAdjustment({ ...base, locationType: 'SHOPIFY_LOCATION', value: 5 }))
      .toThrowError(expect.objectContaining({ code: 'SHOPIFY_SYNCED_READ_ONLY' }))
  })

  it('rejects a negative or non-integer value', () => {
    expect(() => computeLocationAdjustment({ ...base, locationType: 'WAREHOUSE', value: -1 }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_VALUE' }))
    expect(() => computeLocationAdjustment({ ...base, locationType: 'WAREHOUSE', value: 3.5 }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_VALUE' }))
  })

  it('rejects setting on-hand below reserved', () => {
    expect(() => computeLocationAdjustment({ ...base, locationType: 'WAREHOUSE', value: 1 }))
      .toThrowError(expect.objectContaining({ code: 'BELOW_RESERVED' }))
  })

  it('returns noop when value equals current quantity', () => {
    expect(computeLocationAdjustment({ ...base, locationType: 'WAREHOUSE', value: 10 }))
      .toEqual({ change: 0, noop: true })
  })

  it('returns a positive delta when increasing', () => {
    expect(computeLocationAdjustment({ ...base, locationType: 'WAREHOUSE', value: 15 }))
      .toEqual({ change: 5, noop: false })
  })

  it('returns a negative delta when decreasing down to reserved', () => {
    expect(computeLocationAdjustment({ ...base, locationType: 'CHANNEL_RESERVED', value: 2 }))
      .toEqual({ change: -8, noop: false })
  })

  it('error is an instanceof LocationAdjustmentError', () => {
    try { computeLocationAdjustment({ ...base, locationType: 'AMAZON_FBA', value: 1 }) }
    catch (e) { expect(e).toBeInstanceOf(LocationAdjustmentError) }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/location-adjustment.vitest.test.ts`
Expected: FAIL — cannot find module `./location-adjustment.js`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/location-adjustment.ts
export type LocationAdjustmentCode =
  | 'FBA_READ_ONLY'
  | 'SHOPIFY_SYNCED_READ_ONLY'
  | 'INVALID_VALUE'
  | 'BELOW_RESERVED'

export class LocationAdjustmentError extends Error {
  code: LocationAdjustmentCode
  constructor(code: LocationAdjustmentCode, message: string) {
    super(message)
    this.name = 'LocationAdjustmentError'
    this.code = code
  }
}

export interface ComputeAdjustmentInput {
  locationType: string
  currentQuantity: number
  currentReserved: number
  /** requested absolute new on-hand */
  value: number
}

/**
 * Pure: validate an absolute on-hand "set" for one location and return the
 * signed delta to apply (or a noop). Read-only location types and invalid
 * inputs throw LocationAdjustmentError so the route can map .code → 400.
 */
export function computeLocationAdjustment(
  input: ComputeAdjustmentInput,
): { change: number; noop: false } | { change: 0; noop: true } {
  const { locationType, currentQuantity, currentReserved, value } = input

  if (locationType === 'AMAZON_FBA') {
    throw new LocationAdjustmentError(
      'FBA_READ_ONLY',
      'FBA stock cannot be edited directly — Amazon is the source of truth.',
    )
  }
  if (locationType === 'SHOPIFY_LOCATION') {
    throw new LocationAdjustmentError(
      'SHOPIFY_SYNCED_READ_ONLY',
      'Shopify location stock is synced from Shopify and is read-only here.',
    )
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new LocationAdjustmentError(
      'INVALID_VALUE',
      'On-hand must be a whole number of 0 or more.',
    )
  }
  if (value < currentReserved) {
    throw new LocationAdjustmentError(
      'BELOW_RESERVED',
      `Can't set on-hand below the ${currentReserved} unit(s) currently reserved.`,
    )
  }
  const change = value - currentQuantity
  if (change === 0) return { change: 0, noop: true }
  return { change, noop: false }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/location-adjustment.vitest.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git commit --only apps/api/src/services/location-adjustment.ts apps/api/src/services/location-adjustment.vitest.test.ts \
  -m "feat(stock): pure location on-hand adjustment validator

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Backend — pure FBA/FBM/total roll-up

**Files:**
- Create: `apps/api/src/services/stock-summary.ts`
- Test: `apps/api/src/services/stock-summary.vitest.test.ts`

**Interfaces:**
- Produces: `summarizeProductStock(levels: Array<{ locationType: string; quantity: number }>): { fbaStock: number; fbmStock: number; totalStock: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/stock-summary.vitest.test.ts
import { describe, it, expect } from 'vitest'
import { summarizeProductStock } from './stock-summary.js'

describe('summarizeProductStock', () => {
  it('splits FBA vs everything-else and totals them', () => {
    expect(summarizeProductStock([
      { locationType: 'AMAZON_FBA', quantity: 12 },
      { locationType: 'WAREHOUSE', quantity: 5 },
      { locationType: 'CHANNEL_RESERVED', quantity: 3 },
      { locationType: 'SHOPIFY_LOCATION', quantity: 2 },
    ])).toEqual({ fbaStock: 12, fbmStock: 10, totalStock: 22 })
  })

  it('returns zeros for no levels', () => {
    expect(summarizeProductStock([])).toEqual({ fbaStock: 0, fbmStock: 0, totalStock: 0 })
  })

  it('handles FBA-only', () => {
    expect(summarizeProductStock([{ locationType: 'AMAZON_FBA', quantity: 7 }]))
      .toEqual({ fbaStock: 7, fbmStock: 0, totalStock: 7 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/stock-summary.vitest.test.ts`
Expected: FAIL — cannot find module `./stock-summary.js`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/stock-summary.ts
export interface SummaryLevel {
  locationType: string
  quantity: number
}

/**
 * Pure: roll StockLevel rows into the FBA / FBM / total split the products
 * grid shows. FBM = the sum of every location that isn't AMAZON_FBA, matching
 * GET /api/products' own aggregation.
 */
export function summarizeProductStock(levels: SummaryLevel[]): {
  fbaStock: number
  fbmStock: number
  totalStock: number
} {
  let fba = 0
  let fbm = 0
  for (const l of levels) {
    if (l.locationType === 'AMAZON_FBA') fba += l.quantity
    else fbm += l.quantity
  }
  return { fbaStock: fba, fbmStock: fbm, totalStock: fba + fbm }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/stock-summary.vitest.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git commit --only apps/api/src/services/stock-summary.ts apps/api/src/services/stock-summary.vitest.test.ts \
  -m "feat(stock): pure FBA/FBM/total roll-up helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Backend — `POST /api/stock/adjust-location` route

**Files:**
- Modify: `apps/api/src/routes/stock.routes.ts` (add imports near the top with the other service imports; add the route block just after the existing `fastify.patch('/stock/:id', …)` handler, ~line 2864)

**Interfaces:**
- Consumes: `computeLocationAdjustment`, `LocationAdjustmentError` (Task 1); `summarizeProductStock` (Task 2); existing `applyStockMovement` (already imported in this file).
- Produces: `POST /api/stock/adjust-location` body `{ productId: string; locationId: string; value: number; reason?: string; notes?: string }` → `200 { ok: true; noop: boolean; movement: unknown | null; totals: { fbaStock: number; fbmStock: number; totalStock: number } }`, or `400/404 { error: string; code?: string }`.

- [ ] **Step 1: Add the service imports**

At the top of `apps/api/src/routes/stock.routes.ts`, beside the existing `import { applyStockMovement, … } from '../services/stock-movement.service.js'`, add:

```ts
import { computeLocationAdjustment, LocationAdjustmentError } from '../services/location-adjustment.js'
import { summarizeProductStock } from '../services/stock-summary.js'
```

- [ ] **Step 2: Add the route handler (after the `PATCH /stock/:id` block)**

```ts
  // ── POST /api/stock/adjust-location ─────────────────────────────
  // Set a product's absolute on-hand at ONE location from the products
  // grid. Reads the current level server-side, derives the delta, and
  // writes one audited StockMovement via applyStockMovement (which
  // upserts, so a location with no level yet is created). FBA + Shopify
  // are read-only. Keyed on productId only (variations are child
  // Product rows; ProductVariation is deprecated).
  fastify.post('/stock/adjust-location', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        productId?: string
        locationId?: string
        value?: number
        reason?: string
        notes?: string
      }
      const productId = typeof body.productId === 'string' ? body.productId : ''
      const locationId = typeof body.locationId === 'string' ? body.locationId : ''
      const value = Number(body.value)
      if (!productId || !locationId) {
        return reply.code(400).send({ error: 'productId and locationId are required', code: 'MISSING_FIELDS' })
      }

      const ALLOWED_REASONS = ['MANUAL_ADJUSTMENT', 'INVENTORY_COUNT', 'WRITE_OFF']
      const reason = ALLOWED_REASONS.includes(body.reason ?? '')
        ? (body.reason as 'MANUAL_ADJUSTMENT' | 'INVENTORY_COUNT' | 'WRITE_OFF')
        : 'MANUAL_ADJUSTMENT'

      const location = await prisma.stockLocation.findUnique({
        where: { id: locationId },
        select: { type: true },
      })
      if (!location) return reply.code(404).send({ error: 'Location not found', code: 'NO_LOCATION' })

      // Fresh server-side read → delta derived here, never from the client.
      const existing = await prisma.stockLevel.findFirst({
        where: { locationId, productId, variationId: null },
        select: { quantity: true, reserved: true },
      })
      const currentQuantity = existing?.quantity ?? 0
      const currentReserved = existing?.reserved ?? 0

      const adj = computeLocationAdjustment({
        locationType: location.type,
        currentQuantity,
        currentReserved,
        value,
      })

      let movement: unknown = null
      if (!adj.noop) {
        movement = await applyStockMovement({
          productId,
          locationId,
          change: adj.change,
          reason,
          notes: body.notes,
          actor: 'products-grid-location-edit',
        })
      }

      // Recompute the product's split so the grid cell can reconcile.
      const levels = await prisma.stockLevel.findMany({
        where: { productId },
        select: { quantity: true, location: { select: { type: true } } },
      })
      const totals = summarizeProductStock(
        levels.map((l) => ({ locationType: l.location.type, quantity: l.quantity })),
      )

      return { ok: true, noop: adj.noop, movement, totals }
    } catch (error: any) {
      if (error instanceof LocationAdjustmentError) {
        return reply.code(400).send({ error: error.message, code: error.code })
      }
      fastify.log.error({ err: error }, '[stock/adjust-location] failed')
      return reply.code(400).send({ error: error?.message ?? String(error) })
    }
  })
```

> Note: absolute-set under simultaneous edits to the *same* (product, location) can lose an update — identical to the existing `PATCH /api/products/:id/fbm-stock` behavior and acceptable at this app's single-operator scale. Not adding serializable isolation in v1 to avoid nesting side effects inside `applyStockMovement`'s own transaction/cascade.

- [ ] **Step 3: Verify the API builds**

Run: `cd apps/api && npm run build`
Expected: build passes (no TS errors).

- [ ] **Step 4: Manual smoke test against the local server**

Get a real warehouse location id and a leaf product id, then exercise the endpoint:

```bash
# A warehouse (editable) location id:
curl -s localhost:3001/api/stock/locations | npx --yes json -a locations | grep -i warehouse  # note an id of type WAREHOUSE
# A leaf product id (parentId not null, or a standalone) — pick one from:
curl -s 'localhost:3001/api/products?limit=5' | npx --yes json products | head

# Set on-hand to 15 at that location (replace IDs):
curl -s -X POST localhost:3001/api/stock/adjust-location \
  -H 'Content-Type: application/json' \
  -d '{"productId":"<LEAF_ID>","locationId":"<WAREHOUSE_ID>","value":15,"reason":"INVENTORY_COUNT","notes":"plan smoke test"}'
```

Expected JSON: `{ "ok": true, "noop": false, "movement": { … }, "totals": { "fbaStock": …, "fbmStock": …, "totalStock": … } }`.
Then confirm rejection paths return `400` with a `code`:
- FBA location id → `code: "FBA_READ_ONLY"`.
- `"value": -1` → `code: "INVALID_VALUE"`.

(If the API port differs, use the value from `getBackendUrl()` / `.env`.)

- [ ] **Step 5: Commit**

```bash
git commit --only apps/api/src/routes/stock.routes.ts \
  -m "feat(stock): POST /api/stock/adjust-location for per-location on-hand edits

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Frontend — pure inventory-editor logic

**Files:**
- Create: `apps/web/src/app/products/next/inventoryEditor.logic.ts`
- Test: `apps/web/src/app/products/next/inventoryEditor.logic.vitest.test.ts`

**Interfaces:**
- Produces:
  - `isLocationEditable(type: string): boolean`
  - `getStockColor(qty: number, threshold: number): string`
  - `REASON_OPTIONS: ReadonlyArray<{ value: string; label: string }>`, `DEFAULT_REASON: string`
  - `interface LevelCell { locationId; locationCode; locationName; locationType; quantity; reserved; available; editable }`
  - `buildListModel(levels: RawListLevel[], activeLocations: RawLocation[]): LevelCell[]`
  - `interface MatrixModel { columns: Array<{ locationId; locationCode; locationType; editable }>; rows: Array<{ productId; sku; name; thumbnailUrl; cells: Record<string, { quantity; reserved; available }> }> }`
  - `buildMatrixModel(locations: RawLocation[], children: RawFamilyChild[]): MatrixModel`
  - `editorModeForRow(row: { isParent: boolean }): 'matrix' | 'list'`
  - exported raw types `RawListLevel`, `RawLocation`, `RawFamilyChild`, `RawFamilyChildLevel`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/app/products/next/inventoryEditor.logic.vitest.test.ts
import { describe, it, expect } from 'vitest'
import {
  isLocationEditable, buildListModel, buildMatrixModel, editorModeForRow,
  REASON_OPTIONS, DEFAULT_REASON,
} from './inventoryEditor.logic'

describe('isLocationEditable', () => {
  it('warehouse and channel-reserved are editable', () => {
    expect(isLocationEditable('WAREHOUSE')).toBe(true)
    expect(isLocationEditable('CHANNEL_RESERVED')).toBe(true)
  })
  it('FBA and Shopify are not editable', () => {
    expect(isLocationEditable('AMAZON_FBA')).toBe(false)
    expect(isLocationEditable('SHOPIFY_LOCATION')).toBe(false)
  })
})

describe('reason options', () => {
  it('exposes exactly the three canonical reasons with a sane default', () => {
    expect(REASON_OPTIONS.map((r) => r.value)).toEqual(['MANUAL_ADJUSTMENT', 'INVENTORY_COUNT', 'WRITE_OFF'])
    expect(DEFAULT_REASON).toBe('MANUAL_ADJUSTMENT')
  })
})

describe('buildListModel', () => {
  const locations = [
    { id: 'L1', code: 'IT-MAIN', name: 'Italy Main', type: 'WAREHOUSE' },
    { id: 'L2', code: 'AMZ-FBA', name: 'Amazon FBA', type: 'AMAZON_FBA' },
    { id: 'L3', code: 'SHOP', name: 'Shopify', type: 'SHOPIFY_LOCATION' },
  ]
  it('merges existing levels and fills missing locations with editable 0-rows', () => {
    const levels = [{ location: locations[0], quantity: 8, reserved: 2, available: 6 }]
    const model = buildListModel(levels, locations)
    expect(model).toHaveLength(3)
    expect(model[0]).toMatchObject({ locationId: 'L1', quantity: 8, reserved: 2, available: 6, editable: true })
    expect(model[1]).toMatchObject({ locationId: 'L2', quantity: 0, editable: false }) // FBA, no level
    expect(model[2]).toMatchObject({ locationId: 'L3', quantity: 0, editable: false }) // Shopify
  })
})

describe('buildMatrixModel', () => {
  const locations = [
    { id: 'L1', code: 'IT-MAIN', name: 'Italy Main', type: 'WAREHOUSE' },
    { id: 'L2', code: 'AMZ-FBA', name: 'Amazon FBA', type: 'AMAZON_FBA' },
  ]
  const children = [
    { id: 'C1', sku: 'JKT-RED-M', name: 'Red / M', thumbnailUrl: null, stockLevels: [
      { locationId: 'L1', locationCode: 'IT-MAIN', locationType: 'WAREHOUSE', quantity: 6, reserved: 1, available: 5 },
      { locationId: 'L2', locationCode: 'AMZ-FBA', locationType: 'AMAZON_FBA', quantity: 8, reserved: 0, available: 8 },
    ] },
    { id: 'C2', sku: 'JKT-RED-L', name: 'Red / L', thumbnailUrl: null, stockLevels: [] },
  ]
  it('builds columns from locations and cells keyed by locationId', () => {
    const m = buildMatrixModel(locations, children)
    expect(m.columns.map((c) => c.locationId)).toEqual(['L1', 'L2'])
    expect(m.columns[1]).toMatchObject({ locationType: 'AMAZON_FBA', editable: false })
    expect(m.rows[0].cells['L1']).toEqual({ quantity: 6, reserved: 1, available: 5 })
    expect(m.rows[1].cells['L1']).toBeUndefined() // C2 has no level at L1 yet
  })
})

describe('editorModeForRow', () => {
  it('parents → matrix, leaves → list', () => {
    expect(editorModeForRow({ isParent: true })).toBe('matrix')
    expect(editorModeForRow({ isParent: false })).toBe('list')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/app/products/next/inventoryEditor.logic.vitest.test.ts`
Expected: FAIL — cannot find module `./inventoryEditor.logic`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/app/products/next/inventoryEditor.logic.ts

/** Location types whose stock we never let the operator edit from the grid. */
export const READONLY_LOCATION_TYPES = new Set(['AMAZON_FBA', 'SHOPIFY_LOCATION'])

export function isLocationEditable(type: string): boolean {
  return !READONLY_LOCATION_TYPES.has(type)
}

export const REASON_OPTIONS = [
  { value: 'MANUAL_ADJUSTMENT', label: 'Manual adjustment' },
  { value: 'INVENTORY_COUNT', label: 'Inventory count' },
  { value: 'WRITE_OFF', label: 'Write-off / damage' },
] as const

export const DEFAULT_REASON = 'MANUAL_ADJUSTMENT'

/** Low-stock → status color token; mirrors the grid cell coloring. */
export function getStockColor(qty: number, threshold: number): string {
  if (qty === 0) return 'var(--status-danger-line)'
  if (qty <= threshold) return 'var(--status-warning-line)'
  return 'var(--status-success-line)'
}

export interface LevelCell {
  locationId: string
  locationCode: string
  locationName: string
  locationType: string
  quantity: number
  reserved: number
  available: number
  editable: boolean
}

export interface RawListLevel {
  location: { id: string; code: string; name: string; type: string }
  quantity: number
  reserved: number
  available: number
}
export interface RawLocation {
  id: string
  code: string
  name: string
  type: string
}

/** List mode: merge a product's existing levels with the full active-location
 *  list so locations without a level still appear (as editable 0-rows for
 *  editable types — that is the "add at location" affordance). */
export function buildListModel(levels: RawListLevel[], activeLocations: RawLocation[]): LevelCell[] {
  const byId = new Map(levels.map((l) => [l.location.id, l]))
  return activeLocations.map((loc) => {
    const lv = byId.get(loc.id)
    return {
      locationId: loc.id,
      locationCode: loc.code,
      locationName: loc.name,
      locationType: loc.type,
      quantity: lv?.quantity ?? 0,
      reserved: lv?.reserved ?? 0,
      available: lv?.available ?? 0,
      editable: isLocationEditable(loc.type),
    }
  })
}

export interface RawFamilyChildLevel {
  locationId: string
  locationCode: string
  locationType: string
  quantity: number
  reserved: number
  available: number
}
export interface RawFamilyChild {
  id: string
  sku: string
  name: string
  thumbnailUrl: string | null
  stockLevels: RawFamilyChildLevel[]
}
export interface MatrixModel {
  columns: Array<{ locationId: string; locationCode: string; locationType: string; editable: boolean }>
  rows: Array<{
    productId: string
    sku: string
    name: string
    thumbnailUrl: string | null
    cells: Record<string, { quantity: number; reserved: number; available: number }>
  }>
}

/** Matrix mode: child products (variations) as rows × active locations as columns. */
export function buildMatrixModel(locations: RawLocation[], children: RawFamilyChild[]): MatrixModel {
  const columns = locations.map((loc) => ({
    locationId: loc.id,
    locationCode: loc.code,
    locationType: loc.type,
    editable: isLocationEditable(loc.type),
  }))
  const rows = children.map((c) => {
    const cells: MatrixModel['rows'][number]['cells'] = {}
    for (const sl of c.stockLevels) {
      cells[sl.locationId] = { quantity: sl.quantity, reserved: sl.reserved, available: sl.available }
    }
    return { productId: c.id, sku: c.sku, name: c.name, thumbnailUrl: c.thumbnailUrl, cells }
  })
  return { columns, rows }
}

export function editorModeForRow(row: { isParent: boolean }): 'matrix' | 'list' {
  return row.isParent ? 'matrix' : 'list'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/app/products/next/inventoryEditor.logic.vitest.test.ts`
Expected: PASS (all describes green).

- [ ] **Step 5: Commit**

```bash
git commit --only apps/web/src/app/products/next/inventoryEditor.logic.ts apps/web/src/app/products/next/inventoryEditor.logic.vitest.test.ts \
  -m "feat(products-next): pure inventory-editor view-model logic

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Frontend — `useInventoryEditor` data hook

**Files:**
- Create: `apps/web/src/app/products/next/useInventoryEditor.ts`

**Interfaces:**
- Consumes: `buildListModel`, `buildMatrixModel`, `LevelCell`, `MatrixModel`, `RawLocation` (Task 4); `getBackendUrl` (`@/lib/backend-url`); `emitInvalidation` (`@/lib/sync/invalidation-channel`).
- Produces: `useInventoryEditor(productId: string | null, mode: 'list' | 'matrix')` → `{ loading: boolean; error: string | null; list: LevelCell[] | null; matrix: MatrixModel | null; reload: () => Promise<void>; commit: (a: { productId: string; locationId: string; value: number; reason: string; notes?: string }) => Promise<{ ok: boolean; error?: string }> }`.

- [ ] **Step 1: Write the implementation**

```ts
// apps/web/src/app/products/next/useInventoryEditor.ts
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import {
  buildListModel, buildMatrixModel,
  type LevelCell, type MatrixModel, type RawLocation,
} from './inventoryEditor.logic'

type Mode = 'list' | 'matrix'

interface State {
  loading: boolean
  error: string | null
  list: LevelCell[] | null
  matrix: MatrixModel | null
}

const EMPTY: State = { loading: false, error: null, list: null, matrix: null }

export function useInventoryEditor(productId: string | null, mode: Mode) {
  const [state, setState] = useState<State>(EMPTY)
  const reqId = useRef(0)

  const load = useCallback(async () => {
    if (!productId) {
      setState(EMPTY)
      return
    }
    const my = ++reqId.current
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const base = getBackendUrl()
      if (mode === 'matrix') {
        const res = await fetch(`${base}/api/stock/product/${productId}?family=true`, { cache: 'no-store' })
        if (!res.ok) throw new Error(`Failed to load (${res.status})`)
        const data = await res.json()
        if (!data.family) throw new Error('No variation data for this product.')
        const matrix = buildMatrixModel(data.family.locations as RawLocation[], data.family.children)
        if (my === reqId.current) setState({ loading: false, error: null, list: null, matrix })
      } else {
        const [pRes, lRes] = await Promise.all([
          fetch(`${base}/api/stock/product/${productId}`, { cache: 'no-store' }),
          fetch(`${base}/api/stock/locations`, { cache: 'no-store' }),
        ])
        if (!pRes.ok) throw new Error(`Failed to load product (${pRes.status})`)
        if (!lRes.ok) throw new Error(`Failed to load locations (${lRes.status})`)
        const pData = await pRes.json()
        const lData = await lRes.json()
        const active = (lData.locations as Array<RawLocation & { isActive: boolean }>).filter((l) => l.isActive)
        const list = buildListModel(pData.stockLevels, active)
        if (my === reqId.current) setState({ loading: false, error: null, list, matrix: null })
      }
    } catch (e: any) {
      if (my === reqId.current) setState({ loading: false, error: e?.message ?? 'Failed to load', list: null, matrix: null })
    }
  }, [productId, mode])

  useEffect(() => { void load() }, [load])

  const commit = useCallback(
    async (args: { productId: string; locationId: string; value: number; reason: string; notes?: string }) => {
      try {
        const res = await fetch(`${getBackendUrl()}/api/stock/adjust-location`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) return { ok: false as const, error: data?.error ?? `Save failed (${res.status})` }
        emitInvalidation({ type: 'stock.adjusted', meta: { productId: args.productId, source: 'products-next-location-edit' } })
        await load()
        return { ok: true as const }
      } catch (e: any) {
        return { ok: false as const, error: e?.message ?? 'Save failed' }
      }
    },
    [load],
  )

  return { ...state, reload: load, commit }
}
```

- [ ] **Step 2: Verify the web build / types**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "useInventoryEditor\|inventoryEditor.logic" || echo "no type errors in new files"`
Expected: `no type errors in new files`.

- [ ] **Step 3: Commit**

```bash
git commit --only apps/web/src/app/products/next/useInventoryEditor.ts \
  -m "feat(products-next): useInventoryEditor data hook (fetch + commit)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Frontend — `InventoryCell` + styles

**Files:**
- Create: `apps/web/src/app/products/next/InventoryCell.tsx`
- Modify: `apps/web/src/app/products/next/styles.module.css` (append cell classes)

**Interfaces:**
- Consumes: `getStockColor` (Task 4); `ProductRow` (`../_types`).
- Produces: `<InventoryCell row={ProductRow} onOpen={(row: ProductRow) => void} />`.

- [ ] **Step 1: Write the component**

```tsx
// apps/web/src/app/products/next/InventoryCell.tsx
'use client'

import { Lock } from 'lucide-react'
import type { ProductRow } from '../_types'
import { getStockColor } from './inventoryEditor.logic'
import styles from './styles.module.css'

/** Available column cell: FBA (read-only, lock) over FBM (color-coded). Whole
 *  cell is a button that opens the per-location inventory editor. */
export function InventoryCell({ row, onOpen }: { row: ProductRow; onOpen: (row: ProductRow) => void }) {
  const hasSplit = row.fbaStock != null || row.fbmStock != null
  return (
    <button
      type="button"
      className={styles.invCellBtn}
      onClick={() => onOpen(row)}
      aria-label={`Edit inventory for ${row.name}`}
    >
      <span className={styles.invSplit}>
        {hasSplit ? (
          <>
            <span className={styles.invLine}>
              <span className={styles.invNum}>{row.fbaStock ?? 0}</span>
              <span className={styles.invTag}>FBA</span>
              <Lock size={10} className={styles.invLock} aria-label="Amazon-managed, read-only" />
            </span>
            <span className={styles.invLine}>
              <span className={styles.invNum} style={{ color: getStockColor(row.fbmStock ?? 0, row.lowStockThreshold) }}>
                {row.fbmStock ?? 0}
              </span>
              <span className={styles.invTag}>FBM</span>
            </span>
          </>
        ) : (
          <span className={styles.invLine}>
            <span className={styles.invNum} style={{ color: getStockColor(row.totalStock, row.lowStockThreshold) }}>
              {row.totalStock}
            </span>
            <span className={styles.invTag}>units</span>
          </span>
        )}
      </span>
    </button>
  )
}
```

- [ ] **Step 2: Append the styles**

Append to `apps/web/src/app/products/next/styles.module.css`:

```css
.invCellBtn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  padding: 2px 4px;
  background: none;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
}
.invCellBtn:hover {
  background: var(--surface-hover);
}
.invCellBtn:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}
.invSplit {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.invLine {
  display: flex;
  align-items: center;
  gap: 4px;
}
.invNum {
  font-variant-numeric: tabular-nums;
  font-weight: 680;
}
.invTag {
  color: var(--text-tertiary);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.invLock {
  color: var(--text-tertiary);
}
```

> If `--surface-hover` / `--border-focus` are not defined tokens in this app, substitute the nearest existing token used elsewhere in `styles.module.css` (check the file's other `:hover`/`:focus-visible` rules) — do not introduce raw colors.

- [ ] **Step 3: Verify build + token guard**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | grep -i InventoryCell || echo "InventoryCell types OK"`
Then from repo root: `node apps/web/src/design-system/tools/token-guard.mjs 2>&1 | tail -3` (or the project's documented token-guard command).
Expected: types OK; token-guard passes.

- [ ] **Step 4: Commit**

```bash
git commit --only apps/web/src/app/products/next/InventoryCell.tsx apps/web/src/app/products/next/styles.module.css \
  -m "feat(products-next): InventoryCell FBA/FBM split (opens editor)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Frontend — `LocationQtyInput` editable control + styles

**Files:**
- Create: `apps/web/src/app/products/next/LocationQtyInput.tsx`
- Modify: `apps/web/src/app/products/next/styles.module.css` (append input classes)

**Interfaces:**
- Produces: `<LocationQtyInput value={number} reserved={number} editable={boolean} locationType={string} saving={boolean} onCommit={(value: number) => void} />`. Read-only types render the number plus a lock (FBA) or "synced" (Shopify) marker; editable types render a click-to-edit number `<input>` committing on Enter/blur, cancelling on Esc. Reason/notes are owned by the modal (Task 8), so this control only emits the new absolute value.

- [ ] **Step 1: Write the component**

```tsx
// apps/web/src/app/products/next/LocationQtyInput.tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import { Lock, Loader2 } from 'lucide-react'
import styles from './styles.module.css'

export function LocationQtyInput({
  value,
  reserved,
  editable,
  locationType,
  saving,
  onCommit,
}: {
  value: number
  reserved: number
  editable: boolean
  locationType: string
  saving: boolean
  onCommit: (value: number) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(value))
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) setDraft(String(value))
  }, [value, editing])

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  if (!editable) {
    return (
      <span className={styles.invRoLevel} title={`${value} on hand · ${reserved} reserved`}>
        <span className={styles.invNum}>{value}</span>
        {locationType === 'AMAZON_FBA' ? (
          <Lock size={11} className={styles.invLock} aria-label="Amazon-managed, read-only" />
        ) : (
          <span className={styles.invSynced}>synced</span>
        )}
      </span>
    )
  }

  const commit = () => {
    setEditing(false)
    const n = Number(draft)
    if (Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n !== value) onCommit(n)
    else setDraft(String(value))
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="number"
        min={0}
        className={styles.invQtyInput}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') { setDraft(String(value)); setEditing(false) }
        }}
        aria-label="On-hand quantity"
      />
    )
  }

  return (
    <button
      type="button"
      className={styles.invQtyBtn}
      onClick={() => setEditing(true)}
      title={`${value} on hand · ${reserved} reserved`}
      disabled={saving}
    >
      <span className={styles.invNum}>{value}</span>
      {saving && <Loader2 size={11} className={styles.invSpin} aria-label="Saving" />}
    </button>
  )
}
```

- [ ] **Step 2: Append the styles**

Append to `apps/web/src/app/products/next/styles.module.css`:

```css
.invRoLevel { display: inline-flex; align-items: center; gap: 4px; }
.invSynced { color: var(--text-tertiary); font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
.invQtyBtn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 6px; min-width: 40px;
  background: var(--surface-subtle); border: 1px solid var(--border-subtle);
  border-radius: 6px; cursor: pointer; font-variant-numeric: tabular-nums;
}
.invQtyBtn:hover { border-color: var(--border-strong); }
.invQtyBtn:disabled { opacity: 0.6; cursor: default; }
.invQtyInput {
  width: 56px; padding: 2px 6px;
  background: var(--surface-base); border: 1px solid var(--border-focus);
  border-radius: 6px; font-variant-numeric: tabular-nums;
}
.invSpin { color: var(--text-tertiary); animation: invspin 0.8s linear infinite; }
@keyframes invspin { to { transform: rotate(360deg); } }
```

> Same token note as Task 6 — if any `--surface-*` / `--border-*` token name doesn't exist, swap for the nearest one already used in this CSS module; never hardcode colors.

- [ ] **Step 3: Verify build**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | grep -i LocationQtyInput || echo "LocationQtyInput types OK"`
Expected: `LocationQtyInput types OK`.

- [ ] **Step 4: Commit**

```bash
git commit --only apps/web/src/app/products/next/LocationQtyInput.tsx apps/web/src/app/products/next/styles.module.css \
  -m "feat(products-next): LocationQtyInput editable on-hand control

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Frontend — `InventoryEditorModal` (list + matrix) + styles

**Files:**
- Create: `apps/web/src/app/products/next/InventoryEditorModal.tsx`
- Modify: `apps/web/src/app/products/next/styles.module.css` (append modal/table/matrix classes)

**Interfaces:**
- Consumes: `Modal` (`@/design-system/components`); `useInventoryEditor` (Task 5); `LocationQtyInput` (Task 7); `editorModeForRow`, `REASON_OPTIONS`, `DEFAULT_REASON` (Task 4); `ProductRow` (`../_types`).
- Produces: `<InventoryEditorModal row={ProductRow | null} onClose={() => void} />`.

- [ ] **Step 1: Write the component**

```tsx
// apps/web/src/app/products/next/InventoryEditorModal.tsx
'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Modal } from '@/design-system/components'
import type { ProductRow } from '../_types'
import { useInventoryEditor } from './useInventoryEditor'
import { LocationQtyInput } from './LocationQtyInput'
import { editorModeForRow, REASON_OPTIONS, DEFAULT_REASON } from './inventoryEditor.logic'
import styles from './styles.module.css'

export function InventoryEditorModal({ row, onClose }: { row: ProductRow | null; onClose: () => void }) {
  const open = row != null
  const mode = row ? editorModeForRow(row) : 'list'
  const { loading, error, list, matrix, commit, reload } = useInventoryEditor(row?.id ?? null, mode)

  const [reason, setReason] = useState<string>(DEFAULT_REASON)
  const [notes, setNotes] = useState('')
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const doCommit = async (productId: string, locationId: string, value: number) => {
    const key = `${productId}:${locationId}`
    setSavingKey(key)
    setToast(null)
    const r = await commit({ productId, locationId, value, reason, notes: notes || undefined })
    setSavingKey(null)
    if (!r.ok) setToast(r.error ?? 'Save failed')
  }

  const header = useMemo(() => (
    <div className={styles.invModalHead}>
      <div className={styles.invReasonRow}>
        <label className={styles.invReasonLabel}>
          Reason
          <select className={styles.invReasonSelect} value={reason} onChange={(e) => setReason(e.target.value)}>
            {REASON_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <input
          className={styles.invNotesInput}
          placeholder="Notes (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          aria-label="Adjustment notes"
        />
      </div>
      {toast && <div className={styles.invToast} role="alert">{toast}</div>}
    </div>
  ), [reason, notes, toast])

  const footer = (
    <div className={styles.invModalFoot}>
      <Link href="/fulfillment/stock" className={styles.invManageLink} target="_blank" rel="noopener noreferrer">
        Manage in Stock →
      </Link>
      <button type="button" className={styles.invCloseBtn} onClick={onClose}>Close</button>
    </div>
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      size={mode === 'matrix' ? 'xl' : 'md'}
      title={row ? row.name : 'Inventory'}
      subtitle={row?.sku}
      footer={footer}
    >
      {header}

      {loading && <div className={styles.invState}>Loading inventory…</div>}

      {!loading && error && (
        <div className={styles.invState}>
          <p>{error}</p>
          <button type="button" className={styles.invRetryBtn} onClick={() => void reload()}>Retry</button>
        </div>
      )}

      {!loading && !error && mode === 'list' && list && (
        list.length === 0 ? (
          <div className={styles.invState}>
            <p>No active locations yet.</p>
            <Link href="/fulfillment/stock/locations" className={styles.invManageLink} target="_blank" rel="noopener noreferrer">
              Create a location →
            </Link>
          </div>
        ) : (
          <table className={styles.invTable}>
            <thead>
              <tr>
                <th>Location</th><th>On hand</th><th>Reserved</th><th>Available</th>
              </tr>
            </thead>
            <tbody>
              {list.map((lv) => (
                <tr key={lv.locationId}>
                  <td>
                    <span className={styles.invLocCode}>{lv.locationCode}</span>
                    <span className={styles.invLocType}>{lv.locationType.replace(/_/g, ' ').toLowerCase()}</span>
                  </td>
                  <td>
                    <LocationQtyInput
                      value={lv.quantity}
                      reserved={lv.reserved}
                      editable={lv.editable}
                      locationType={lv.locationType}
                      saving={savingKey === `${row!.id}:${lv.locationId}`}
                      onCommit={(v) => doCommit(row!.id, lv.locationId, v)}
                    />
                  </td>
                  <td className={styles.invNum}>{lv.reserved}</td>
                  <td className={styles.invNum}>{lv.available}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {!loading && !error && mode === 'matrix' && matrix && (
        <div className={styles.invMatrixWrap}>
          <table className={styles.invMatrix}>
            <thead>
              <tr>
                <th className={styles.invMatrixCorner}>Variation</th>
                {matrix.columns.map((c) => (
                  <th key={c.locationId}>{c.locationCode}{!c.editable && ' 🔒'}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((r) => (
                <tr key={r.productId}>
                  <td className={styles.invMatrixRowHead}>{r.name || r.sku}</td>
                  {matrix.columns.map((c) => {
                    const cell = r.cells[c.locationId] ?? { quantity: 0, reserved: 0, available: 0 }
                    return (
                      <td key={c.locationId}>
                        <LocationQtyInput
                          value={cell.quantity}
                          reserved={cell.reserved}
                          editable={c.editable}
                          locationType={c.locationType}
                          saving={savingKey === `${r.productId}:${c.locationId}`}
                          onCommit={(v) => doCommit(r.productId, c.locationId, v)}
                        />
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}
```

- [ ] **Step 2: Append the styles**

Append to `apps/web/src/app/products/next/styles.module.css`:

```css
.invModalHead { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.invReasonRow { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.invReasonLabel { display: inline-flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--text-secondary); }
.invReasonSelect, .invNotesInput {
  padding: 4px 8px; background: var(--surface-base);
  border: 1px solid var(--border-subtle); border-radius: 6px; font-size: 13px;
}
.invNotesInput { flex: 1; min-width: 160px; }
.invToast { padding: 6px 10px; border-radius: 6px; background: var(--status-danger-bg); color: var(--status-danger-text); font-size: 12px; }
.invState { padding: 24px; text-align: center; color: var(--text-secondary); display: flex; flex-direction: column; gap: 10px; align-items: center; }
.invRetryBtn, .invCloseBtn { padding: 6px 12px; border: 1px solid var(--border-subtle); border-radius: 6px; background: var(--surface-base); cursor: pointer; }
.invTable { width: 100%; border-collapse: collapse; font-size: 13px; }
.invTable th { text-align: left; padding: 6px 8px; color: var(--text-tertiary); font-weight: 600; border-bottom: 1px solid var(--border-subtle); }
.invTable td { padding: 6px 8px; border-bottom: 1px solid var(--border-subtle); }
.invLocCode { font-weight: 600; margin-right: 6px; }
.invLocType { color: var(--text-tertiary); font-size: 11px; text-transform: capitalize; }
.invMatrixWrap { overflow-x: auto; }
.invMatrix { border-collapse: collapse; font-size: 13px; }
.invMatrix th, .invMatrix td { padding: 6px 8px; border: 1px solid var(--border-subtle); white-space: nowrap; text-align: center; }
.invMatrixCorner, .invMatrixRowHead { position: sticky; left: 0; background: var(--surface-base); text-align: left; font-weight: 600; z-index: 1; }
.invModalFoot { display: flex; justify-content: space-between; align-items: center; width: 100%; gap: 12px; }
.invManageLink { color: var(--text-link); font-size: 13px; }
```

> Token note as before — reconcile any missing `--status-*` / `--text-link` / `--surface-*` token names against those already present in this CSS module before committing; never hardcode colors.

- [ ] **Step 3: Verify build + token guard**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | grep -i InventoryEditorModal || echo "InventoryEditorModal types OK"`
Then run the token-guard command (as in Task 6 Step 3).
Expected: types OK; token-guard passes.

- [ ] **Step 4: Commit**

```bash
git commit --only apps/web/src/app/products/next/InventoryEditorModal.tsx apps/web/src/app/products/next/styles.module.css \
  -m "feat(products-next): InventoryEditorModal (list + variation×location matrix)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Wire the cell + modal into the grid

**Files:**
- Modify: `apps/web/src/app/products/next/ProductsNextClient.tsx`
  - Add imports for `InventoryCell` and `InventoryEditorModal`.
  - Add `modalRow` state.
  - Replace the `available` column renderer's `<AvailableCell row={row} />` (~line 1167) with `<InventoryCell row={row} onOpen={setModalRow} />`.
  - Render `<InventoryEditorModal row={modalRow} onClose={() => setModalRow(null)} />` next to the other modals (near `PreferencesModal`, ~line 1577).
  - Delete the now-unused `AvailableCell` function (~lines 524-549) and remove the `Tooltip` import **iff** it is unused elsewhere in the file.

**Interfaces:**
- Consumes: `InventoryCell` (Task 6), `InventoryEditorModal` (Task 8), `ProductRow` (already imported).

- [ ] **Step 1: Add imports**

Near the other local imports at the top of `ProductsNextClient.tsx`:

```ts
import { InventoryCell } from './InventoryCell'
import { InventoryEditorModal } from './InventoryEditorModal'
```

- [ ] **Step 2: Add modal state**

Inside the component, beside the other `useState` hooks (e.g. near where `selected`/preferences state is declared):

```ts
const [modalRow, setModalRow] = useState<ProductRow | null>(null)
```

- [ ] **Step 3: Swap the column renderer**

Find the `available` column definition (~line 1165):

```tsx
          render: (row) => {
            if (isLoadingRow(row)) return null
            return <AvailableCell row={row} />
          },
```

Replace with:

```tsx
          render: (row) => {
            if (isLoadingRow(row)) return null
            return <InventoryCell row={row} onOpen={setModalRow} />
          },
```

> If `setModalRow` isn't in scope where `columns` is built (it's likely a `useMemo`), add `setModalRow` to that `useMemo`'s dependency array, or hoist `setModalRow` via `useCallback`. Verify with the build in Step 6.

- [ ] **Step 4: Render the modal**

Beside the existing `<PreferencesModal … />` (~line 1577):

```tsx
<InventoryEditorModal row={modalRow} onClose={() => setModalRow(null)} />
```

- [ ] **Step 5: Remove dead code**

Delete the `AvailableCell` function (~lines 524-549). Then check whether `Tooltip` is still referenced:

Run: `grep -n "Tooltip" apps/web/src/app/products/next/ProductsNextClient.tsx`
- If the only matches were inside the deleted `AvailableCell`, remove the now-unused `Tooltip` import line.
- If `Tooltip` is used elsewhere, leave the import.

- [ ] **Step 6: Verify build**

Run: `cd apps/web && npm run build 2>&1 | tail -20`
Expected: build passes, no unused-import or type errors.

- [ ] **Step 7: Commit**

```bash
git commit --only apps/web/src/app/products/next/ProductsNextClient.tsx \
  -m "feat(products-next): wire InventoryCell + editor modal into the Available column

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: End-to-end manual verification + cross-check

**Files:** none (verification only).

- [ ] **Step 1: Run both servers locally** (whatever the project's dev command is, e.g. `npm run dev` at root or per-app). Confirm the API exposes `/api/stock/adjust-location` and the web app builds.

- [ ] **Step 2: Standalone product** — open `/products/next`, find a standalone product (no variations), click its Available cell. Verify the modal opens in **list mode**, shows each location's on-hand/reserved/available, FBA shows a lock, Shopify shows "synced". Edit a warehouse location's on-hand (set-to a new number), pick a reason, Enter. Verify it saves, the cell's FBM/total update, and no error toast.

- [ ] **Step 3: Add at an empty location** — for the same product, set a non-zero on-hand on a warehouse location that previously had **no** level (showed 0). Verify it persists (creates the level via upsert) and reappears on reopen.

- [ ] **Step 4: Parent product** — click a parent's Available cell. Verify the modal opens in **matrix mode** (variations as rows × locations as columns), FBA/Shopify columns are read-only (🔒 / non-editable), and editing a warehouse cell for one variation saves and updates that variation's numbers.

- [ ] **Step 5: Guards** — confirm: editing an FBA cell is impossible (read-only); setting an on-hand below that location's reserved shows the `BELOW_RESERVED` message in the toast; a negative value is rejected.

- [ ] **Step 6: Cross-surface consistency** — open `/fulfillment/stock`, find the same product, and confirm the on-hand numbers match what you set on `/products/next` (the `stock.adjusted` event + shared ledger keep them in sync). Confirm the audit movement appears (e.g. in the stock drawer's movement history).

- [ ] **Step 7: Final push**

```bash
git push  # rebase if rejected: git pull --rebase && git push
```

---

## Self-Review

**Spec coverage** (against `2026-06-29-products-next-inventory-column-design.md`):
- §4.1 read endpoints → Task 5 (hook uses `/api/stock/product/:id`, `?family=true`, `/api/stock/locations`). ✔
- §4.2 `POST /api/stock/adjust-location` (absolute value, server-side delta, upsert, recomputed totals) → Tasks 1–3. ✔
- §5.1 `InventoryCell` FBA/FBM split → Task 6. ✔
- §5.2 modal list + matrix, `LocationQtyInput`, "+ Add at location" (implicit 0-rows / empty matrix cells) → Tasks 7–8. ✔
- §5.3 wiring + `stock.adjusted` emit + optimistic-ish reload → Tasks 5, 9. ✔
- §6 guards (FBA + Shopify read-only, integer ≥ 0, ≥ reserved) → Task 1 (+ UI in Task 7). ✔
- §7 states (loading/error/empty) + a11y (DS Modal focus/Esc, labelled inputs) → Task 8. ✔
- §2.1 variation correction (productId-only writes) → Tasks 3, 4 (no `variationId` anywhere). ✔
- §9 out-of-scope link "Manage in Stock →" → Task 8. ✔
- §11 testing (pure unit tests + manual matrix) → Tasks 1, 2, 4, 10. ✔

**Deviation from spec:** the spec listed a looser reason set (Damage/Theft/Found/Correction); the canonical `MovementReason` enum only has `MANUAL_ADJUSTMENT`, `INVENTORY_COUNT`, `WRITE_OFF`, so the plan uses those three (Damage → "Write-off / damage"). Reason/notes are a single modal-level control (cleaner in the matrix than per-cell). Both are improvements consistent with the spec's intent.

**Placeholder scan:** no TBD/TODO; every code step shows complete code; runtime IDs in the curl test are obtained via shown commands (not plan placeholders). ✔

**Type consistency:** `commit(...)` signature matches between Task 5 (hook) and Task 8 (modal call); `LevelCell`/`MatrixModel` produced in Task 4 are consumed unchanged in Tasks 5/8; `computeLocationAdjustment`/`summarizeProductStock` signatures match between Tasks 1/2 and Task 3. ✔
