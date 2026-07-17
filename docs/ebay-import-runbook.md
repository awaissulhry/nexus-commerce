# eBay Import — Verification Runbook

**Scope:** the dynamic eBay flat-file import (plan: `docs/superpowers/plans/2026-07-17-ebay-import-excellence.md`) plus the shared-SKU multi-listing model it feeds (E2 + the duplicate-SKU fix `ba28fe74`).

## 1. What shipped (EI series, 2026-07-17)

| Phase | What | Where |
|---|---|---|
| Fix | Duplicate-SKU publish blocker: text-boolean coercion at both doors, family resolution for file-linked/_shared rows, structural shared flag, **adopt-don't-duplicate belt** (a row with a live ItemID never re-lists) | `ba28fe74` |
| EI.1 | Typed coercion (booleans/EU numbers/strict enums canonicalized by option AND label — policy names → ids/multi-value themes/maxLength warns/junk drop) + per-cell issues; File-market selector scopes per-market columns ("Item ID" is deliberate, never column-order luck) | `importCoerce.pure.ts`, wizard |
| EI.2 | Review-listings step: blocks from parentage/parent_sku/ItemID, pooled-SKU badges, per-block **Adopt/Create/Skip** (Adopt default with a live ItemID), one-click "Flag all as Shared-SKU" | `importBlocks.pure.ts`, wizard |
| EI.3 | Import policies (Prices/Quantities/Content/Images/Business policies — all ON; identity+structure+aspects always import; **pool never written**), destructive rows (end/deactivate) behind typed-END, cell-level from→to plan with per-cell exclusion | `importPlan.pure.ts`, wizard |
| EI.4 | Sheet picker + header-row override on `/ebay/flat-file/parse` (workbook block on every Excel parse) | routes + wizard |
| EI.5 | Aspect header unification (dual Italian/EN sets fold into ONE canonical aspect column; ghost columns synthesized; `variantAttributes ⚠` auto-skips); text-category flags; category-required item-specifics report | `importAspects.pure.ts`, wizard |
| EI.6 | "Save wired up" banner (products created, memberships created/updated/skips, pool-untouched note) + per-ItemID **Verify** via read-only `GET /ebay/flat-file/verify-item` (Trading GetItem vs saved memberships: matched/missing/extra/not-pool-linked) | routes + client |

## 2. Invariants

- **The stock pool is never written by import or save** (FM Phase 1). Imported quantities are per-listing eBay quantities.
- **A row carrying a live ItemID is never re-listed** — publish skips with "Save the sheet to adopt"; memberships adopt on save. This holds even if the operator publishes before saving.
- **Amazon SKUs…** n/a here; **eBay child SKUs are case-sensitive custom labels** — matching is exact.
- Destructive `end`/`deactivate` rows never import silently; typed END required.
- Shared-SKU flag is structural: file value applies under BOTH merge modes.

## 3. Regression battery

```bash
# Pure import stack + full eBay web suite
cd apps/web && npx vitest run src/app/products/ebay-flat-file/
# expected: 21 files / 205+ tests green (importCoerce 7, importBlocks 8, importPlan 9, importAspects 7, sharedsku 10)

# Server eBay suite (memberships, shared push incl. adopt belt, create planner)
cd apps/api && npx vitest run $(find src -name '*.vitest.test.ts' | grep -iE 'ebay' | tr '\n' ' ')
# expected: 38+ files / 541+ tests green

# Typecheck + DS ratchet
cd apps/web && npx tsc --noEmit && cd ../api && npx tsc --noEmit
node scripts/ds-conformance-guard.mjs --manifest products   # must not exceed baseline (16 as of EI.5)
```

## 4. Owner E2E — the GALE 5-listing file

1. eBay flat file (IT) → File → import → drag `GALE eBay IT - 5 listings XXS-5XL (import).xlsx`.
2. **Map**: File market = IT (default); expect Item ID/Price/Qty mapped to IT columns; `Taglia (Size)`/`Size ⚠` both on `aspect_Taglia`; `variantAttributes ⚠` skipped.
3. **Review listings**: 5 blocks — GALE-JACKET + 4 others, each Adopt (live ItemIDs), 20 pooled SKUs badged. If the file lacked Shared-SKU flags, the red banner's "Flag all as Shared-SKU" fixes all blocks in one click.
4. **Preview**: policies all ON; no destructive rows; plan shows updates to the existing family + new rows for the 4 new parents; Import.
5. **Save** → "Save wired up" banner: 4 products created · 5 listings · ~100 memberships created · pool untouched. Click **Verify** per ItemID → expect `Active · 20/20 SKUs matched`.
6. **Publish** → primary family pushes; the 4 adopted listings report "already live (ItemID …) — Save the sheet to adopt" only if publish ran before save; after a save they simply skip as already-membershiped. No duplicate-SKU errors anywhere.
7. Change one pooled SKU's stock on /stock → all 5 eBay listings' quantities update via the fan-out (watch OutboundSyncQueue TRADING entries).

## 5. Gotchas

- `/ebay/flat-file/parse` rejects Amazon official templates with a redirect hint (A3.1a) — that's intentional.
- The wizard's aspect tier only folds `X (Y)` and `X ⚠` shapes; a bare unmatched header still lands in Unmapped for manual mapping.
- `verify-item` returns `DRY-RUN` status when `NEXUS_EBAY_REAL_API` isn't enabled (non-prod) — memberships comparison still runs.
- The Combobox target list scopes per-market columns to the wizard's File market; switching market re-runs auto-map and resets block decisions/cell exclusions.
