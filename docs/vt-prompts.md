# VT — lane prompts (Variation theme column) — 2026-09-13

**Owner-approved 2026-09-13** ("I actually agree, so let's go ahead and start and make sure that everything's AAA quality
all along"). Design: `docs/2026-09-13-variation-theme-column-design.md` (the doc). Canvas:
https://claude.ai/code/artifact/4a00d87b-cbf9-4ffb-a659-2431e293bf03. Composes with VX
(`docs/2026-09-12-variation-projection-design.md`). The Owner launches each lane in its own terminal on
`claude --model claude-opus-5` and pastes ONE prompt below. Lanes report to the Owner in `docs/pes-claims.md`; there is
no hub (#794). VT.0 is done (doc §1 T14–T18, §4).

**Order:** VT.1 starts now. VT.2 starts when `docs/vt1-contracts.md` exists (it codes against typed fixtures until VT.1's
routes answer). VT.3 and VT.4 start after VT.2's editor is on screen with fixtures. VT.F last.

---

## The AAA bar (pasted at the top of EVERY prompt — verbatim, binding)

You are building for an Owner who holds a zero-defect, best-in-industry bar. These rules are measured, not aspirational:

1. **A claim must match its measurement.** Every "done", "works", "renders", "writes" carries the number, the
   read-back, the screenshot or the test name that shows it. A write's RESPONSE is not what it wrote — read it back after
   8 s with `expectedVersion` as the discriminator. Adjectives are not evidence.
2. **A negative needs a positive control in the same run.** "0 errors", "empty", "no request" are claims that the
   instrument was pointed at the right thing; show the arm that DID fire.
3. **Name the database before any write.** Local API `:8091` → `apps/api/.env` → Docker `127.0.0.1:55439/nexus_development`
   (GALE `Product.version` 58) vs Neon prod (`Product.version` 51). Read the discriminator, write it in your ledger
   section, then write. Prod writes: NONE from a lane. Fixture writes: `VX-TEST-3AX` (create it under the XAVIA family,
   DRAFT, excluded on every coordinate, announced in the ledger before creation) and disposable DRAFT rows only. GALE-JACKET
   is read-only on channel coordinates — its eBay·IT item 257584954808 and Amazon ASIN B0F7J163XJ are LIVE.
4. **One definition, zero copies.** Grid chrome and column rules live in the ENGINE (`design-system/grid/**`) and are spread
   by BOTH sheet builders (`master/columns.tsx`, `master/channelColumns.tsx`) — `EDITOR_ONLY=parity node
   scripts/check-editor-open.mjs --strict` must include the new column. The editor is ONE component with two hosts
   (cell + Variants dock). No page-local control, no local colour map, no second parser, no second resolver.
5. **Derive, never hardcode.** Theme candidates, attribute bindings, aspect names, limits and labels come from the cached
   schemas and the wire — a hand-written list of themes or attributes is a defect (T14: 349 distinct enum values, 32 with
   two spellings).
6. **AG Grid facts you must design around** (memory, all measured): a React editor MUST call `props.onValueChange` on every
   change (a ref `getValue` is never read); AG owns Enter/Tab/Esc inside a popup editor (design the interaction so they do
   the right thing; `suppressKeyboardEvent` only when proven on screen); an untouched edit must be discarded
   (`isCancelAfterEnd`); reporting on mount arms a write — report nothing until the operator changes something; the
   fill handle swallows double-click (disable it on this column); `valueSetter` must mutate `params.data`; inline
   `cellEditorParams` objects re-run the column model (stable references).
7. **Gates, one clean run, all exit 0, pasted into the ledger:** `npx tsc --noEmit -p apps/web/tsconfig.json` · API tsc ·
   vitest for every touched module (apps/web vitest is node-only — no DOM assertions there) ·
   `node scripts/check-ag-grid-import-boundary.mjs` · `node scripts/check-editor-open.mjs` (and `--strict` parity) ·
   `node scripts/check-control-census.mjs` (signed in) · `node scripts/check-layout-v2.mjs` ·
   `node scripts/check-raw-primitives-ratchet.mjs` · `node scripts/check-dark-alias-scope.mjs` ·
   `node scripts/check-ds-dts-fresh.mjs` (**R-VT-14**: a stale `.d.ts` SHADOWS its source — the error reads
   *"does not provide an export named …"* for an export that exists; `--write` regenerates, and the fork ratchet
   excludes `.d.ts` by design) · the factory mirror ratchet for every shared DS file ·
   `node scripts/check-table-grants.mjs` (**R-LX-28**, CLOSE.1: any migration that adds a table must end with the runtime
   role's `GRANT` and, for workspace-scoped data, `nexus_workspace_isolation` — a grant-less table passes `prisma validate`,
   `prisma generate`, `tsc` and every mocked test, and answers `42501` in the running app inside a `try/catch`. LOCAL only:
   it refuses a `neon.tech` host and asserts `current_database() = nexus_development` before its first read). Zero console errors on every state you own, at 1440×900, signed in.
8. **Copy is verbatim** from the doc's Appendix A. Header `Variation theme` on every scope (D-VT1).
9. **Nothing is committed.** Nothing outside your owned paths is edited without a claim in the ledger. A question for
   the Owner is a ledger line with your measurement and a recommendation — you do not rule.
10. **`grep` in this shell is a function over `ugrep` that skips gitignored and NUL-carrying files** — use `/usr/bin/grep`
    with a positive control for every set claim. `tsx watch` restarts only on the import graph; a `.vitest.test.ts` save
    restarts nothing.

11. **Never `git checkout --`, `git stash`, `git reset` or `git restore` on the shared working tree** — not even on "your"
    files: every file carries other lanes' uncommitted layers and a checkout erases them (VT.1 measured it: 28 false failures,
    two ≤41 s windows in which any concurrent save would have been overwritten). Build a test baseline by COPYING files aside
    (`cp` to your scratch dir) or by applying `docs/audits/2026-09-13-lx-revert/tree-before-revert.patch` in a worktree —
    never by touching the shared tree's contents.

12. **Exit codes are captured by REDIRECT, never through a pipe** — `cmd > log 2>&1; echo $?` — a `| tail` or `| grep` returns
    its own status and ate a red gate (VT.F, `check-ds-dts-fresh`). And `pgrep -fc` is Linux-only: on macOS it exits 2 and a
    witness that reads `null` can pass `assert.notEqual(null, 0)` — assert the TYPE of a witness, not only its value.

Claim your lane FIRST: append `### VT.n — <your session name> — <mandate> — 2026-09-13` at the BOTTOM of
`docs/pes-claims.md` with the exact paths you own; rulings are at the TOP of that file (read both ends).

---

## VT.1 — backend: resolver, column, one write path

[paste "The AAA bar" above]

You are lane **VT.1**. Read, in order: `docs/2026-09-13-variation-theme-column-design.md` (all of it; §1 T1–T18 are the
facts, §3.2 the derivation, §3.3 the column contract, §3.6 the writes, §4 your row), then
`docs/2026-09-12-variation-projection-design.md` §3–§6 and §9 (you implement its VX.1 scope re-cut around the column),
`docs/vp2-contracts.md`, `docs/pes5-phase0-backend.md` §3. Memory traps that bit this exact area:
`reference_two_column_builders_drift`, `reference_contract_field_varies_by_market`,
`reference_combination_value_is_not_the_inherited_value`, `reference_write_predicate_must_match_its_readers`,
`reference_bulk_patch_routes_six_channel_fields`, `reference_which_database_is_this_api_on`.

**You own:** `apps/api/src/services/pim/family-projection*.ts`, `services/pim/variation-rules.service.ts` (new),
`services/pim/variation-theme-segments.ts` (new — `canonicalThemeSegment`, the ONE theme parser, the attribute binding),
`services/pim/sheet-columns.service.ts` + `studio-sheet.service.ts` (the one column only), `services/pim/channel-specs/
{amazon,ebay}.ts` (retire the two raw theme columns), `services/listing-wizard/amazon-publish.adapter.ts:410-430`
(attribute binding only), `services/ebay-variation-push.service.ts:900-912` + `services/ebay-family-axes.service.ts:232`
(precedence only), `routes/product-studio.routes.ts` (additive), `docs/vt1-contracts.md` (new), tests beside each.

**Phase 0 — measure, read-only, ledger before code (half a day):**
- The live eBay aspects for GALE's eBay·IT category on IT and DE (`getCategoryAspectsRich`, `variantEligible`) — through
  the running API or `railway run --service "/api" env -u REDIS_URL npx tsx scripts/<probe>.mts` (a plain laptop process
  has revoked tokens and reads as a clean empty — positive control: the IT aspect list must contain `Colore`). Write the
  eligible names for `color` and `size` on both sites.
- The `xracing` family (T18): `Product.variationTheme = "Fit Type / Size Name / Color Name"`, `variationAxes = []`, 49
  children — read what the children's `variantAttributes` carry and what its Amazon listings (if any) carry. Report; do
  not correct.
- Re-run `apps/api/scripts/_vt0-theme-derivation.mts` against the LOCAL Docker DB and diff against the prod numbers in
  the doc (T14) — state which DB `:8091` is on.
- Baseline timings: `GET /studio/sheet` on GALE for master, Amazon·IT, eBay·IT, Shopify (warm, three runs each) and
  Amazon·IT `/studio/columns` (VX M14: 3.77 s). Every later phase re-measures these; a regression is a defect.

**Phase 1 — `docs/vt1-contracts.md` FIRST** (so VT.2 can code against fixtures): the `VariationThemeCell` from doc §3.3
finalised, the resolver's `source` vocabulary (`derived | rule | override | none`), the PATCH body (`theme?`, `mapping[]`,
`reset?`, `expectedVersion`), the 400/409 shapes, and the readiness item kinds. Include three FIXTURE payloads (GALE
master, Amazon·DE derived, eBay·IT overridden) VT.2 can import.

**Phase 2 — the resolver** (`variation-rules.service.ts`): `resolveVariationProjection(coordinate)` = override (parent
listing row per `aliasKey`; `''` theme = null, T16) → rule (`MarketplaceSchemaMapping.variations` per category → channel
wide, VX M2) → derived (doc §3.2: bare-form tie-break, `canonicalThemeSegment`, attribute binding against the schema's
`properties`, latest `CategorySchema` row regardless of `expiresAt`). Pure, unit-tested against the four outcome classes
with the REAL enum from a CategorySchema row copied into a fixture (`unique`, `ambiguous → bare form`, `set-only`,
`none`). Amazon display labels = bound attributes' `title`s (`Colore / Taglia` on IT, `Farbe / Größe` on DE — assert
both). eBay names = the site aspect from Phase 0. Shopify = English label.

**Phase 3 — the column**: `/studio/sheet` serves `variation_theme` (`kind: 'variationTheme'`, `shape: 'axes'`) on EVERY
scope, first after identity, with the full `VariationThemeCell`; `—` on children; alias rows carry their own projection.
Retire `channel-specs/amazon.ts:58` `variation_theme` and `channel-specs/ebay.ts:136` `variationTheme` from the sheet;
remove `variation_theme` from `CHANNEL_WRITABLE` (`studio-sheet.service.ts:520-527`) and `channel-field-map.ts:31-32`.
Prove with a before/after diff of `/studio/columns` on all four scopes that exactly those two columns left and one arrived.

**Phase 4 — writes**: master → `PATCH /studio/variation-axes` (exists); channel → `PATCH /studio/projection` (exists)
gains `reset: true` and the keys-the-variants validation (VX.4, `400 collision_unresolved` with the `CollisionReport`).
eBay precedence flip (VX D1/M3): the coordinate's `_variationAxes` when non-empty, else `Product.variationTheme` — with a
characterisation test asserting byte-identical push plans for EVERY parent listing before and after (read-only over the
catalogue); `ebay-family-axes.service.ts:232` reads through the same resolver. Amazon adapter: `buildChildAttributes`
binds segments through `variation-theme-segments.ts` and REFUSES (a named issue on the submission, never a silent
`color_name`) when a segment binds to no property. Rehearse the write on `VX-TEST-3AX` only, with the 8 s read-back and
`expectedVersion` bump; then the 409 path with a stale version.

**Phase 5 — readiness**: `theme-unset`, `collision`, `attribute-unbound` in `scope-readiness.service.ts` (coordinate with
the LX.5 owner in the ledger before editing that file).

**Done when:** every phase's numbers are in your ledger section (timings within baseline, four scopes' column diffs, the
characterisation test name, the fixture write pair request/read-back), all gates green on one clean run, `docs/
vt1-contracts.md` final, nothing committed.

---

## VT.2 — GDS: the cell, the editor, the one write branch

[paste "The AAA bar" above]

You are lane **VT.2**. Read: the doc (§3.3 contract, §3.4 cell, §3.5 editor, §3.6 the SheetWriter branch, Appendix A
copy), the canvas (artboards 1–5 are your screen truth — measure against them), `docs/vt1-contracts.md` (code against its
fixtures until VT.1's routes answer), `design-system/grid/editors/ListPanelEditor.tsx` (the closest existing editor; its
draft-mirroring rule for Enter is yours too), `SelectPanelEditor.tsx`, `sheetColumn.ts`, `shapeColumn.ts`, `sheetWriter.ts`,
`openGesture.ts`, `renderers/provenanceMark.tsx`, `CascadeCell.tsx`, and the DS primitives `AxisChip`, `MappingChip`,
`OrderedList`, `OptionList`, `TagInput`, `Listbox`, `Banner`, `Tag`. Memory: `reference_ag36_react_editor_onvaluechange`,
`reference_ag_popup_editor_owns_keys`, `reference_ag_fill_handle_swallows_dblclick`,
`reference_ag_react_inline_options_rerun_column_model`, `reference_ag_value_setter_must_mutate_params_data`,
`feedback_grid_chrome_lives_in_the_engine`, `feedback_shared_components_no_copy_props`, `reference_ds_toast_two_providers`.

**You own:** `apps/web/src/design-system/grid/editors/AxesPanelEditor.tsx` (new) + test, `grid/renderers/variationTheme.tsx`
(new) + test, `grid/editors/{sheetColumn,shapeColumn,sheetWriter}.ts` (additive: `shape: 'axes'`, `kind:
'variationTheme'`, the routing branch), `grid/theme/grid.css` (the `.nds-axes-editor` block only), the `apps/factory`
mirrors of every shared file, `_studio/variants/channel/dock/sections.tsx` (section 1 → the shared editor, claim it),
DS stories/catalog entries for the two new pieces.

**Build, in this order, each step on screen before the next:**
1. `variationTheme` renderer: every state in doc §3.4 / canvas artboard 5 (parent text · derived tint+link · overridden
   tint+pencil · lock · `n dropped` tag · `—` child · `Set axes…` · `Choose a theme` · focus). Provenance through
   `classifyProvenance` + `ProvenanceMark` — no new member, no local colour. Copy/export/filter text = delivered names
   joined with the channel separator.
2. `AxesPanelEditor` as an AG popup (`cellEditorPopup: true`, `editorBox` kind `list`, 420 wide): header · source row ·
   (Amazon) theme `OptionList` grouped `Covers every axis / Drops an axis / Deprecated`, typing filters · axis rows
   (`OrderedList` of `MappingChip`/`AxisChip`, grips inert on Amazon with the reason) · `+ Add …` (`OptionList` of
   candidates from the wire) · lock `Banner` · footer. `onValueChange` on EVERY change; report nothing until touched;
   `isCancelAfterEnd` when untouched; `,` and `/` add the highlighted candidate (D-VT7) — prove each key on screen with
   the network tab armed (a keystroke that "works" without a witnessed commit is not done). Enter = AG commits the last
   reported value; Esc discards. Fill handle disabled on the column.
3. Commit rules (doc §3.5): unchanged → nothing; unlocked → the SheetWriter branch keyed on `column.kind ===
   'variationTheme'` → `cell.write.endpoint` with CAS on `cell.write.expectedVersion`, 409 → repaint + refetch like every
   other cell; locked + SET change → open the plan Modal (VT.4 supplies the plan; until then a held `Modal md` with the
   reason, never a silent write); locked + order-only change on eBay → allowed.
4. The Variants dock's section 1 renders the SAME component (host = dock; its `Save mapping` footer stays). One test file
   covers both hosts.
5. Parity: `EDITOR_ONLY=parity node scripts/check-editor-open.mjs --strict` extended so the new column is one of the
   readings on all three scopes; census + layout gates extended to the editor's controls.

**Done when:** the before/after table (canvas artboard vs screen, per state, numbers) is in your ledger section; the
witnessed commit pairs (request body → read-back) for one master write and one channel write on `VX-TEST-3AX`; all gates
green on one clean run; factory mirror identical; nothing committed.

---

## VT.3 — the mapping page Variations group

[paste "The AAA bar" above]

You are lane **VT.3**. Read: the doc §3.7, VX §11.1 (the group as designed) and its Appendix C copy, the canvas artboard 6,
`docs/vt1-contracts.md`, `apps/web/src/app/channels/mapping/**` (`MappingClient.tsx`, `_shared/*` — the Rithum frame,
`ImpactReview`, `api.ts`, `contracts.ts`), `docs/2026-09-01-pes6-global-mapping-engine.md`. You own
`apps/web/src/app/channels/mapping/**` only; the API side is VT.1's (`channel-mapping.routes.ts` additions are a ledger
request to VT.1 with the exact shape you need).

Build the `Variations` group under the selected category after the field groups, DS only: Rule line (`No rule — <n>
families follow the derived theme` + `derived` tag + `Write a rule for <category>`), Theme (`Listbox sm` of the enum with
labels, Amazon only), Axes on channel (`MappingChip` rows, `none dropped` / the dropped names), Collisions radios,
Listing split radios, Value maps counts + link, Axis names sentence, Preview SKU + `Preview payload`. Save = one PUT under
`reviewRequired` with the existing blast-radius simulation ("38 products follow this rule · 0 would gain a collision").
`[List]` → `/products/next?filter=variation-mapping:derived|rule|overridden`. Counts come from the wire, never computed on
the page.

**Done when:** the group renders from fixtures, then live against VT.1, at 1440 with one row per line as on the canvas
(numbers in the ledger), a rule write on the XAVIA category rehearsed and read back, gates green, nothing committed.

---

## VT.4 — live gate, plans, collisions, catalogue filter

[paste "The AAA bar" above]

You are lane **VT.4**. Read: the doc §3.5 commit rules and canvas artboard 7, VX §6 (collisions), §8 (preview), §9 (plans,
D8: dry-run ONLY, no live executor), §11.3 (`collides`), §11.4 (catalogue filter), `docs/vt1-contracts.md`. You own
`apps/api/src/services/pim/theme-change.service.ts` (new) + route additions in `product-studio.routes.ts` (coordinate
with VT.1 in the ledger — same file), `_studio/variants/channel/dock/` Collisions section, `design-system/grid/renderers/
projection.ts` (the sixth word `collides`, claim it), `apps/web/src/app/products/next/**` (the `Variation mapping` filter
+ footer counts).

Build: `POST /studio/projection/theme-change` (`dryRun: true` is the only accepted value) returning `ThemeChangePlan` for
`amazon-new-parent`, `ebay-relist`, `shopify-in-place` — built from the SAME adapter functions the publish path calls
(a test pins plan payload ≡ live payload; a second composer is a defect); the plan Modal (`Change variation theme…` ·
steps table · Keeps / Loses · `Copy plan`) opened by VT.2's locked-commit path; the collision matrix on `VX-TEST-3AX`
(each resolver × each drop: fold produces `L / Slim` pins that read back `pinned`, exclude leaves exactly 4 included,
split is `unresolved` while aliases are not creatable) and the `collides` projection word; the catalogue filter fed by
VT.1's readiness items.

**Done when:** the three plans render on the fixture with their steps and the ≡ test name in the ledger; the collision
matrix numbers are in the ledger; zero live calls made (state how you know: the client's dry-run flag + the network
capture); gates green; nothing committed.

---

## VT.F — final pass

[paste "The AAA bar" above]

You are lane **VT.F**, after VT.1–VT.4 report done. You own everything they owned. Produce, on GALE-JACKET and
`VX-TEST-3AX` at 1440×900 signed in: (1) a before/after table per canvas artboard (chrome heights, column widths, cell
states, editor anatomy, copy) — numbers, never adjectives; (2) a functionality matrix: every cell state in doc §3.4 ×
every scope (master, Amazon·IT, Amazon·DE, eBay·IT, Shopify) × every commit rule in §3.5, each cell of the matrix a
witnessed outcome; (3) the two-column-builders parity reading with the new column; (4) all gates on one clean run;
(5) the timing table against VT.1's baseline; (6) the list of everything the programme left held (alias split, live
executor) with its on-screen reason. Then delete `VX-TEST-3AX` with a ledger line. Nothing committed until the Owner says
so — the Owner commits.

---

## VT.F — final pass (updated 2026-09-13 ~14:00 by the orchestrator, after VT.1b/VT.2c/VT.3b/VT.4)

[paste "The AAA bar" — all 11 rules]

You are lane **VT.F**, after every VT lane has reported (VT.1 + VT.1b, VT.2 + VT.2b + VT.2c, VT.3 + VT.3b, VT.4 + VT.4b). You own
everything they owned. Read their ledger sections and the orchestrator's verification notes near the top (search
`DONE and VERIFIED`), then do, in this order, each with its numbers in your section:

**A · Fix list (each with a test and a witnessed reading where it is on screen):**
1. **R-VT-4** — the column width is **160** on every scope (VT.2b reported done without it; it still reads 200); re-measure
   `check-layout-v2` §9.1 on Amazon·IT before/after and record the required-column count both ways.
2. **R-VT-7** — Amazon `targetOptions` = the theme's bound segment attributes (from `variation-theme-segments.ts`), never `[]`
   with `targetOptionsState: 'ok'`; an empty list carries its own state word. Then the dock reorder's **200 arm** on
   `VX-TEST-3AX` Amazon·IT becomes runnable — run it (request → 8 s read-back → restore).
3. **R-VT-8** — the editor's target `Listbox` renders inside the AG popup (a portal click ends the edit — measured by VT.2c);
   check the DS `Listbox` for a portal prop, add one in the DS if absent (mirror to factory), never page-local; witness a mouse
   re-point that survives.
4. **R-VT-9** — the dock's Amazon section carries the theme picker (VX §11.2); the dock PATCH sends `theme`.
5. The sheet cell serves `locked.lockedAxisKeys` + `addableAxes` (per-axis locks are dock-only today; the cell's `+ Add`
   offered aspects as axes → 400) — one function feeds both hosts.
6. A 409 `axes_locked` race (a coordinate that went live between read and commit) routes to the plan, never an error toast.
7. `MappingImpact.category` for the `variationChange` kind — the review drawer must name the category, not "All marketplace
   categories" (VT.3b).
8. The gate wrapper `scripts/studio-gate-session.mjs`: the aloneness guard also sees OTHER wrapper runs — a lock file plus
   `pgrep -fc 'node scripts/'`, never a `ps | grep` that matches its own shell (VT.3b's tainted reading).
9. VT.4's red `theme-change` test; VP.4's dead `.nds-vp-dock-*` row CSS deleted (VT.2c measured `oldRowsStillRendered: 0`).
10. One spelling: `Color` vs `Colour` across the sheet cell, the Variants page, the editor, the mapping page and the canvas copy —
    pick the codebase's existing English label for the `color` attribute (derive it: the master column header on GALE, the
    `KNOWN_THEME_LABELS`), apply it everywhere VT wrote copy, and record where it came from.
12. **R-VT-11** — an unknown `variation-mapping` word at the URL layer narrows to 0 rows WITH the banner naming it (today the page
    shows 31 + the banner while the server answers 0); one arbiter, both layers agree; test both.
11. Delete the lab `apps/web/src/app/design/axes-column/` and the fixture family `VX-TEST-3AX` (+ children, listings cascade —
    the DELETE VT.1 wrote in its section) on the LOCAL DB with a ledger line and a read-back proving 0 rows remain.

**B · The screen-debt table** (from VT.2b's and VT.4's signed-in gate runs): `selectHasChevron: NOT MEASURED (master read null)`
×2, drawer `RECORD PANEL TOP 56`, `amazon·DE · images` 4, `ebay·IT · variants` `selection must occupy 43px` ×21, and
`check-layout-v2`'s 31 findings — each row: the finding verbatim, the surface, the OWNER (VP · PES.4 drawer · PES.7 images ·
LX · VT · CH.1), fixed-here or handed-off, and for the VT-owned ones the fix. The toolbar clipping is LX.F2's (R-LX-18) — cite
its result, do not duplicate.

**C · Verification, on GALE-JACKET (read-only on channel coordinates) and the fixture before you delete it, 1440×900 signed in
through the wrapper:** (1) a before/after table per canvas artboard 1–7 (chrome heights, the column at 160, cell states, editor
anatomy, dock lines, mapping group lines, plan modal lines) — numbers, Δ; (2) the functionality matrix: every cell state in doc
§3.4 × every scope (master, Amazon·IT, Amazon·DE, eBay·IT, Shopify) × every commit rule in §3.5 — each cell a witnessed outcome
(request or plan or refusal), never "should"; (3) the parity reading of the column on the REAL sheet on all three scopes under a
saved view; (4) timings vs VT.1's baseline (`/studio/sheet` per scope, `/studio/columns` Amazon·IT); (5) all gates on ONE clean
run: web tsc, API tsc, vitest for every VT module, `check-editor-open.mjs --strict`, `check-control-census.mjs`,
`check-layout-v2.mjs` (all three through the wrapper, alone), `check-ag-grid-import-boundary.mjs`,
`check-raw-primitives-ratchet.mjs`, `check-dark-alias-scope.mjs`, `check-ds-fork-drift.mjs --check`, `check-no-nul-bytes.mjs`
strict, zero console errors on every VT state; (6) `.claude/DS-GAPS.md` entries for the DS pieces VT added; (7) the list of
everything the programme left HELD with its on-screen reason (alias split until PES.5-ii; the live theme-change executor,
D-VT6/VX D8; `fold` where no cell is writable) — a held control is rendered and says why, never hidden.

**D · Deploy prerequisites, verbatim for the Owner:** the `ReadinessIndex.variationSource` SQL (VT.1b), the one-shot readiness
backfill (R-LX-9), and anything VT.F itself adds. Nothing is committed; the Owner commits.

Done = the report with A per item, B as a table, C with every number and the matrix, D verbatim, `ASSUMED:` / `QUESTION FOR
THE OWNER:` lines, what you did NOT do and why.
