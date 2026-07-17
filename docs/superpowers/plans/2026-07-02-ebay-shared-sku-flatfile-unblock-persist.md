# eBay Shared-SKU Flat-File — Unblock + Persist (Option A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator put the SAME child variant SKU under MULTIPLE eBay parent listings from the flat file (different parent SKUs → different ItemIDs → one synced inventory pool), by unblocking the flat-file's duplicate-SKU guard for shared families and persisting new member child Products on save so the membership fan-out can sync their stock.

**Architecture:** The shared-SKU engine already exists on `main` (Phases 1–4: `SharedListingMembership` model, `createSharedListing`/`pushSharedListings` Trading-API push, stock fan-out via `enqueueSharedTradingFanout`, and the `shared_sku_listing` parent flag + push routing). This plan closes the three gaps that stop the flat-file workflow: (1) `validateRows()` rejects a duplicate SKU across the sheet; (2) new member SKUs are never created as Products on save, so `SharedListingMembership.productId` is `null` and the fan-out can't sync them; (3) `createSharedListing` only reads `row._productId` and never falls back to a SKU lookup. We reuse the pure create logic already shipped in P1.1 (`ebay-flat-file-create.logic.ts`) and make the P1.2 save pre-pass shared-aware.

**Tech Stack:** TypeScript, Fastify (apps/api), Prisma (packages/database), Next.js/React (apps/web), Vitest (`*.vitest.test.ts`, run `cd apps/api && npx vitest run <path>` or `npx vitest run <web path>` from repo root).

## Global Constraints

- The eBay flat-file page + routes (`apps/web/src/app/products/ebay-flat-file/**`, `apps/api/src/routes/ebay-flat-file.routes.ts`) are "untouchable" without approval. THIS engagement is the approval. Changes must be ADDITIVE & surgical; do not restructure `validateRows` or the grid — only add the shared-family exception.
- Do NOT change behavior for NON-shared families: a duplicate SKU in a normal (non-`shared_sku_listing`) family stays a hard error; normal single-parent create/re-parent (P1.2) is unchanged for them.
- Product creation touches the live DB. Code lands + deploys; the actual live shared-listing test (Task 4) is a SEPARATE gated step on a scratch family — confirm before running.
- Preserved config tables (ChannelConnection/Marketplace/OAuth/API keys) are never touched. Creation touches only `Product` (+ existing ChannelListing/membership flows).
- Verify locally via vitest + `cd apps/api && npx tsc --noEmit` (and `apps/web` tsc for the client change). No Docker/live DB in unit tests — use mock prisma.
- A shared child's `SharedListingMembership.productId` MUST be set (non-null) for the fan-out to sync its stock (fan-out filters memberships by `productId`).
- Commit locally with `git commit --only <files>`; controller owns pushes (never `--no-verify`).

## Baseline / disposition of prior work

Three local, unpushed commits exist on `main` from the abandoned single-parent approach:
- `a0d70bc0` P1.1 — pure planner/builder (`ebay-flat-file-create.logic.ts`) — **KEEP & REUSE** (builder + `extractVariantAttributes` are shared-model-agnostic).
- `6b52081a` P1.1 review fixes — **KEEP**.
- `5de94779` P1.2 — create pre-pass + service + route wiring — **EVOLVE** (Task 1 fixes its outstanding review bug AND makes it shared-aware). Its create path is reused; its re-parent step is skipped for shared families.

Decision (revisit if wrong): a newly-created shared member Product keeps `parentId = the parent it was entered under` (P1.2's existing behavior) — harmless because push grouping uses row state, not DB `parentId`, and the `SharedListingMembership` table is the real multi-listing source of truth. Round-tripping the same SKU as multiple rows on reload is explicitly out of scope (that is Option B).

## File Structure

- `apps/api/src/services/ebay-flat-file-create.logic.ts` — MODIFY: pure planner gains a `sharedFamilyKeys` input so re-parents inside shared families are suppressed. (Reuses existing builder/extractor unchanged.)
- `apps/api/src/services/ebay-flat-file-create.logic.vitest.test.ts` — MODIFY: add shared-family planner cases + the outstanding P1.1-review regression test (parent row in payload).
- `apps/api/src/services/ebay-flat-file-create.service.ts` — MODIFY: fix the `candidateParentIds` bug (drop `tempRowIdsInPayload`); pass `sharedFamilyKeys` into the planner; minor cleanups (remove `prisma as any` need, P2002 target assert, shadowing, doc comment).
- `apps/api/src/services/ebay-flat-file-create.service.vitest.test.ts` — MODIFY: add existing-parent-in-payload test + shared-skip-reparent test.
- `apps/api/src/routes/ebay-flat-file.routes.ts` — MODIFY (surgical): pass `sharedFamilyKeys` (derived from rows) into `runEbayFlatFileCreates`; remove the redundant `prisma as any`.
- `apps/api/src/services/ebay-shared-listing-push.service.ts` — MODIFY: `createSharedListing` resolves `productId` by SKU lookup when `row._productId` is absent; wrap membership creation in `$transaction`.
- `apps/api/src/services/ebay-shared-listing-push.service.vitest.test.ts` — MODIFY: add SKU-fallback + transactional-write tests.
- `apps/web/src/app/products/ebay-flat-file/EbayFlatFileClient.tsx` — MODIFY (surgical, approved exception): `validateRows` allows a duplicate SKU when its occurrences span ≥2 DISTINCT shared families.
- `apps/web/src/app/products/ebay-flat-file/validateRows.sharedsku.vitest.test.ts` — CREATE: unit tests for the relaxation (extract the pure check or test `validateRows` directly if exported).

---

### Task 1: Shared-aware create service (fix P1.2 bug + suppress re-parent for shared families)

**Files:**
- Modify: `apps/api/src/services/ebay-flat-file-create.logic.ts` (`planEbayFamilyCreates` gains `sharedFamilyKeys`)
- Modify: `apps/api/src/services/ebay-flat-file-create.service.ts` (`runEbayFlatFileCreates`: fix candidateParentIds, derive+pass sharedFamilyKeys, cleanups)
- Modify: `apps/api/src/routes/ebay-flat-file.routes.ts` (derive sharedFamilyKeys from rows, pass to service, drop `prisma as any`)
- Test: `apps/api/src/services/ebay-flat-file-create.logic.vitest.test.ts`, `...service.vitest.test.ts`

**Interfaces:**
- Consumes: `buildEbayProductCreateInput`, `extractVariantAttributes` (unchanged, from `ebay-flat-file-create.logic.ts`).
- Produces: `planEbayFamilyCreates({ rows, existingBySku, existingParentById, sharedFamilyKeys })` — new optional `sharedFamilyKeys: Set<string>`; when a re-parent candidate's family key ∈ sharedFamilyKeys, the re-parent is suppressed (emitted as a `warnings` entry, not a `reparents` entry). `runEbayFlatFileCreates(prisma, rows, opts?: { sharedFamilyKeys?: Set<string> })`.

- [ ] **Step 1: Add the P1.1-review regression test (currently failing) — parent row present in payload.** In `...logic.vitest.test.ts`, add a case: an existing parent row with `_rowId === _productId === 'P_real'` present in the payload alongside a NEW child whose `platformProductId === 'P_real'`; supply `existingParentById` with `P_real`. Assert the child resolves to `{ kind: 'existing', productId: 'P_real' }` (not `unresolved parent`). This locks the candidateParentIds fix.

- [ ] **Step 2: Fix `candidateParentIds` in the service.** In `ebay-flat-file-create.service.ts`, delete the `tempRowIdsInPayload` construction and change `candidateParentIds` to every non-empty `platformProductId` in the payload (temp client `_rowId`s are cuid/nanoid and won't match real product ids in the DB `findMany`, and the planner already prioritizes temp parents):

```ts
const candidateParentIds = [
  ...new Set(
    rows.map(r => String(r.platformProductId ?? '').trim()).filter(Boolean),
  ),
]
```

- [ ] **Step 3: Add `sharedFamilyKeys` to the planner.** In `planEbayFamilyCreates`, accept `sharedFamilyKeys?: Set<string>` (default empty). Where a re-parent entry is produced, if `sharedFamilyKeys.has(String(row.platformProductId ?? ''))` OR `sharedFamilyKeys.has(existing.parentId ?? '')`, push `{ sku, reason: 'reparent suppressed: shared family (membership-managed)' }` to `warnings` instead of adding to `reparents`.

- [ ] **Step 4: Add the shared-skip-reparent planner test.** In `...logic.vitest.test.ts`: existing child (`sku` in `existingBySku`, `parentId: 'A'`), `platformProductId: 'B'`, with `sharedFamilyKeys = new Set(['B'])`. Assert `reparents` is empty and `warnings` has one entry. Without `sharedFamilyKeys`, assert the same input still produces one `reparents` entry (regression guard).

- [ ] **Step 5: Derive + pass `sharedFamilyKeys` in the service + route.** In `runEbayFlatFileCreates`, accept `opts?: { sharedFamilyKeys?: Set<string> }` and thread it into `planEbayFamilyCreates`. In `ebay-flat-file.routes.ts`, before the pre-pass call, derive the set from the family parents that carry the shared flag and pass it; drop the redundant cast:

```ts
const sharedFamilyKeys = new Set(
  rows
    .filter(r => (r as Record<string, unknown>).shared_sku_listing === true)
    .map(r => String(r._productId ?? r._rowId ?? r.platformProductId ?? ''))
    .filter(Boolean),
)
const createResult: CreateResult = await runEbayFlatFileCreates(prisma, rows, { sharedFamilyKeys })
```

- [ ] **Step 6: Minor review cleanups (from P1.2 review).** (a) Assert P2002 target includes `sku` before idempotent recovery: `const t = (err as { meta?: { target?: unknown } })?.meta?.target; const isSkuP2002 = code === 'P2002' && (Array.isArray(t) ? t.includes('sku') : String(t ?? '').includes('sku'));` — use `isSkuP2002` in place of the bare `code === 'P2002'`. (b) Rename the shadowing map callback param `p` → `row` at the `existingProductRows.map(...)` site. (c) Fix the `CreateResult.idMap` doc comment (reparents go to `reparented`, never `idMap`).

- [ ] **Step 7: Run tests + typecheck.**

Run: `cd apps/api && npx vitest run src/services/ebay-flat-file-create.logic.vitest.test.ts src/services/ebay-flat-file-create.service.vitest.test.ts`
Expected: all pass (including the new regression + shared-skip cases).
Run: `cd apps/api && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 8: Commit.**

```bash
git commit --only apps/api/src/services/ebay-flat-file-create.logic.ts apps/api/src/services/ebay-flat-file-create.logic.vitest.test.ts apps/api/src/services/ebay-flat-file-create.service.ts apps/api/src/services/ebay-flat-file-create.service.vitest.test.ts apps/api/src/routes/ebay-flat-file.routes.ts -m "feat(ebay): shared-aware create pre-pass + P1.2 review fixes (shared-SKU A / Task 1)"
```

---

### Task 2: `createSharedListing` — resolve productId by SKU + transactional membership writes

**Files:**
- Modify: `apps/api/src/services/ebay-shared-listing-push.service.ts` (`createSharedListing`)
- Test: `apps/api/src/services/ebay-shared-listing-push.service.vitest.test.ts`

**Interfaces:**
- Consumes: existing `SharedListingCtx` (has `db` seam for tests), `buildSharedListingInput`, `addFixedPriceItem`.
- Produces: `createSharedListing` behavior unchanged EXCEPT `productIdBySku` is backfilled from a `product.findMany({ where: { sku: { in }, deletedAt: null } })` lookup for any variant whose `row._productId` is absent, and the per-variant membership `create` calls run inside `db.$transaction`.

- [ ] **Step 1: Write the failing SKU-fallback test.** In the service test, build a `ctx.db` mock where `product.findMany` returns `[{ id: 'prod-1', sku: 'SHARED-M' }]` and variant rows have NO `_productId`. Call `createSharedListing`. Assert the created membership for `SHARED-M` has `productId: 'prod-1'` (not `null`). Run it → FAIL (current code sets `null`).

- [ ] **Step 2: Implement the SKU fallback.** After building `productIdBySku` from `row._productId`, collect SKUs still missing a productId and resolve them:

```ts
const missing = [...productIdBySku.entries()].filter(([, id]) => !id).map(([sku]) => sku)
if (missing.length) {
  const found = await db.product.findMany({ where: { sku: { in: missing }, deletedAt: null }, select: { id: true, sku: true } })
  for (const f of found) productIdBySku.set(f.sku, f.id)
}
```

- [ ] **Step 3: Wrap membership writes in a transaction.** Replace the per-variant `await db.sharedListingMembership.create(...)` loop with a single `await db.$transaction(input.variations.map(v => db.sharedListingMembership.create({ data: { ...same fields... } })))`. Keep the existing `SKIPPED_EXISTS` pre-check and the returned `count`. (Fixes the known non-transactional-write issue.)

- [ ] **Step 4: Run the tests.**

Run: `cd apps/api && npx vitest run src/services/ebay-shared-listing-push.service.vitest.test.ts`
Expected: all pass (SKU-fallback test now GREEN; existing 25 tests still pass).
Run: `cd apps/api && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit.**

```bash
git commit --only apps/api/src/services/ebay-shared-listing-push.service.ts apps/api/src/services/ebay-shared-listing-push.service.vitest.test.ts -m "feat(ebay): shared membership resolves productId by SKU + transactional writes (shared-SKU A / Task 2)"
```

---

### Task 3: Relax `validateRows` duplicate-SKU for shared families (client)

**Files:**
- Modify: `apps/web/src/app/products/ebay-flat-file/EbayFlatFileClient.tsx` (`validateRows`, ~line 107–129)
- Test: `apps/web/src/app/products/ebay-flat-file/validateRows.sharedsku.vitest.test.ts` (CREATE)

**Interfaces:**
- Consumes: `EbayRow` fields `sku`, `platformProductId`, `_isParent`, `shared_sku_listing`, `_productId`, `_rowId`.
- Produces: a duplicate SKU is downgraded from `error` to allowed (no issue) when ALL its occurrences belong to families whose parent has `shared_sku_listing === true` AND those occurrences span ≥2 DISTINCT family keys. Otherwise the duplicate stays a hard `error`. Non-duplicate validation is unchanged.

- [ ] **Step 1: Extract a pure helper `isSharedDuplicateAllowed(sku, allRows)`** (module-scope, exported for test) that returns true iff: the rows in `allRows` with that `sku` map to ≥2 distinct family keys (`platformProductId ?? _productId ?? _rowId`), and for every such row the family's parent (the row in `allRows` whose `_isParent === true` and whose id equals that family key, or the row itself if it is the parent) has `shared_sku_listing === true`.

```ts
export function isSharedDuplicateAllowed(sku: string, allRows: EbayRow[]): boolean {
  const occ = allRows.filter(r => String(r.sku ?? '').trim() === sku)
  if (occ.length < 2) return false
  const familyKeyOf = (r: EbayRow) => String(r.platformProductId ?? r._productId ?? r._rowId ?? '')
  const keys = new Set(occ.map(familyKeyOf))
  if (keys.size < 2) return false // same family twice = real error
  const parentSharedByKey = (key: string) => {
    const parent = allRows.find(r => r._isParent === true && String(r._productId ?? r._rowId ?? r.platformProductId ?? '') === key)
    return (parent ?? occ.find(o => familyKeyOf(o) === key))?.shared_sku_listing === true
  }
  return [...keys].every(parentSharedByKey)
}
```

- [ ] **Step 2: Write failing tests** in `validateRows.sharedsku.vitest.test.ts`: (a) same SKU under two shared parents → `isSharedDuplicateAllowed` true; (b) same SKU under two NON-shared parents → false; (c) same SKU twice under ONE parent → false; (d) same SKU under one shared + one non-shared → false. Run → FAIL (helper not yet imported/among exports if TDD-first; write helper in Step 1 then these pass).

- [ ] **Step 3: Wire the helper into `validateRows`.** Change line ~129 so the duplicate branch defers to the helper:

```ts
if ((skuCount.get(sku) ?? 0) > 1 && !isSharedDuplicateAllowed(sku, allRows as EbayRow[])) {
  issues.push({ level: 'error', sku, field: 'sku', msg: 'Duplicate SKU — each listing needs a unique SKU' })
}
```

- [ ] **Step 4: Run tests + web typecheck.**

Run: `npx vitest run apps/web/src/app/products/ebay-flat-file/validateRows.sharedsku.vitest.test.ts`
Expected: all pass.
Run: `cd apps/web && npx tsc --noEmit` (or the web typecheck script)
Expected: clean for this file.

- [ ] **Step 5: Commit.**

```bash
git commit --only apps/web/src/app/products/ebay-flat-file/EbayFlatFileClient.tsx apps/web/src/app/products/ebay-flat-file/validateRows.sharedsku.vitest.test.ts -m "feat(ebay): allow same SKU across distinct shared families in validateRows (shared-SKU A / Task 3)"
```

---

### Task 4: End-to-end verification on a scratch family (GATED live step — controller runs, not a subagent)

**Files:** none (verification only).

This step writes to the live eBay account + DB. Do NOT run until Tasks 1–3 are pushed + deployed AND the user explicitly confirms the scratch family to use.

- [ ] **Step 1:** Controller pushes Tasks 1–3 to `main` (pre-push hook must pass: schema-drift, i18n, link-targets, UI-token, web build, api build). Railway + Vercel auto-deploy.
- [ ] **Step 2:** On a scratch family, in the eBay flat file: enter (or add) the SAME child variant SKU under TWO different parent SKUs; set `shared_sku_listing = true` on BOTH parent rows. Confirm the grid no longer blocks the duplicate SKU (Task 3).
- [ ] **Step 3:** Save. Confirm via `scripts/_ebay-*`-style read (or DB query) that a `Product` exists for any new member SKU (Task 1) — one Product per SKU, not duplicated.
- [ ] **Step 4:** Push both families. Confirm two distinct eBay ItemIDs are returned and two sets of `SharedListingMembership` rows exist, EACH with a non-null `productId` (Task 2).
- [ ] **Step 5:** Change the shared SKU's stock (e.g., via a stock movement). Confirm the fan-out enqueues a `QUANTITY_UPDATE` for BOTH ItemIDs and both listings reflect the new quantity (Phase 3 engine + Task 2's productId link).
- [ ] **Step 6:** Record results in the SDD ledger; report to the user.

---

## Self-Review notes
- Spec coverage: G-block → Task 3; G-persist → Task 1 (create) + Task 2 (link productId); inventory sync → existing Phase 3 engine, made reachable by Task 2's non-null productId. Round-trip/view + incremental live edits are explicitly deferred (Options B/C).
- No new migration (SharedListingMembership + platformAttributes flag already exist).
- Non-shared families: Task 3 helper returns false unless parents are shared; Task 1 suppresses reparent only for shared family keys — normal families unaffected.
