# MX — lane prompts (the Matrix page, FRONTEND build) — 2026-09-13

**Owner-approved 2026-09-13 (terminal):** the Variants page stays aside; a NEW Matrix page is built with what is left;
the complete frontend now, the backend in a later session; design-system aligned, AAA. Design:
`docs/2026-09-13-matrix-page-design.md` (read the **Revision** block first, then §3, §5, Appendix A). Canvas:
https://claude.ai/code/artifact/3d5563a7-5779-4f78-96ad-9c3a4356876e (artboards 1–2 and 4–6 apply; artboard 3's
"narrowed state" and the family band do NOT — they are the Variants page's). Contract (the wire authority, DONE by
session `[d4423145]` = MX.C): `apps/web/src/app/products/[id]/edit/_studio/matrix/{contract,fixtures,preview,store}.ts`
+ `matrix.vitest.test.ts` (22 tests green). Session `[d4423145]` orchestrates; lanes report in `docs/pes-claims.md`.

**Order:** MX.G and MX.P start together. MX.P codes against MX.G's exported NAMES from the prompt below and uses a local
stub with the SAME props until MX.G's barrel exports exist (never a second implementation). MX.F last.

---

## The AAA bar (pasted at the top of EVERY prompt — verbatim, binding)

You are building for an Owner who holds a zero-defect, best-in-industry bar. These rules are measured, not aspirational:

1. **A claim must match its measurement.** Every "done", "works", "renders" carries the number, the screenshot or the
   test name that shows it. Adjectives are not evidence. Zero console errors on every state you own, at 1440×900,
   signed in — and say what you measured at 1280 and 1728.
2. **A negative needs a positive control in the same run.** "0 errors", "no request" are claims that the instrument was
   pointed at the right thing; show the arm that DID fire.
3. **Name the database before any write.** The Matrix page in preview mode writes NOTHING to any server: every write goes
   to the in-memory store (`store.ts`) and the Network panel proves it (0 PATCH/POST to `/studio/matrix`, positive
   control: the sheet's own GET). Local API `:8091` → Docker `nexus_development` (GALE `Product.version` 59). No prod
   writes. Fixture family GALE-JACKET `cmokmy3a40078pm0p1fvnu523` (read-only; its rows are real, its Matrix cells are
   fixtures).
4. **One truth per cell, one definition, zero copies.** Every cell kind is ONE engine definition in `design-system/grid/**`
   (MX.G) consumed by the page (MX.P); no page-local renderer, editor, colour, tone or copy. Tones come from
   `readinessMeta` / `projectionMeta`; words from `contract.ts` `MATRIX_COPY` and `MATRIX_CELL_LABELS`; widths from
   `MATRIX_CELL_WIDTHS`. The page derives no number: quantities, prices and states come from `MatrixRead` verbatim.
5. **One door for writes.** The page writes through the engine's `SheetWriter` with ONE additive routing branch keyed on
   the Matrix kinds → `source.ts` (`applyCells` in preview mode; `PATCH …/studio/matrix` in live mode). CAS on
   `MatrixCells.version`; a `conflict` repaints + refetches like every sheet cell; `refused` shows the cell's own reason.
6. **Preview before consequence.** Every SELECTION verb runs `previewVerb` → the preview dialog (old → new, refusals by
   cause, notices, the confirm level and word) → `applyVerb` → a revert toast that calls `revertOperation`. The fill handle
   is DISABLED on `fulfilment`, `listing`, `syncState`; it works on `price`, `syncQty`, `syncBuffer`. The `Fulfilment`
   select never writes inline: choosing a method opens the `set-fulfilment` preview for that ONE row.
7. **Honest absence.** `absent` kinds render nothing in the grid and appear greyed in Customise with their sentence; an
   unconnected coordinate is ONE `Not listed` column; `count: null` never renders as `0`; the preview banner is on screen
   whenever `MatrixRead.source === 'preview'`. A held control carries `aria-disabled` + the reason in the DOM, never a
   silent `disabled` (`scripts/check-silent-disabled.mjs`).
8. **AG Grid facts you must design around** (memory, all measured): a React editor MUST call `props.onValueChange` on every
   change; AG owns Enter/Tab/Esc in a popup editor; an untouched edit is discarded (`isCancelAfterEnd`); reporting on
   mount arms a write; the fill handle swallows double-click; `valueSetter` must MUTATE `params.data`; inline
   `cellEditorParams`/`cellRendererParams` literals re-run the column model (stable objects); a span cannot cross AG's
   pinned boundary; column ids and group ids share ONE namespace (use `grp-` prefixes).
9. **Gates, one clean run, all exit 0, exit codes read BARE (never through a pipe), pasted into the ledger:**
   `npx tsc --noEmit -p apps/web/tsconfig.json` · `npx vitest run` for every touched module (node-only — no DOM
   assertions) · `node scripts/check-ag-grid-import-boundary.mjs` · `node scripts/check-editor-open.mjs` (MX.G adds rows;
   both lanes run `EDITOR_ONLY=contract`) · `node scripts/check-control-census.mjs` (signed in; MX.P extends it to
   `matrix`) · `node scripts/check-layout-v2.mjs` (MX.P extends the band budget) · `node scripts/check-raw-primitives-ratchet.mjs`
   · `node scripts/check-dark-alias-scope.mjs` · `node scripts/check-ds-fork-drift.mjs --check` (MX.G mirrors every new
   or edited DS file to `apps/factory/src/design-system/**` and adds them to `requiredMirrors`) ·
   `node scripts/check-grid-option-identity.mjs` · `node scripts/check-silent-disabled.mjs`. Before a browser gate run,
   announce `MX.n gate starting <what>` in your ledger section and `MX.n gate finished <what> exit N` after; check the
   last 80 lines of the ledger for another lane's unfinished `gate starting` and hold your `apps/*` saves while one runs.
10. **Copy is verbatim** from `contract.ts` and the doc's Appendix A. Nothing is committed. Nothing outside your owned
    paths is edited without a claim in the ledger. A design question is a ledger line with your measurement and a
    recommendation — you do not rule. `grep` here is a function over `ugrep` (skips gitignored/NUL files) — use
    `/usr/bin/grep` with a positive control for every set claim.

Claim your lane FIRST: append `### MX.n — <your session name> — <mandate> — 2026-09-13` at the BOTTOM of
`docs/pes-claims.md` with the exact paths you own; rulings are at the TOP of that file (read both ends). Read the
**Revision** block of the design doc before anything else.

---

## MX.G — GDS: the eight Matrix cell kinds, the writer branch, the registry verbs, the gate rows, the mirrors

You own MX.G. Read: the design doc Revision + §3.1, §3.4, §3.5, §3.8, Appendix A; `_studio/matrix/contract.ts`
(the types you render — import them; never redeclare a shape), `preview.ts` (`syncLabel`, `followQty`),
`design-system/grid/renderers/{projection.ts,ProjectionCell.tsx,readiness.ts,provenance.ts,provenanceMark.tsx,cells.tsx,format.ts,shapeCells.tsx}`,
`editors/{sheetColumn.ts,shapeColumn.ts,sheetWriter.ts,SelectCellEditor.tsx,SelectPanelEditor.tsx,FormulaCellEditor.tsx,openGesture.ts,writeGate.ts,index.ts}`,
`actions/registry.ts`, `theme/grid.css` (the `.nds-cell-is-*` classes), `docs/2026-09-03-cell-editing-contract.md`,
`docs/2026-09-04-cell-editor-shell-design.md`, `scripts/check-editor-open.mjs` (how contract rows are declared and
driven), `scripts/check-ds-fork-drift.mjs` (`requiredMirrors`), VT.2's ledger section (its `sheetWriter` branch and
`shapeColumn` branch are the pattern you follow — additive, keyed on `column.kind`).

Build, in `apps/web/src/design-system/grid/` (NEW files unless stated; every one mirrored to `apps/factory`):
- `renderers/matrixCells.ts` (pure): the eight kinds' display rules — `matrixCellText(kind, cells, coord)` (copy/export/
  filter text), `matrixCellTone(...)` (READ from `readinessMeta`/`projectionMeta`, never chosen), `matrixCellClasses(...)`
  (`.nds-cell-is-inherited` for FOLLOW/master price, `-pinned` for PINNED/override, `-locked` for FBA/parent/absent, a
  NEW `.nds-cell-is-paused` you add to `theme/grid.css` for the paused tint, `.nds-cell-is-refused` for a failed queue),
  `matrixCellTooltip(...)` (the Appendix A sentences via `MATRIX_COPY`). Unit-tested against every state in §3.4.
- `renderers/MatrixCells.tsx`: `ListingStateCell` (extends `ProjectionCell`'s vocabulary: add `suppressed`, `closed`,
  `error`, `ended` to `projection.ts` with tones READ from `readinessMeta` — `suppressed` → `row:errors`, `closed`/`ended`
  → `row:unlisted`, `error` → `row:errors`; the checkbox is ABSENT on the Matrix (`state`-only rendering, a prop, not a
  fork)), `FulfilmentCell` (method + ✎/🔗 `ProvenanceMark` + ⚠ guard mark + ⇄ reported mark + `SelectChevron`),
  `SyncModeCell`, `SyncQtyCell` (Follow: muted number + 🔗; Pinned: number + ✎; Paused: ⏸ + held; FBA: `—`;
  Uncounted; Closed; oversold ⚠), `SyncBufferCell`, `SyncStateCell` (icon + word/relative time; click → `onJump`
  from params), `PriceCell` (money in `coord.currency` via `formatGridValue('money')` — check it takes a currency;
  if not, extend `format.ts` additively — with 🔗/✎/ƒ marks and ⚠ clamped), `SaleCell` (`€89.00 · 12 Sep → 30 Sep`).
  Every renderer reads its facts from `params.data` through a `facts` callback in STABLE `cellRendererParams` (the
  `ProjectionCell` pattern); the cell VALUE is the one scalar a fill may copy (`syncQty` → number, `price` → number,
  `syncBuffer` → number, `syncMode` → 'FOLLOW'|'PINNED', `fulfilment` → method, others → null).
- `editors/SaleCellEditor.tsx`: AG popup editor (`editorBox` kind 'value'): price `Input` + two DS date inputs; calls
  `props.onValueChange` on every change; Enter commits (AG's), Esc discards; untouched → `isCancelAfterEnd`.
- `editors/matrixColumn.ts`: `matrixColumnDef<T>(kind, opts)` — ONE function that returns the `ColDef` for a kind:
  width from `MATRIX_CELL_WIDTHS`, header from `MATRIX_CELL_LABELS`, renderer, editor (`selectEditor` for `syncMode`
  with Follow/Pinned and for `fulfilment` with `coord.vocabulary.fulfilment`; `numericEditor` for `syncQty`/`syncBuffer`;
  the sheet's formula-aware value editor for `price`; `SaleCellEditor` for `salePrice`; none for `listing`/`syncState`),
  `editable` from `cells.writable[kind]` with the reason surfaced (`none+say`), `suppressFillHandle`/fill rules per kind,
  `valueSetter` that MUTATES `params.data`, `cellClassRules` from `matrixCellClasses`, `tooltipValueGetter` from
  `matrixCellTooltip`, `comparator` for sorting. Exported through `editors/index.ts`.
- `editors/sheetWriter.ts` (ADDITIVE): `matrixWrite(column, cell, before, after)` — the routing branch keyed on
  `column.kind ∈ MATRIX_CELL_KINDS` that yields a `MatrixWriteCell` (`contract.ts`) or `{ send: false, reason }`
  (unchanged → nothing; Follow→typed number = `syncQty`; the class stays untouched). Import the contract types from
  `@/app/products/[id]/edit/_studio/matrix/contract` — if the boundary guard forbids a DS → app import, move the
  contract's TYPES into `design-system/grid/matrix/contract.ts` and make the app file re-export them (say which in the ledger).
- `editors/sheetColumn.ts` (ADDITIVE): the Matrix kinds join `SheetColumnLike.kind`'s documented set; `sheetValidationFor`
  returns the numeric/select validation for the writable kinds.
- `actions/matrixActions.ts`: the eleven verbs of `MATRIX_VERB_LABELS` declared ONCE as `GridAction<T>` definitions
  (scope SELECTION for all; ROW additionally for `push-now`, `retry-sync`, `set-fulfilment`), `impact` per §3.8 (the
  confirm level comes from `previewVerb`, so declare `confirm: 'preflight'`-style deferral if the registry supports it;
  otherwise `confirm` and let the dialog escalate), `availability` from the selection (no inventory in the selection →
  `disabled('…')` with the reason; a parent-only selection → hidden), `collect` = the verb's parameter form spec
  (`{ kind: 'number', label: 'Price', currency }` etc.) — the page renders the form, you declare it.
- `scripts/check-editor-open.mjs` + `docs/2026-09-03-cell-editing-contract.md`: contract rows for every Matrix kind ×
  state (`fresh`, `locked` for FBA/parent) driven on the Matrix host (`?tab=matrix` on GALE, master scope), with the
  same gesture columns; the `--strict` parity block includes the Matrix host. Provenance marks `·` until MX.F witnesses.
- `theme/grid.css` (APPEND only): `.nds-cell-is-paused` (the SUNK ground + `--nds-text-2`), the ⏸ glyph sizing, the
  Matrix money/number right-alignment if `cells.tsx` lacks it. Every colour is a token; `check-dark-alias-scope` must pass.
- `apps/factory` mirrors of every new/edited DS file; `requiredMirrors` in `check-ds-fork-drift.mjs` lists them.
- A grid-lab scenario `apps/web/src/app/design/grid-lab/MatrixScenario.tsx` (register it in `GridLabClient` the way the
  others are) that renders every §3.4 state from `buildPreviewMatrix` on a 6-row fixture — MX.F reads it and you
  screenshot it: every state, 36px rows, at 1440.

Done when: the lab renders every state (screenshot table in the ledger: kind × state × what is on screen); `onValueChange`
proven on `SaleCellEditor` and the select/number editors (a write reaches the writer branch — log it — and an untouched
edit does not, positive control); fill over `fulfilment` writes NOTHING while fill over `syncBuffer` DOES (positive
control); unit tests for `matrixCells.ts`, `matrixColumn.ts`, `matrixWrite`, `matrixActions` green; the editor-open
contract rows declared and the gate exit code pasted; mirrors ratchet green; tsc green. You do not touch
`_studio/**` (except reading `contract.ts`/`preview.ts`) or the API.

## MX.P — the page: `Matrix` under Information, on the shared sheet substrate

You own MX.P. Read: the design doc Revision + §3.1–§3.5, §3.8–§3.10, Appendix A; the canvas artboards 1, 2, 4–6;
`_studio/matrix/{contract,fixtures,preview,store}.ts` + the test (your data layer — import, never re-derive);
`_studio/variants/family/FamilyVariants.tsx` (the composition pattern you follow: `useMasterSheet` for rows + writer +
tracker, `useFamilyProjections` for images/axis values/channels, `GridSheet` + `NexusGrid` + `SHEET_GRID_OPTIONS`,
`SheetToolbar`, `useRegisterViewChip`, `PreferencesModal` via `columnStateToPrefs`, `FamilySelectionBar`),
`_studio/variants/family/columns.tsx` (identity column = `VariantIdentity`, `IDENTITY_COL`, the `grp-` group ids),
`_studio/{StudioTabHost,StudioSubheader,navigation,scopes,types,navigationHref,SaveIndicator,contracts}.tsx/.ts`
(the tab registration points — eight places, listed in the PES structure map: `StudioTabId`, `STUDIO_TABS`,
`STUDIO_TAB_LABELS`, `STUDIO_TAB_ICONS`, `TABS` map, `visibleTabs`, `contracts.tsx` URL read, `navigationHref`;
plus `SaveIndicator`'s wording and the two vitest files that pin the lists), `sheet/{SheetToolbar.tsx,useSheetColumns.ts,views.ts,sheetGridStates.ts,SheetLoadError.tsx}`,
`design-system/patterns/BulkActionBar.tsx`, `design-system/components/{Banner,Modal,SummaryTable,Listbox,Input}`.

Build, under `apps/web/src/app/products/[id]/edit/_studio/matrix/` (NEW files; MX.C's four files + test are read-only for you):
- `MatrixTab.tsx` (the mount; `TABS.matrix`), `MatrixSurface.tsx` (the page), `useMatrix.ts` (state), `source.ts`
  (`fetchMatrix(productId, {accountId, locale, signal})`: `GET MATRIX_ENDPOINTS.read` with `credentials:'include'`; a
  200 → parse at ONE boundary into `MatrixRead` with `source:'live'` (refuse a body that lacks `coordinates`/`rows`
  with a sentence, never a half page); a 404/501 → `buildPreviewMatrix` from the sheet rows (`PreviewRowInput`) and
  the scope options × connected accounts (`PreviewCoordinateInput` from `useStudioScope().options.channels/markets`
  + `marketplaces[].connected/accounts`); any other status → the shared `SheetLoadError`), `columns.tsx` (the grid:
  PRODUCT group = `VariantIdentity` at `IDENTITY_COL_W` 380, pinned; SHARED group = `Base price` (the sheet's own
  `basePrice` column def, read-only in preview mode with the reason), `Stock` (read-only, `MatrixRowRead.stock`,
  tooltip lists locations, `Uncounted` warning), `Status` (the sheet's own `status` column def); then ONE `ColGroupDef`
  per coordinate in `MatrixRead.coordinates` order — `groupId: 'grp-<key>'`, `headerName: coord.label`, children =
  `coord.cells.map(kind => matrixColumnDef(kind, …))` with `colId: '<key>.<kind>'`; an unconnected coordinate → one
  `Not listed` column (`MATRIX_COPY.notListed`, 120px, muted); the strip tag (`19 listed · 1 draft`) rendered by a
  `headerGroupComponent` reading `coord.listed/draft` (`null` → no tag)), `chips.ts` (Pinned · Paused · Oversold ·
  Sync issues · Suppressed — counts from the read, `null` while loading, cells keyed `<key>.<kind>` so the chip tints
  the matching cells), `filters.ts` (scope-bar semantics: `scope === 'master'` → all coordinates; a channel chip →
  that channel's groups (its region-inventory group included); the market listbox → that market's group + its
  region group; pure + tested), `MatrixToolbar.tsx` (`SheetToolbar` with count `21 rows · 1 parent · 20 variants`,
  Find, chips, Customise (the ONE `PreferencesModal` with groups = coordinates, presets `Everything · Inventory ·
  Pricing · Listings` built as `GridViewPreset`s, saved views on surface `product-edit:views:matrix` through
  `useSheetColumns` if its `columns` input can be satisfied — else `columnStateToPrefs` like Variants, say which),
  Export (what is on screen, D15.2 key row `sku` + `<key>.<kind>`), Import held with the reason `Import lands with the
  Matrix service`, ⋯ = Reload), `MatrixSelectionBar.tsx` (DS `BulkActionBar` + the registry verbs from
  `matrixActions`; a disabled verb keeps its reason), `verbs/VerbDialog.tsx` (DS `Modal`: the parameter form declared
  by the action's `collect`, the `SummaryTable` of `VerbPreview.changes` (Variant · Coordinate · From → To · Note),
  the refusals list by cause, the notices (EU, simulated), type-to-confirm `Input` when `confirm === 'type-to-confirm'`,
  footer `Cancel` / `Apply to N cells`), `verbs/useVerbRun.ts` (preview → apply via `useMatrix` → revert toast
  (`useToast`, "Reverted N cells") → `revertOperation`), `MatrixBanner` (the DS `Banner tone="info"` with
  `MATRIX_COPY.previewBanner` when `source === 'preview'`; nothing in live mode), `matrix.module.css` (layout only —
  no colours, no sizes the tokens own), tests for `filters.ts`, `chips.ts`, `source.ts`'s parse boundary.
- Writes: `useMatrix` owns the `MatrixRead` state and `write(cells)` (preview: `applyCells`; live: `PATCH`), exposing
  per-cell outcomes to the `CellSaveTracker` the sheet already uses (saving → saved | refused with reason | conflict →
  refetch). Wire the grid's `onCellValueChanged` through `writeGate` → the engine's `matrixWrite` branch → `write`.
  Typing into a Follow `Qty` pins (the store does it; the cell repaints from the new read). The `Fulfilment` select →
  opens the `set-fulfilment` VerbDialog for that row (never a direct write). A `syncState` click → jumps to
  `tab=errors` for that listing (`studioViewHref`).
- Frame: `matrix` joins `StudioTabId`, `STUDIO_TABS` (`sheet, matrix, variants, …`), labels (`Matrix`), icons
  (`Grid3x3` from lucide — verify it exists in `apps/web/node_modules/lucide-react`'s `.d.ts`; else `Table2`'s sibling
  `LayoutGrid`), `visibleTabs` (offered on every scope; a channel scope = filtered), `contracts.tsx` (nothing to do if it
  reads `STUDIO_TABS`), `SaveIndicator` wording (`Autosave on` like the sheet), the two vitest files that pin the lists.
- Footer: `<n> rows · <m> variants` + the notes slot (`MATRIX_COPY.sharedEu(markets)` when an EU group is on screen;
  `MATRIX_COPY.pinnedThisSession(n) · Undo` after pins, wired to a single-step undo through the store).
- Gates: extend `scripts/check-control-census.mjs` and `scripts/check-layout-v2.mjs` to the `matrix` surface (the band
  budget = top 56 · subheader 49 · scope 40 · toolbar 40 · strip 30 · header 28; identity 380; row 36).

Done when: the page is on screen on GALE at 1440×900 in preview mode with the banner, every coordinate group in
contract order, the EU region group carrying the inventory cells ONCE, the alias group `eBay · IT ②`, a `Not listed`
column for the unconnected market, chips with real counts, Customise/presets/saved views working, scope-bar filtering
proven (screenshots per state), a cell edit round trip proven (pin a Follow qty → ✎ + version bump + `Queued`; 0
network writes, positive control the page's GET), a verb round trip proven (Adjust prices −5 % → dialog → Apply →
cells repaint → Revert → cells restored), the fulfilment dialog opening from the cell, the census + layout gates green on
`matrix`, tsc + vitest green, zero console errors at 1440 (and the readings at 1280/1728). You do not touch
`design-system/**` (MX.G's) or `_studio/variants/**`.

## MX.F — final pass (written 2026-09-13 ~17:55 after MX.G and MX.P reported; MX.1's items appended when it reports)

You own MX.F. Read the whole design doc (Revision first) + the three lanes' ledger sections (`### MX.G`, `### MX.P`,
`### MX.1 — agent of [d4423145]`, all continuations) + the orchestrator's `MX.C follow-up` note. Both frontend lanes
have reported DONE, so their paths are yours to edit now (claim each file you touch in your section first).

Fix list (each with a before/after measurement in the ledger):
1. `MATRIX_CELL_WIDTHS.salePrice` 150 → **190** (ruled): `packages/shared/matrix-contract.ts`, MX.G's DS copy
   `apps/web/src/design-system/grid/matrix/contract.ts` (+ its factory mirror) with the parity test green, the doc §3.3
   widths line. Measure the compound `€89.00 · 12 Sep → 30 Sep` no longer clips at 190 in the grid lab.
2. `Base price` header truncates to `Base pr…` at 100px on the live page (orchestrator's 17:5x screenshot). Widen the
   SHARED `Base price` column so the full label + the header menu fit (measure the header's text width; 112–120), in
   MX.P's `columns.tsx`; keep `Stock` 96 and `Status` 104 unless they truncate too (measure).
3. Editor-open gate: re-run `EDITOR_ONLY=contract node scripts/check-editor-open.mjs` AND the `--strict` parity block
   through `scripts/studio-gate-session.mjs` with the API warm (curl the sheet route first — MX.G's three sheet-scope
   rows read `could not read the column contract` on a cold first dial). The Matrix host must be green on every row it
   can drive; rows the GALE fixture cannot produce (`syncMode/syncQty/syncBuffer fresh` — every EU row on GALE is
   Amazon-managed by the guard; `price/salePrice locked`) are driven on MX.1's disposable fixture family if it exists,
   else recorded `NOT MEASURED — fixture` with the lab round trip cited. Flip the contract doc's provenance marks to ✓
   for what you witnessed.
4. Live-mode verification on GALE (read-only): every coordinate group in contract order, the EU inventory lane once,
   the guard's ⚠ on FBM rows (`Guard reads FBA — the quantity is not pushed` in the tooltip), `not buyable` on the
   DISCOVERABLE rows, the parent row's per-market cells (`—`, no inventory facts — MX.1's fix), the eBay groups,
   `Not listed` singles, chips with live counts, the footer EU note; screenshots at 1440×900 of: all coordinates ·
   scrolled to eBay · Amazon chip · market DE narrowed on the Amazon scope · Customise open · a verb dialog (preview)
   · the fulfilment dialog · the Sync cell jump. Zero console errors, positive control witnessed.
5. Write / verb / revert proof in LIVE mode on MX.1's disposable fixture family ONLY (never GALE): pin a Follow qty
   through the cell → `PATCH` captured → read back ≥ 8 s → version +1 → the cell repaints from the server → `Set to
   Follow` verb → preview → apply → revert → read back; a `conflict` produced deliberately (stale version) → repaint +
   refetch; a refused FBA cell → the server's `Amazon-managed` sentence on the cell. Network panel: every write is ONE
   `PATCH …/studio/matrix` or `POST …/verbs`; nothing else.
6. All gates on one clean run on the final tree, exit codes bare, pasted: web tsc · factory tsc · api tsc · vitest for
   `_studio/matrix`, `design-system/grid` (matrix suites), `packages/shared` (matrix), api matrix suites ·
   `check-ag-grid-import-boundary` · `check-ds-fork-drift --check` · `check-dark-alias-scope` ·
   `check-raw-primitives-ratchet` · `check-grid-option-identity` · `check-silent-disabled` · `check-control-census`
   (matrix) · `check-layout-v2` (matrix) · `check-editor-open` (contract + strict) · `check-no-nul-bytes` ·
   `sync-control-scenarios.vitest.test.ts`.
7. The functionality matrix (every cell kind × every §3.4 state × coordinate kind: EU region · market · alias · GLOBAL
   · Not listed) with Screen / Injected / Held per row, live where GALE has the state, lab where it does not.
Nothing committed; the ledger holds the numbers; your FINAL message = the tables + every exit code + what you could not
measure and why + any `QUESTION FOR THE OWNER` verbatim.
8. From MX.1's report: (a) `apps/web/src/app/design/grid-lab/MatrixScenario.tsx:221` exposes `window.__matrixLab` — guard it
   with `process.env.NODE_ENV !== 'production'` so `check-global-exposure` (currently exit 1 on it) goes green; (b) the
   `Not listed` cell's tooltip says "no account is connected" — true only for `connected: false`; a connected-but-unlisted
   coordinate (`connected: true, cells: []`) needs its own sentence (`No listing on this coordinate yet`); (c) RULED:
   widen the contract's `absent[].cell` to `MatrixCellKind | 'businessPrice' | 'businessTiers'` in
   `packages/shared/matrix-contract.ts` + the DS copy (+ parity test, + mirror) so the derived B2B absence has a wire
   slot, and render those two in Customise greyed with MX.1's sentence; (d) the two other red gates
   (`route-prisma-ratchet` on assets/brand-story/catalog-transfer, `column-drift` on ReadinessIndex) are OTHER lanes'
   pre-existing reds — measure them on a clean run, attribute them in the ledger, do not fix them.
9. Live-mode facts to assert on GALE from MX.1's read: 20 coordinates in D-MX12 order; `AMAZON:EU` carries the five
   inventory kinds once with `sharedInventoryWith [IT,DE,FR,ES]`; every Amazon row `FBA_EXCLUDED` (the product flag is
   FBA); BLACK-MEN-S carries the guard sentence AND the EU-conflict sentence in `writeBlockedReason`; the parent row is
   null/held on every cell; 10 `Not listed` singles. MX.1's disposable fixture family was DELETED at its close — for
   item 5 recreate one the same way (its ledger section says how: `MX-TEST-<date>` under XAVIA, DRAFT, `syncPaused`,
   `isPublished:false`, local DB only), announce it, delete it at your close with a positive control.
