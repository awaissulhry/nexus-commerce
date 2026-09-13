# Commit attribution — 2026-09-13 (COMMIT.0, read-only)

Snapshot: `git status --porcelain=v1 --untracked-files=all` at **2026-09-13 12:59:58 local**, HEAD `da1078ddf` (the only commit today, 06:29:58: the lx4/lx5 migration folders, 2 files). **1191 porcelain entries** (317 ` M` · 873 `??` · 1 ` D`); tracked diff `318 files changed, 18315 insertions(+), 8811 deletions(-)`. Nothing staged, no `.git/index.lock` at snapshot time. Every count below is against this frozen list (`attribution.json`, one row per entry); the tree kept moving after 12:59 (the ledger, at least), so re-run `git status` before committing and diff it against `group-*.txt`.

Lane: COMMIT.0, agent of [3aec8721]. Edited NO source file; ran NO state-changing git command; created only this directory and one ledger line.

## Method

For each path, in this order, the first rule that fires decides; the `method` and `evidence` fields in `attribution.json` say which:

1. **Path rule** — `docs/audits/**`, `apps/api/scripts/_*.mts`, `scripts/_*.mjs|.mts` → PROBE/SCRATCH; `docs/pes-claims.md` and the two MX docs → OTHER.
2. **Explicit JOINT table** (37 files) — a file two programmes touched, each hunk assigned from the ledger claim + the marker in the hunk's added lines (`git diff -U0`, per-hunk marker census: `R-VT-n`, `R-LX-n`, `VT.n`, `LX.n`, `P0–P3-n`, `F-LX-n`, `CLOSE.1`).
3. **Consolidation** — the 15 files in `docs/audits/2026-09-13-single-sheet/source-manifest.json`, their tests, the compatibility wrappers (`MasterSheet.tsx`/`ChannelSheet.tsx`/`index.tsx`/`ChannelScopeTab.tsx`/`viewChips.ts`, each now 2–8 added lines delegating to `ProductSheet*`), `StudioTabHost.tsx` (mounts `ProductSheetTab`), `reloadGuard.vitest.test.ts` (re-pointed at the adapter), and `scripts/check-layout-v2.mjs` (its only hunk adds the 13 consolidation files to `STAMP_FILES`). Ledger: nexus-commerce-89 at :40897/:40899/:40901/:40903.
4. **VX-MOCK** — the four `/design/variation-projection` files + the two VX docs (claims :39724, :40741).
5. **NUL sweep** — 13 files whose HEAD copies carried NUL bytes (sum **35** = LX.F2's R-LX-19 figure exactly). For 11 of them the ONLY change is the NUL → `\u001f` delimiter swap (proved by `diff <(git show HEAD:f | tr -d '\0') f` = the swapped lines only). Those 11 are other streams' files (ads, agent-fleet, ebay, KT/UFX probes, factory) → bucket **LX**, sub-tagged, because `scripts/check-no-nul-bytes.mjs` is STRICT over `git ls-files` — commit the gate without them and it reds on a clean checkout. The other two (`variantAxes.ts`, `error-grouping.service.ts`) carry a second programme's hunk and are handled by name.
6. **VT by claim** — the VT.1/VT.2/VT.3/VT.4/VT.2c/VT.F/VT.F2 claim blocks (VT.F's 67-file list at :44816) + the new-file name families (`variation-*`, `theme-change*`, `ThemeChangePlan*`, `themeChangePlan*`, `themePlanAsk*`, `AxesPanelEditor*`, `variationTheme*`, `VariationsGroup`, `variations*`, `variationMappingFilter*`).
7. **LX by claim** — LX.6 / LX.F / LX.F2 / LX.FIN / CLOSE.1 claim blocks (:41160, :41241, :44011, :45366, :47024) — CLOSE.1's paths are placed by claim: `check-table-grants.mjs`, `table-grants-baseline.json`, `check-market-languages.mjs`, `market-languages-baseline.json`, `market-languages-guard.ts` + test, `Pill.tsx` ×2, `primitives.css` ×2, `GridToolbarFold.tsx`, `toolbars/index.ts`, `toolbarFold.vitest.test.ts`, `SheetToolbar.tsx`, `FamilyBar.tsx` → **LX**; `useMasterSheetAdapter.tsx` → JOINT (consolidation+LX+VT); its R-VT-15/R-VT-16 hunks in `useMasterSheet.ts`, `useChannelSheetAdapter.tsx`, `sheetWriter.ts`, `grid.css` are VT-programme content authored by CLOSE.1 and are marked so in the JOINT owners.
8. **LX by list** — `docs/audits/2026-09-13-lx-revert/files-checked-out-to-HEAD.txt` (175 tracked paths, **all 175 still dirty**) and `files-deleted.txt` (61; 58 present — the 3 absent are `CompletenessPill.vitest.test.tsx` (renamed `.ts`) and the lx4/lx5 folders, committed in `da1078ddf`). These lists were derived by nexus-commerce-89 from LX's own step manifests (`step*/manifest.json` / `source-manifest.json`, union 186 source paths of which 153 are dirty; the other 33 were read, not written, and are clean at HEAD).
9. **Markers only** — 0 files needed this (every remaining file was decided by a claim or a list). **mtime clusters** were used only as corroboration: `04:49:54` = the 05:25 revert-undo bulk stamp (119 of the 128 files so stamped are in the LX list; the other 7 are consolidation, above + `viewChips.ts`); `07:26:13` = VT.1's baseline restore of 16 files (content decides, not the stamp); `10:15:14` = the NUL sweep; `12:47:34` = CLOSE.1's pill pass.

**Positive controls run** (≥3 per bucket, each attribution reached by a second method):
- VT: `channel-mapping.routes.ts` (VT.F list ∧ markers VT.1b×2/R-VT-2), `variantAxes.vitest.test.ts` (VT.F2 claim :47139 ∧ mtime 12:23 in VT.F2's window), `content-publisher.ts` (marker VT.4 ∧ mtime 07:47:48 in VT.4's window ∧ the hunk's own text "EXTRACTED VERBATIM … VT.4").
- LX: `apps/api/src/index.ts` (LX list ∧ diff = `startReadinessReconcileCron` import+call), `CommandPalette.tsx` (LX.6 item (h) ∧ marker LX.16), `ScopeBar.tsx` (LX.F R-LX-9 `notComputed` ∧ mtime 07:46:24; factory mirror 08:34:08 ∧ `ds-fork-baseline.json` 08:34:35 in the same minute).
- JOINT: `schema.prisma` (LX list ∧ `variationSource` lines 50–57/67 in the diff ∧ VT.1b note :1130), `readiness-model.ts` (LX deleted list ∧ VT.4b note :1150 ∧ content markers), `useMasterSheet.ts` (LX list ∧ R-VT-15×2 in the diff ∧ the VT.F2 note routing R-VT-15 to CLOSE.1).
- CONSOLIDATION: `MasterSheet.tsx` (+6/−1982, the 6 added lines are the wrapper) ∧ README "compatibility wrappers"; `check-layout-v2.mjs` (13 added lines all name consolidation files); `viewChips.ts` (5 added lines delegate to `../sheetChips`).
- PROBE/SCRATCH: `_kt-study2.mts` (tracked probe ∧ NUL-strip residual = 4 delimiter swaps), `docs/audits/2026-09-11-variants-final/sheet-parity.json` (+1/−1: only `at` moved), the LX step dirs (582 untracked files, 68 tracked, 202 MB — see §PROBE).
- NUL census: 0 NUL bytes in all 562 present non-audit paths; positive control HEAD `ads-contest-flags.ts` = 1.
- `grep`: every set claim above used `/usr/bin/grep` (the shell `grep` is a `ugrep` function that skips NUL files — it would have hidden 13 of these paths at HEAD).

## (d) Count table

| bucket | entries | status split | note |
|---|---:|---|---|
| VT | 99 | 0 M · 50 ?? · 0 D | product code + VT docs/fixtures + gate tooling VT.F claims |
| LX | 305 | 0 M · 80 ?? · 0 D | incl. CLOSE.1's claimed paths and the 11 NUL-sweep-only files of other streams |
| JOINT | 37 | 0 M · 6 ?? · 0 D | 32 LX+VT · 4 CONSOLIDATION+LX/VT · 1 LX+orchestrator fix (`scopes.ts`) — table below |
| CONSOLIDATION | 23 | 0 M · 15 ?? · 0 D | nexus-commerce-89 single-sheet extraction (+ VP.1's surgical removals, superseded by the wrappers) |
| VP | 0 | — | VP.1–VP.5/VP.F base is committed in `f212c2348` (`git log -1` on `variants/channel/MappingDock.tsx`, `variants/family/FamilyVariants.tsx`, `VariantsTab.tsx`); every dirty `_studio/variants/**` hunk today carries a VT or CLOSE.1 marker; the one VP artefact (`sheet-parity.json`) is under PROBE/SCRATCH |
| VX-MOCK | 6 | 0 M · 6 ?? · 0 D | 4 mock files + 2 VX docs |
| LX-MOCK | 0 | — | `apps/web/src/app/design/language-axis/**` = 4 tracked files, last touched by `b499da490`, `git status` on the dir = 0 |
| OTHER | 3 | 0 M · 2 ?? · 0 D | `docs/pes-claims.md` (ledger, 4.5 MB, every lane appends) · MX design + prompts (session d4423145) |
| PROBE/SCRATCH | 718 | 0 M · 714 ?? · 0 D | 61 + 27 untracked probes, 2 tracked probes, 628 audit entries (202 MB untracked) |
| UNKNOWN | 0 | — | 2 were UNKNOWN on the first pass and were settled by a second look (`viewChips.ts` → consolidation by its 5 added lines; `themeChangePlan.vitest.test.ts` → VT.4's claimed test, :42274) |
| **total** | **1191** | | |

## JOINT files (37) with hunk owners

`--only` commits a whole file, so these cannot be split between the VT and LX commits: they go in ONE commit whose message names both programmes. Parties and owners per file (hunk numbers are `git diff -U0` order at 12:59):

| file | parties | hunk owners |
|---|---|---|
| `.claude/DS-GAPS.md` | LX+VT (+VP.5 owner of record) | +47 append-only lines: LX.7, LX strict editor, LX.10, LX.11, LX.12, LX6 ×2 entries; VT.2c OptionList/OrderedList lines; VT.F ×2 entries (R-VT-8 Listbox, held-control gap) |
| `api/routes/product-studio.routes.ts` | LX+VT | 20 hunks: VT.1 h2–h4 (reset:true), VT.4 h5 (POST …/projection/theme-change, 44 lines); LX step 7 + LX.F h1,h6–h20 (locales, contentAddress) |
| `api/svc/ebay-variation-push.service.ts` | VT+LX | +15/-7: VT.1 eBay precedence (~:900, VT.1×1); LX.F P0-2 R-LX-7 review verdict (1 hunk) |
| `api/pim/information-values.vitest.test.ts` | LX+VT | +18/-3: LX.F R-LX-13 mock triage; VT.1 filters out the variationTheme column (2 lines) |
| `api/pim/scope-readiness.service.ts` | LX+VT | 9 hunks: LX h1–h3,h5–h9 (LX.F R-LX-9 ×2, LX.FIN R-LX-22 ×2, LX.15); VT.1b/VT.4b inside h4 (variationSource relay, markers VT.4b×1 VT.1b×1) |
| `api/pim/sheet-columns.service.ts` | LX+VT | 9 hunks: VT h2,h4,h5 (VT.1 column + R-VT-4 width 160 by VT.F + VT.2),h6 (raw theme columns retired, VT.1); LX h1 (normalizeLanguage import),h3 (Languages-view classification),h7 (LX7 cache key),h8,h9 (LX.F R-LX-10 cache-only read) |
| `api/pim/sheet-rows.service.ts` | LX+VT | +61/-13: LX.F R-LX-15/P2-14 (list); VT.1b 3-line `kind` union widening (theme-unset\|collision\|attribute-unbound) |
| `api/pim/studio-sheet.service.ts` | LX+VT | 48 hunks: VT.1 h9,h11,h13,h17(part),h46 (VT.1×7, VT.1b×1, R-VT-13×2 by VT.F2); LX h1–h8,h10,h12,h14–h16,h17(part: R-LX-16/F-LX-8/P2-15),h18–h45,h47,h48 (LX steps 2–7 + LX.6×2 + LX.F×3 + LX.F2×2, R-LX-10/P2-19) |
| `api/svc/products/list-products.service.ts` | LX+VT | +45: LX steps + LX.F P2-16; VT.1b `?variationMapping=` narrowing (VT.1b×2) |
| `api/svc/products/products-grid.contract.ts` | LX+VT | +45: LX.F P2-16 (empty fallback filter) + LX steps; VT.4b `variationMapping` dimension |
| `api/svc/shopify/content-workspace.service.ts` | LX+VT | +32/-2: LX marketLanguages/translations (list); VT.F2 R-VT-13 order consumption |
| `factory/ds/grid/theme/grid.css` | LX+VT | byte-identical mirror of apps/web/…/grid.css (cmp = identical); same owners |
| `apps/web/src/app/products/[id]/datasheet/variantAxes.ts` | LX(R-LX-19)+VT | LX.F2 R-LX-19 delimiter swap (AXIS_KEY_SEP NUL → \u001f, 2 lines); VT.F2 R-VT-13 variationMappingAxisKeys reader (import + 6-line comment + 3-line body) |
| `…/_studio/drawer/types.ts` | LX+VT | +18/-2: VT.2 SheetColumnKind variationTheme + shape axes (VT.2×2); LX.F P1-6 channelSnapshot in LAYER_OF |
| `…/_studio/scopes.ts` | LX (LX.F P2-15) + orchestrator fix | 9 hunks, ALL LX: h1 = LX.F P2-15 channel-label swap INCLUDING the orchestrator's 11:25 fix (import-then-re-export; the bare re-export had bound nothing, TS2304 ×2); h2 languageLabel; h3–h9 LX steps (ordered languages). VT-ish added lines: 0 |
| `…/_studio/sheet/channel/types.ts` | LX+VT | 9 hunks: VT.2 h2,h4; LX.3 h5 + LX h1,h3,h6–h9 |
| `…/_studio/sheet/channel/useChannelSheet.ts` | LX+VT | +58: LX (commitLanguageGroups, locales, contentAddress); VT.1/VT.2/VT.2b/VT.2c commitVariationTheme + batch split (VT=16) |
| `…/_studio/sheet/master/columns.tsx` | LX+VT | 7 hunks: VT.2 h2 (variationThemeColumnDef import), h6 (kind===variationTheme early return, 18 lines, marker VT.2); LX h1,h3 (languageColumn import),h4,h5 (ProvenanceMark hunks left by nexus-commerce-89's 04:45 renderer revert),h7 (languageColumn bulletPoints editor) |
| `…/_studio/sheet/master/masterWrite.ts` | LX+VT | +201/-45: LX commitLanguageGroups (6 LX-ish lines); VT.1/VT.2/VT.2b/VT.2c/VT.4/VT.1b (VT=35, six VT markers) |
| `…/_studio/sheet/master/types.ts` | LX+VT | 7 hunks: VT.2 h2,h4 (kind/shape widening); LX h1,h3,h5; LX.FIN R-LX-22 h6 |
| `…/_studio/sheet/master/useMasterSheet.ts` | LX+VT(R-VT-15 by CLOSE.1) | +16/-4: LX `locales` query (list); R-VT-15 onRefused (2 hunks, authored by CLOSE.1) |
| `…/_studio/sheet/useSheetColumns.ts` | LX+VT | +52: LX (Languages view, 30 LX-ish lines); VT.2 R-VT-1 structural-column seam (1 hunk) |
| `…/_studio/sheet/views.ts` | LX+VT | +58: LX Languages preset (LANGUAGES_VIEW_ID); VT.2/R-VT-1 (VT=7) |
| `…/_studio/sheet/views.vitest.test.ts` | LX+VT | +70: LX (list); VT.2 +8 tests (R-VT-1×2 VT.2×1) |
| `apps/web/src/app/products/next/ProductsNextClient.tsx` | LX+VT | +175/-15: LX step 7 (languageColumns import, language state, useCatalogLanguages) ; VT.1b/VT.4b/R-VT-11 variation-mapping filter + FamilyFooter wiring (VT=60 added lines, markers VT.4b×5 VT.1b×3 R-VT-11×3) |
| `web/ds/grid/renderers/index.ts` | LX+VT | 4 hunks: LX.FIN h1,h2 (ScopeReadinessCell/ScopeReadinessValue exports), LX h3 (describeCellSource re-export); VT.2 h4 (variationTheme exports, 5 lines) |
| `web/ds/grid/theme/grid.css` | LX+VT | 169 added lines in 2 hunks: LX.F2 R-LX-18 toolbar fold (added lines 1–20, 38–52) + LX.FIN folded-panel tokens (21–50) + LX.12/LX formula value mode (53–54) + LX.10 outdated cell (56–58) + LX.11 wide group label (60–63); VT.2 `.nds-axes-*` block (65–169) incl. R-VT-16 (76–81, CLOSE.1) and VT.2c |
| `packages/database/prisma/schema.prisma` | LX+VT | 3 hunks: h1,h2 LX relations; h3 116 appended lines = LX.3/LX.5/LX.6 R-LX-4/LX.F2 R-LX-17/LX.FIN R-LX-24 models + VT.1b `ReadinessIndex.variationSource String?` (added lines 50–57, 67) |
| `packages/shared/package.json` | LX+VT | +20 lines: LX exports ./cell-provenance, ./channel-label, ./content-header, ./content-language (16 lines); VT.F2 export ./variation-mapping (4 lines) |
| `packages/shared/products-grid.ts` | LX+VT | +55: LX steps + LX.F R-LX-9 (×2); VT.4b `variationMapping: string[]` (VT.4b×1 VT.1b×1) |
| `scripts/check-editor-open.mjs` | LX+VT | +166/-52: VT.2/VT.2b/VT.2c/R-VT-1/R-VT-4 parity (VT=19); LX.8 one line (list) |
| `api/pim/readiness-index.service.ts` | LX+VT | LX-created (deleted list) + LX.F2 R-LX-17 (×4 markers); VT.1b hunk lines 10–11 (import variationSourceFor) and 103–113 (variationSource stamped into the index row) |
| `api/pim/readiness-model.ts` | LX+VT | LX-created + LX.F P1-5/R-LX-9 + LX.FIN R-LX-22; VT.4b/VT.1b lines 86–94 (`variationSource` on ReadinessMatrixEntry) |
| `…/_studio/sheet/ProductSheet.tsx` | CONSOLIDATION+VT | 89 extraction (manifest hash c835145a…); VT.2c/VT.4 ThemeChangePlanHost mount in ListingAdapter (lines 3, 21–35) |
| `…/_studio/sheet/channel/useChannelSheetAdapter.tsx` | CONSOLIDATION+LX+VT | nexus-commerce-89 extraction (manifest); LX.6 items (e),(f) + LX.13/LX.14/LX.15 (LX=57 lines); VT.2 column kind ×2; R-VT-15 (CLOSE.1) ×1 |
| `…/_studio/sheet/master/channelColumns.tsx` | CONSOLIDATION+VT | 89 hoist of the checkpoint channel column builder (lx-revert README); VT.2 kind===variationTheme early return (VT.2×1) |
| `…/_studio/sheet/master/useMasterSheetAdapter.tsx` | CONSOLIDATION+LX+VT | 89 extraction; LX.6 (e); LX.FIN R-LX-22 ×4; CLOSE.1 R-LX-27 ×1; VT.2 ×1; R-VT-15 (CLOSE.1) ×1 |

Evidence per file (claims + census) is in `attribution.json` → `evidence`.

## PROBE/SCRATCH (718) — not product code

| group | entries | bytes | what |
|---|---:|---:|---|
| `docs/audits/2026-09-12-language-axis` | 583 | 209,642,519 | lx-audit (LX steps 0–7 evidence) |
| `apps/api/scripts/_*.mts` | 63 | 177,547 | other-stream probe — the ONLY change is LX.F2 R-LX-19 NUL → \u001f delimiter swap (HEAD NUL 6/7 → 0); commit WITH LX or the strict NUL gate reds on a clean checkout |
| `scripts/_*.mjs|.mts` | 27 | 151,359 | lx-probe |
| `docs/audits/2026-09-13-single-sheet` | 24 | 566,818 | consolidation-audit (nexus-commerce-89 parity fixture; 10 files carry 2026-09-08 mtimes = copied fixture) |
| `docs/audits/2026-09-13-lx6` | 8 | 57,001 | lx-audit (LX.6 probes + outputs) |
| `docs/audits/2026-09-13-lx-revert` | 5 | 1,456,725 | lx-revert (nexus-commerce-89 undo material: 1.3 MB patch + tgz) |
| `docs/audits/2026-09-13-lx-fin` | 4 | 67,672 | lx-audit + PROD SQL/backfill (R-LX-23, R-LX-24) — see §b |
| `docs/audits/2026-09-11-variants-final` | 1 | 883 | vp-audit (VP.F parity artefact; only the `at` stamp moved, 2026-09-12T21:44Z) |
| `docs/audits/2026-09-13-lx-f2` | 1 | 1,582 | lx-audit + PROD SQL (R-LX-17) — see §b |
| `docs/audits/2026-09-13-lx-takeover` | 1 | 83,347 | lx-audit (LX.R findings) |
| `docs/audits/2026-09-13-vt1b` | 1 | 1,238 | vt-audit + PROD SQL (variationSource) — see §b |

- The 61 `apps/api/scripts/_*.mts` untracked probes: `_lxf2-*` 8, `_lxfin-*` 17, `_vt0*` 2, `_vt1-*` 11, `_vt1b-*` 9, `_vt4b-*` 2, `_vtf2-*` 12. The 27 `scripts/_*` probes: `_close1-pills` 1, `_lxf2-toolbar` 1, `_lxfin-screens*` 2, `_vt2c-*` 1, `_vt4-*` 2, `_vt4b-*` 2, `_vtf-*` 12, `_vtf2-*` 6. Lanes wrote them "outside the API import graph"; none is imported by product code (they are named by their lane sections as probes).
- The 2 TRACKED probes (`_kt-study2.mts`, `_ufx-gpsr-ps-stage.mts`, other streams) carry only the R-LX-19 delimiter swap — see the LX/NUL note; if they are left out of the LX commit the strict NUL gate reds.
- **`docs/audits/2026-09-12-language-axis/`: 582 untracked files, 202 MB** (largest: `step5/isolated-after.json` 16.3 MB, four `step3/*production-diffs.jsonl` at 12.1 MB each, `step7/write-*.json` 8.1 MB ×4). Committing LX's evidence is a repository-size decision, not an attribution one; it is the programme's §4 record and is referenced from the ledger. `docs/audits/2026-09-13-lx-revert/` holds a 1.3 MB `git diff` patch + a 68 KB tgz of the tree (undo material).
- The five PROD SQL/backfill files under `docs/audits/**` are listed in §(b).

## (a) NUL bytes and `.d.ts`

- **NUL**: `LC_ALL=C tr -cd '\000' < f | wc -c` = **0 for all 562 present non-audit paths** (every VT/LX/JOINT/CONSOLIDATION file; the 563rd is the deleted `LocalesTab.tsx`). Positive control: the HEAD copy of `apps/api/src/services/advertising/ads-contest-flags.ts` = 1. The 13 HEAD-NUL files sum to 35 bytes = R-LX-19.
- **`.d.ts`**: **0 `.d.ts` in the porcelain set.** `.gitignore:96` ignores `apps/web/src/design-system/**/*.d.ts` (247 exist on disk, e.g. `Pill.d.ts`, `GridToolbarFold.d.ts`, `Listbox.d.ts`, `AxesPanelEditor.d.ts` — all ignored, none tracked), so the 55 → 0 regeneration by VT.F2 (`check-ds-dts-fresh --write`) and CLOSE.1's "generated `.d.ts`" cannot enter any commit and need no pathspec. They are rebuilt from their sources by the gate (`node scripts/check-ds-dts-fresh.mjs --write`) — R-VT-14 in `docs/vt-prompts.md` rule 7. Factory: 3 tracked `.d.ts` (e.g. `MetricStrip.d.ts`), none dirty. `packages/shared/dist` is ignored (VT.F2's "dist emit" is a build artefact; consumers rebuild with `cd packages/shared && npm run build`).

## (b) Migrations and SQL outside `prisma/migrations/`

- `packages/database/prisma/migrations`: `git status` on the folder = **clean**. Five `lx` folders present and tracked: `20260912_lx1_remove_legacy_content_guard`, `20260912_lx1_translation_store`, `20260912_lx2_marketplace_languages`, `20260912_lx4_channel_listing_translations`, `20260912_lx5_readiness_index` — lx4/lx5 committed in `da1078ddf` (06:29:58, 2 files, +70). Nothing further to commit there. (nexus-commerce-89's 05:05 note said the lx1 corrective folder was missing from the repo; at 12:59 it is present and tracked.)
- `schema.prisma` is JOINT: 116 appended lines carry LX models (LX.3/LX.5/R-LX-4/R-LX-17/R-LX-24) and VT.1b's `ReadinessIndex.variationSource String?` — the VT column has NO folder under `prisma/migrations/`.
- **SQL/backfill authored OUTSIDE `prisma/migrations/`, applied to LOCAL only, for the Owner to apply on prod (ruling #12, ledger :113 — an UNAPPLIED migration folder stays out of `prisma/migrations/` and is moved in at apply time; once applied it stays permanently):**
  1. `docs/audits/2026-09-13-vt1b/20260913_vt4_readiness_variation_source.sql` — `ReadinessIndex.variationSource` + partial index (VT.1b, :1130).
  2. `docs/audits/2026-09-13-lx-f2/20260913_lxf2_readiness_sort_projection.sql` — R-LX-17 sort keys + index (LX.F2).
  3. `docs/audits/2026-09-13-lx-fin/20260913_lxfin_error_grouping_fingerprint_backfill.mts` — R-LX-23 fingerprint recompute (LX.FIN; `error-grouping-fingerprints-before.json` beside it is the 74-row before-state).
  4. `docs/audits/2026-09-13-lx-fin/20260913_lxfin_seller_reference_labels.sql` — R-LX-24 `SellerReferenceLabel` table.
  5. `docs/audits/2026-09-13-lx-fin/20260913_lxfin_seller_reference_labels_grants.sql` — R-LX-24 grants + RLS; **LX.FIN: 4 and 5 must be applied TOGETHER** (12 green mocked tests hid a `42501`).
  These stay under `docs/audits/**` (PROBE/SCRATCH) until the Owner applies them; when applied, each becomes a folder under `prisma/migrations/` per ruling #12. Also open from LX.F2: the 3-row `EBAY_IT → IT` prod migration (F9) and the store markets' languages (R-LX-26) — decisions, not files.

## (c) Recommended commit sequence

Pathspec files are in this directory (one path per line, exactly the porcelain spelling). Every studio path contains `[id]`. MEASURED: `git ls-files -- 'apps/web/src/app/products/[id]/edit/_studio/scopes.ts'` returns the file **with and without** `--literal-pathspecs` (git tries an exact match before glob matching), so the flag is not required; it is kept in the recipe as a zero-cost guard against a shell that expands the brackets, not as a correctness claim. `git commit --only` refuses untracked paths ("pathspec did not match", memory: the no-op-then-`--amend` trap), so `git add` the group's untracked members FIRST, then commit with `--only` and the full group list; verify `git show --stat HEAD | tail -1` reports the group's file count (a dropped file is silent).

```
until [ ! -e .git/index.lock ]; do sleep 2; done
G=docs/audits/2026-09-13-commit-attribution
# 1. VT (99 files)
git --literal-pathspecs add --pathspec-from-file=$G/group-VT.txt
git --literal-pathspecs commit --only --pathspec-from-file=$G/group-VT.txt -m "feat(vt): Variation theme column — VT.1–VT.F2 (see docs/vt-prompts.md)"
# 2. LX (305 files; includes the D of tabs/LocalesTab.tsx and the 11 R-LX-19 NUL fixes in other streams' files)
git --literal-pathspecs add --pathspec-from-file=$G/group-LX.txt
git --literal-pathspecs commit --only --pathspec-from-file=$G/group-LX.txt -m "feat(lx): language axis — steps 1–7 + LX.6/LX.F/LX.F2/LX.FIN/CLOSE.1"
# 3. JOINT (37 files — both programmes in one file; message names both)
git --literal-pathspecs add --pathspec-from-file=$G/group-JOINT.txt
git --literal-pathspecs commit --only --pathspec-from-file=$G/group-JOINT.txt -m "feat(vt+lx): files carrying both programmes' hunks (owners in $G/attribution.md)"
# 4. CONSOLIDATION (23 files, nexus-commerce-89)
git --literal-pathspecs add --pathspec-from-file=$G/group-CONSOLIDATION.txt
git --literal-pathspecs commit --only --pathspec-from-file=$G/group-CONSOLIDATION.txt -m "refactor(studio): one ProductSheetSurface for master and channel scopes (single-sheet consolidation)"
# 5. VX-MOCK (6: mock + design docs) — separately
git --literal-pathspecs add --pathspec-from-file=$G/group-VX-MOCK.txt
git --literal-pathspecs commit --only --pathspec-from-file=$G/group-VX-MOCK.txt -m "docs(vx): variation projection design + /design/variation-projection mock"
# 6. LX-MOCK — nothing to commit (already in b499da490)
# 7. OTHER (3): MX docs as their own commit; docs/pes-claims.md LAST (it changes under every lane)
# 8. PROBE/SCRATCH (718) — NOT product code. Owner's call whether to commit the audit evidence (202 MB) as docs(audit) commits; the 88 untracked probe scripts should be deleted or left untracked, never committed as product code.
```

Order matters only in one place: **JOINT after VT and LX** (so each JOINT file's message can cite both), and the ledger last. Ordering VT before LX or the reverse changes nothing — no VT-only file imports an LX-only file's *new* export or vice versa within a single commit boundary that the pre-push hook would see, because the hook builds the **working tree**, not the commit. Which is the trap: **the pre-push hook (`.githooks/pre-push`) builds the whole tree (`apps/web` `next build` into the shared `.next` + API tsc + the ratchets) — it does not test any individual commit**, so (i) pushing is a separate decision from committing, (ii) a sibling session's push within the same ~3 min collides on `.next` (ENOENT on half-written artefacts, not a code error), (iii) "not pushed" only lasts until the next sibling push carries every local commit to origin and into a Railway build, and (iv) a commit that omits a file the tree needs (e.g. an LX file left out of group-LX) passes the hook and ships broken. After each commit: `git --literal-pathspecs status --porcelain -- <group file>` should be empty for that group.

The 11 NUL-sweep files: if the Owner prefers not to commit other streams' files under an LX message, commit them as a separate `chore(nul): R-LX-19 delimiter swap in 11 files` BEFORE the LX commit that carries `scripts/check-no-nul-bytes.mjs` — the gate is strict over `git ls-files`.

## What I could not attribute, and why (honest limits)

- **No path is UNKNOWN**, but three attributions rest on content + mtime rather than a claim line naming the file — flagged in `evidence` for the owning lane to confirm: `_studio/variants/family/FamilyVariants.tsx` (CLOSE.1 R-LX-27, `familyVerbs.status()` + compaction comment, mtime 12:47:34 = `FamilyBar.tsx` to the second; no lane line names it), `scripts/ds-fork-baseline.json` (LX.F P2-3 factory barrel, 08:34:35, one minute after LX.F's factory `ScopeBar` mirror), `api/pim/variation-local-db.vitest-helper.ts` (VT.F, 11:11, name family only — 0 markers).
- **Ledger line → lane is unreliable after ~L44000**: sections interleave (a lane's appends land under another lane's header), so "the nearest `###` above the line" was NOT used as an attribution method — only claim blocks and markers inside hunks were.
- **Hunk owners inside JOINT files are marker-based**: a marker can be a citation (e.g. `market-languages-guard.vitest.test.ts` cites VT.1's file and is LX; `FamilyFooter.tsx` cites R-LX-9 and is VT). Where a hunk had no marker it was assigned to the programme whose claim covers that file region; `studio-sheet.service.ts` has 48 hunks and 33 of them are marker-less LX-step hunks (in the LX revert list; VT.1 claimed only `CHANNEL_WRITABLE` + additive hunks, all of which carry `VT.1`).
- **The LX lists are nexus-commerce-89's derivation** from LX's manifests (the revert README), not a statement by the LX session; they agree with the manifests' union on all 153 dirty members and were the only complete list of LX-touched tracked files available.
- **VP's residual**: VP.1's surgical removals in `MasterSheet.tsx`/`ChannelSheet.tsx`/`index.tsx` are no longer distinguishable — the consolidation rewrote those files to wrappers; bucketed CONSOLIDATION. `_studio/relationships/` (VP.1) does not exist in the tree or in history.
- **`.d.ts` freshness at commit time was not re-measured** (the gate needs a run; R-VT-14 says a stale one shadows its source) — they are ignored, so it cannot affect the commit, only the build.
- The snapshot is 12:59:58; the ledger (`docs/pes-claims.md`) and possibly other files moved after it (CLOSE.1 and VT.F2 were closing). Re-diff `git status --porcelain` against `group-*.txt` before committing; any path not in any group file is new since the snapshot and is UNATTRIBUTED.

## Full lists

### VT (99)
- `M` `apps/api/src/routes/channel-mapping.routes.ts` — VT.1b rule route; VT.F list :44821; markers VT.1b×2 VT.3 R-VT-2
- `M` `apps/api/src/services/amazon-mapper.service.ts` — VT.F2 R-VT-13 :46399; marker R-VT-13
- `M` `apps/api/src/services/ebay-family-axes.service.ts` — VT.1 claim :40946; marker VT.1
- `M` `apps/api/src/services/listing-wizard/amazon-publish.adapter.ts` — VT.1 :40945, VT.4 P0, VT.F2 R-VT-13; markers VT.4×4 VT.1×3 R-VT-13×3
- `M` `apps/api/src/services/listing-wizard/submission.service.ts` — VT.F2 R-VT-13 :46399; marker R-VT-13
- `M` `apps/api/src/services/pim/attribute-foundation.vitest.test.ts` — marker VT.1 (raw theme columns retired); not in LX list
- `M` `apps/api/src/services/pim/channel-field-map.ts` — VT.1 claim :40945
- `M` `apps/api/src/services/pim/channel-specs/amazon.ts` — VT.1 claim :40945
- `M` `apps/api/src/services/pim/channel-specs/ebay.ts` — VT.1 claim :40945
- `M` `apps/api/src/services/pim/channel-specs/etsy.vitest.test.ts` — marker VT.1; not in LX list
- `M` `apps/api/src/services/pim/channel-specs/shopify-mapping.vitest.test.ts` — marker VT.1; not in LX list
- `M` `apps/api/src/services/pim/channel-specs/store.vitest.test.ts` — marker VT.1; not in LX list
- `M` `apps/api/src/services/pim/family-contract.vitest.test.ts` — marker VT.1; not in LX list
- `M` `apps/api/src/services/pim/family-projection.service.ts` — VT.1/VT.1b/VT.4/VT.2c/R-VT-7/R-VT-13; VT.F list; 26 VT markers, 1 LX-ish (localeCompare)
- `M` `apps/api/src/services/pim/family-projection.vitest.test.ts` — R-VT-7/R-VT-13 markers
- `M` `apps/api/src/services/pim/mapping/field-catalogue.service.ts` — markers VT.1b×2 R-VT-2×2 (test file is LX.F's — separate row)
- `M` `apps/api/src/services/pim/mapping/impact.service.ts` — markers VT.1b×3 VT.3b×2; VT.F A-item MappingImpact.category
- `M` `apps/api/src/services/pim/mapping/review-draft.ts` — markers VT.1b R-VT-2
- `M` `apps/api/src/services/pim/schema-mapping.service.ts` — VT.1b R-VT-2 validator; VT.F list; markers VT.1b×8 R-VT-2×7
- `M` `apps/api/src/services/pim/sheet-values.ts` — marker VT.1×2; NOT in the LX checked-out list (manifest union = LX read it in step 3-switch)
- `M` `apps/api/src/services/pim/write-routing.vitest.test.ts` — marker VT.1; not in LX list
- `M` `apps/api/src/services/shopify/content-publisher.ts` — VT.4 verbatim extraction for the shopify-in-place plan (marker VT.4, mtime 07:47:48 in VT.4's window); not in LX list
- `M` `apps/api/vitest.config.ts` — VT.F2 R-VT-12 :46395
- `M` `apps/factory/src/design-system/components/Listbox.tsx` — mirror of R-VT-8
- `M` `apps/factory/src/design-system/grid/renderers/projection.ts` — VT.4 mirror
- `M` `apps/web/src/app/catalog/[id]/edit/tabs/PlatformTab.tsx` — VT.F2 R-VT-13 reader :46400; marker R-VT-13×2
- `M` `apps/web/src/app/channels/mapping/MappingClient.tsx` — VT.3 claim :41500
- `M` `apps/web/src/app/channels/mapping/_shared/api.ts` — VT.3 claim :41500
- `M` `apps/web/src/app/channels/mapping/_shared/contracts.ts` — VT.3 claim :41500
- `M` `apps/web/src/app/channels/mapping/mapping.module.css` — VT.3 claim :41500
- `M` `apps/web/src/app/products/[id]/edit/_studio/variants/channel/MappingDock.tsx` — VT.4/VT.2c/VT.1b markers; VP base committed in f212c2348
- `M` `apps/web/src/app/products/[id]/edit/_studio/variants/channel/dock/sections.tsx` — VT.2c SpecificsSection + VT.4 CollisionsSection :43467/:42280; VP base committed
- `M` `apps/web/src/app/products/[id]/edit/_studio/variants/channel/index.ts` — VT.4/VT.2 barrel
- `M` `apps/web/src/app/products/[id]/edit/_studio/variants/channel/projection.vitest.test.ts` — VT.2c/VT.1b markers
- `M` `apps/web/src/app/products/[id]/edit/_studio/variants/channel/source.ts` — VT.4/VT.2c/R-VT-9
- `M` `apps/web/src/app/products/[id]/edit/_studio/variants/channel/types.ts` — VT.4/R-VT-7/R-VT-9
- `M` `apps/web/src/app/products/[id]/edit/_studio/variants/channel/variants-channel.css` — VT.2c (dead VP.4 CSS removed, VT.F A-item)
- `M` `apps/web/src/app/products/next/FamilyFooter.tsx` — VT.4b :1148 (R-LX-9 is a citation); not in LX list
- `M` `apps/web/src/design-system/components/Listbox.tsx` — VT.F R-VT-8 portalTo; markers VT.2c R-VT-8
- `M` `apps/web/src/design-system/grid/editors/editorBox.ts` — marker VT.2; VT.4 section :43105
- `M` `apps/web/src/design-system/grid/editors/editorBox.vitest.test.ts` — marker VT.2
- `M` `apps/web/src/design-system/grid/editors/index.ts` — VT.2 claim :41128
- `M` `apps/web/src/design-system/grid/editors/shapeColumn.ts` — VT.2 claim :41125; R-VT-4
- `M` `apps/web/src/design-system/grid/editors/sheetColumn.ts` — VT.2 claim :41126
- `M` `apps/web/src/design-system/grid/editors/sheetWriter.ts` — VT.2 claim :41127 + VT.F2/CLOSE.1 R-VT-15 hunk (:47087); +291 all VT (LX-ish hits are the word "fallback" in VT prose)
- `M` `apps/web/src/design-system/grid/renderers/projection.ts` — VT.4 sixth word :42278
- `M` `apps/web/src/design-system/grid/renderers/projection.vitest.test.ts` — VT.4
- `M` `apps/web/src/design-system/grid/renderers/shapeFormat.ts` — marker VT.2
- `M` `scripts/check-control-census.mjs` — VT.2 step 5 :41145 (markers VT.2 R-GATE-1); VP.5 base committed
- `??` `apps/api/src/lib/testing/database-target.ts` — VT.F2 R-VT-12
- `??` `apps/api/src/lib/testing/database-target.vitest.test.ts` — VT.F2 R-VT-12
- `??` `apps/api/src/services/listing-wizard/amazon-publish-binding.vitest.test.ts` — VT.1b P0 binding test (mtime 09:03 VT.1b window)
- `??` `apps/api/src/services/pim/__fixtures__/outerwear-theme-schema.ts` — VT.1 fixture
- `??` `apps/api/src/services/pim/theme-change.service.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/api/src/services/pim/theme-change.vitest.test.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/api/src/services/pim/variation-ebay-precedence.vitest.test.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/api/src/services/pim/variation-excluded.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/api/src/services/pim/variation-local-db.vitest-helper.ts` — VT.F (11:11) — name + window; no markers
- `??` `apps/api/src/services/pim/variation-mapping-filter.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/api/src/services/pim/variation-mapping-filter.vitest.test.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/api/src/services/pim/variation-rule-store.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/api/src/services/pim/variation-rule-store.vitest.test.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/api/src/services/pim/variation-rule-view.service.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/api/src/services/pim/variation-rule-view.vitest.test.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/api/src/services/pim/variation-rules.service.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/api/src/services/pim/variation-rules.vitest.test.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/api/src/services/pim/variation-theme-facts.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/api/src/services/pim/variation-theme-segments.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/api/src/services/pim/variation-theme-segments.vitest.test.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/api/src/services/shopify/content-axis-order.vitest.test.ts` — VT.F2 R-VT-13 (12:20)
- `??` `apps/api/vitest.setup.ts` — VT.F2 R-VT-12
- `??` `apps/web/src/app/channels/mapping/_shared/VariationsGroup.tsx` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/web/src/app/channels/mapping/_shared/variations-fixtures.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/web/src/app/channels/mapping/_shared/variations.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/web/src/app/channels/mapping/_shared/variations.vitest.test.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/web/src/app/products/[id]/datasheet/variantAxes.vitest.test.ts` — VT.F2 R-VT-13 (3 new tests, :47139)
- `??` `apps/web/src/app/products/[id]/edit/_studio/variants/channel/ThemeChangePlanHost.tsx` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/web/src/app/products/[id]/edit/_studio/variants/channel/ThemeChangePlanModal.tsx` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/web/src/app/products/[id]/edit/_studio/variants/channel/theme-change-plan.css` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/web/src/app/products/[id]/edit/_studio/variants/channel/themeChangePlan.vitest.test.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/web/src/app/products/[id]/edit/_studio/variants/channel/themePlanAsk.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/web/src/app/products/[id]/edit/_studio/variants/channel/themePlanAsk.vitest.test.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/web/src/app/products/next/variationMappingFilter.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/web/src/app/products/next/variationMappingFilter.vitest.test.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/web/src/design-system/grid/editors/AxesPanelEditor.tsx` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/web/src/design-system/grid/editors/AxesPanelEditor.vitest.test.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/web/src/design-system/grid/editors/sheetWriter.variationTheme.vitest.test.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/web/src/design-system/grid/renderers/variationTheme.tsx` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `apps/web/src/design-system/grid/renderers/variationTheme.vitest.test.ts` — VT.1/VT.4/VT.2/VT.3 new-file claims (theme-change*, variation-*, VariationsGroup, ThemeChangePlan*, AxesPanelEditor*, variationTheme*)
- `??` `docs/2026-09-13-variation-theme-column-design.md` — VT design (orchestrator)
- `??` `docs/fixtures/vt1/fixtures.ts` — VT.1 claim :40950
- `??` `docs/vt-prompts.md` — VT prompts
- `??` `docs/vt1-contracts.md` — VT.1 claim :40950
- `??` `packages/shared/variation-mapping.ts` — VT.F2 :46397
- `??` `packages/shared/variation-mapping.vitest.test.ts` — VT.F2 :46397
- `??` `scripts/lib/gate-aloneness.mjs` — VT.F A8 :44831
- `??` `scripts/lib/gate-aloneness.test.mjs` — VT.F A8
- `??` `scripts/studio-gate-session.mjs` — VT.2b R-GATE-1 :1181; VT.F list
- `??` `scripts/studio-gate-session.selftest.mjs` — VT.F list

### LX (305)
- `M` `apps/api/src/index.ts` — LX revert list; census +2/-0 VT=0 LX=0 ; mtime 2026-09-13 04:52:22 (edited by a later LX lane)
- `M` `apps/api/src/jobs/advertising-rule-evaluator.job.ts` — HEAD NUL count +3/-3; 13-file sum = 35 = R-LX-19's figure
- `M` `apps/api/src/lib/amazon-sp-client.lifecycle.vitest.test.ts` — LX revert list; census +3/-2 VT=0 LX=0 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/lib/amazon-sp-client.ts` — LX revert list; census +3/-1 VT=0 LX=0 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/lib/amazon-sp-client.vitest.test.ts` — LX revert list; census +21/-0 VT=0 LX=0 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/lib/auth/permissions-manifest-order.vitest.test.ts` — LX revert list; census +8/-0 VT=0 LX=3 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/lib/auth/permissions-manifest.ts` — LX revert list; census +3/-0 VT=0 LX=2 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/lib/cron/clustered.ts` — LX.F P3-26 :41273; markers P3-26 LX.F
- `M` `apps/api/src/lib/cron/clustered.vitest.test.ts` — LX.F P3-26
- `M` `apps/api/src/lib/database-context.ts` — LX revert list; census +17/-2 VT=0 LX=0 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/routes/advertising.routes.ts` — HEAD NUL count +2/-2; 13-file sum = 35 = R-LX-19's figure
- `M` `apps/api/src/routes/aplus-content.routes.ts` — LX revert list; census +14/-19 VT=0 LX=14 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/routes/assets.routes.ts` — LX revert list; census +13/-10 VT=0 LX=11 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/routes/brand-story.routes.ts` — LX revert list; census +17/-22 VT=0 LX=17 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/routes/catalog-transfer.routes.ts` — LX revert list; census +19/-2 VT=0 LX=10 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/routes/categories.routes.ts` — LX.6 item 2 (step6 source-manifest); markers R-LX-4 LX.6
- `M` `apps/api/src/routes/cell-formula.routes.ts` — LX revert list; census +16/-9 VT=0 LX=13 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/routes/families.routes.ts` — LX revert list; census +10/-35 VT=0 LX=8 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/routes/listings-syndication.routes.ts` — LX revert list; census +33/-38 VT=0 LX=26 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/routes/mapping-propagation.routes.ts` — LX revert list; census +2/-0 VT=0 LX=2 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/routes/marketplaces.routes.ts` — LX revert list; census +27/-17 VT=0 LX=12 ; mtime 2026-09-13 07:21:13 (edited by a later LX lane)
- `M` `apps/api/src/routes/pim-global.routes.ts` — LX list + LX.F F-LX-1 marker (+ in the LX revert list)
- `M` `apps/api/src/routes/product-enrichment.routes.ts` — LX revert list; census +3/-2 VT=0 LX=3 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/routes/product-seo.routes.ts` — LX revert list; census +18/-13 VT=0 LX=14 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/routes/product-translations.routes.ts` — LX revert list; census +32/-72 VT=0 LX=22 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/routes/products-ai.routes.ts` — LX.FIN R-LX-25 :45384 (+ in the LX revert list)
- `M` `apps/api/src/routes/products-bulk-noop.vitest.test.ts` — LX.F R-LX-13; markers R-LX-13 LX.F
- `M` `apps/api/src/routes/products-catalog.routes.ts` — LX revert list; census +3/-5 VT=0 LX=2 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/routes/products.routes.ts` — LX revert list; census +11/-9 VT=0 LX=7 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/advertising/ads-contest-flags.ts` — HEAD NUL count +-/--; 13-file sum = 35 = R-LX-19's figure
- `M` `apps/api/src/services/advertising/ads-contest-flags.vitest.test.ts` — HEAD NUL count +-/--; 13-file sum = 35 = R-LX-19's figure
- `M` `apps/api/src/services/agent-fleet/sweep-report.service.ts` — HEAD NUL count +-/--; 13-file sum = 35 = R-LX-19's figure
- `M` `apps/api/src/services/ai/enrichment/cell-key.ts` — LX revert list; census +3/-2 VT=0 LX=3 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/ai/enrichment/draft.service.ts` — LX revert list; census +14/-20 VT=0 LX=9 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/ai/enrichment/generate.service.ts` — LX revert list; census +2/-1 VT=0 LX=2 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/ai/seo-regen.service.ts` — LX revert list; census +2/-5 VT=0 LX=2 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/amazon/flat-file-ufx6-gpsr.vitest.test.ts` — LX revert list; census +1/-0 VT=0 LX=1 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/aplus-amazon-pull.service.ts` — LX revert list; census +3/-2 VT=0 LX=3 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/aplus-amazon.service.ts` — LX revert list; census +5/-5 VT=0 LX=4 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/asset-locale-overlay.service.ts` — LX revert list; census +3/-10 VT=0 LX=2 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/brand-story-amazon.service.ts` — LX revert list; census +4/-4 VT=0 LX=3 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/bulk-action.service.ts` — LX revert list; census +10/-86 VT=0 LX=6 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/categories/reference-labels.service.ts` — LX.6 :41168, LX.F2 R-LX-12, LX.FIN R-LX-24 :45400
- `M` `apps/api/src/services/categories/reference-labels.service.vitest.test.ts` — LX.6/LX.FIN
- `M` `apps/api/src/services/categories/schema-sync.service.ts` — LX.F2 R-LX-20 :44050
- `M` `apps/api/src/services/channel-batch/amazon-batch-feed.service.ts` — LX.F P2-20 :41270
- `M` `apps/api/src/services/content-auto-publish.service.ts` — LX.F P0-2 R-LX-7 :41255
- `M` `apps/api/src/services/ebay-inventory-readback.service.ts` — HEAD NUL count +1/-1; 13-file sum = 35 = R-LX-19's figure
- `M` `apps/api/src/services/ebay-presentation-order.service.ts` — LX.F2 R-LX-20 (10:23:30 cluster)
- `M` `apps/api/src/services/ebay-publish.service.ts` — LX.F P0-2 :41255
- `M` `apps/api/src/services/ebay-shared-listing-push.service.ts` — LX.F P0-2 (marker R-LX-7; mtime 07:23:34 = ebay-publish.service.ts)
- `M` `apps/api/src/services/error-grouping.service.ts` — LX.F2 R-LX-19 delimiter swap (HEAD NUL=1→0) + LX.FIN R-LX-23 export
- `M` `apps/api/src/services/etsy/information-content.ts` — LX revert list; census +4/-15 VT=0 LX=3 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/family-completeness.service.ts` — LX revert list; census +9/-28 VT=0 LX=6 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/images/amazon-image-feed.service.ts` — LX.F P2-20 :41271 (−1 MARKETPLACE_LOCALE import)
- `M` `apps/api/src/services/images/product-media.service.ts` — LX revert list; census +6/-2 VT=0 LX=5 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/listing-wizard/ebay-publish.adapter.ts` — LX.F P0-2 (marker R-LX-7; mtime 07:23:34)
- `M` `apps/api/src/services/master-content.service.ts` — LX revert list; census +60/-169 VT=0 LX=24 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/outbound-sync.service.ts` — LX revert list; census +34/-4 VT=0 LX=7 R-LX-7×1; mtime 2026-09-13 07:22:56 (edited by a later LX lane)
- `M` `apps/api/src/services/pim/apply-mapping.service.ts` — LX revert list; census +17/-36 VT=0 LX=9 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/attribute-resolver.ts` — LX revert list; census +37/-158 VT=0 LX=12 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/catalog-amazon-workbook.ts` — LX revert list; census +3/-3 VT=0 LX=3 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/catalog-product-transfer.ts` — LX revert list; census +6/-4 VT=0 LX=5 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/catalog-product-transfer.vitest.test.ts` — LX.F2 R-LX-21
- `M` `apps/api/src/services/pim/catalog-source-mapping.vitest.test.ts` — LX.F2 R-LX-21
- `M` `apps/api/src/services/pim/catalog-transfer-effects.ts` — LX revert list; census +28/-7 VT=0 LX=10 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/catalog-transfer-export.ts` — LX revert list; census +33/-16 VT=0 LX=20 R-LX-8×1; mtime 2026-09-13 07:41:23 (edited by a later LX lane)
- `M` `apps/api/src/services/pim/catalog-transfer-export.vitest.test.ts` — LX revert list; census +2/-1 VT=0 LX=1 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/catalog-transfer-file.ts` — LX revert list; census +4/-4 VT=0 LX=2 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/catalog-transfer-http.vitest.test.ts` — LX.F2 R-LX-21
- `M` `apps/api/src/services/pim/catalog-transfer-jobs.ts` — LX.F2 R-LX-21 (+ in the LX revert list)
- `M` `apps/api/src/services/pim/catalog-transfer-jobs.vitest.test.ts` — LX revert list; census +11/-2 VT=0 LX=4 LX7×1; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/catalog-transfer-plan.ts` — LX.F P1-8/R-LX-8 + LX.F2 R-LX-21 (+ in the LX revert list)
- `M` `apps/api/src/services/pim/catalog-transfer-test/store.ts` — LX.F2 R-LX-21 (markers ×3)
- `M` `apps/api/src/services/pim/catalog-transfer.service.ts` — LX.F2 R-LX-21/F-LX-4 :44036 (+ in the LX revert list)
- `M` `apps/api/src/services/pim/catalog-transfer.vitest.test.ts` — LX revert list; census +52/-12 VT=0 LX=24 LX.F×2 R-LX-8×1 P1-8×1; mtime 2026-09-13 08:53:07 (edited by a later LX lane)
- `M` `apps/api/src/services/pim/catalog-workbook-scopes.ts` — LX revert list; census +10/-5 VT=0 LX=8 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/catalog-workbook-scopes.vitest.test.ts` — LX revert list; census +2/-2 VT=0 LX=1 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/catalog-workbook.ts` — LX revert list; census +39/-15 VT=0 LX=7 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/catalog-workbook.vitest.test.ts` — LX revert list; census +32/-30 VT=0 LX=1 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/channel-inheritance.ts` — LX revert list; census +1/-2 VT=0 LX=0 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/channel-specs/etsy-mapping.vitest.test.ts` — LX.F2 R-LX-21
- `M` `apps/api/src/services/pim/channel-specs/index.ts` — LX.F2 R-LX-20 :44050 (+ in the LX revert list)
- `M` `apps/api/src/services/pim/channel-specs/shopify.ts` — LX revert list; census +8/-3 VT=0 LX=0 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/channel-specs/store.ts` — LX revert list; census +5/-3 VT=0 LX=5 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/content-locale.ts` — LX revert list; census +14/-39 VT=0 LX=11 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/content-locale.vitest.test.ts` — LX.F R-LX-13
- `M` `apps/api/src/services/pim/global-content.ts` — LX revert list; census +5/-6 VT=0 LX=4 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/global-content.vitest.test.ts` — LX revert list; census +2/-2 VT=0 LX=1 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/import-diff.service.ts` — LX.F P2-18 (+ in the LX revert list)
- `M` `apps/api/src/services/pim/import-diff.service.vitest.test.ts` — LX.F P2-18 (+ in the LX revert list)
- `M` `apps/api/src/services/pim/import-jobs.service.ts` — LX revert list; census +2/-1 VT=0 LX=2 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/information-database.vitest.test.ts` — LX.F/LX.F2 R-LX-16 (+ in the LX revert list)
- `M` `apps/api/src/services/pim/information-locale.ts` — LX.F P2-17 :41269 (+ in the LX revert list)
- `M` `apps/api/src/services/pim/information-sheet.ts` — LX revert list; census +8/-1 VT=0 LX=5 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/listing-readiness.service.ts` — LX revert list; census +49/-106 VT=0 LX=12 ; mtime 2026-09-13 07:45:57 (edited by a later LX lane)
- `M` `apps/api/src/services/pim/listing-readiness.vitest.test.ts` — LX revert list; census +58/-115 VT=0 LX=16 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/localized-content.ts` — LX revert list; census +3/-2 VT=0 LX=0 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/localized-route.vitest.test.ts` — LX.F R-LX-13
- `M` `apps/api/src/services/pim/mapping-simulate.service.ts` — LX revert list; census +9/-4 VT=0 LX=8 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/mapping/category-mapping.service.ts` — LX.F2 R-LX-20
- `M` `apps/api/src/services/pim/mapping/cell-formula-channel-write.vitest.test.ts` — LX.F R-LX-13
- `M` `apps/api/src/services/pim/mapping/cell-formula.service.ts` — LX.F F-LX-1 (markers LX.F×3 F-LX-1×3) (+ in the LX revert list)
- `M` `apps/api/src/services/pim/mapping/field-catalogue.vitest.test.ts` — LX.F R-LX-13
- `M` `apps/api/src/services/pim/mapping/formula-storage.ts` — LX revert list; census +29/-7 VT=0 LX=11 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/mapping/formula-storage.vitest.test.ts` — LX.F R-LX-13
- `M` `apps/api/src/services/pim/mapping/mapping-sources.service.ts` — LX revert list; census +8/-5 VT=0 LX=8 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/mapping/master-rule.service.ts` — LX revert list; census +6/-4 VT=0 LX=6 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/mapping/resolve-batch.service.ts` — LX revert list; census +40/-21 VT=0 LX=22 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/mapping/resolve-batch.vitest.test.ts` — LX.F R-LX-13
- `M` `apps/api/src/services/pim/market-language-payloads.vitest.test.ts` — LX revert list; census +3/-1 VT=0 LX=1 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/market-languages-guard.ts` — LX.F P2-9/P2-10 + CLOSE.1 R-LX-29 :47033
- `M` `apps/api/src/services/pim/market-languages-guard.vitest.test.ts` — LX.F + CLOSE.1 R-LX-29 (VT.1 lines are citations)
- `M` `apps/api/src/services/pim/market-languages.ts` — LX.F F-LX-5 (+ in the LX revert list)
- `M` `apps/api/src/services/pim/market-languages.vitest.test.ts` — LX.F P2-17/P2-15
- `M` `apps/api/src/services/pim/master-inheritance.vitest.test.ts` — LX.F R-LX-13
- `M` `apps/api/src/services/pim/product-relationship.vitest.test.ts` — LX.F2 R-LX-21
- `M` `apps/api/src/services/pim/readiness-account.vitest.test.ts` — LX.F R-LX-13
- `M` `apps/api/src/services/pim/readiness.service.ts` — LX revert list; census +9/-1 VT=0 LX=4 LX.5×1; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/resolve-channel-field.ts` — LX revert list; census +43/-25 VT=0 LX=20 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/resolver-shadow.ts` — LX revert list; census +3/-1 VT=0 LX=1 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/schema-sync-bridge.ts` — LX.F2 R-LX-20
- `M` `apps/api/src/services/pim/scope-readiness.vitest.test.ts` — LX.F R-LX-9 ×3 (+ in the LX revert list)
- `M` `apps/api/src/services/pim/studio-account-resolution.vitest.test.ts` — LX.F R-LX-13
- `M` `apps/api/src/services/pim/studio-channel-provenance.vitest.test.ts` — LX.F R-LX-13
- `M` `apps/api/src/services/pim/studio-columns.ts` — LX revert list; census +3/-2 VT=0 LX=0 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/pim/studio-sheet-axis.vitest.test.ts` — LX.F R-LX-13
- `M` `apps/api/src/services/pim/translation-write.ts` — LX revert list; census +86/-31 VT=0 LX=22 LX.F×1 LX.7V×1; mtime 2026-09-13 09:11:35 (edited by a later LX lane)
- `M` `apps/api/src/services/products/bulk-edit.service.ts` — LX.F P2-12 (+ in the LX revert list)
- `M` `apps/api/src/services/products/translation-resolver.service.ts` — LX revert list; census +13/-9 VT=0 LX=8 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/shopify/channel-sheet-projection.ts` — LX revert list; census +20/-4 VT=0 LX=7 LX.6×1 LX.12×1; mtime 2026-09-13 07:08:39 (edited by a later LX lane)
- `M` `apps/api/src/services/shopify/channel-sheet.service.ts` — LX.F F-LX-1 (marker) (+ in the LX revert list)
- `M` `apps/api/src/services/shopify/content-sync.service.ts` — LX.F P0-2 (marker R-LX-7; 07:23:54)
- `M` `apps/api/src/services/shopify/listing-information-plan.ts` — LX revert list; census +32/-9 VT=0 LX=19 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/services/taxonomy/repository.ts` — LX.F2 R-LX-20
- `M` `apps/api/src/services/translation-completeness.service.ts` — LX revert list; census +14/-30 VT=0 LX=11 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/api/src/test-support/formula-database.ts` — LX.F P3-22 :41274
- `M` `apps/factory/src/app/api/products/templates/[id]/costing/route.ts` — HEAD NUL count +-/--; 13-file sum = 35 = R-LX-19's figure
- `M` `apps/factory/src/design-system/CHANGELOG.md` — LX revert list; census +23/-0 VT=0 LX=6 LX.11×1 LX.10×1; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/factory/src/design-system/catalog/README.md` — LX revert list; census +16/-0 VT=0 LX=6 LX.10×1; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/factory/src/design-system/components/SourceIndicator.tsx` — LX revert list; census +6/-4 VT=0 LX=0 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/factory/src/design-system/grid/renderers/readiness.ts` — LX.F R-LX-9 mirror
- `M` `apps/factory/src/design-system/patterns/ScopeBar.tsx` — LX.F R-LX-9 mirror (08:34:08)
- `M` `apps/factory/src/design-system/primitives/Pill.tsx` — CLOSE.1 mirror
- `M` `apps/factory/src/design-system/styles/primitives.css` — CLOSE.1 mirror
- `M` `apps/factory/src/lib/__tests__/fs1-aggregate-parity.test.ts` — HEAD NUL count +-/--; 13-file sum = 35 = R-LX-19's figure
- `M` `apps/factory/src/lib/inbox/attachments.ts` — HEAD NUL count +-/--; 13-file sum = 35 = R-LX-19's figure
- `M` `apps/web/src/app/products/[id]/edit/ProductEditClient.tsx` — LX.6 (h) :41181 (step6 manifest)
- `M` `apps/web/src/app/products/[id]/edit/_shared/useTabPrefs.ts` — LX.6 (h) (step6 manifest)
- `M` `apps/web/src/app/products/[id]/edit/_studio/StudioBar.tsx` — LX revert list; census +21/-9 VT=0 LX=8 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/StudioClient.tsx` — LX revert list; census +3/-2 VT=0 LX=3 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/StudioLoader.tsx` — LX revert list; census +1/-0 VT=0 LX=1 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/ai/api.ts` — LX revert list; census +8/-0 VT=0 LX=3 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/ai/drafts.ts` — LX revert list; census +11/-0 VT=0 LX=3 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/ai/drafts.vitest.test.ts` — LX revert list; census +12/-0 VT=0 LX=4 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/ai/useAiDraftLayer.ts` — LX revert list; census +8/-6 VT=0 LX=0 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/ai/useAiDrafts.ts` — LX revert list; census +12/-4 VT=0 LX=4 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/channel-ops/ErrorsSyncTab.tsx` — LX revert list; census +5/-9 VT=0 LX=0 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/contracts.tsx` — LX revert list; census +34/-25 VT=0 LX=32 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/drawer/RecordDrawer.tsx` — LX.6 item (e) :41179 (markers LX.13×2)
- `M` `apps/web/src/app/products/[id]/edit/_studio/drawer/fields/FormulaField.tsx` — LX revert list; census +3/-2 VT=0 LX=2 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/drawer/formulaCandidates.ts` — LX revert list; census +4/-17 VT=0 LX=2 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/drawer/formulaCandidates.vitest.test.ts` — LX revert list; census +6/-0 VT=0 LX=1 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/drawer/panes/RecordPane.tsx` — LX revert list; census +7/-7 VT=0 LX=6 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/readiness.ts` — LX.FIN R-LX-22 :45391 (+ in the LX revert list)
- `M` `apps/web/src/app/products/[id]/edit/_studio/readiness.vitest.test.ts` — LX.FIN R-LX-22 (+ in the LX revert list)
- `M` `apps/web/src/app/products/[id]/edit/_studio/scopes.vitest.test.ts` — LX revert list; census +35/-9 VT=0 LX=26 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/sheet/FormulaBulkDialog.tsx` — LX revert list; census +11/-8 VT=0 LX=6 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/sheet/ReferenceSelectEditor.tsx` — LX.6 (step6 source-manifest)
- `M` `apps/web/src/app/products/[id]/edit/_studio/sheet/SheetToolbar.tsx` — LX revert list; census +69/-16 VT=0 LX=18 R-LX-18×4 LX.F2×4 R-LX-27×2; mtime 2026-09-13 12:47:14 (edited by a later LX lane)
- `M` `apps/web/src/app/products/[id]/edit/_studio/sheet/channel/CascadeCell.tsx` — LX revert list; census +1/-1 VT=0 LX=0 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/sheet/channel/channel-sheet.css` — LX revert list; census +4/-0 VT=0 LX=0 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/sheet/channel/rows.ts` — LX revert list; census +11/-1 VT=0 LX=1 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/sheet/channel/rows.vitest.test.ts` — LX revert list; census +12/-0 VT=0 LX=0 LX6×1; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/sheet/channel/value-source.ts` — LX revert list; census +0/-54 VT=0 LX=0 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/sheet/channel/value-source.vitest.test.ts` — LX revert list; census +2/-60 VT=0 LX=0 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/sheet/master/FamilyBar.tsx` — CLOSE.1 R-LX-27 :47041
- `M` `apps/web/src/app/products/[id]/edit/_studio/sheet/master/adaptLegacy.ts` — LX.FIN R-LX-22 (markers R-LX-22 LX.FIN LX.15)
- `M` `apps/web/src/app/products/[id]/edit/_studio/sheet/master/adaptLegacy.vitest.test.ts` — LX.FIN R-LX-22
- `M` `apps/web/src/app/products/[id]/edit/_studio/sheet/master/masterWrite.vitest.test.ts` — LX revert list; census +25/-29 VT=0 LX=8 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/sheet/referenceOptions.ts` — LX.6 item 2 :41171
- `M` `apps/web/src/app/products/[id]/edit/_studio/sheet/referenceOptions.vitest.test.ts` — LX.6 item 2 ("Description theme" = reference label, not variation)
- `M` `apps/web/src/app/products/[id]/edit/_studio/sheet/sheetExport.ts` — LX.F P2-13 :41288
- `M` `apps/web/src/app/products/[id]/edit/_studio/sheet/sheetExport.vitest.test.ts` — LX.F P2-13
- `M` `apps/web/src/app/products/[id]/edit/_studio/sheet/sheetRecovery.ts` — LX.6 (step6 source-manifest)
- `M` `apps/web/src/app/products/[id]/edit/_studio/sheet/useReferenceNames.ts` — LX.6 item 2
- `M` `apps/web/src/app/products/[id]/edit/_studio/shopify/channelSheetWriter.ts` — LX revert list; census +1/-1 VT=0 LX=1 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/studio-data.ts` — LX revert list; census +8/-4 VT=0 LX=6 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/studio.module.css` — LX revert list; census +3/-0 VT=0 LX=2 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/types.ts` — LX.FIN R-LX-22 :45392 (+ in the LX revert list)
- `M` `apps/web/src/app/products/[id]/edit/_studio/useCellFormulas.ts` — LX revert list; census +48/-30 VT=0 LX=13 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/[id]/edit/_studio/variants/family/FamilyVariants.tsx` — CLOSE.1 R-LX-27: familyVerbs.status → status() with the compaction comment; mtime 12:47:34 = FamilyBar.tsx (CLOSE.1) to the second; VP base committed f212c2348. Method: content + mtime cluster (no claim names it — CLOSE.1 should confirm)
- `M` `apps/web/src/app/products/[id]/edit/studio/page.tsx` — LX revert list; census +1/-0 VT=0 LX=1 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `D` `apps/web/src/app/products/[id]/edit/tabs/LocalesTab.tsx` — LX revert list; mtime (absent) (edited by a later LX lane)
- `M` `apps/web/src/app/products/_lenses/TranslationsLens.tsx` — LX.FIN R-LX-25 :45386
- `M` `apps/web/src/app/products/_shared/ProductDrawer.tsx` — LX.6 (h) + LX.FIN R-LX-25 :45385
- `M` `apps/web/src/app/products/catalog-transfer/page.tsx` — LX revert list; census +4/-2 VT=0 LX=2 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/ebay-flat-file/presentation-test/PresentationFixture.tsx` — LX revert list; census +1/-1 VT=1 LX=1 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/listing-readiness/page.tsx` — LX revert list; census +44/-105 VT=0 LX=10 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/listing-readiness/readiness.module.css` — LX revert list; census +2/-0 VT=0 LX=0 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/app/products/next/productsServerContract.ts` — LX revert list; census +1/-0 VT=0 LX=1 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/components/CommandPalette.tsx` — LX.6 (h) LX.16 marker (Locales entry removal)
- `M` `apps/web/src/design-system/CHANGELOG.md` — LX revert list; census +25/-0 VT=0 LX=7 LX.7×1 LX.11×1 LX.10×1; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/design-system/catalog/README.md` — LX revert list; census +18/-0 VT=0 LX=6 LX.10×1; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/design-system/catalog/TokenCatalog.tsx` — LX revert list; census +1/-0 VT=0 LX=0 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/design-system/components/SourceIndicator.tsx` — LX revert list; census +6/-4 VT=0 LX=0 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/design-system/grid/editors/FormulaCellEditor.tsx` — LX revert list; census +6/-6 VT=0 LX=0 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/design-system/grid/editors/FormulaCellEditor.vitest.test.ts` — LX revert list; census +14/-0 VT=0 LX=0 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/design-system/grid/renderers/IdentityBand.tsx` — LX revert list; census +1/-53 VT=0 LX=1 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/design-system/grid/renderers/cells.tsx` — LX.FIN R-LX-22 :45393 (ScopeReadinessCell)
- `M` `apps/web/src/design-system/grid/renderers/provenance.ts` — LX revert list; census +34/-6 VT=0 LX=6 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/design-system/grid/renderers/provenanceMark.tsx` — LX revert list; census +8/-5 VT=0 LX=0 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `apps/web/src/design-system/grid/renderers/readiness.ts` — LX.F R-LX-9 (marker)
- `M` `apps/web/src/design-system/grid/toolbars/index.ts` — LX.F2 R-LX-18 + CLOSE.1 R-LX-27 :47038
- `M` `apps/web/src/design-system/patterns/ScopeBar.tsx` — LX.F R-LX-9 `notComputed` (1 line, 07:46:24 LX.F window)
- `M` `apps/web/src/design-system/primitives/Pill.tsx` — CLOSE.1 R-LX-27 :47036
- `M` `apps/web/src/design-system/styles/primitives.css` — CLOSE.1 R-LX-27
- `M` `docs/2026-09-03-cell-editing-contract.md` — LX revert list; census +31/-9 VT=0 LX=3 LX.8×2; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `packages/database/workspaces/model-ownership.json` — LX revert list; census +3/-1 VT=0 LX=2 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `packages/database/workspaces/scoped-keys.json` — LX revert list; census +43/-0 VT=0 LX=6 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `packages/shared/listing-readiness.ts` — LX revert list; census +8/-8 VT=0 LX=1 R-LX-9×1 LX.F×1; mtime 2026-09-13 08:28:03 (edited by a later LX lane)
- `M` `packages/shared/product-media.ts` — LX revert list; census +5/-3 VT=0 LX=5 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `packages/shared/product-media.vitest.test.ts` — LX revert list; census +1/-1 VT=0 LX=1 ; mtime 04:49:54 (untouched since the 05:25 undo)
- `M` `scripts/ds-fork-baseline.json` — LX.F P2-3 factory barrel + mirrors (08:34:35; adds grid/renderers/index.ts to the baseline). Method: claim (LX.F :41290) + mtime cluster; no lane line names the file today
- `M` `scripts/studio-browser-auth.mjs` — LX revert list; census +53/-11 VT=5 LX=2 R-LX-3×1 LX.FIN×1 LX.F2×1 LX.6×1; mtime 2026-09-13 11:55:35 (edited by a later LX lane)
- `??` `apps/api/src/jobs/readiness-reconcile.job.ts` — LX deleted-files list; mtime 2026-09-13 08:56:01 (edited by a later LX lane)
- `??` `apps/api/src/jobs/readiness-reconcile.vitest.test.ts` — LX deleted-files list; mtime 2026-09-12 23:50:39 (edited by a later LX lane)
- `??` `apps/api/src/services/categories/category-schema-coordinate.ts` — LX.F2 R-LX-20 (new, 10:22)
- `??` `apps/api/src/services/categories/category-schema-coordinate.vitest.test.ts` — LX.F2 R-LX-20
- `??` `apps/api/src/services/pim/amazon-content-payload.ts` — LX deleted-files list; mtime 2026-09-13 08:20:41 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/amazon-content-payload.vitest.test.ts` — LX deleted-files list; mtime 2026-09-13 07:20:26 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/cached-schema-context.ts` — LX deleted-files list; mtime 2026-09-12 23:24:41 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/catalog-language.ts` — LX deleted-files list; mtime 2026-09-13 10:28:25 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/catalog-language.vitest.test.ts` — LX deleted-files list; mtime 2026-09-13 10:31:12 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/catalog-transfer-content.ts` — LX step 7 (step7 manifest: created) (+ in the LX revert list)
- `??` `apps/api/src/services/pim/catalog-translate.ts` — LX deleted-files list; mtime 2026-09-13 09:08:56 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/catalog-translate.vitest.test.ts` — LX deleted-files list; mtime 2026-09-13 09:10:22 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/channel-specs/cache-first.vitest.test.ts` — LX deleted-files list; mtime 2026-09-13 08:26:30 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/content-bulk-write.ts` — LX deleted-files list; mtime 2026-09-13 08:40:56 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/content-language.ts` — LX deleted-files list; mtime 2026-09-12 09:13:06 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/content-language.vitest.test.ts` — LX deleted-files list; mtime 2026-09-12 08:19:20 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/content-read.ts` — LX deleted-files list; mtime 2026-09-13 03:09:47 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/content-read.vitest.test.ts` — LX deleted-files list; mtime 2026-09-13 07:39:47 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/content-readiness.vitest.test.ts` — LX deleted-files list; mtime 2026-09-12 09:04:37 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/content-resolver-shadow.vitest.test.ts` — LX deleted-files list; mtime 2026-09-12 09:28:24 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/content-resolver.ts` — LX deleted-files list; mtime 2026-09-13 00:12:49 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/content-resolver.vitest.test.ts` — LX deleted-files list; mtime 2026-09-12 09:04:37 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/content-wire-parity.vitest.test.ts` — LX.F R-LX-15 parity test (marker)
- `??` `apps/api/src/services/pim/content-write.ts` — LX deleted-files list; mtime 2026-09-13 09:47:46 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/content-write.vitest.test.ts` — LX deleted-files list; mtime 2026-09-13 09:11:59 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/language-sheet.ts` — LX deleted-files list; mtime 2026-09-13 02:41:09 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/language-sheet.vitest.test.ts` — LX deleted-files list; mtime 2026-09-13 02:41:09 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/legacy-content-write.ts` — LX deleted-files list; mtime 2026-09-12 08:57:14 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/publish-review-gate.ts` — LX.F P0-2 :41254
- `??` `apps/api/src/services/pim/publish-review-gate.vitest.test.ts` — LX.F P0-2
- `??` `apps/api/src/services/pim/readiness-index.vitest.test.ts` — LX deleted-files list; mtime 2026-09-12 23:49:07 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/sheet-columns-cache.vitest.test.ts` — LX deleted-files list; mtime 2026-09-13 00:19:15 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/studio-columns-cache.vitest.test.ts` — LX deleted-files list; mtime 2026-09-13 00:16:46 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/studio-content-wire.ts` — LX deleted-files list; mtime 2026-09-13 03:29:00 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/studio-content-wire.vitest.test.ts` — LX deleted-files list; mtime 2026-09-13 03:15:23 (edited by a later LX lane)
- `??` `apps/api/src/services/pim/studio-sheet-language-issue.vitest.test.ts` — LX.F (08:26)
- `??` `apps/factory/src/design-system/grid/renderers/CompletenessPill.tsx` — LX deleted-files list; mtime 2026-09-13 03:02:59 (edited by a later LX lane)
- `??` `apps/factory/src/design-system/grid/renderers/index.ts` — LX deleted-files list; mtime 2026-09-13 03:02:59 (edited by a later LX lane)
- `??` `apps/factory/src/design-system/grid/renderers/provenance.ts` — LX deleted-files list; mtime 2026-09-13 03:34:52 (edited by a later LX lane)
- `??` `apps/factory/src/design-system/grid/renderers/provenanceMark.tsx` — LX deleted-files list; mtime 2026-09-13 04:29:02 (edited by a later LX lane)
- `??` `apps/web/src/app/products/[id]/edit/_studio/ai/api.vitest.test.ts` — LX deleted-files list; mtime 2026-09-13 02:32:33 (edited by a later LX lane)
- `??` `apps/web/src/app/products/[id]/edit/_studio/channel-ops/ReadinessPanel.tsx` — LX deleted-files list; mtime 2026-09-12 23:58:06 (edited by a later LX lane)
- `??` `apps/web/src/app/products/[id]/edit/_studio/channel-ops/readiness.module.css` — LX deleted-files list; mtime 2026-09-12 23:55:52 (edited by a later LX lane)
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/buildSheetColumns.tsx` — LX deleted-files list; mtime 2026-09-13 01:42:36 (edited by a later LX lane)
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/buildSheetColumns.vitest.test.ts` — LX deleted-files list; mtime 2026-09-13 04:31:06 (edited by a later LX lane)
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/compareTargets.ts` — LX.6 item (e) :41182
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/compareTargets.vitest.test.ts` — LX.6 item (e)
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/content-wire.vitest.test.ts` — LX.F R-LX-15 (08:55) (+ in the LX revert list)
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/content-write.vitest.test.ts` — LX deleted-files list; mtime 2026-09-12 16:46:44 (edited by a later LX lane)
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/formulaColumns.ts` — LX deleted-files list; mtime 2026-09-13 02:34:09 (edited by a later LX lane)
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/formulaColumns.vitest.test.ts` — LX deleted-files list; mtime 2026-09-13 02:32:33 (edited by a later LX lane)
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/languageChips.ts` — LX deleted-files list; mtime 2026-09-13 03:11:19 (edited by a later LX lane)
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/languageWrites.ts` — LX deleted-files list; mtime 2026-09-13 01:09:10 (edited by a later LX lane)
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/languageWrites.vitest.test.ts` — LX deleted-files list; mtime 2026-09-13 03:30:54 (edited by a later LX lane)
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/languages.ts` — LX deleted-files list; mtime 2026-09-13 02:28:47 (edited by a later LX lane)
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/languages.vitest.test.ts` — LX deleted-files list; mtime 2026-09-13 03:12:37 (edited by a later LX lane)
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/master/channelColumns.vitest.test.ts` — LX6 renderer tests (deleted list), rewritten by nexus-commerce-89 :40899
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/master/coordinateReadiness.vitest.test.ts` — LX.FIN R-LX-22 :45396
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/useLanguageChips.ts` — LX deleted-files list; mtime 2026-09-13 01:41:49 (edited by a later LX lane)
- `??` `apps/web/src/app/products/_shared/translationSurfaceAddress.vitest.test.ts` — LX.FIN R-LX-25
- `??` `apps/web/src/app/products/next/TranslateDialog.tsx` — LX deleted-files list; mtime 2026-09-13 01:57:02 (edited by a later LX lane)
- `??` `apps/web/src/app/products/next/language.module.css` — LX deleted-files list; mtime 2026-09-13 00:31:37 (edited by a later LX lane)
- `??` `apps/web/src/app/products/next/languageColumns.tsx` — LX deleted-files list; mtime 2026-09-13 00:31:37 (edited by a later LX lane)
- `??` `apps/web/src/design-system/grid/renderers/CompletenessPill.tsx` — LX deleted-files list; mtime 2026-09-13 03:02:59 (edited by a later LX lane)
- `??` `apps/web/src/design-system/grid/renderers/CompletenessPill.vitest.test.ts` — LX.F P3-22 (marker)
- `??` `apps/web/src/design-system/grid/renderers/provenanceLanguage.vitest.test.ts` — LX deleted-files list; mtime 2026-09-13 03:34:52 (edited by a later LX lane)
- `??` `apps/web/src/design-system/grid/renderers/readiness.vitest.test.ts` — LX.F R-LX-9 (marker)
- `??` `apps/web/src/design-system/grid/toolbars/GridToolbarFold.tsx` — LX.F2 R-LX-18 + CLOSE.1 R-LX-27
- `??` `apps/web/src/design-system/grid/toolbars/toolbarFold.vitest.test.ts` — CLOSE.1
- `??` `docs/lx-prompts-2026-09-13.md` — LX prompts (orchestrator)
- `??` `packages/shared/cell-provenance.ts` — LX deleted-files list; mtime 2026-09-13 00:12:49 (edited by a later LX lane)
- `??` `packages/shared/channel-label.ts` — LX.F P2-15
- `??` `packages/shared/content-address.vitest.test.ts` — LX.FIN R-LX-25
- `??` `packages/shared/content-header.ts` — LX.F P2-13
- `??` `packages/shared/content-language.ts` — LX deleted-files list; mtime 2026-09-13 11:20:10 (edited by a later LX lane)
- `??` `scripts/check-market-languages.mjs` — LX.F P2-11 + CLOSE.1 R-LX-29
- `??` `scripts/check-no-nul-bytes.mjs` — LX.F / LX.F2 R-LX-19
- `??` `scripts/check-table-grants.mjs` — CLOSE.1 R-LX-28 :47031
- `??` `scripts/market-languages-baseline.json` — CLOSE.1 R-LX-29 (12:43)
- `??` `scripts/table-grants-baseline.json` — CLOSE.1 R-LX-28

### CONSOLIDATION (23)
- `M` `apps/web/src/app/products/[id]/edit/_studio/StudioTabHost.tsx` — docs/audits/2026-09-13-single-sheet/{README.md,source-manifest.json}; ledger :40897/:40901/:40903 (nexus-commerce-89); mtime 04:49:54 = whole-tree patch re-apply, NOT in the LX checked-out list
- `M` `apps/web/src/app/products/[id]/edit/_studio/sheet/channel/ChannelScopeTab.tsx` — docs/audits/2026-09-13-single-sheet/{README.md,source-manifest.json}; ledger :40897/:40901/:40903 (nexus-commerce-89); mtime 04:49:54 = whole-tree patch re-apply, NOT in the LX checked-out list
- `M` `apps/web/src/app/products/[id]/edit/_studio/sheet/channel/ChannelSheet.tsx` — docs/audits/2026-09-13-single-sheet/{README.md,source-manifest.json}; ledger :40897/:40901/:40903 (nexus-commerce-89); mtime 2026-09-13 09:44:05
- `M` `apps/web/src/app/products/[id]/edit/_studio/sheet/channel/viewChips.ts` — docs/audits/2026-09-13-single-sheet/{README.md,source-manifest.json}; ledger :40897/:40901/:40903 (nexus-commerce-89); mtime 04:49:54 = whole-tree patch re-apply, NOT in the LX checked-out list
- `M` `apps/web/src/app/products/[id]/edit/_studio/sheet/master/MasterSheet.tsx` — docs/audits/2026-09-13-single-sheet/{README.md,source-manifest.json}; ledger :40897/:40901/:40903 (nexus-commerce-89); mtime 04:49:54 = whole-tree patch re-apply, NOT in the LX checked-out list
- `M` `apps/web/src/app/products/[id]/edit/_studio/sheet/master/index.tsx` — docs/audits/2026-09-13-single-sheet/{README.md,source-manifest.json}; ledger :40897/:40901/:40903 (nexus-commerce-89); mtime 04:49:54 = whole-tree patch re-apply, NOT in the LX checked-out list
- `M` `apps/web/src/app/products/[id]/edit/_studio/sheet/master/reloadGuard.vitest.test.ts` — docs/audits/2026-09-13-single-sheet/{README.md,source-manifest.json}; ledger :40897/:40901/:40903 (nexus-commerce-89); mtime 04:49:54 = whole-tree patch re-apply, NOT in the LX checked-out list
- `M` `scripts/check-layout-v2.mjs` — docs/audits/2026-09-13-single-sheet/{README.md,source-manifest.json}; ledger :40897/:40901/:40903 (nexus-commerce-89); mtime 04:49:54 = whole-tree patch re-apply, NOT in the LX checked-out list
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/ProductSheetSurface.tsx` — docs/audits/2026-09-13-single-sheet/{README.md,source-manifest.json}; ledger :40897/:40901/:40903 (nexus-commerce-89); mtime 2026-09-13 04:17:08
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/ProductSheetTab.tsx` — docs/audits/2026-09-13-single-sheet/{README.md,source-manifest.json}; ledger :40897/:40901/:40903 (nexus-commerce-89); mtime 2026-09-13 04:17:08
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/channel/cellDetailsSource.ts` — docs/audits/2026-09-13-single-sheet/{README.md,source-manifest.json}; ledger :40897/:40901/:40903 (nexus-commerce-89); mtime 2026-09-13 03:43:35
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/productSheetInteraction.vitest.test.ts` — docs/audits/2026-09-13-single-sheet/{README.md,source-manifest.json}; ledger :40897/:40901/:40903 (nexus-commerce-89); mtime 2026-09-13 03:47:57
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/productSheetModel.ts` — docs/audits/2026-09-13-single-sheet/{README.md,source-manifest.json}; ledger :40897/:40901/:40903 (nexus-commerce-89); mtime 2026-09-13 04:17:08
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/productSheetRows.ts` — docs/audits/2026-09-13-single-sheet/{README.md,source-manifest.json}; ledger :40897/:40901/:40903 (nexus-commerce-89); mtime 2026-09-13 03:15:20
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/productSheetRows.vitest.test.ts` — docs/audits/2026-09-13-single-sheet/{README.md,source-manifest.json}; ledger :40897/:40901/:40903 (nexus-commerce-89); mtime 2026-09-13 03:38:04
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/sheetChips.ts` — docs/audits/2026-09-13-single-sheet/{README.md,source-manifest.json}; ledger :40897/:40901/:40903 (nexus-commerce-89); mtime 2026-09-13 03:30:53
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/sheetChips.vitest.test.ts` — docs/audits/2026-09-13-single-sheet/{README.md,source-manifest.json}; ledger :40897/:40901/:40903 (nexus-commerce-89); mtime 2026-09-13 03:38:04
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/useProductSheetInteraction.ts` — docs/audits/2026-09-13-single-sheet/{README.md,source-manifest.json}; ledger :40897/:40901/:40903 (nexus-commerce-89); mtime 2026-09-13 03:47:25
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/useSheetChips.ts` — docs/audits/2026-09-13-single-sheet/{README.md,source-manifest.json}; ledger :40897/:40901/:40903 (nexus-commerce-89); mtime 2026-09-13 03:40:52
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/useSheetGeometry.ts` — docs/audits/2026-09-13-single-sheet/{README.md,source-manifest.json}; ledger :40897/:40901/:40903 (nexus-commerce-89); mtime 2026-09-13 03:52:55
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/useSheetGridBindings.ts` — docs/audits/2026-09-13-single-sheet/{README.md,source-manifest.json}; ledger :40897/:40901/:40903 (nexus-commerce-89); mtime 2026-09-13 03:17:33
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/useSheetPreferences.ts` — docs/audits/2026-09-13-single-sheet/{README.md,source-manifest.json}; ledger :40897/:40901/:40903 (nexus-commerce-89); mtime 2026-09-13 03:30:53
- `??` `apps/web/src/app/products/[id]/edit/_studio/sheet/useSheetSaveStatus.ts` — docs/audits/2026-09-13-single-sheet/{README.md,source-manifest.json}; ledger :40897/:40901/:40903 (nexus-commerce-89); mtime 2026-09-13 03:18:48

### VX-MOCK (6)
- `??` `apps/web/src/app/design/variation-projection/VariationProjectionClient.tsx` — VX claims docs/pes-claims.md:39724 and :40741 (new files only, nothing committed)
- `??` `apps/web/src/app/design/variation-projection/fixtures.ts` — VX claims docs/pes-claims.md:39724 and :40741 (new files only, nothing committed)
- `??` `apps/web/src/app/design/variation-projection/page.tsx` — VX claims docs/pes-claims.md:39724 and :40741 (new files only, nothing committed)
- `??` `apps/web/src/app/design/variation-projection/variation-projection.module.css` — VX claims docs/pes-claims.md:39724 and :40741 (new files only, nothing committed)
- `??` `docs/2026-09-12-variation-projection-design.md` — VX claims docs/pes-claims.md:39724 and :40741 (new files only, nothing committed)
- `??` `docs/vx-prompts.md` — VX claims docs/pes-claims.md:39724 and :40741 (new files only, nothing committed)

### OTHER (3)
- `M` `docs/pes-claims.md` — ledger — every lane appends; commit separately/last
- `??` `docs/2026-09-13-matrix-page-design.md` — MX design (session d4423145), ledger :41468
- `??` `docs/mx-prompts.md` — MX prompts DRAFT, ledger :41468

### PROBE/SCRATCH — the 90 probe scripts (the 628 audit entries are listed only in `attribution.json` / `group-PROBE-SCRATCH.txt`)
- `M` `apps/api/scripts/_kt-study2.mts` — tracked probe, see sub
- `M` `apps/api/scripts/_ufx-gpsr-ps-stage.mts` — tracked probe, see sub
- `??` `apps/api/scripts/_lxf2-disc.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_lxf2-errgroups.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_lxf2-f9.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_lxf2-f9b.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_lxf2-itemg.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_lxf2-p221b.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_lxf2-p221c.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_lxf2-verifycols.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_lxfin-aiaddr.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_lxfin-aiconf.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_lxfin-disc.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_lxfin-fingerprints.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_lxfin-fixture.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_lxfin-grantprobe.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_lxfin-r22.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_lxfin-r22b.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_lxfin-r22c.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_lxfin-r22d.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_lxfin-r25.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_lxfin-r26.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_lxfin-roles.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_lxfin-storelocales.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_lxfin-stores.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_lxfin-verifyrls.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_lxfin-verifyschema.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vt0-theme-derivation.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vt0b-theme-attributes.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vt1-ebay-precedence.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vt1-emit-fixture.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vt1-fixture-connect.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vt1-fixture-create.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vt1-fixture-facts.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vt1-lifecycle.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vt1-phase0-db.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vt1-phase0-ebay-aspects.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vt1-required.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vt1-suit.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vt1-write-rehearsal.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vt1b-col-check.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vt1b-disc.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vt1b-final-state.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vt1b-index-proof.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vt1b-lock-parity.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vt1b-p0-live.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vt1b-rule-commit-rehearsal.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vt1b-rvt2-probe.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vt1b-rvt2-rehearsal.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vt4b-arm.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vt4b-filter-proof.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vtf2-cat-facts.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vtf2-cm.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vtf2-create-fixture.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vtf2-delete-fixture.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vtf2-ebay-facts.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vtf2-ebay-store.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vtf2-facts.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vtf2-final-check.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vtf2-raw-mapping.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vtf2-shape-audit.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vtf2-shape-census.mts` — untracked, named by its lane prefix
- `??` `apps/api/scripts/_vtf2-trigger-facts.mts` — untracked, named by its lane prefix
- `??` `scripts/_close1-pills.mjs` — untracked, named by its lane prefix
- `??` `scripts/_lxf2-toolbar.mjs` — untracked, named by its lane prefix
- `??` `scripts/_lxfin-screens.mjs` — untracked, named by its lane prefix
- `??` `scripts/_lxfin-screens2.mjs` — untracked, named by its lane prefix
- `??` `scripts/_vt2c-screens.mjs` — untracked, named by its lane prefix
- `??` `scripts/_vt4-screens.mjs` — untracked, named by its lane prefix
- `??` `scripts/_vt4-screens2.mjs` — untracked, named by its lane prefix
- `??` `scripts/_vt4b-footer.mjs` — untracked, named by its lane prefix
- `??` `scripts/_vt4b-screens.mjs` — untracked, named by its lane prefix
- `??` `scripts/_vtf-200arm.mjs` — untracked, named by its lane prefix
- `??` `scripts/_vtf-coords.mjs` — untracked, named by its lane prefix
- `??` `scripts/_vtf-db.mjs` — untracked, named by its lane prefix
- `??` `scripts/_vtf-delete-fixture.mjs` — untracked, named by its lane prefix
- `??` `scripts/_vtf-ebay-fixture.mjs` — untracked, named by its lane prefix
- `??` `scripts/_vtf-env-which-db.mjs` — untracked, named by its lane prefix
- `??` `scripts/_vtf-gate-users.mjs` — untracked, named by its lane prefix
- `??` `scripts/_vtf-matrix.mts` — untracked, named by its lane prefix
- `??` `scripts/_vtf-mk-ebay.mjs` — untracked, named by its lane prefix
- `??` `scripts/_vtf-screens.mjs` — untracked, named by its lane prefix
- `??` `scripts/_vtf-src-values.mjs` — untracked, named by its lane prefix
- `??` `scripts/_vtf-wire.mjs` — untracked, named by its lane prefix
- `??` `scripts/_vtf2-cells.mjs` — untracked, named by its lane prefix
- `??` `scripts/_vtf2-order-arm.mjs` — untracked, named by its lane prefix
- `??` `scripts/_vtf2-reset-arm.mjs` — untracked, named by its lane prefix
- `??` `scripts/_vtf2-screens.mjs` — untracked, named by its lane prefix
- `??` `scripts/_vtf2-set-dropped.mjs` — untracked, named by its lane prefix
- `??` `scripts/_vtf2-which-db.mjs` — untracked, named by its lane prefix
