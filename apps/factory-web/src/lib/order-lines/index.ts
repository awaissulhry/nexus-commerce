/**
 * owb-po3 — `lib/order-lines`: THE ONE LINES TABLE (design § 5zi B + C, § 5j). S1 owns it; S2 mounts it on the office Lines tab, web B
 * on the portal order's Lines tab (po6), the New order window draws it (po3). Keep these exports and props stable: a change is said
 * to the S1 lead first.
 *
 * ── The table: `<OrderLinesTable model={…} actions={…} foot={…} />` ─────────────────────────────────────────────────────────────
 * model (`OrderLinesModel`):
 *   rows        LineRow[]           one per line, by seq; NEVER a price (build them: `lineRowsOfDraft(request, { styles, kinds })` for a
 *                                   draft; an order host writes its own adapter to `LineRow`).
 *   mode        'draft' | 'sent' | 'confirmed' | 'shipped'   draft saves · sent reads (says why) · confirmed: typing calls `onAsk`
 *                                   (absent: reads) · shipped reads ("It left the factory. A change now is a return.").
 *   columns     OwnColumn[]         the record's own columns in order (`ownColumnsOfRecord(record.ownColumns)`).
 *   styles      ModelStyle[]        the Model cell's styles (ownLabel → "Your designs", else "The factory's range").
 *   kinds       NewDesignKind[]     "A new design: …" kinds (code + words).
 *   prices      LinePrices | null   money: null → no Your price column and no price key at all (the money wall).
 *   pending     boolean             "Add a line" drew a row with nothing chosen ("Choose the model…").
 *   removed     RemovedLine[]       lines taken out → "Put it back" (draft only).
 *   writeHeld   string | null       why nothing writes now (words). saving: line ids being saved.
 *   columnsDoor boolean             offer "Columns · n…" / "Add a column…".  refusals?: line id → words.  room?: 'narrow' | 'wide'.
 *   door?       'portal' | 'office' the office reads its own word for a few keys ("Price", "Sent by the customer…").
 * actions (`OrderLinesActions`, every one optional): onModel(rowId | null, ModelChoice) · onMaterial(rowId, value) · onAddMaterial ·
 *   onSizes(rowId) · onPieces(rowId, count | null) · onOwnValue(rowId, columnId, value, version | null) · onPrice(rowId, text) ·
 *   onCopy · onTakeOut · onPutBack(lineId) · onAdd · onDropPending · onColumns · onRefused(rowId, words) · onAsk(rowId, field, value).
 * foot: the host's own doors beside "Add a line" (the portal's "Add from: …").
 *
 * ── Columns of your own: `<OwnColumnsWindow model={…} actions={…} />` (+ `OwnColumnsBody`), `<OwnChips columns lines max? />`
 *   (2 chips + "+ n"; `ownChipsOf` pure), the rules in `own-columns/rules.ts`, the commands `ownColumnsPort(api, door, partyId?)`.
 */
export { OrderLinesTable, sizesWords, type AskField, type OrderLinesActions, type OrderLinesModel } from './view/OrderLinesTable'
export {
  LINE_MODES,
  lineRowsOfDraft,
  modelChoiceOf,
  modelFields,
  modelGroupsOf,
  modelValueOf,
  materialChoiceOf,
  modeHeldOf,
  nextLineFields,
  ownColumnsOfRecord,
  piecesOfRows,
  piecesTyped,
  priceHintOf,
  type LineMaterial,
  type LineModelKind,
  type LinePrices,
  type LineRow,
  type LinesMode,
  type ModelChoice,
  type ModelStyle,
  type NewDesignKind,
  type PriceHint,
} from './model'
export { OwnColumnsBody, OwnColumnsWindow, type OwnColumnsWindowActions, type OwnColumnsWindowModel } from './own-columns/OwnColumnsWindow'
export { OwnChips, ownChipsOf, ownValueWords, type OwnChip } from './own-columns/OwnChips'
export { cleanOwnValue, newColumnProblem, OWN_COLUMNS_MAX, QUICK_COLUMNS, switchOff, toggledColumns } from './own-columns/rules'
export { ownColumnsPort, type LinesDoor, type OwnColumnsPort, type OwnLineRef } from './api'
export { NO_OWN_COLUMNS, OWN_COLUMN_KINDS, ownColumnSchema, ownValueSchema, recordOwnColumnsSchema, removedLineSchema, type OwnColumn, type OwnColumnKind, type OwnValue, type RecordOwnColumns, type RemovedLine } from './schema'
export { useCell, useHeldModel } from './redraw'
export { ORDER_LINES_NS, useLinesWords } from './words'
