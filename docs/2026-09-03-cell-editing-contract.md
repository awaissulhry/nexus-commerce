# The Cell Editing Contract — Product Edit Studio

**Status:** hub order #776(2), written 2026-09-03 by session `nexus-commerce-b0`. Every gesture ×
every column kind × every state, and what the sheet must do. `scripts/check-editor-open.mjs`
**parses the table below and asserts it line by line, on all three scopes (master·DE, Amazon·IT, eBay·IT), failing on a single miss.**

## How to read it, and the two rules that keep it honest

1. **The gate reads THIS FILE.** The table is not a description of the gate; it is the gate's input.
   There is no second copy to drift from — edit a cell here and the next run asserts the new value.
   A row the parser cannot understand FAILS the run rather than being skipped.
2. **Every cell is marked with its provenance.** `✓` = measured in a browser on this build, today.
   `·` = declared, and asserted by the gate, but not separately hand-witnessed. `n/a` = the
   combination cannot be produced, with the reason. **Nothing here is asserted from memory**, and a
   cell nobody has measured is never dressed as one that has been.

## Vocabulary

| token | meaning |
|---|---|
| `inline` | the cell itself becomes the editor |
| `pop:value` | the DS formula-aware editor in plain single-value mode (`Cell value`) |
| `pop:text` | the DS formula-aware textarea in plain long-text mode (`Cell value`) |
| `pop:list` | the DS listbox panel (select / yes-no) |
| `pop:fx` | the formula editor |
| `none` | no editor opens |
| `none+say` | no editor opens, and the sheet states why in the cell's own words |
| `pop:multi` | the chip-list editor for a `shape: list` cell — the DS option list (closed list) or chip input (free text) in AG's popup (AM.1 §A.3 row 3) |
| `pop:measure` | the value + unit editor for a `shape: measure` cell (AM.1 §A.3 row 4) |
| `pop:sale` | the Matrix sale editor — price + start + end in AG's popup (`SaleCellEditor`, MX.G) |

## The states

| state | how it is produced | note |
|---|---|---|
| `fresh` | first gesture after rows render | the arm the 2026-09-03 P0 lived in |
| `batch` | within ~3 s of paint, while `POST /pim/formulas/batch` is landing | repaints the ƒ marks |
| `flush` | a save is in flight after choosing its destination, if required (the probe holds the PATCH response open) | inherited/drift language text requires the LX.8 acknowledgement above the grid |
| `locked` | `editable: false` on the wire | 11 of 96 columns |
| `fxblocked` | `formulaWritable: false` on the wire | **the same 11 columns today** — see below |

🔴 **`locked` and `fxblocked` are not independent axes on this coordinate.** Measured on the live
contract today: `formulaWritable === false` on exactly `sku, condition_type, amazonAsin, ebayItemId,
parentAsin, buyBoxPrice, competitorPrice, shippingTemplate, amazon_bullets, amazon_browseNode,
amazon_searchKeywords` — the same 11 columns that carry `editable: false`. Ruling #770 measured
`fabric_type` as formula-blocked and that reading was correct when taken; `fabric_type` is now
`formulaWritable: true` and `kind: longtext`. The rows are kept separate because the server may
diverge them again, and the gate asserts both — but today they exercise one set of columns, and
saying otherwise would claim coverage this build cannot give.

## The table

<!-- CONTRACT-TABLE-START -->

| kind | state | col | dblclick | enter | f2 | type | equals |
|---|---|---|---|---|---|---|---|
| text | fresh | brand, videoId | pop:value · | pop:value · | pop:value · | pop:value · | pop:fx ✓ |
| text | batch | brand, videoId | pop:value · | pop:value · | pop:value · | pop:value · | pop:fx ✓ |
| text | flush | brand, videoId | pop:value · | pop:value · | pop:value · | pop:value · | pop:fx · |
| longtext | fresh | name | pop:text ✓ | pop:text ✓ | pop:text ✓ | pop:text ✓ | pop:fx ✓ |
| longtext | batch | name | pop:text ✓ | pop:text ✓ | pop:text ✓ | pop:text ✓ | pop:fx ✓ |
| longtext | flush | name | pop:text · | pop:text · | pop:text · | pop:text · | pop:fx · |
| number | fresh | basePrice | pop:value · | pop:value · | pop:value · | pop:value · | pop:fx ✓ |
| number | batch | basePrice | pop:value · | pop:value · | pop:value · | pop:value · | pop:fx ✓ |
| number | flush | basePrice | pop:value · | pop:value · | pop:value · | pop:value · | pop:fx · |
| select | fresh | status | pop:list ✓ | pop:list ✓ | pop:list ✓ | pop:list ✓ | pop:fx ✓ |
| select | batch | status | pop:list ✓ | pop:list ✓ | pop:list ✓ | pop:list ✓ | pop:fx ✓ |
| select | flush | status | pop:list · | pop:list · | pop:list · | pop:list · | pop:fx · |
| text | locked | amazonAsin | none+say ✓ | none+say ✓ | none+say ✓ | none+say ✓ | none+say ✓ |
| text | fxblocked | amazonAsin | none+say ✓ | none+say ✓ | none+say ✓ | none+say ✓ | none+say ✓ |
| list | fresh | supplier_declared_dg_hz_regulation | pop:multi ✓ | pop:multi ✓ | pop:multi ✓ | pop:multi ✓ | pop:fx ✓ |
| measure | fresh | item_weight | pop:measure ✓ | pop:measure ✓ | pop:measure ✓ | pop:measure ✓ | pop:fx ✓ |

<!-- CONTRACT-TABLE-END -->

`col` is the column the gate drives for that row.

**AM.1 (2026-09-05) renamed the driving columns:** `name` is `longtext` on every scope now (it carries the
channel's title cap), so it drives the long-text rows; `item_name` no longer exists (merged into `name`); `brand`
(text on all three scopes, in every landing view) drives the text rows. The `flush` state holds the PATCH for
the Title positive-control edit while the row's column is exercised. The scalar timing arms derive their
columns and modes from this table too; they must not retain the removed `item_name` column.

**LX.8 (2026-09-12):** a channel Title edit may first show an acknowledgement row above the grid.
The flush arm verifies that both destinations and Cancel are visible, chooses the shared destination,
then holds the resulting PATCH. An unanswered acknowledgement is not an in-flight save. All open-gesture
expectations in the table remain unchanged. Contract API reads use the same authenticated test browser
session as the screen; an anonymous refusal is not a missing column contract.

**AM.1 also moved the locked arm:** `condition_type` is editable and formula-writable on every scope now (the
channel accepts it), so no scope has a locked `select` — the `locked`/`fxblocked` rows drive `amazonAsin` (text,
`editable:false`, `formulaWritable:false`, in every landing view). eBay's `brand` became the 394-option "Marca"
aspect (a select), which is why the text rows drive `brand` on master/Amazon and substitute on eBay. The gate
drives a named column only while it still satisfies the row on that scope; otherwise it substitutes and SAYS so.

For the `list` and `measure` rows, `kind` is the column's SHAPE (AM.1), not its wire kind — the gate resolves
them by `shape`, and a scalar row never resolves to a shaped column of the same wire kind. Neither shaped
column is in a landing view, so the gate reveals one through Customise, as it does for `locked`.

## The Matrix table (MX.G, 2026-09-13) — driven on the Matrix host, `?tab=matrix` on GALE, master scope

The Matrix page (`docs/2026-09-13-matrix-page-design.md` §3.4) puts eight cell KINDS under every coordinate group,
each defined ONCE by `matrixColumnDef` (`design-system/grid/editors/matrixColumn.ts`). The gate drives them on the
Matrix host with the SAME gesture columns; `col` is the column's KIND — the gate resolves the column by the
`<coordinateKey>.<kind>` suffix of the rendered col-ids, and the row by the state: `fresh` takes the first row whose
cell of that kind carries `nds-cell-is-editable`, `locked` the first whose cell carries `nds-cell-is-locked` (the parent
row, an FBA row). A kind the host does not render is recorded n/a, never passed.

**Provenance (MX.G's `EDITOR_ONLY=contract` run, 2026-09-13 17:32–17:34, GALE preview mode, the page on the engine):**
`✓` = measured on that run (8 rows × 5 gestures). The rows still `·` are UNDRIVABLE on GALE's PREVIEW fixture and the gate
says so as NOT MEASURED: `syncMode` / `syncQty` / `syncBuffer` `fresh` — every one of the 21 rendered `AMAZON:EU` rows is
Amazon-managed there (21/21 `nds-cell-is-locked`, `—`; measured on the page itself), so no row carries an editable cell of
those kinds (the same engine columns ARE editable in the grid lab, where the round trips are proven); `price` / `salePrice`
`locked` — the fixture has no formula-owned price and never locks a sale. They become drivable on MX.1's LIVE read (GALE
carries 4 FBM children, design M6) or on a fixture row whose hash lands on FBM. `syncState`: the mouse gesture IS the
jump (§3.4 — the cell navigated to Needs attention and left the DOM), so `dblclick` is `none` by design and the keyboard
gestures cannot follow it in one gate row (the gate loads the page once per row) — MX.F drives them with a keyboard-first
pass or a split row.

<!-- MATRIX-CONTRACT-TABLE-START -->

| kind | state | col | dblclick | enter | f2 | type | equals |
|---|---|---|---|---|---|---|---|
| listing | fresh | listing | none+say ✓ | none+say ✓ | none+say ✓ | none+say ✓ | none+say ✓ |
| fulfilment | fresh | fulfilment | pop:list ✓ | pop:list ✓ | pop:list ✓ | pop:list ✓ | pop:list ✓ |
| syncMode | fresh | syncMode | pop:list ✓ | pop:list ✓ | pop:list ✓ | pop:list ✓ | pop:list ✓ |
| syncQty | fresh | syncQty | inline ✓ | inline ✓ | inline ✓ | inline ✓ | inline ✓ |
| syncBuffer | fresh | syncBuffer | inline ✓ | inline ✓ | inline ✓ | inline ✓ | inline ✓ |
| syncState | fresh | syncState | none+say ✓ | none+say ✓ | none+say ✓ | none+say ✓ | none+say ✓ |
| price | fresh | price | inline ✓ | inline ✓ | inline ✓ | inline ✓ | inline ✓ |
| salePrice | fresh | salePrice | pop:sale ✓ | pop:sale ✓ | pop:sale ✓ | pop:sale ✓ | pop:sale ✓ |
| fulfilment | locked | fulfilment | none+say ✓ | none+say ✓ | none+say ✓ | none+say ✓ | none+say ✓ |
| syncMode | locked | syncMode | none+say ✓ | none+say ✓ | none+say ✓ | none+say ✓ | none+say ✓ |
| syncQty | locked | syncQty | none+say ✓ | none+say ✓ | none+say ✓ | none+say ✓ | none+say ✓ |
| syncBuffer | locked | syncBuffer | none+say ✓ | none+say ✓ | none+say ✓ | none+say ✓ | none+say ✓ |
| price | locked | price | none+say ✓ | none+say ✓ | none+say ✓ | none+say ✓ | none+say ✓ |
| salePrice | locked | salePrice | none+say ✓ | none+say ✓ | none+say ✓ | none+say ✓ | none+say ✓ |

<!-- MATRIX-CONTRACT-TABLE-END -->

**Provenance (MX.F's two `EDITOR_ONLY=contract` runs through `studio-gate-session.mjs`, 2026-09-13 18:23–18:34 on GALE
LIVE (`source:'live'`, MX.1's read) and 18:34–18:43 on the disposable `MX-TEST-20260913` family, `EDITOR_PRODUCT=`):**
every `✓` above was measured on at least one of them, 5 gestures each. GALE live drove `listing` · `fulfilment` · `price` ·
`salePrice` `fresh` and the six `locked` rows (the `locked` price/sale cells are the PARENT row's — held with MX.1's
`The parent is not buyable — set prices on the variants`, which the gate's `none+say` regex now knows; before that edit the
same toast was classified `none`); the fixture family drove `syncMode` / `syncQty` / `syncBuffer` `fresh` (its `AMAZON:EU`
rows are FBM, `FOLLOW · PAUSED (listing)`, `writable:true`), which GALE cannot produce (every GALE Amazon variant is
`FBA_EXCLUDED`). `syncState`: both runs measured `none+say` on ALL five gestures including `dblclick` — the cell no longer
leaves the DOM on a double-click (MX.P's `onCellDoubleClicked` toasts the fact sentence over a held Matrix cell; the jump to
Needs attention is the Sync cell's BUTTON click, witnessed separately), so the row declares `none+say` throughout and no
split row is needed. The three SHEET scopes stayed NOT MEASURED on both runs — the gate's page-context fetch of
`/studio/sheet` throws `TypeError: Failed to fetch` inside its browser (the same URL answers 200 from an operator's
signed-in tab on `localhost:8091` and `127.0.0.1:8091` alike) — a host/session reading for the hub, not the Matrix's.

What each row rests on (all engine definitions, `matrixColumn.ts`): `listing` and `syncState` are FACTS
(`editable: false`, `matrixCellEditable` gives the sentence — `Inclusion is set with the tick, not by typing` ·
`The sync state is a fact — use Push quantity now, or Retry on a failure`); `fulfilment` and `syncMode` mount the DS
listbox (`selectEditor`), and a fulfilment CHOICE opens the `Set fulfilment…` preflight rather than writing — the
column's `valueSetter` returns `false`; `syncQty` / `syncBuffer` are AG's number editor inline; `price` is the sheet's
formula-aware editor (`formulaCellEditorSelector`, `=` opens the formula editor) ONLY when the host passes `formula`
— **MX.P's REQUEST (6), 2026-09-13: the sheet's `FormulaWiring` is `useCellFormulas`' and wiring it into the Matrix is a
follow-up lane, so THIS build passes none and `price` is AG's number editor, `inline` on every gesture (`=` included: the
number editor opens on it)**; `salePrice` is the sale popup. `locked` rows drive the FBA row's inventory cells (`Amazon-managed`) or the parent row (`Set on the variants —
the parent has no listing of its own`); the `none+say` regex the gate polls for carries those sentences.

The fill handle is REFUSED on `fulfilment`, `listing`, `syncState`, `salePrice` (`suppressFillHandle: true`) and works
on `price`, `syncQty`, `syncBuffer`, `syncMode` — asserted by `matrixColumn.vitest.test.ts`, witnessed in the grid lab
(`/design/grid-lab?tab=matrix`, MX.G's ledger section) and, on the page, by MX.F.

`tab`, `esc` and `clickaway` are deliberately **not** columns of this table. They are not open
gestures — they are what an ALREADY-OPEN editor does — and giving them a column here would invite
the gate to assert the wrong proposition. They have their own table below and their own assertions.

## The keyboard model, once an editor is open

Measured today, uncontaminated (a distinct value and a fresh page load per trial), on `name` and
`basePrice`, and separately on `item_name` and `status` to confirm the popup kinds behave identically.

| key | editor | focus | write |
|---|---|---|---|
| `Esc` | closes ✓ | stays on the cell ✓ | **never**, touched or not ✓ |
| `Enter` | closes ✓ | moves **down** one row ✓ | commits if changed ✓ |
| `Tab` | closes, and **opens on the next cell** ✓ | moves **right** ✓ | commits if changed ✓ |
| click-away | closes ✓ | follows the click ✓ | commits if changed ✓ |

**A commit only fires when the value actually CHANGED.** `writeGate`'s `sameValue` rule drops a
re-typed identical value, by design.

🔴 **This is the single most dangerous line in this document to measure carelessly.** Running the
four trials in sequence without reloading leaves each one starting from the value the previous one
committed; the value then does not change, no write is sent, and the reading looks exactly like
*"Tab and click-away silently discard the operator's edit"* — a data-loss defect that does not
exist. This lane produced that false reading today, with a positive control in the same run, and
was one step from reporting it. A fresh load and a distinct value per trial is not tidiness; it is
what separates the two.

🔴 `Tab` leaving an editor open on the next cell is Excel's behaviour and is deliberate — but it is
not obvious from the footer's own summary, which says only "Tab →". Recorded so it is a decision
rather than an accident.

## Known gaps, stated rather than papered over

- **`yes/no` has no row.** `kind: 'boolean'` is produced by nothing: the sheet stringifies wire
  booleans into two-option selects, and the live contract carries **0** boolean columns of 96. The
  ColDef branch exists and is correct; it cannot be exercised, so it is not claimed.
- **`formula-bearing` has no row.** A cell must already hold a stored formula, and creating one is a
  WRITE. Not taken without the hub's word; the fixture family is XAVIA, so it is available on
  request and would be announced in the ledger first.
- **`flush` rows are `·`, not `✓`.** The gate produces the state by holding the `PATCH` response
  open; no human has watched a gesture during a held save.
- **Three rows cannot currently be measured on Amazon·IT, and the reason is a defect elsewhere.**
  `number/batch`, `number/flush` and `select/fxblocked` need a column that is not in that scope's
  landing view, so the gate reveals it through the Customise dialog. The reveal works ONCE and never
  again, because **a column ticked in Customise does not survive a reload** — measured on a fresh
  context with an 8 s settle (long past the debounced persist #774 warns about):

  | scope | column | after Save | after reload |
  |---|---|---|---|
  | Amazon·IT | `item_package_quantity` | present | **absent** |
  | master·DE | `handmade_classification` | present | **absent** |
  | master·DE | `condition_type` | present | **absent** |

  `handmade_classification` on master is the exact column ruling #774 verified when it closed the
  Owner's item 44. **Attribution is NOT established** — this lane changed the double-click capture,
  the editor sizing, the blanking scope and the refusal wiring, none of which touch column
  persistence — and a coordinate match is not an attribution. Reported to the hub as the highest
  item on this page rather than worked around here: the three rows FAIL rather than being marked
  n/a, because they are blocked, not inapplicable.
- **Typing a non-numeric character into a number cell opens an EMPTY editor** (measured: `basePrice`
  showed `0`; typing `Q` gave `""`). Committing from there would clear the value. Excel rejects the
  keystroke and keeps the value. Recorded here as an open question for the hub rather than silently
  accepted; it is not in the table because the table asserts WHICH editor opens, and this is a
  question about what it opens WITH.

## Parity — the three scopes are ONE sheet (2026-09-04)

Owner: *"no inconsistencies or any differences in the UI at all."* Measured on the day, BEFORE the
fix, with `.probe/scopes.mjs` on master·DE / Amazon·IT / eBay·IT:

| reading | master·DE | Amazon·IT | eBay·IT | cause |
|---|---|---|---|---|
| header height | 57px | **29px** | **29px** | the channels defined no column filters — no floating-filter row |
| footer | `21 rows` + keyboard hint + `?` | `21 rows` | `21 rows` | the note slot (offline · refusal · hint) was master-only JSX |
| number cells | right-aligned, `nds-ag-num` | left-aligned | left-aligned | `numericColumn` never spread on the channel |
| validation tint / corner mark / tooltip | yes | **none** | **none** | the channel built no `SheetValidation` at all |
| empty required cell | `⚠ required` | `—` | `—` | two renderers, two answers |
| identity column header | `Product` | `SKU` | `SKU` | two literals |
| toolbar row count | 21 (all rendered rows) | 20 (variants only) | 20 | two definitions; the footer beneath said 21 |
| long-text renderer + length mark | yes | no | no | `LongTextCell` was master-only |
| formula keys (`Tab` inside `=`) | suppressed | **not suppressed** | **not suppressed** | `suppressFormulaKeys` never wired |

None of these was a decision. Every one was a piece written into `master/columns.tsx` that the
channel builder never received, because there was no single place to receive it from. The pieces
now live in the engine — `sheetValidationFor`, `composeSheetCellClassRules`, `sheetFilterFor`,
`SHEET_SHORTCUT_HINT`, `RequiredValue` — and in one shared `SheetFooterNote`; both column builders
call them, so a sheet cannot drift from a rule it does not own a copy of.

**The gate's `parity` block** loads all three scopes and compares nine readings to master's —
header height, row height, cell padding, cell font, floating-filter row, footer note, identity
header, every editable cell carrying the base class, the select chevron. A difference fails; a
null on master fails as NOT MEASURED rather than comparing equal to another null. First run,
2026-09-04: **18 of 18 equal**.

**Declared, not drifted:** the channel toolbar has no saved-views selector and says so in its own
slot (`absent: { control: 'views', reason: 'No saved views here' }`). The family verbs (Attach /
Promote / Add variation / Demote) exist only where a family is edited — master — and *Add listing
alias* only where aliases exist — the channels. Those are the scope's meaning, and the parity
block does not assert them.

**Measured on the wire while porting:** Amazon·IT sends `applicableProductTypes` on 63 of 97
columns and `requiredForProductTypes` alongside; eBay·IT sends neither (= every type). The channel's
hand-written wire mirror declared neither field, so `columnApplies` — master's gate — had nothing to
read there. Both are mirrored now.

## September 12 instrument alignment

The September 6 formula-editing and September 7 formula-quality designs make ordinary text and number opens formula-aware value popups, and long text a formula-aware textarea. `=` still opens expression mode. The table now distinguishes the actual input mode from the shared wrapper. Comma-separated fixture columns are tried in order: eBay’s Category is a category picker despite its text wire kind, so Video supplies the plain-text control when Brand is a select.

Virtualized columns must be scrolled into view before deciding presence. Center gestures target the value body, clear of the source action; corner gestures still target the fill handle. Geometry uses Description for both long-text and expression mode at the right edge. Locked relationship fields explain their server-provided relationship rule; that sentence also counts as a refusal.

Refusal warnings may use SourceIndicator or the master provenance mark; hover must show the exact stubbed server sentence and the formula mark must be absent. The shared footer note slot is compared across scopes; the documented scope-specific shared-write reach count sits outside that slot. All findings print, and wrong input modes fail the timing-row mark.

The visibility control uses the actual center or corner point for each gesture; a visible center does not prove the corner fits in the viewport. Playwright’s layout-stability wait is retained; the exact hit point is rechecked after its scroll. SourceIndicator’s exact refusal has a native title fallback in channel hosts that disable custom tooltip portals. Loading/error panel text is included in failed input-mode diagnostics; Q-LX4-2 has not changed the timing contract.

Diagnostic correction: removing Playwright’s stable-element wait caused first-load geometry to shift between the visibility check and the gesture (19 select abstentions in the focused run). The wait is restored and the exact point is revalidated afterward. Failed opens record their hit target and focused element.

The fixture token must resolve to its ledger heading, not a quoted earlier diagnostic. Focused runs label their closing result as a focused block, never a full-gate pass.
