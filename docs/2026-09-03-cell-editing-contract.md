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
| `pop:text` | AG's large-text popup (long text) |
| `pop:list` | the DS listbox panel (select / yes-no) |
| `pop:fx` | the formula editor |
| `none` | no editor opens |
| `none+say` | no editor opens, and the sheet states why in the cell's own words |
| `pop:multi` | the chip-list editor for a `shape: list` cell — the DS option list (closed list) or chip input (free text) in AG's popup (AM.1 §A.3 row 3) |
| `pop:measure` | the value + unit editor for a `shape: measure` cell (AM.1 §A.3 row 4) |

## The states

| state | how it is produced | note |
|---|---|---|
| `fresh` | first gesture after rows render | the arm the 2026-09-03 P0 lived in |
| `batch` | within ~3 s of paint, while `POST /pim/formulas/batch` is landing | repaints the ƒ marks |
| `flush` | a save is in flight (the probe holds the PATCH response open) | writer debounce is 40 ms |
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
| text | fresh | brand | inline ✓ | inline ✓ | inline ✓ | inline ✓ | pop:fx ✓ |
| text | batch | brand | inline ✓ | inline ✓ | inline ✓ | inline ✓ | pop:fx ✓ |
| text | flush | brand | inline · | inline · | inline · | inline · | pop:fx · |
| longtext | fresh | name | pop:text ✓ | pop:text ✓ | pop:text ✓ | pop:text ✓ | pop:fx ✓ |
| longtext | batch | name | pop:text ✓ | pop:text ✓ | pop:text ✓ | pop:text ✓ | pop:fx ✓ |
| longtext | flush | name | pop:text · | pop:text · | pop:text · | pop:text · | pop:fx · |
| number | fresh | basePrice | inline ✓ | inline ✓ | inline ✓ | inline ✓ | pop:fx ✓ |
| number | batch | basePrice | inline ✓ | inline ✓ | inline ✓ | inline ✓ | pop:fx ✓ |
| number | flush | basePrice | inline · | inline · | inline · | inline · | pop:fx · |
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
whichever column the row drives.

**AM.1 also moved the locked arm:** `condition_type` is editable and formula-writable on every scope now (the
channel accepts it), so no scope has a locked `select` — the `locked`/`fxblocked` rows drive `amazonAsin` (text,
`editable:false`, `formulaWritable:false`, in every landing view). eBay's `brand` became the 394-option "Marca"
aspect (a select), which is why the text rows drive `brand` on master/Amazon and substitute on eBay. The gate
drives a named column only while it still satisfies the row on that scope; otherwise it substitutes and SAYS so.

For the `list` and `measure` rows, `kind` is the column's SHAPE (AM.1), not its wire kind — the gate resolves
them by `shape`, and a scalar row never resolves to a shaped column of the same wire kind. Neither shaped
column is in a landing view, so the gate reveals one through Customise, as it does for `locked`.

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
