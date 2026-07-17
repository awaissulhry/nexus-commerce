# AMX — Amazon Import Excellence: total control, every scenario

**Date:** 2026-07-17 · **Status: PROPOSAL — AWAITING OWNER GATE** · Owner ask: "proper control over each and everything… best in class… no errors… consider each and every scenario." Companion to the shipped EI series (eBay) — this closes the gap the other way.

**Protected surfaces honored:** flat-file editors untouched without approval (this IS the approval request); FBA-quantity invariant never weakened; pool never written; design system only; legacy import untouched.

---

## 0. Ground truth — the Amazon import TODAY (verified in code 2026-07-17)

The Amazon wizard is already the strongest importer in the app (A-series + FX suite, all shipped and prod-verified this week):

| Capability | State |
|---|---|
| Amazon official templates (.xlsm, v2 + legacy) | ✅ detected in ~30 ms, banner (id/market/types/action histogram), market auto-switch, per-template presets |
| Multi-sheet / header-row control | ✅ A2b |
| Mapping | ✅ 100% deterministic on real templates (template-path tier), exhaustive columns by construction (A4C, coverage sentinel `uncovered: []`), AI tail for leftovers (gated on prod AI provider) |
| Typed coercion (server) | ✅ enum canonicalization (exact/case/normalized), EU-locale numbers, booleans, maxLength — with per-cell issue records |
| Preflight at preview | ✅ validate-rows (required/enum/length/GPSR/deprecated/locked-attribute warnings) chips per new row |
| Cell-level plan | ✅ from→to per cell, willApply + reason, per-cell checkboxes, group toggle-all, live re-plan on policy change |
| Policies | ✅ Qty OFF / Prices ON (owner defaults); FBA belt (FBA rows never import qty) |
| Destructive gating | ✅ delete-action rows excluded + typed-DELETE override → routed through removeFromAmazon |
| Duplicates in file | ✅ deduped (first wins), count shown ("N duplicates merged") |
| Round-trip | ✅ A7 vault + Export for Amazon (.xlsm), 5/5 real files identity-verified |

**The honest remaining gaps** (each verified, with file/line evidence):

1. **No family review.** The wizard has zero parentage awareness (`grep parentage ImportWizardModal.tsx` → nothing). A 41-row AIREON file is one flat list: no per-family grouping, no per-family decision, and the four family-integrity scenarios surface LATE (at submit preflight) or never:
   - re-parenting is visible only as a `parent_sku` cell diff buried among hundreds of cells — not badged;
   - an orphan child (parent in neither file nor grid) only errors at submit (G.1);
   - a `variation_theme` / `product_type` mismatch between a child and its family is not checked at import;
   - a partial file for a NEW family creates an incomplete family with no completeness signal.
2. **Coerce issues are a count, not locations.** "7 values flagged" renders with no list, no per-cell tint, no way to find them (`flaggedCount` only, ImportWizardModal:517/804). The eBay wizard now shows every issue inline — Amazon should too.
3. **Policies stop at qty/price.** No Content / Images / Compliance / other group toggles (EI.3 has five). Amazon's manifest GROUPS make this generic — per-group toggles, not hardcoded lists.
4. **Localized enum values match by string luck.** Manifest columns carry `optionCodes` + localized labels (flat-file.service:851-905), but `coerceValue` matches `options` only. A DE file's localized dropdown value should canonicalize to the submit-expected form deliberately, with a per-cell note — today it depends on which form the manifest happened to store.
5. **Silent belts.** The FBA qty strip happens without a count ("FBA rows never import quantity regardless" — comment, no UI); delete exclusions and duplicate merges are counts without row lists. "No errors" requires *visible* belts.
6. **No post-apply report.** After Apply the wizard closes; there is no persistent "what just happened" panel (EI.6 parity: N cells applied / M new rows / K qty cells stripped as FBA / deletes armed / duplicates dropped — with a jump-to-changed-rows filter), and imports aren't labeled in version history.
7. **One file at a time.** The owner's real workflow is IT→DE→ES→FR back-to-back (A6). Market auto-switch per file works, but there's no queue: drop 4 files, process sequentially with one combined report.

## 1. Design — phases

### AMX.1 — Family review step (the big one)
Amazon-flavored EI.2: after mapping+coercion, group rows into families (parentage_level/parent_sku), render a **Review families** step — per family: parent SKU, product type, theme, child count, New/Update mix, and badges for the four integrity scenarios (re-parent from→to, orphan child, theme/type mismatch, new-family completeness vs required axes). Per-family decision: **Import / Skip**. Pure module + tests (mirrors `importBlocks.pure.ts`).

### AMX.2 — Visible belts + per-cell issues + generic policy groups
- Coerce issues: inline list + tint on the exact plan cells, count → locations.
- One "what will happen" summary strip: cells applying, new rows, **FBA qty cells stripped (count + SKUs)**, delete rows excluded/armed, duplicates merged (with SKUs), unmatched skipped.
- Policy toggles generalized to manifest groups (Content, Images, Compliance, Dimensions…) — qty/price keep their owner defaults; everything togglable.

### AMX.3 — Localized-value intelligence
`coerceValue` matches against `optionCodes` AND localized labels, canonicalizing to the submit-expected form with a per-cell "matched DE label → code" note. Per-market correctness proven with DE/ES/FR template fixtures (the A4C smoke files).

### AMX.4 — Post-apply report + labeled history
Persistent grid banner after apply (EI.6 parity) with the summary + a one-click filter to just-changed rows; version-history entries stamped "import: <filename>".

### AMX.5 — Multi-file queue (A6 completed)
Drop several files (or re-invoke wizard without closing): sequential per-file flow with remembered per-template presets, market auto-switch per file, one combined final report across markets.

### AMX.6 — Verification
Scenario ledger (below) turned into fixtures + tests; runbook section beside `docs/xlsm-hybrid-runbook.md` §4; owner E2E = the real 4-market AIREON pass.

## 2. Scenario ledger (the "every scenario" contract)

| # | Scenario | Today | After |
|---|---|---|---|
| 1 | Re-parent via changed parent_sku | cell diff, unbadged | AMX.1 badge + per-family decision |
| 2 | Orphan child (parent nowhere) | errors at submit | AMX.1 badge at import |
| 3 | Child type ≠ family type | unchecked | AMX.1 badge |
| 4 | Theme mismatch vs family | unchecked | AMX.1 badge |
| 5 | New family partial (missing axes/sizes) | silent | AMX.1 completeness badge |
| 6 | FBA row with qty in file | stripped silently | AMX.2 counted + listed |
| 7 | Delete rows | typed-DELETE ✅ | unchanged (+ in summary) |
| 8 | Duplicate SKUs in file | merged, count only | AMX.2 SKU list |
| 9 | Localized dropdown values (DE/ES/FR) | string-luck match | AMX.3 deliberate code canonicalization |
| 10 | Flagged values (bad number/enum) | count only | AMX.2 located + tinted |
| 11 | Wrong-market file | template banner + switch ✅ | unchanged |
| 12 | Multi-sheet/odd header | A2b ✅ | unchanged |
| 13 | 4-market session | manual per file | AMX.5 queue + combined report |
| 14 | "What did that import do?" | toast, gone | AMX.4 persistent report + history label |
| 15 | Amazon template round-trip | A7 ✅ 5/5 identity | unchanged |

## 3. Owner decision points

1. **Scope order** — recommend AMX.1 → AMX.2 → AMX.4 (control + visibility first), then AMX.3 → AMX.5, AMX.6 throughout.
2. **Per-group policy defaults** — all ON except Qty (owner's standing default). Confirm.
3. **AMX.5 queue** — worth it now, or after your 4-market E2E pass exercises the single-file flow? Recommend: build it now; the workflow is yours weekly.

## 4. Exit criteria

The real AIREON IT→DE→ES→FR files imported in one queued session: families reviewed (0 unexpected badges), every flagged cell locatable, FBA strips counted, per-market localized values canonicalized to codes, combined report accurate, grid submit preflight clean, and `import(export(grid))` still a no-op.
