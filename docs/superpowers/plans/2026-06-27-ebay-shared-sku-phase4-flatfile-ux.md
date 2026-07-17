# eBay Shared-SKU — Phase 4: Flat-File UX (route shared-flagged families to pushSharedListings) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Phase 2's `pushSharedListings(rows, ctx)` into the eBay flat-file push. A per-parent **shared-SKU listing (Trading API)** flag, persisted on the parent row, causes that family to publish via the Trading-API multi-variation path (where the same variant SKU may repeat across different parent listings) instead of the unique-SKU Inventory-API `pushVariationGroup`. Add a per-parent boolean column + a compliance warning that this is ONLY for genuinely-different products that legitimately share stock (NOT identical-item cloning, which violates eBay's duplicate-listing policy).

**Architecture:** Flag is a free-form boolean that round-trips through the **existing** `ChannelListing.platformAttributes` JSON (`sharedSkuListing`) — no schema change, no migration. `packSharedFields` writes it; `buildFlatRow` reads it; the unchanged `/push` body already carries the full row (incl. the flag + `_isParent`) to the backend. The push handler adds ONE branch: when a multi-row family's parent has the flag, call `pushSharedListings(familyRows, { oauthToken: token, market: mp, capQty: capToFbm })`; otherwise the current `pushVariationGroup` path. Frontend adds one `boolean` column (mirroring `best_offer_enabled`) plus a compliance panel in the existing push-extras surface.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Fastify, Prisma (postgres/Neon), Next.js (App Router, client component), vitest 4. No new deps.

**Scope boundary:** Phase 4 wires the EXISTING Phase 2 service into the route + UI. It does NOT change `pushSharedListings`/`createSharedListing`/`buildSharedListingInput` (Phase 2) and does NOT enqueue fan-out sync (Phase 3). It does NOT add a DB migration (the flag reuses existing JSON). The `SharedListingMembership` table from Phase 2 is created only when that branch merges and Railway runs `prisma migrate deploy` — a gated step OUTSIDE this plan; until then `pushSharedListings` writes memberships against a table that exists on `main` only post-merge, so live exercise of this path is itself gated behind that merge.

## Global Constraints

- **eBay only.** Do not touch Amazon/Shopify.
- **UNTOUCHABLE-FILES EXCEPTION — APPROVED (option A).** `/products/ebay-flat-file` page + components and `apps/api/src/routes/ebay-flat-file.routes.ts` are normally zero-change-without-approval (see memory: "Flat-file editor untouchable"). The user **explicitly approved** modifying them **for this feature**. Keep every change **minimal and additive** — new column, new branch, new warning panel; do not refactor or reflow existing logic.
- **Reuse Phase 2 `pushSharedListings`** from `apps/api/src/services/ebay-shared-listing-push.service.ts` — signature: `pushSharedListings(rows: SharedRow[], ctx: SharedListingCtx): Promise<SharedListingResult[]>`, where `SharedListingCtx = { oauthToken: string; market: string; capQty?: CapQtyFn; ... }`. Do NOT reimplement listing-building.
- **Resolve `oauthToken` via the path's existing values.** The `/push` handler already resolves `token = await ebayAuthService.getValidToken(connection.id)` (`ebay-flat-file.routes.ts:576`) and `capToFbm` (the pool-aware qty cap, `:645-697`). Pass `{ oauthToken: token, market: mp, capQty: capToFbm }` straight to `pushSharedListings` — `CapQtyFn` and `capToFbm` already share the exact `(pid, sku, requested, market) => number` contract (`:645`).
- **Branch only the multi-SKU family path.** The shared-SKU concept is inherently a multi-variation listing. Route the flag only inside the existing `if (familyRows.length > 1)` block (`:780`); single-row families keep the current per-row Inventory-API flow. Offers-only strategy (`:766`) is unaffected (it's a re-price-only fast path).
- **Flag persistence = existing JSON, NO migration.** Store the flag at `ChannelListing.platformAttributes.sharedSkuListing` (boolean) via `packSharedFields` (`ebay-variation-push.service.ts:1546`) and read it back in `buildFlatRow` (`:1382`-style). `Product` already has `parentId` (schema.prisma:249) and several `Json?` columns, but reusing `platformAttributes` keeps the change to two existing functions and avoids a Product migration entirely.
- **`_isParent` marks the parent.** `buildFlatRow` sets `_isParent: !product.parentId` and `platformProductId: product.parentId ?? product.id` (`:1421`,`:1424`); the push handler picks the parent as `familyRows.find(r => r._isParent) ?? familyRows[0]` (`:785`). The flag attaches to that parent row.
- **Compliance, not enforcement.** The "genuinely different products" guard is a WARNING surfaced to the operator (eBay forbids listing the *same* item as multiple listings — [eBay duplicate-listing policy]); Nexus cannot mechanically prove two SKUs are different products, so it warns and lets the operator proceed. Do NOT hard-block.
- **Test runner:** vitest. Backend per-file: `cd apps/api && npx vitest run <path>`. UI: i18n/locale does not switch headlessly in Playwright and SSE/grid render is hard to assert in CI (repo norm) — UI changes are verified by `tsc` + manual; do NOT add a Playwright test for the toggle.
- Repo conventions: ESM `.js` import specifiers in `apps/api`; `'use client'` components in `apps/web/src/app/...`; column model lives in `apps/web/src/app/products/ebay-flat-file/ebay-columns.ts`.

---

### Task 1: Persist the `shared_sku_listing` flag through the existing JSON round-trip (no migration)

**Files:**
- Modify: `apps/api/src/services/ebay-variation-push.service.ts` (`packSharedFields` write + `buildFlatRow` read)

**Interfaces:**
- Produces: `ChannelListing.platformAttributes.sharedSkuListing: boolean` (persisted on every market listing of the family by the existing PATCH `/rows` → `packSharedFields` path); flat row key `shared_sku_listing: boolean` (read back by `buildFlatRow`).
- Consumed by: Task 2 (push handler reads `parentRow.shared_sku_listing`) and Task 4 (column).

**Why no migration:** `packSharedFields` already serialises ~25 fields into `platformAttributes` (`ebay-variation-push.service.ts:1546-1571`); adding one boolean key is additive JSON. `buildFlatRow` already hydrates flat-row fields from `firstAttrs` (`:1380-1411`). Reusing this avoids a `Product`/`ChannelListing` schema change.

- [ ] **Step 1: Add the write in `packSharedFields`**

In `apps/api/src/services/ebay-variation-push.service.ts`, inside the `platformAttributes: { ... }` object literal returned by `packSharedFields` (the block beginning at line 1546), add one line alongside the other flags (e.g. directly after `subtitle:`):

```ts
      // Phase 4 — shared-SKU listing routing flag (Trading-API multi-variation,
      // shared variant SKUs across parents). Round-trips via existing JSON; no migration.
      sharedSkuListing: Boolean(row.shared_sku_listing),
```

- [ ] **Step 2: Add the read in `buildFlatRow`**

In the same file, in the `const row: Record<string, unknown> = { ... }` literal built by `buildFlatRow` (begins line 1371), add one field near the other `firstAttrs`-sourced flags (e.g. after the `subtitle:` line ~1383):

```ts
    // Phase 4 — shared-SKU listing flag (parent-level), read back from platformAttributes.
    shared_sku_listing: (firstAttrs.sharedSkuListing as boolean | undefined) ?? false,
```

- [ ] **Step 3: Type-check**

Run: `cd apps/api && npx tsc --noEmit 2>&1 | grep -E 'ebay-variation-push' || echo "no type errors in ebay-variation-push.service.ts"`
Expected: no errors in the file.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/ebay-variation-push.service.ts
git commit -m "feat(ebay-shared): round-trip shared_sku_listing flag via platformAttributes (no migration)"
```

---

### Task 2: Route shared-flagged multi-SKU families to `pushSharedListings` in the push handler

**Files:**
- Modify: `apps/api/src/routes/ebay-flat-file.routes.ts` (import + the multi-SKU branch inside the family loop)

**Interfaces:**
- Consumes: `pushSharedListings`, `SharedListingResult` from `../services/ebay-shared-listing-push.service.js`; the route's existing `token` (`:576`), `capToFbm` (`:645`), per-market loop var `mp` (`:762`), `familyRows`/parent detection (`:765`,`:785`).
- Produces: shared-flagged families publish via Trading API; `perRowResults` gets one `{ sku, market, status, message, itemId }` entry per variant SKU (shape-compatible with the existing array at `:746-752`).

**Branch point (verified):** inside `for (const [familyKey, familyRows] of families)` (`:765`), after the `offers-only` early-continue (`:766-779`), at the top of the `if (familyRows.length > 1)` block (`:780`). The full row object (incl. `shared_sku_listing` + `_isParent`) is already in `familyRows` because the client posts `toPush` rows verbatim (`EbayFlatFileClient.tsx:706`).

- [ ] **Step 1: Add the import**

Near the other service imports at the top of `apps/api/src/routes/ebay-flat-file.routes.ts` (e.g. after the `ebay-variation-push.service.js` imports, ~line 40), add:

```ts
import { pushSharedListings, type SharedListingResult } from '../services/ebay-shared-listing-push.service.js';
```

- [ ] **Step 2: Add the routing branch**

Inside the `if (familyRows.length > 1) {` block (line 780), as the FIRST statements (before `const parentRowForKey = ...` at `:785`), insert:

```ts
          // Phase 4 — shared-SKU listing routing. A genuinely-different-products
          // family that legitimately shares stock can publish as a Trading-API
          // multi-variation listing (same variant SKU may repeat across parents),
          // instead of the unique-SKU Inventory-API group. Flag lives on the parent.
          const sharedParent = familyRows.find((r) => r._isParent) ?? familyRows[0]
          if (sharedParent?.shared_sku_listing === true) {
            const sharedResults: SharedListingResult[] = await pushSharedListings(
              familyRows as Array<Record<string, unknown>>,
              { oauthToken: token, market: mp, capQty: capToFbm },
            )
            for (const r of sharedResults) {
              perRowResults.push({
                sku: r.parentSku,
                market: mp,
                status: r.status === 'ERROR' ? 'ERROR' : 'PUSHED',
                message: r.itemId ? `${r.message} (ItemID ${r.itemId})` : r.message,
                itemId: r.itemId,
              })
            }
            continue
          }
```

> Notes: `pushSharedListings` re-groups by `platformProductId` internally, so passing the single family's rows yields exactly one `SharedListingResult` here; the loop is future-proof if that changes. `SKIPPED_EXISTS` (idempotency) maps to `PUSHED` so re-pushing a live shared listing is not surfaced as an error. The `EbayPushJob` durable-history write at `:1100` already serialises `perRowResults`, so shared pushes appear in history with no extra work.

- [ ] **Step 3: Type-check**

Run: `cd apps/api && npx tsc --noEmit 2>&1 | grep -E 'ebay-flat-file.routes' || echo "no type errors in ebay-flat-file.routes.ts"`
Expected: no errors in the file. (If `r._isParent`/`r.shared_sku_listing` flag a type error because `rows` is `Array<Record<string, unknown>>`, cast the predicate row as in the snippet — values are `unknown` and the `=== true` comparisons are valid on `unknown`.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/ebay-flat-file.routes.ts
git commit -m "feat(ebay-shared): route shared-flagged families to pushSharedListings (Trading API)"
```

---

### Task 3: Backend routing unit test (parent-flag decides Trading-API vs Inventory-API)

**Files:**
- Create: `apps/api/src/services/ebay-shared-listing-push.routing.vitest.test.ts`

**Interfaces:**
- Consumes: `pushSharedListings` (exercised with injected `db` + `addFixedPriceItemFn` seams that already exist on `SharedListingCtx`, Phase 2). This test asserts the **routing decision contract** the handler relies on: a family whose parent has `shared_sku_listing` is publishable purely from its rows via `pushSharedListings`, and the `capQty`/`oauthToken`/`market` ctx wiring matches `capToFbm`'s shape.

> Why test the service-via-ctx rather than the Fastify route: the route needs a live eBay connection + token + prisma; the repo's norm for this code is mock-injected service tests (see Phase 2's `ebay-shared-listing-push.service.vitest.test.ts`). This test pins the exact call the handler makes (`pushSharedListings(familyRows, { oauthToken, market, capQty })`) and the `capQty` contract, which is the part most likely to regress.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/ebay-shared-listing-push.routing.vitest.test.ts
import { describe, it, expect, vi } from 'vitest'
import { pushSharedListings, type CapQtyFn } from './ebay-shared-listing-push.service.js'

function mockDb() {
  const created: any[] = []
  return {
    created,
    sharedListingMembership: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => { created.push(data); return data }),
    },
  }
}

// A flagged family exactly as the push handler hands it to pushSharedListings:
// the full flat rows, parent carrying _isParent + shared_sku_listing.
const familyRows = [
  { sku: 'LNR-BLK', _isParent: true, shared_sku_listing: true, platformProductId: 'P', title: 'Inner Liner', category_id: '57988', condition: '1000' },
  { sku: 'SHARED-M', platformProductId: 'P', it_price: 49.9, it_qty: 9, aspect_Size: 'M', _productId: 'p1' },
  { sku: 'SHARED-L', platformProductId: 'P', it_price: 49.9, it_qty: 9, aspect_Size: 'L', _productId: 'p2' },
]

describe('Phase 4 shared-SKU routing contract', () => {
  it('publishes a flagged family via the injected addFixedPriceItem and writes one membership per variant', async () => {
    const db = mockDb()
    const addFn = vi.fn(async () => ({ itemId: '110099887766' }))
    const results = await pushSharedListings(familyRows, { oauthToken: 'TKN', market: 'IT', db, addFixedPriceItemFn: addFn })
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('CREATED')
    expect(results[0].itemId).toBe('110099887766')
    expect(addFn).toHaveBeenCalledOnce()
    // ctx.market threads through to the Trading-API call:
    expect(addFn).toHaveBeenCalledWith(expect.anything(), { oauthToken: 'TKN', market: 'IT' })
    expect(db.created).toHaveLength(2) // M + L (parent is not a sellable variant)
  })

  it('applies capToFbm-shaped capQty to each variant quantity', async () => {
    const db = mockDb()
    const addFn = vi.fn(async () => ({ itemId: 'X' }))
    // Mirror the route's capToFbm signature: (pid, sku, requested, market) => number
    const capQty: CapQtyFn = vi.fn((_pid, _sku, requested) => Math.min(requested, 3))
    await pushSharedListings(familyRows, { oauthToken: 'T', market: 'IT', db, addFixedPriceItemFn: addFn, capQty })
    // requested 9 → capped 3 on both variants
    expect(db.created.every((m) => m.lastQtyPushed === 3)).toBe(true)
    expect(capQty).toHaveBeenCalledWith('p1', 'SHARED-M', 9, 'IT')
  })
})
```

- [ ] **Step 2: Run to verify it fails, then passes**

Run: `cd apps/api && npx vitest run src/services/ebay-shared-listing-push.routing.vitest.test.ts`
Expected: GREEN (Phase 2 already provides the injectable seams; this test should pass once the file is added — its value is as a regression pin on the exact ctx contract the handler uses. If it fails, the Phase 2 service contract drifted — STOP and reconcile, do not weaken the test).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/ebay-shared-listing-push.routing.vitest.test.ts
git commit -m "test(ebay-shared): pin Phase 4 routing ctx contract (capQty/oauthToken/market)"
```

---

### Task 4: Frontend — `shared_sku_listing` boolean column + EbayRow field + compliance warning

**Files:**
- Modify: `apps/web/src/app/products/ebay-flat-file/ebay-columns.ts` (new column in the Listing group)
- Modify: `apps/web/src/app/products/ebay-flat-file/EbayFlatFileClient.tsx` (`EbayRow` field; compliance panel in `renderPushExtras`)

**Interfaces:**
- Produces: a `boolean` grid column `shared_sku_listing` editable on parent rows; its value flows to the backend unchanged via the existing `POST /push` body (`EbayFlatFileClient.tsx:706`) and is persisted via PATCH `/rows` → Task 1.
- Consumes: existing `boolean` cell rendering (`EbayFlatFileClient.tsx:1060`) and toggle pattern (mirrors `best_offer_enabled`, `:1134`); existing `renderPushExtras` warning surface (`:1161`).

- [ ] **Step 1: Add the column to the Listing group**

In `apps/web/src/app/products/ebay-flat-file/ebay-columns.ts`, in the `listing` group's `columns` array (after the `variation_theme` column, ~line 205), add:

```ts
      {
        id: 'shared_sku_listing',
        label: 'Shared-SKU (Trading API)',
        description: 'Publish this family as an eBay Trading-API multi-variation listing whose variant SKUs may also appear in OTHER listings (shared stock across genuinely-different products). Leave OFF for normal unique-SKU listings. Only set on the parent row. WARNING: never use to clone the SAME item into multiple listings — eBay prohibits duplicate listings.',
        required: false,
        kind: 'boolean',
        width: 150,
      },
```

- [ ] **Step 2: Add the field to `EbayRow`**

In `EbayFlatFileClient.tsx`, in the `EbayRow` interface (after `_isParent?: boolean`, line 74), add:

```ts
  /** Phase 4 — publish this family via the Trading-API shared-SKU path (parent-level). */
  shared_sku_listing?: boolean
```

- [ ] **Step 3: Restrict editing to the parent row (optional, additive)**

The `boolean` cell already toggles generically. Because the flag only has meaning on the parent, optionally guard the toggle so it is a no-op / disabled on variant rows. Find the boolean toggle handler that mirrors `best_offer_enabled` (around `EbayFlatFileClient.tsx:1134`) — when handling `col.id === 'shared_sku_listing'`, only apply on rows where `(row as EbayRow)._isParent === true`. Keep this minimal; if it complicates the generic handler, skip it and rely on the description + the parent-only read in the backend (`familyRows.find(r => r._isParent)`), which already ignores the flag on non-parent rows.

- [ ] **Step 4: Add the compliance warning to `renderPushExtras`**

In `renderPushExtras` (`EbayFlatFileClient.tsx:1161`), add a sibling panel after the `incompleteBefore` panel (after line 1194, before the `<div className="flex items-center gap-2">` at 1195). It shows when the push set contains a flagged parent and the publish panel is open:

```tsx
      {publishPanelOpen && rows.some((r) => (r as EbayRow)._isParent && (r as EbayRow).shared_sku_listing) && (
        <div className="absolute bottom-full mb-1.5 right-0 w-80 rounded-lg border border-blue-300 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-800 px-3 py-2 shadow-sm z-50">
          <p className="text-xs font-semibold text-blue-800 dark:text-blue-300 mb-1">
            Shared-SKU listing (Trading API)
          </p>
          <p className="text-[10px] text-blue-700 dark:text-blue-400">
            One or more families publish as Trading-API multi-variation listings whose variant SKUs may
            also appear in other listings. Use this ONLY for genuinely-different products that legitimately
            share stock. Listing the <span className="font-semibold">same item</span> as multiple listings
            violates eBay&rsquo;s duplicate-listing policy.
          </p>
        </div>
      )}
```

> Position note: `renderPushExtras` stacks absolutely-positioned panels at `bottom-full right-0`. If two panels could show at once, bump this one's offset (e.g. `mb-1.5` → a larger margin) so they don't overlap — verify visually per the repo's "self-verify before showing" norm.

- [ ] **Step 5: Add the flag to the `renderPushExtras` dependency array**

Because the new panel reads `rows` (already a param) but the memo deps list at `:1222` does not include row contents, confirm the panel re-renders on toggle. `renderPushExtras` is a `useCallback`; `rows` arrives as a call argument (from `PushExtrasCtx`), so no dep change is needed — but verify the toggle visibly flips the panel in the running app.

- [ ] **Step 6: Type-check the web app**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | grep -E 'ebay-flat-file|ebay-columns' || echo "no type errors in eBay flat-file UI"`
Expected: no errors in the touched files.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/products/ebay-flat-file/ebay-columns.ts apps/web/src/app/products/ebay-flat-file/EbayFlatFileClient.tsx
git commit -m "feat(ebay-shared): shared-SKU parent toggle + compliance warning on eBay flat-file"
```

---

## Phase 4 exit verification (after all tasks)

- [ ] `cd apps/api && npx vitest run src/services/ebay-shared-listing-push.routing.vitest.test.ts` — green.
- [ ] `cd apps/api && npx vitest run src/services/ebay-shared-listing-push.service.vitest.test.ts` — Phase 2 suite still green (untouched).
- [ ] `cd apps/api && npx tsc --noEmit 2>&1 | grep -E 'ebay-flat-file.routes|ebay-variation-push|ebay-shared-listing' || echo "api clean"` — no type errors in touched API files.
- [ ] `cd apps/web && npx tsc --noEmit 2>&1 | grep -E 'ebay-flat-file|ebay-columns' || echo "web clean"` — no type errors in touched UI files.
- [ ] Confirm files touched are ONLY: `apps/api/src/services/ebay-variation-push.service.ts`, `apps/api/src/routes/ebay-flat-file.routes.ts`, the new routing test, `apps/web/src/app/products/ebay-flat-file/ebay-columns.ts`, `apps/web/src/app/products/ebay-flat-file/EbayFlatFileClient.tsx`. `ebay-shared-listing-push.service.ts` (Phase 2) is NOT modified.
- [ ] Manual (post-merge of Phase 2 table only — see GATED): on `/products/ebay-flat-file`, load a family, tick **Shared-SKU (Trading API)** on the parent, save, push → push history shows a Trading-API ItemID; an unflagged family still goes through the Inventory-API group path unchanged.

## GATED — do NOT do in this plan
- **No DB migration is introduced by Phase 4** (the flag reuses `ChannelListing.platformAttributes` JSON). Do NOT add a `Product`/`ChannelListing` column.
- **Do NOT run `prisma migrate deploy` / apply any migration.** The `SharedListingMembership` table (Phase 2) is applied only when the feature branch merges to `main` and Railway deploys — a gated approval step. Until then the shared-SKU push path will throw at the membership write against a missing table on any non-merged environment; that is expected and is why live exercise of this path is gated behind the merge.
- **Do NOT merge to `main` without explicit user approval** (standing migration-approval rule — merging triggers `prisma migrate deploy` and creates the Phase 2 table).
- **Do NOT flip `NEXUS_ENABLE_EBAY_PUBLISH`** or otherwise change the publish gate (`ebay-flat-file.routes.ts:545`); the route already honours it for shared pushes since the gate check runs before the family loop.

## Notes for the executor
- The whole `toPush` row array (incl. `_isParent`, `platformProductId`, `shared_sku_listing`, all `aspect_*`/market fields) is posted verbatim to `/push` (`EbayFlatFileClient.tsx:706`) — no payload shape change is needed for the flag to reach the handler.
- The grid's `sku` column is free text (`ebay-columns.ts:132-141`); it does NOT prevent the same variant SKU appearing under different parent rows — which is exactly what shared-SKU listings need. CAVEAT: `validateRows` (`EbayFlatFileClient.tsx:124`) flags duplicate SKUs **across the whole loaded sheet** as a blocking error. If an operator loads two shared families that intentionally repeat a SKU into ONE sheet, that pre-push guard would block them. Phase 4 does not need to change this (operators normally load/push one family at a time via `?familyId=`), but if cross-family shared SKUs in one sheet become a real workflow, relax that check to skip rows whose parent has `shared_sku_listing` — note it as a known limitation rather than fixing speculatively.
- `capToFbm` and Phase 2's `CapQtyFn` share the identical `(productId, sku, requested, market) => number` signature (`ebay-flat-file.routes.ts:645`), so it drops into `ctx.capQty` with no adapter.
- UI: locale won't switch headlessly in Playwright and the grid/push panel are awkward to assert in CI (repo norm) — rely on `tsc` + the manual check above; do not add a Playwright spec for the toggle.
