# EI — eBay Import Excellence: fully dynamic, operator-controlled import

**Date:** 2026-07-17 · **Status: PROPOSAL — AWAITING OWNER GATE** · Owner ask: "completely dynamic, especially the import from file feature for the eBay flat file. Proper control over each and everything… best in class." Child SKUs stay identical across listings (inventory pooling) — that model is now unblocked (`ba28fe74`) and this plan makes the import worthy of it.

**Protected surfaces honored:** flat-file editors untouched without approval (this IS the approval request); FBA/pool invariants; existing legacy import untouched; design system only.

---

## 0. Ground truth — what the eBay import is TODAY (verified in code 2026-07-17)

`EbayImportWizard.tsx` (671 lines) is a basic 3-step modal (Upload → Map → Preview):

| Area | Today | Amazon wizard (A-series, shipped) |
|---|---|---|
| Parsing | one shot, first sheet, header row 1 | template detection, sheet picker, header-row override |
| Mapping | exact/normalized label match, first-wins | manifest-driven, deterministic 100%, per-template presets |
| Ambiguity | "Item ID" label exists for EVERY market → first-wins by column order (silently wrong for DE/FR/ES files) | market-scoped columns + market auto-switch |
| Coercion | none (fixed: booleans only, `ba28fe74`) | typed coerce stage (number/enum/boolean/date) with per-cell errors |
| Validation | none in wizard — errors surface later at publish | preflight in the plan step (required/enum/length/GPSR…) |
| Merge preview | counts only (N new / N update) | full cell-level from→to diff, per-cell willApply toggles |
| Policies | none | qty OFF / price ON toggles, delete typed-override, FBA belt |
| Row actions | none (Action column ignored on import) | delete rows excluded by default + typed-DELETE arm |
| Block model | none — flat rows only | n/a (Amazon has no multi-listing blocks) |
| Post-import | toast | plan summary + per-family outcomes |
| Presets | none | per-`templateIdentifier` mapping+toggles memory |

eBay-specific machinery that EXISTS and the wizard ignores: the 81-col Nexus export format (one block per ItemID, parent+children), `SharedListingMembership` adoption on save, `planEbayFamilyCreates` (server create/reparent planner with shared-family suppression), aspect requirements in `schemaCache` (`findMissingRequiredAspects`), per-market column groups, category breadcrumbs (B3), draft store.

## 1. What broke yesterday (root causes now fixed, lessons feed this plan)

The GALE 5-listing import failed to publish ("Duplicate SKU" per listing) because: text `'TRUE'` flags failed every strict boolean check; file-linked children couldn't resolve their parents in validation; fill-missing could never flip a structural flag; and a publish-before-save would have double-listed live items (adopt belt added). **Every one of these is a class of bug a real import pipeline eliminates by design: typed coercion, a server-computed plan, and an explicit adopt/create decision per block.**

## 2. Design — phases (EI.1 → EI.7)

### EI.1 — Typed coercion + market-aware mapping (foundation)
- Reuse the Amazon approach: map against the **eBay column manifest with kinds** (text/number/enum/boolean/readonly + per-market prefix awareness), not bare labels.
- Market disambiguation: headers like "Item ID"/"Price (€)"/"Qty" resolve to the ACTIVE market's columns by default, with a per-header market chip the operator can flip (control over each and everything). A file whose per-market columns name another market (e.g. `de_item_id` or a "DE" group header) proposes a market switch like Amazon's template banner.
- Coerce stage server-side (`/ebay/flat-file/coerce` mirroring Amazon's): numbers (comma decimals), booleans (TRUE/VERO/Sì/1…), enums validated against column options (strict/soft per column), dates. Per-cell issues rendered in the wizard, never silently dropped.
- Readonly columns (Item ID, Status): importable as **identity** (adoption keys), never as content writes — labeled "used to link, not to edit".

### EI.2 — Block/family awareness in the wizard (the multi-listing heart)
- Detect the block model in the file (Parent/Child + Parent SKU + Item ID columns): show a **family tree preview** — N listings, each parent + children, shared child SKUs highlighted with a pool badge ("this SKU appears in 5 listings — stock will pool").
- Per-block decisions, defaulted smart but overridable: **Adopt** (has live ItemID → memberships on save; never re-list), **Create** (no ItemID → new listing on publish), **Skip**. This is the owner's "proper control": nothing implicit.
- Orphan/duplicate/shared-flag validation IN the wizard (same pure helpers the grid uses — `isSharedDuplicateAllowed`, `planEbayFamilyCreates` dry-run server-side) so publish-time surprises are gone by construction.
- Review-groups step (owner's E1 ask): families grouped for review; approve per family or all.

### EI.3 — Cell-level merge plan (parity with Amazon FX.5)
- Server `plan-import` for eBay: existing grid rows + incoming → per-cell from→to with willApply under fill-missing/overwrite + **structural fields** (parent_sku, variation_theme, shared_sku_listing, category) applied in both modes with explicit badges.
- Column allowlist toggles: **price ON / qty policy** (default: per-listing qty ON but pool never written — FM Phase 1 already guarantees the pool; surface that promise in the UI), content ON, images ON/OFF, policies ON/OFF.
- Action column honored: blank=upsert, `skip`, `end/deactivate` rows excluded by default behind a typed override (mirror Amazon's delete panel; eBay "End listing" is the destructive analog).

### EI.4 — Sheet/header/format control (parity with A2b)
- Multi-sheet workbooks: sheet picker + header-row override on every Excel parse (the fast `parseOoxmlSheet` walker is already in the api — wire it into the eBay `/parse`).
- Accept the Nexus 81-col export, bare CSV/TSV, pasted rows, and (stretch) eBay's own File Exchange/Seller Hub report formats — each detected and labeled with a banner like the Amazon template banner.
- Presets: per-source-signature (header-set hash) mapping + policy memory, like `tpl:{templateIdentifier}`.

### EI.5 — Aspect & category intelligence
- Aspects from the file (`Taglia (Size)`, `Colore (Color)`, `Size ⚠`…) unified into canonical aspect columns with the cased-wins rule the membership upsert already uses; per-category REQUIRED aspects validated in the wizard (schemaCache — `findMissingRequiredAspects`).
- Category by ID or by name: a category cell containing text searches the taxonomy (B3 breadcrumb service) and proposes the ID; pushes still send the ID only.
- Variation-theme reconciliation: file theme vs family theme conflicts surfaced with a one-click resolution (adopt file / keep grid).

### EI.6 — Post-import truth + adoption visibility
- Save response already returns `createResult` + `sharedMemberships` — render it: "4 listings adopted (80 memberships), 1 updated, pool untouched; fan-out live." Persistent panel, not a toast.
- One-click "Verify on eBay": per adopted ItemID, a GetItem read-back comparing variant SKUs/qty (read-only) so the operator SEES the pool wiring before trusting it.
- Import history entries (who/when/file/counts) in the existing version-history panel.

### EI.7 — Verification + runbook
- Pure-test battery per stage (coerce, block detection, plan, adopt/create routing) + an end-to-end fixture mirroring the GALE 5-listing file; runbook section in `docs/xlsm-hybrid-runbook.md`'s style; owner E2E script.

## 3. Owner decision points

1. **Qty on import** — Amazon-style default OFF, or ON for per-listing eBay qty (pool is never written either way)? Recommendation: ON (eBay per-listing qty is display/cap, pool stays authoritative), toggleable.
2. **End-listing rows** — same typed-override pattern as Amazon deletes? Recommendation: yes.
3. **Adopt-by-default** — blocks with live ItemIDs default to Adopt (never re-list). Recommendation: yes (the belt already enforces the safe half).
4. **Scope order** — EI.1+EI.2 first (they remove the whole bug class you hit), then EI.3 → EI.6. EI.4/EI.5 can land in either order.

## 4. Exit criteria

Re-import of the exact GALE 5-listing file: wizard shows 5 blocks (1 update + 4 adopt), zero validation surprises, save reports 80 memberships, publish pushes the primary family and skips-adopts the rest, fan-out syncs a test qty change to all 5 listings within a minute, and `import(export(grid))` is a no-op plan.
