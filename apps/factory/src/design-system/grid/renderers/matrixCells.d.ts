/**
 * MX.G — the eight Matrix cell kinds' DISPLAY RULES, pure.
 *
 * Design `docs/2026-09-13-matrix-page-design.md` §3.4 is the table this file implements and
 * Appendix A is the copy. Every word an operator reads in a Matrix cell, every tone it paints,
 * every `.nds-cell-is-*` class it wears and every tooltip sentence is decided HERE, once, and the
 * renderers in `MatrixCells.tsx` draw the answer. A page that wrote `sync.kind === 'PAUSED' ? …`
 * anywhere else would have forked the vocabulary — the failure
 * `reference_two_column_builders_drift` records.
 *
 * ## Three rules this file exists to keep
 *
 * 1. **No tone is CHOSEN.** Every tone below is READ from `readinessMeta()` or `projectionMeta()`
 *    and records where it came from in `matrixCellToneFrom`, exactly as `projection.ts` does (hub
 *    ruling #3). The one exception is stated the way `projection.ts` states its own: a cell at rest
 *    that paints NO status colour answers `null`, because there is no colour to delegate.
 * 2. **The page derives no number.** `SyncCell` is `resolveIntendedQuantity`'s verdict on the wire
 *    (contract §3.6) and `PriceCell.value` is the number the push reads. Nothing here recomputes a
 *    quantity from a pool; `intended` is quoted, never derived. The one arithmetic in the whole
 *    Matrix frontend is `preview.ts`'s `followQty`, and it is preview-mode only.
 * 3. **`null` is never `0`.** `intended: null`, `value: null` and an absent cell render the dash,
 *    with the reason on the tooltip where one exists — the rule `renderers/format.ts` already keeps
 *    for every other cell type.
 *
 * 🔴 **The signatures here are MX.P's, deliberately.** MX.P built the page against a local stub
 * (`_studio/matrix/gdsStub.tsx`) carrying these exact names and arities so that adopting the engine
 * is one changed import and a deleted file — never a second implementation. Where this file departs
 * from the stub it is because the stub had a defect, and each departure is named at its site.
 *
 * Pure `.ts`: no React, no AG, no CSS import, so every rule in it is reachable from this
 * workspace's node-only vitest (`matrixCells.vitest.test.ts`).
 */
import { type FulfilmentMethod, type MatrixCellKind, type MatrixCells, type MatrixCoordinate, type MatrixCopy, type SaleCell, type SyncCell } from '../matrix/contract';
import { type ReadinessTone } from './readiness';
/** The em dash every empty Matrix cell draws — the sheet's own, not a second one. */
export declare const MATRIX_DASH = "\u2014";
/**
 * The engine's default copy table — design Appendix A, verbatim.
 *
 * 🔴 **A restatement of `_studio/matrix/contract.ts`'s `MATRIX_COPY`, gated rather than trusted.**
 * The engine has to be able to render a Matrix cell on its own: it is mirrored into `apps/factory`,
 * where no `_studio` tree exists, and the grid lab renders these cells with no page around them.
 * `matrix/contract.parity.vitest.test.ts` asserts every member of this table produces the SAME
 * string as the app's for the same arguments, so a reworded sentence is a red test and not a second
 * truth (`reference_two_column_builders_drift`: put the rule in the engine, assert parity in the
 * gate). The app may still pass its own table as the last argument — this is an injectable default,
 * which is what separates it from a fork.
 */
export declare const MATRIX_CELL_COPY: MatrixCopy;
/**
 * One name per row of the §3.4 table, so "every state rendered" is a SET CLAIM that can be checked
 * rather than an adjective. `MatrixScenario` builds one fixture per member and the ledger's
 * screenshot table is indexed by it.
 *
 * 🔴 Derived nowhere else. A lane that needs "is this cell paused" asks `matrixCellState`, so the
 * screenshot, the class, the tone, the tooltip and the gate row all answer from ONE discriminator.
 */
export type MatrixCellState = 'absent' | 'listed' | 'draft' | 'excluded' | 'not-set-up' | 'needs-value' | 'suppressed' | 'closed' | 'error' | 'ended' | 'fulfilment-set' | 'fulfilment-derived' | 'fulfilment-guard-differs' | 'fulfilment-reported-differs' | 'follow' | 'pinned' | 'paused-policy' | 'paused-listing' | 'amazon-managed' | 'uncounted' | 'offer-closed' | 'oversold' | 'queue-sent' | 'queue-queued' | 'queue-sending' | 'queue-failed' | 'queue-dead' | 'queue-paused' | 'queue-never' | 'price-master' | 'price-override' | 'price-formula' | 'price-clamped' | 'sale-set' | 'sale-none';
/** Is this kind one of ours? A read boundary should parse, not cast. */
export declare function isMatrixCellKind(value: unknown): value is MatrixCellKind;
/** Amazon's own report and our method disagree. `MCF` is eBay's and the report never speaks to it. */
export declare const matrixReportedDiffers: (method: FulfilmentMethod | null, reported: "AFN" | "MFN" | null) => boolean;
/** The fail-closed guard and the typed column disagree (design M7 — two stores, one fact). */
export declare const matrixGuardDiffers: (method: FulfilmentMethod | null, guard: "FBA" | "FBM" | null) => boolean;
/** The one oversold sentence — the ⚠ mark's title and the tooltip line are the same string. */
export declare const MATRIX_OVERSOLD_SENTENCE = "The channel holds more than the pool can back";
/**
 * The §3.4 state of one cell.
 *
 * 🔴 The ORDER of the tests is the design's own precedence and is not cosmetic.
 * `resolveIntendedQuantity` resolves FBA_EXCLUDED → CLOSED → PAUSED → PINNED → FOLLOW → UNCOUNTED
 * (contract §3.6, quoting `sync-control-core.ts:146`), and `SyncCell.kind` already carries that
 * verdict — so this function READS the verdict rather than re-deriving it, and only the facts the
 * verdict does not carry (`oversold`, which is orthogonal) are tested after it.
 */
export declare function matrixCellState(kind: MatrixCellKind, cells: MatrixCells | null | undefined): MatrixCellState;
/**
 * Money in the COORDINATE's currency.
 *
 * 🔴 `formatGridValue('money')` could not do this, measured: `renderers/format.ts` routes `money`,
 * `money2` and `eur` through EUR-pinned formatters. The Matrix is a per-market grid and GBP markets
 * are in the contract (Amazon UK, design M17), so a EUR-pinned formatter prints `€` over a pound
 * price. `format.ts` is extended additively with a `currency` option in the same pass, and this
 * function is what the Matrix cells call — one formatter for the eight kinds, so a price cell and a
 * sale cell cannot round differently.
 *
 * `en-GB` fixes the grouping and symbol placement so SSR and client render identically — the same
 * reason `lib/format.ts` pins its locale.
 */
export declare function matrixMoney(value: number | null | undefined, currency: string): string;
export declare function matrixDay(iso: string | null | undefined): string;
/** `2 min` · `9 h` · `3 d` — the queue row's own AGE, never a wall clock the operator must subtract. */
export declare function matrixAgo(iso: string | null | undefined, now?: number): string | null;
/** `€89.00 · 12 Sep → 30 Sep` (Appendix A). An open-ended window prints only the side it has. */
export declare function matrixSaleText(sale: SaleCell | null | undefined, currency: string): string;
/** The Mode word — `Follow` · `Pinned` · `—` (Appendix A). */
export declare function matrixModeWord(sync: SyncCell | null | undefined): string;
/**
 * The Sync word — `Sent <ago>` · `Queued` · `Sending` · `Failed` · `Dead` · `Paused · policy` ·
 * `Paused · listing` · `Never` (Appendix A, verbatim).
 */
export declare function matrixQueueWord(cells: MatrixCells | null | undefined, now?: number): string;
/**
 * The Sync cell AT REST — design §3.4's own column, verbatim: `✓ 2 min` · `Queued` · `Sending` ·
 * `✗ Failed` · `Dead` · `⏸ policy` / `⏸ listing` · `—` never.
 *
 * 🔴 Two forms, one fact, and the split is the design's: §3.4 draws the CELL (a glyph and a short
 * word, because the column is 96px and `Paused · listing` measured 94px against 63 available), and
 * Appendix A fixes the WORD an export, a filter and a tooltip carry (`matrixQueueWord`). The glyph
 * is the identity (`reference_tag_identity_is_glyph_not_colour`); the tone rides on it.
 */
export declare function matrixQueueGlyph(cells: MatrixCells | null | undefined, now?: number): {
    glyph: string;
    word: string;
} | null;
/**
 * The Qty word — `<n>` · `⏸ <n>` · `—` · `Uncounted` · `Closed` (Appendix A).
 *
 * The ⏸ belongs to the TEXT and not only to the renderer, because this same function feeds the
 * clipboard, the CSV export and the text filter (`valueFormatter` / `getQuickFilterText`), and a
 * paused row that exported as a bare number would read as a pushed quantity in a spreadsheet.
 */
export declare function matrixQtyText(cells: MatrixCells | null | undefined, copy?: MatrixCopy): string;
/**
 * The ONE text of a Matrix cell: the word on screen, and the same string a copy, an export, a
 * quick filter and the comparator read.
 *
 * 🔴 It is the same function the renderer's own word comes from, so the clipboard and the screen
 * cannot disagree — the rule `variationThemeText` established for the variation-theme column and
 * the reason `shapeColumn.ts` routes `valueFormatter` and `filterValueGetter` through one place.
 */
export declare function matrixCellText(kind: MatrixCellKind, cells: MatrixCells | null | undefined, coord: Pick<MatrixCoordinate, 'currency'>, copy?: MatrixCopy, now?: number): string;
/** Where a tone was read from, as `"<vocabulary>:<state>"`, or `null` when nothing is painted. */
export type MatrixToneSource = `row:${string}` | `scope:${string}` | null;
/**
 * Which readiness/projection entry this cell's tone was read from. Exported so a test can assert
 * the delegation without re-deriving it, and so an auditor can check it by reading.
 */
export declare function matrixCellToneFrom(kind: MatrixCellKind, cells: MatrixCells | null | undefined): MatrixToneSource;
/**
 * The tone of one Matrix cell, READ from the readiness/projection tables — `null` where the cell
 * paints no status colour, which is most cells at rest.
 *
 * `coord` is accepted and unused: the tone of a cell is a property of the CELL, never of the
 * coordinate it sits under, and taking the argument keeps MX.P's call sites unchanged while making
 * that fact explicit rather than implied by an absence.
 */
export declare function matrixCellTone(kind: MatrixCellKind, cells: MatrixCells | null | undefined, _coord?: Pick<MatrixCoordinate, 'key'>): ReadinessTone | null;
/**
 * The `.nds-cell-is-*` classes one Matrix cell wears, in PRECEDENCE order — the first match wins
 * and the rest are not applied.
 *
 * 🔴 Precedence is behaviour, and §3.4's own words fix it: *"a paused listing's Mode · Qty · Buffer
 * · Sync cells share one muted tint"* and *"an FBA row's four inventory cells render `—`"*. So a
 * paused FOLLOW cell must NOT also wear `nds-cell-is-inherited`, or two tints fight over one cell
 * and the operator reads the weaker one. `locked` (nothing can be written here) beats `paused`
 * (nothing is being sent) beats `refused` (the last send failed) beats the provenance tints.
 *
 * 🔴 `nds-cell-is-refused` is ALSO `roundTripClassRules`'s class for a write the server refused, and
 * the two uses cannot collide: it is applied here ONLY on `syncState`, which is read-only on every
 * Matrix column (`WRITABLE_CELL_KINDS` excludes it and `matrixCellEditable` refuses it outright), so
 * no write can ever land on a cell this rule paints. Stated because `sheetColumn.ts` asserts its
 * rule sets disjoint and a future lane adding a `syncState` editor would break that silently.
 */
export declare function matrixCellClasses(kind: MatrixCellKind, cells: MatrixCells | null | undefined, _coord?: Pick<MatrixCoordinate, 'key'>): string[];
/** Every class `matrixCellClasses` can emit — the set a column builds its `cellClassRules` from. */
export declare const MATRIX_CELL_CLASSES: readonly string[];
/**
 * The ONE tooltip of a Matrix cell — Appendix A, verbatim, through the copy table.
 *
 * Composed from SERVER-STATED facts only. Where a cell has nothing to add beyond the word already
 * in it, the answer is `null` and no title is rendered: a sheet where every cell carries a hover is
 * the noise the DS spent a pass removing (`ProjectionCell`'s own note).
 *
 * A `writeBlockedReason` is appended for any cell the operator cannot write, whatever else it says
 * — a held control must carry its reason in the DOM (`scripts/check-silent-disabled.mjs`).
 */
export declare function matrixCellTooltip(kind: MatrixCellKind, cells: MatrixCells | null | undefined, coord: Pick<MatrixCoordinate, 'currency' | 'sharedInventoryWith'>, copy?: MatrixCopy, now?: number): string | null;
export interface MatrixEditability {
    editable: boolean;
    /** The sentence a held cell carries. `null` only when the cell IS editable. */
    reason: string | null;
}
/**
 * May the operator write this cell here, and if not, WHY.
 *
 * `writable` is the SERVER's answer (contract §3.6 `writable` / `writeBlockedReason`) and the engine
 * never second-guesses it — except in one direction that costs nothing and closes a hole: a kind
 * that is not writable by DESIGN is never editable whatever the wire says. `listing` is the
 * projection PATCH's own control (the tick), `syncState` is a fact, and `fulfilment` never writes
 * inline — choosing a method opens the `set-fulfilment` preflight for that one row (§3.4).
 *
 * 🔴 `writable: undefined` is `false` with a sentence, never `true`. The contract says
 * "Absent = false", and an editor that opened on a cell the server never blessed would arm a write
 * the server will refuse — the same defect as a silently disabled control, one step later.
 */
export declare function matrixCellEditable(kind: MatrixCellKind, cells: MatrixCells | null | undefined): MatrixEditability;
/**
 * The cell's VALUE — what AG carries, compares and (where the handle is allowed) FILLS.
 *
 * 🔴 A SCALAR for every kind the fill handle may carry, and that is the design (`ProjectionCell`'s
 * own note says why a whole cell object as a value is a hazard: dragging one variant's ASIN onto
 * nineteen others):
 *   `syncQty` → the number, `syncBuffer` → the number, `price` → the number,
 *   `syncMode` → `'FOLLOW' | 'PINNED'`, `fulfilment` → the method.
 * `listing` and `syncState` answer `null` — they are facts, and there is nothing a fill could
 * honestly carry. Everything else a cell says is read from the ROW through `facts`.
 *
 * 🔴 `salePrice` is the ONE COMPOUND value — `{ value, start, end }` — and the reason is AG's own
 * commit path, not taste. `CellCtrl.saveNewValue` fires `cellValueChanged` only when the editor's
 * value `!==` the getter's, and `RowNode.setDataValue` re-reads the getter for the event's
 * `newValue`. With a scalar value here, a sale whose DATES moved and whose price did not would
 * re-read as the same number: the event would carry `oldValue === newValue`, the write gate's
 * `unchanged` rule would drop it, and the operator's edit would vanish with nothing on screen
 * saying so. The compound is safe precisely because this kind is NOT in `MATRIX_FILLABLE_KINDS` —
 * the hazard the scalar rule guards against cannot arise on a column whose handle is refused. The
 * setter REPLACES the object rather than mutating it in place, so the event's old and new
 * references differ and `sameValue` compares them structurally.
 *
 * 🔴 `syncQty` answers `intended`, NOT `held`, and the difference is measurable: `intended` is what
 * WOULD be pushed (`resolveIntendedQuantity`'s output) and `held` is what the channel currently has.
 * On a PAUSED row `intended` is `null` by contract — so the cell's value is `null` there, which is
 * correct: a fill from a paused cell must not stamp the stale channel number onto twenty rows.
 * MX.P's stub read `intended ?? held`, which would have done exactly that.
 */
export declare function matrixCellValue(kind: MatrixCellKind, cells: MatrixCells | null | undefined): unknown;
/**
 * The value the SALE editor edits and reports — the wire's own `SaleCell`, re-typed here so the
 * editor, the setter and the writer name one shape. An all-null compound means "no sale".
 */
export type SaleEditorValue = SaleCell;
/** Is this a sale compound (the editor's report), rather than a bare number or nothing? */
export declare function isSaleEditorValue(v: unknown): v is SaleEditorValue;
/**
 * Coerce what an editor, a paste or a fill handed the column into the value the kind stores, or
 * `undefined` when it cannot be stored — the setter then refuses (returns `false`) and AG keeps
 * the old value, which is the honest answer to `"abc"` in a quantity cell.
 *
 * Numbers arrive as numbers from AG's number editor and as STRINGS from a paste (`"5"`); both are
 * accepted. `''` on a number kind clears nothing here — a quantity has no "empty", so it refuses.
 * `syncQty` and `syncBuffer` are whole units; `price` keeps two decimals of intent as typed.
 */
export declare function matrixCoerceValue(kind: MatrixCellKind, value: unknown): unknown;
/**
 * The DEFAULT `params.data` mutation — what the column's `valueSetter` does when the host supplies
 * no `applyValue` of its own. It writes into the `MatrixCells` object the host's `cells(data)`
 * reader returned, which is the row's own nested object: mutating it IS mutating `params.data`,
 * which AG requires (`reference_ag_value_setter_must_mutate_params_data`).
 *
 * 🔴 It moves the VALUE and nothing else. Typing a number into a Follow cell leaves `kind` and
 * `mode` as they were: D-MX3 says typing pins, and the STORE (preview) or the SERVICE (live) is
 * what turns the write into a pin and answers with the new read — the class stays untouched in
 * the browser so the sheet never claims a provenance the write has not yet earned (the mandate's
 * "the class stays untouched"). `salePrice` REPLACES the compound (see `matrixCellValue`).
 *
 * Returns `false` when there is nothing to write into or the value cannot be stored, so AG keeps
 * the old value and fires nothing.
 */
export declare function matrixApplyValue(cells: MatrixCells | null | undefined, kind: MatrixCellKind, value: unknown): boolean;
/**
 * The kinds AG's fill handle may carry.
 *
 * Design §3.1 rule 5, verbatim: *"the fill handle is disabled on `fulfilment`, `listing`,
 * `syncState`; it works on `price`, `syncQty`, `syncBuffer`"*. Two kinds the rule does not name are
 * decided here, each by the rule's own argument:
 *   · `syncMode` FILLS. It is a scalar with one meaning per cell, its write goes through the same
 *     one door as a quantity, and typing a number into a Follow cell ALREADY flips the mode
 *     (D-MX3) — so refusing the handle would forbid by drag what the keyboard does by design.
 *   · `salePrice` does NOT. Its value is a price but its meaning is a price AND a window; filling
 *     the number alone would set a sale with somebody else's dates, which is not what the operator
 *     dragged. The editor is the only honest way to set one.
 *
 * Written as an ALLOW-list. `variationThemeWrite`'s lock test was a deny-list first and let exactly
 * one case through; an allow-list fails closed when a ninth kind arrives.
 */
export declare const MATRIX_FILLABLE_KINDS: readonly MatrixCellKind[];
export declare function matrixFillAllowed(kind: MatrixCellKind): boolean;
/**
 * The comparator a Matrix column sorts by.
 *
 * Numbers sort as numbers, everything else by its own text, and `null` sorts LAST in an ascending
 * sort rather than first — an operator sorting by Qty is looking for the rows that have one. The
 * same rule `formatGridValue` keeps for display: an absent value is not a zero.
 */
export declare function matrixCompare(kind: MatrixCellKind, a: unknown, b: unknown): number;
/** The fulfilment options a coordinate offers, or `null` where the channel has no such concept. */
export declare function matrixFulfilmentOptions(coord: Pick<MatrixCoordinate, 'vocabulary'>): readonly FulfilmentMethod[] | null;
