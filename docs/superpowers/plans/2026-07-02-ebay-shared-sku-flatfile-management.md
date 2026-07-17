# eBay Shared-SKU Flat-File Management (round-trip + per-listing price) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the eBay flat file a management surface for shared-SKU listings: the SAME child variant SKU appears as a row under EVERY eBay parent listing it belongs to (reconstructed from `SharedListingMembership`), survives reload, can carry a DIFFERENT price per listing, and shares one synced stock pool.

**Architecture:** The shared-SKU engine already exists on `main` (membership model, `createSharedListing`/`pushSharedListings` Trading-API create, stock fan-out via `enqueueSharedTradingFanout`). This plan adds the flat-file management layer on top, reusing `buildFlatRow`, the fan-out, and the existing all-products load mode. Phase 1 = model + create + read-only round-trip view (with per-listing price captured at creation). Phase 2 = editing already-live listings (`ReviseFixedPriceItem`) + membership add/remove on save.

**Tech Stack:** TypeScript, Fastify (apps/api), Prisma (packages/database), Next.js/React (apps/web), Vitest.

## Global Constraints

- eBay flat-file page + routes are "untouchable" without approval — THIS engagement is the approval. Changes ADDITIVE & surgical.
- Do NOT change behavior for NON-shared families (normal single-parent grouping, validation, push) — all shared logic is gated on the `shared_sku_listing` flag / membership presence.
- A shared child has ONE `Product` (one stock pool) but MAY have a different price per listing → the per-listing price lives on `SharedListingMembership.price` (new), NOT on the child Product. Quantity is always the shared pool (edit the pool → fan-out syncs every listing).
- Preserved config tables never touched. Product creation touches only `Product`.
- **Schema migration required** (Task 1) → run only with explicit user go; Neon: strip `-pooler` from the URL for `prisma migrate deploy` (see reference_neon_migrations). No data-destructive change (additive nullable column).
- Verify locally: vitest + `cd apps/api && npx tsc --noEmit` + `cd apps/web && npx tsc --noEmit`. Mock prisma in unit tests (no live DB).
- Commit locally with `git commit --only <files>`; controller owns pushes (never `--no-verify`).
- Live eBay writes are env-gated (`NEXUS_ENABLE_EBAY_PUBLISH`, `NEXUS_EBAY_REAL_API`); the E2E live step (Task 8) is gated on user go + a scratch family.

## Prior work reused
- `a0d70bc0` + `6b52081a` (P1.1 pure planner/builder) — REUSED for create-on-save (Task 7).
- `5de94779` (P1.2 create pre-pass) — EVOLVED in Task 7 (fix its outstanding review bug + make shared-aware). Its single-parent re-parent step is suppressed for shared families.
- Earlier plan `2026-07-02-ebay-shared-sku-flatfile-unblock-persist.md` is SUPERSEDED — its dup-relaxation + create-on-save tasks are folded in here as Tasks 6 + 7.

## File Structure
- `packages/database/prisma/schema.prisma` — MODIFY: add `price Decimal?` to `SharedListingMembership`.
- `packages/database/prisma/migrations/<ts>_shared_listing_membership_price/migration.sql` — CREATE.
- `apps/api/src/services/ebay-shared-listing-push.service.ts` — MODIFY: `createSharedListing` stores `membership.price` from the row, resolves `productId` by SKU fallback, wraps membership writes in `$transaction`.
- `apps/api/src/services/ebay-shared-membership-rows.ts` — CREATE: pure synthesis (`reverseVariationSpecifics`, `synthesizeSharedRow`) + `loadSharedMembershipRows(prisma, parentRows, normalRows)`.
- `apps/api/src/services/ebay-shared-membership-rows.vitest.test.ts` — CREATE.
- `apps/api/src/routes/ebay-flat-file.routes.ts` — MODIFY: GET post-pass appends synthesized rows; PATCH pre-pass passes `sharedFamilyKeys` (Task 7).
- `apps/api/src/services/ebay-flat-file-create.logic.ts` / `.service.ts` (+ tests) — MODIFY (Task 7): fix P1.2 bug + shared-aware skip-reparent.
- `apps/web/src/app/products/ebay-flat-file/EbayFlatFileClient.tsx` — MODIFY (surgical): `validateRows` dup-SKU relaxation (Task 6) + mark `_shared`/`_readonly` rows non-editable + badge (Task 5).
- `apps/web/src/app/products/ebay-flat-file/validateRows.sharedsku.vitest.test.ts` — CREATE.

---

## PHASE 1

### Task 1: Schema — `SharedListingMembership.price`

**Files:** `packages/database/prisma/schema.prisma`, new migration.

- [ ] **Step 1:** Add to the `SharedListingMembership` model (after `variationSpecifics`): `price Decimal? @db.Decimal(10, 2) // per-listing price; null → fall back to child Product price`.
- [ ] **Step 2:** Generate migration SQL (additive, nullable — no backfill needed):
```sql
ALTER TABLE "SharedListingMembership" ADD COLUMN "price" DECIMAL(10,2);
```
Save under `packages/database/prisma/migrations/<timestamp>_shared_listing_membership_price/migration.sql`.
- [ ] **Step 3:** `cd packages/database && npx prisma generate` — client picks up the field; `cd apps/api && npx tsc --noEmit` clean.
- [ ] **Step 4:** Commit (do NOT run `migrate deploy` yet — controller runs it against prod on user go, `-pooler` stripped).
```bash
git commit --only packages/database/prisma/schema.prisma packages/database/prisma/migrations -m "feat(ebay): SharedListingMembership.price for per-listing pricing (shared-mgmt / Task 1)"
```

### Task 2: `createSharedListing` — store per-listing price + productId SKU-fallback + transactional writes

**Files:** `apps/api/src/services/ebay-shared-listing-push.service.ts`, `...service.vitest.test.ts`.

**Interfaces — Produces:** each `sharedListingMembership.create` now sets `price` from the variation; `productId` resolved by SKU lookup when `row._productId` absent; all creates in one `$transaction`.

- [ ] **Step 1 (test, RED):** In the service test, mock `db.product.findMany` → `[{id:'prod-1', sku:'SH-M'}]`, variant rows without `_productId`, `input.variations[0].price = 120`. Assert created membership has `productId:'prod-1'` AND `price` equal to `120`. Run → FAIL.
- [ ] **Step 2:** Backfill `productIdBySku` for missing entries:
```ts
const missing = [...productIdBySku.entries()].filter(([, id]) => !id).map(([sku]) => sku)
if (missing.length) {
  const found = await db.product.findMany({ where: { sku: { in: missing }, deletedAt: null }, select: { id: true, sku: true } })
  for (const f of found) productIdBySku.set(f.sku, f.id)
}
```
- [ ] **Step 3:** In the membership `create` data, add `price: v.price != null ? new Prisma.Decimal(v.price) : null,` (import `Prisma` if not already). Replace the per-variant `await db.sharedListingMembership.create(...)` loop with `await db.$transaction(input.variations.map(v => db.sharedListingMembership.create({ data: { ...fields incl price... } })))`. Keep the `SKIPPED_EXISTS` pre-check + returned `count`.
- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/services/ebay-shared-listing-push.service.vitest.test.ts` (new test GREEN, existing pass) + `npx tsc --noEmit`.
- [ ] **Step 5:** Commit.
```bash
git commit --only apps/api/src/services/ebay-shared-listing-push.service.ts apps/api/src/services/ebay-shared-listing-push.service.vitest.test.ts -m "feat(ebay): store per-listing price + productId fallback + tx membership writes (shared-mgmt / Task 2)"
```

### Task 3: Membership → row synthesis (pure + loader)

**Files:** CREATE `apps/api/src/services/ebay-shared-membership-rows.ts` + `.vitest.test.ts`.

**Interfaces — Produces:**
- `reverseVariationSpecifics(specifics): Record<string,string>` — writes cased + lowercase `aspect_*` (mirror buildFlatRow:1450-1451).
- `synthesizeSharedRow({ membership, childBaseRow, parentProductId }): Record<string,unknown>`.
- `loadSharedMembershipRows(prisma, parentRows, normalRows): Promise<Record<string,unknown>[]>` — reads memberships for the loaded parents, resolves parent ids, dedups vs normalRows, returns synthesized rows.

- [ ] **Step 1 (test, RED):** Write `reverseVariationSpecifics({Colore:'Nero','Base Color':'Black'})` → asserts `aspect_Colore`,`aspect_colore`,`aspect_Base_Color`,`aspect_base_color`. Write `synthesizeSharedRow` test: given a membership `{sku:'C', itemId:'110', parentSku:'P', marketplace:'IT', price: 120, lastQtyPushed: 5, variationSpecifics:{Colore:'Nero'}}`, a `childBaseRow` `{sku:'C', it_price: 100, title:'Jacket'}`, `parentProductId:'pid-P'` → asserts `platformProductId:'pid-P'`, `_isParent:false`, `_shared:true`, `_readonly:true`, `ebay_item_id:'110'`, `it_item_id:'110'`, `it_price:120` (membership price WINS over base 100), `price:120`, `it_qty:5`, `aspect_Colore:'Nero'`, and `title:'Jacket'` (from base).
- [ ] **Step 2:** Implement the pure functions:
```ts
export function reverseVariationSpecifics(specifics: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, val] of Object.entries(specifics)) {
    out[`aspect_${name.replace(/ /g, '_')}`] = val
    out[`aspect_${name.toLowerCase().replace(/ /g, '_')}`] = val
  }
  return out
}

export function synthesizeSharedRow(opts: {
  membership: { sku: string; itemId: string; marketplace: string; price: number | null; lastQtyPushed: number | null; variationSpecifics: Record<string, string> }
  childBaseRow: Record<string, unknown> | null
  parentProductId: string
}): Record<string, unknown> {
  const { membership: m, childBaseRow, parentProductId } = opts
  const mp = m.marketplace.toLowerCase()
  const base: Record<string, unknown> = childBaseRow ? { ...childBaseRow } : { sku: m.sku }
  return {
    ...base,
    _shared: true,
    _readonly: true,
    _isParent: false,
    platformProductId: parentProductId,
    ebay_item_id: m.itemId,
    [`${mp}_item_id`]: m.itemId,
    ...(m.price != null ? { [`${mp}_price`]: m.price, price: m.price } : {}),
    ...(m.lastQtyPushed != null ? { [`${mp}_qty`]: m.lastQtyPushed, quantity: m.lastQtyPushed } : {}),
    ...reverseVariationSpecifics(m.variationSpecifics),
  }
}
```
- [ ] **Step 3:** Implement `loadSharedMembershipRows(prisma, parentRows, normalRows)`: derive `parentSkus` from `parentRows` (rows with `_isParent`); `prisma.sharedListingMembership.findMany({ where: { parentSku: { in: parentSkus }, status: 'ACTIVE' } })`; build `parentIdBySku` from `parentRows` (`sku → _productId`); batch-load child Products (`id in membership.productId`, include eBay channelListings+images) and `buildFlatRow` each into a `childRowById` map; build an `existing` set of `${platformProductId}|${sku}` from `normalRows`; for each membership resolve `parentProductId = parentIdBySku.get(parentSku)` (skip if unresolved), skip if `${parentProductId}|${sku}` already in `existing`, else push `synthesizeSharedRow(...)` and add to `existing`. Convert Decimal `price` → number via `Number(m.price)`.
- [ ] **Step 4:** Loader test with a mock prisma: one normal child row under parent A + a membership of the same SKU under parent B → asserts exactly ONE synthesized row (under B), none duplicated under A.
- [ ] **Step 5:** `cd apps/api && npx vitest run src/services/ebay-shared-membership-rows.vitest.test.ts` + `npx tsc --noEmit`.
- [ ] **Step 6:** Commit.
```bash
git commit --only apps/api/src/services/ebay-shared-membership-rows.ts apps/api/src/services/ebay-shared-membership-rows.vitest.test.ts -m "feat(ebay): synthesize shared-child rows from memberships (shared-mgmt / Task 3)"
```

### Task 4: Wire synthesis into `GET /ebay/flat-file/rows`

**Files:** `apps/api/src/routes/ebay-flat-file.routes.ts` (after the `ebay_item_id` propagation, ~line 117).

- [ ] **Step 1:** After the propagation loop and before `return reply.send({ rows })`, insert:
```ts
// Shared-SKU management: append a row for each shared child under every parent listing it belongs to.
try {
  const parentRows = rows.filter(r => (r as Record<string, unknown>)._isParent === true)
  const sharedRows = await loadSharedMembershipRows(prisma, parentRows, rows)
  rows.push(...sharedRows)
} catch (err) {
  request.log.error(err, 'ebay/flat-file/rows: shared membership synthesis failed (non-fatal)')
}
```
Import `loadSharedMembershipRows` at the top. (Non-fatal: a synthesis failure must never break the normal grid load.)
- [ ] **Step 2:** `cd apps/api && npx tsc --noEmit`. (Route behavior is exercised by Task 3's unit tests + Task 8 live verify; no new route unit test required — note this in the report.)
- [ ] **Step 3:** Commit.
```bash
git commit --only apps/api/src/routes/ebay-flat-file.routes.ts -m "feat(ebay): GET /rows appends synthesized shared-membership rows (shared-mgmt / Task 4)"
```

### Task 5: Grid — synthesized shared rows are read-only + visually marked (client)

**Files:** `apps/web/src/app/products/ebay-flat-file/EbayFlatFileClient.tsx` (surgical).

- [ ] **Step 1:** Add `_shared?: boolean` and `_readonly?: boolean` to the `EbayRow` type (near line 79).
- [ ] **Step 2:** In the cell edit-guard (where the grid decides if a cell is editable), return non-editable when `(row as EbayRow)._readonly === true` — EXCEPT leave existing behavior for non-`_readonly` rows unchanged. (If there is no central editable check, gate the `updateCell` handler: `if ((row as EbayRow)._readonly) return`.)
- [ ] **Step 3:** In the SKU cell renderer (the `renderCellContent` `sku` branch, ~line 1018), when `(row as EbayRow)._shared`, append a small Badge `"Shared"` (design-system `Badge`, subtle/indigo) so the operator can see the row is a membership view.
- [ ] **Step 4:** `cd apps/web && npx tsc --noEmit` clean.
- [ ] **Step 5:** Commit.
```bash
git commit --only apps/web/src/app/products/ebay-flat-file/EbayFlatFileClient.tsx -m "feat(ebay): mark synthesized shared rows read-only + Shared badge (shared-mgmt / Task 5)"
```

### Task 6: `validateRows` — allow same SKU across distinct shared families (client)

(Folded from the superseded Option-A plan.) Add a pure helper `isSharedDuplicateAllowed(sku, allRows)` that returns true iff the SKU's occurrences span ≥2 DISTINCT family keys AND every such family's parent has `shared_sku_listing === true`; wire it into the dup branch at line ~129 so the duplicate is downgraded from `error` when allowed. Create `validateRows.sharedsku.vitest.test.ts` with the four cases (two shared parents → allowed; two non-shared → error; same family twice → error; mixed → error). Full code + tests as specified in `2026-07-02-ebay-shared-sku-flatfile-unblock-persist.md` Task 3. Commit with message `feat(ebay): allow same SKU across distinct shared families in validateRows (shared-mgmt / Task 6)`.

### Task 7: Create-on-save for new member Products + shared-aware pre-pass (server)

(Folded from the superseded Option-A plan Task 1.) Evolve `ebay-flat-file-create.logic.ts` + `.service.ts` + the PATCH route: fix the P1.2 review bug (drop `tempRowIdsInPayload`, query all `platformProductId`s for `candidateParentIds`); add `sharedFamilyKeys` to the planner so re-parents inside shared families are SUPPRESSED (a shared child's parentId must not thrash — memberships own that linkage); derive `sharedFamilyKeys` from `rows` (parents with `shared_sku_listing`) in the route and pass to `runEbayFlatFileCreates`; apply the P1.2-review minors. Full steps/code as in `2026-07-02-ebay-shared-sku-flatfile-unblock-persist.md` Task 1 (plus the `sharedFamilyKeys` suppression). New-member child Products are created so `createSharedListing`'s SKU-fallback (Task 2) links `membership.productId` → fan-out syncs. Commit `feat(ebay): shared-aware create pre-pass + P1.2 fixes (shared-mgmt / Task 7)`.

### Task 8: End-to-end verification on a scratch family (GATED live — controller runs)

Writes to live eBay + DB. Do NOT run until Tasks 1–7 pushed + deployed, the migration applied on user go, AND the user confirms the scratch family.
- [ ] **Step 1:** Controller applies the Task 1 migration on prod (`-pooler` stripped) and pushes Tasks 1–7 (pre-push hook must pass). Railway + Vercel deploy.
- [ ] **Step 2:** In the flat file (no `familyId` → all families), enter the SAME child SKU under TWO parent SKUs at DIFFERENT prices; flag both parents `shared_sku_listing`. Confirm the dup SKU is no longer blocked (Task 6).
- [ ] **Step 3:** Save → confirm a single `Product` exists for a new member SKU (Task 7).
- [ ] **Step 4:** Push both families → confirm two ItemIDs + two `SharedListingMembership` rows, each with the correct per-listing `price` and a non-null `productId` (Tasks 2).
- [ ] **Step 5:** Reload the sheet → confirm the shared child now appears under BOTH parents (synthesized rows, `Shared` badge, read-only) with the two different prices (Tasks 3–5).
- [ ] **Step 6:** Change the shared SKU's stock → confirm both listings' quantities fan out (existing engine + Task 2 productId link).
- [ ] **Step 7:** Record results in the SDD ledger; report to user.

---

## PHASE 2 (outline — detail after Phase 1 ships + live behavior observed)
- `ebay-trading-api.service.ts`: add `buildReviseFixedPriceItemXml` + `reviseFixedPriceItem(itemId, input, ctx)` (full `<Variations>` set; remove = variation `Quantity` 0 / `<Delete>` since eBay forbids dropping a sold variation).
- `POST /ebay/flat-file/shared-membership` (add / remove): add appends a `<Variation>` + `sharedListingMembership.create`; remove sets qty 0/Delete + `status:'ENDED'`.
- Make synthesized rows EDITABLE for price + per-listing qty: writes target the MEMBERSHIP (+ push via `reviseFixedPriceItem`), not the child Product. Drop `_readonly` for the editable fields.
- Revisit product decisions: qty semantics (pooled vs per-listing cap), parent-without-Product placeholder.

## Self-Review notes
- Coverage: round-trip view → Tasks 3+4; per-listing price → Tasks 1+2 (store) +3 (display); dup unblock → Task 6; create/persist new members → Task 7 (+2 link); inventory sync → existing engine (reached via Task 2 productId). Live-listing edit (price/add/remove) explicitly deferred to Phase 2.
- Non-shared families unaffected: synthesis only runs for parents with ACTIVE memberships; validateRows helper false unless parents shared; Task 7 suppresses reparent only for shared family keys.
- Migration is additive/nullable (no data risk); still user-gated per repo policy.
