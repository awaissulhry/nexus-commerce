import { HIDE_AREA_UNITS, lineDifference, type LineDifference } from '@nexus/factory-domain/inventory/receipts/rules'
import { fixedRatio } from '@nexus/factory-domain/product/units/units'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { phrase, type BuyingCan, type Loaded, type Part, type Phrase } from '../../_shared/buying/model'
import type { LiveState } from '../../_shared/buying/hooks'
import type { RecordPanelsViewModel } from '../../../record-panels/model'
import type { ReceiptDailyActions, ReceiptDailyModel, HideListActions, HideListModel } from './daily-state'
import type { ExpectedLine, LineBody, LotWithHides, Receipt, ReceiptBody, ReceiptCounts, ReceiptRow, ReceiptStatus, Recorded, Uom } from './api'

/**
 * Receipts (SCR-063) and receiving against a purchase order with its lots and hides one by one (SCR-061/062) — the
 * screens' rules, pure: the saved views (the tiles are some of them), the receiving form (a line per open PO line;
 * leather in lots of hides, each hide's measured area in m², dm² or ft²; a lot-tracked material in lots with a quantity;
 * anything else a quantity), its running totals against what the line expects and its tolerance (factory-domain's
 * `lineDifference`, the API's own rule), the checks that hold "Post receipt" in words, the body the API takes, a column
 * pasted from a spreadsheet, and what a reversal does.
 */

// ---- the list ---------------------------------------------------------------------------------------------------------------

export const RECEIPT_TONE = Object.freeze({ OPEN: 'neutral', POSTED: 'success', REVERSED: 'danger', CANCELLED: 'neutral' } as const)

/** B-W2a-63: `discrepancies` = receipts with a discrepancy not closed yet (the API's `?discrepancies=open`). */
export const RECEIPT_VIEWS = ['expected', 'posted', 'today', 'waiting', 'discrepancies', 'reversed', 'all'] as const
/** The views whose words are the `warehouse-receipts` catalogue's (W2a), not `buying`'s. */
export const DAILY_VIEWS: readonly ReceiptView[] = Object.freeze(['discrepancies'])
export type ReceiptView = (typeof RECEIPT_VIEWS)[number]

export function receiptViewOf(params: { get(name: string): string | null } | null, canReceive: boolean): ReceiptView {
  const view = params?.get('view') ?? ''
  if ((RECEIPT_VIEWS as readonly string[]).includes(view)) return view as ReceiptView
  const status = params?.get('status')
  if (status === 'POSTED') return 'posted'
  if (status === 'REVERSED') return 'reversed'
  if (params?.get('waiting') === 'true') return 'waiting'
  if (params?.get('discrepancies') === 'open') return 'discrepancies'
  return canReceive ? 'expected' : 'all'
}

export function receiptQuery(view: ReceiptView, q: string, postedFrom: string, cursor: string | null = null) {
  return {
    status: view === 'posted' || view === 'today' ? ('POSTED' as ReceiptStatus) : view === 'reversed' ? ('REVERSED' as ReceiptStatus) : null,
    waiting: view === 'waiting',
    discrepancies: view === 'discrepancies',
    postedFrom: view === 'today' ? postedFrom : null,
    q,
    cursor,
  }
}

/** The tiles: saved views with their counts (Expected counts the open order lines; the others the counts route). */
export const RECEIPT_TILES: readonly { id: string; view: ReceiptView; count: (counts: ReceiptCounts | null, expected: number | null) => number | null; needs?: keyof BuyingCan; daily?: boolean }[] = Object.freeze([
  { id: 'expected', view: 'expected', count: (_counts, expected) => expected, needs: 'receive' },
  { id: 'today', view: 'today', count: (counts) => counts?.postedSince ?? null },
  { id: 'waiting', view: 'waiting', count: (counts) => counts?.waiting ?? null },
  // B-W2a-63 (design rc-metrics "Discrepancies open (W2a)"): not closed yet; an API without the count draws '—'.
  { id: 'discrepancies', view: 'discrepancies', count: (counts) => counts?.discrepanciesOpen ?? null, daily: true },
  { id: 'reversed', view: 'reversed', count: (counts) => counts?.reversed ?? null },
])

/** The expected lines of one order, in its order (the Expected view groups them by order). */
export function expectedByOrder(lines: readonly ExpectedLine[]): { purchaseOrderId: string; number: string; supplier: string; lines: ExpectedLine[] }[] {
  const orders = new Map<string, { purchaseOrderId: string; number: string; supplier: string; lines: ExpectedLine[] }>()
  for (const line of lines) {
    const order = orders.get(line.purchaseOrderId) ?? { purchaseOrderId: line.purchaseOrderId, number: line.number, supplier: line.supplier.name, lines: [] }
    order.lines.push(line)
    orders.set(line.purchaseOrderId, order)
  }
  return [...orders.values()].map((order) => ({ ...order, lines: order.lines.sort((a, b) => a.seq - b.seq) }))
}

/** "Receive n lines" reaches lines of ONE order (a receipt is against one purchase order). */
export function receiveSelection(lines: readonly ExpectedLine[]): { orderId: string | null; held: 'none' | 'several' | null } {
  const orders = [...new Set(lines.map((line) => line.purchaseOrderId))]
  if (orders.length === 0) return { orderId: null, held: 'none' }
  if (orders.length > 1) return { orderId: null, held: 'several' }
  return { orderId: orders[0]!, held: null }
}

// ---- the receiving form -----------------------------------------------------------------------------------------------------

export interface HideDraft {
  key: string
  supplierCode: string
  area: string
  areaUom: Uom
  grade: string
  thicknessMm: string
  shade: string
  defects: string
}

export interface LotDraft {
  key: string
  supplierLotRef: string
  dyeBatch: string
  shade: string
  /** A lot-tracked material: how much came in this lot, in the order line's unit. */
  quantity: string
  hold: boolean
  holdReason: string
  hides: HideDraft[]
}

export interface ReceiveLineDraft {
  line: ExpectedLine
  include: boolean
  /** An untracked material: how much came, in the order line's unit. */
  quantity: string
  lots: LotDraft[]
  differenceReason: string
  note: string
}

export interface ReceiveDraft {
  orderId: string
  lines: ReceiveLineDraft[]
  ddtNumber: string
  ddtDate: string
  /** Local date and time (yyyy-mm-ddThh:mm) in the site's zone; empty = now. */
  receivedAt: string
  note: string
}

let counter = 0
export const draftKey = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${(++counter).toString(36)}`

/** The unit a new hide is measured in: the order line's when it is an area, else the base unit's, else m². */
export function hideUnitFor(line: ExpectedLine): Uom {
  if (HIDE_AREA_UNITS.includes(line.uom)) return line.uom
  if (HIDE_AREA_UNITS.includes(line.item.baseUom)) return line.item.baseUom
  return 'M2'
}

export const blankHide = (line: ExpectedLine, unit?: Uom): HideDraft => ({ key: draftKey('h'), supplierCode: '', area: '', areaUom: unit ?? hideUnitFor(line), grade: '', thicknessMm: '', shade: '', defects: '' })
export const blankLot = (line: ExpectedLine): LotDraft => ({ key: draftKey('l'), supplierLotRef: '', dyeBatch: '', shade: '', quantity: '', hold: false, holdReason: '', hides: line.item.tracking === 'HIDE' ? [blankHide(line)] : [] })

/** The form for the order's open lines (all of them, or the lines asked for), each with one empty lot where it needs lots. */
export function receiveDraft(orderId: string, lines: readonly ExpectedLine[], only: readonly string[] | null = null): ReceiveDraft {
  return {
    orderId,
    lines: lines
      .filter((line) => line.purchaseOrderId === orderId)
      .sort((a, b) => a.seq - b.seq)
      .map((line) => ({ line, include: only === null || only.length === 0 || only.includes(line.purchaseOrderLineId), quantity: '', lots: line.item.tracking === 'HIDE' || line.item.tracking === 'LOT' ? [blankLot(line)] : [], differenceReason: '', note: '' })),
    ddtNumber: '',
    ddtDate: '',
    receivedAt: '',
    note: '',
  }
}

/** A decimal typed by a person: a comma or a point, no grouping; null when it is no number above 0. */
export function typedDecimal(text: string): string | null {
  const cleaned = text.trim().replace(',', '.')
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null
  return new Dec(cleaned).greaterThan(0) ? cleaned : null
}

/** One base unit per unit of the order line (the line's own ratio: base quantity ÷ quantity). */
const lineRatio = (line: ExpectedLine) => {
  const quantity = new Dec(line.quantity)
  return quantity.isZero() ? new Dec(1) : new Dec(line.baseQuantity).dividedBy(quantity)
}

/** A hide's area in the material's base unit (null: no area yet, or a unit that does not turn into the base unit). */
export function hideBaseArea(hide: Pick<HideDraft, 'area' | 'areaUom'>, baseUom: Uom): Decimal | null {
  const area = typedDecimal(hide.area)
  if (area === null) return null
  const ratio = fixedRatio(hide.areaUom, baseUom)
  return ratio === null ? null : new Dec(area).times(ratio.toString())
}

/** What a line brings, in the base unit, as the form stands (four decimals; leather: the hides' areas summed). */
export function lineBase(draft: ReceiveLineDraft): Decimal {
  const { line } = draft
  if (line.item.tracking === 'HIDE') {
    return draft.lots.reduce<Decimal>((sum, lot) => lot.hides.reduce<Decimal>((inner, hide) => inner.plus(hideBaseArea(hide, line.item.baseUom) ?? 0), sum), new Dec(0)).toDecimalPlaces(4)
  }
  if (line.item.tracking === 'LOT') {
    return draft.lots.reduce<Decimal>((sum, lot) => sum.plus(new Dec(typedDecimal(lot.quantity) ?? 0).times(lineRatio(line))), new Dec(0)).toDecimalPlaces(4)
  }
  return new Dec(typedDecimal(draft.quantity) ?? 0).times(lineRatio(line)).toDecimalPlaces(4)
}

/** The line against what it expects, with its tolerance (the API's own rule: factory-domain lineDifference). */
export function lineDiff(draft: ReceiveLineDraft): LineDifference {
  return lineDifference({ expected: draft.line.expected, receivedBefore: draft.line.received, receiving: lineBase(draft).toFixed(4), tolerancePct: draft.line.tolerancePct })
}

/** Hides of a line (all its lots), the ones with an area, and the line's hide estimate still open. */
export function hideCounts(draft: ReceiveLineDraft): { rows: number; measured: number } {
  const hides = draft.lots.flatMap((lot) => lot.hides)
  return { rows: hides.length, measured: hides.filter((hide) => typedDecimal(hide.area) !== null).length }
}

export type ReceiveCheck = { id: string; state: 'ok' | 'blocked' | 'warning'; words: Phrase }

/**
 * What holds "Post receipt", in words, beside the lines (design rc-post ReadinessChecklist): something to receive; every
 * included line has a quantity — leather lines a measured area on every hide row, lot lines a quantity in every lot; a
 * held lot has its reason; more than the tolerance allows has the reason it is taken. The supplier's DDT is a warning
 * only (the API notes it, never refuses it).
 */
export function receiveChecks(draft: ReceiveDraft): ReceiveCheck[] {
  const included = draft.lines.filter((line) => line.include)
  const checks: ReceiveCheck[] = []
  checks.push(included.length > 0 ? { id: 'something', state: 'ok', words: phrase('rc.check.lines', { count: included.length }) } : { id: 'something', state: 'blocked', words: phrase('rc.check.noLine') })
  for (const entry of included) {
    const seq = entry.line.seq
    const tracking = entry.line.item.tracking
    if (tracking === 'HIDE') {
      const counts = hideCounts(entry)
      if (counts.rows === 0) checks.push({ id: `hides-${seq}`, state: 'blocked', words: phrase('rc.check.noHide', { seq }) })
      else if (counts.measured < counts.rows) checks.push({ id: `hides-${seq}`, state: 'blocked', words: phrase('rc.check.hideArea', { seq, count: counts.rows - counts.measured }) })
      else checks.push({ id: `hides-${seq}`, state: 'ok', words: phrase('rc.check.hidesOk', { seq, count: counts.rows }) })
      if (entry.lots.some((lot) => lot.hides.length === 0)) checks.push({ id: `emptyLot-${seq}`, state: 'blocked', words: phrase('rc.check.emptyLot', { seq }) })
      if (entry.lots.some((lot) => lot.hides.some((hide) => hide.thicknessMm.trim() && typedDecimal(hide.thicknessMm) === null))) checks.push({ id: `thickness-${seq}`, state: 'blocked', words: phrase('rc.check.thickness', { seq }) })
      if (entry.line.oneDyeBatch && new Set(entry.lots.map((lot) => lot.dyeBatch.trim()).filter(Boolean)).size > 1) checks.push({ id: `dye-${seq}`, state: 'warning', words: phrase('rc.check.dyeBatches', { seq }) })
    } else if (tracking === 'LOT') {
      if (entry.lots.length === 0) checks.push({ id: `lots-${seq}`, state: 'blocked', words: phrase('rc.check.noLot', { seq }) })
      else if (entry.lots.some((lot) => typedDecimal(lot.quantity) === null)) checks.push({ id: `lots-${seq}`, state: 'blocked', words: phrase('rc.check.lotQuantity', { seq }) })
      else checks.push({ id: `lots-${seq}`, state: 'ok', words: phrase('rc.check.lotsOk', { seq, count: entry.lots.length }) })
    } else if (typedDecimal(entry.quantity) === null) {
      checks.push({ id: `quantity-${seq}`, state: 'blocked', words: phrase('rc.check.quantity', { seq }) })
    }
    if (entry.lots.some((lot) => lot.hold && !lot.holdReason.trim())) checks.push({ id: `hold-${seq}`, state: 'blocked', words: phrase('rc.check.holdReason', { seq }) })
    const diff = lineDiff(entry)
    if (diff.kind === 'OVER' && new Dec(diff.receiving).greaterThan(0)) {
      checks.push(entry.differenceReason.trim() ? { id: `over-${seq}`, state: 'warning', words: phrase('rc.check.overReason', { seq }) } : { id: `over-${seq}`, state: 'blocked', words: phrase('rc.check.over', { seq }) })
    }
  }
  checks.push(draft.ddtNumber.trim() && draft.ddtDate ? { id: 'ddt', state: 'ok', words: phrase('rc.check.ddt') } : { id: 'ddt', state: 'warning', words: phrase('rc.check.noDdt') })
  return checks
}

export const postHeld = (checks: readonly ReceiveCheck[]): Phrase | null => checks.find((check) => check.state === 'blocked')?.words ?? null

const text = (value: string): string | undefined => (value.trim() ? value.trim() : undefined)

/** Local "yyyy-mm-ddThh:mm" in a zone → the instant (the API takes UTC); empty → none (the API takes now). */
export function instantOf(local: string, timeZone: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return undefined
  const asUtc = new Date(`${local}:00Z`)
  const zoned = new Date(asUtc.toLocaleString('en-US', { timeZone }))
  const utc = new Date(asUtc.toLocaleString('en-US', { timeZone: 'UTC' }))
  return new Date(asUtc.getTime() - (zoned.getTime() - utc.getTime())).toISOString()
}

/** The body the API takes for the form as it stands (included lines only; empty fields left out). */
export function receiptBody(draft: ReceiveDraft, timeZone: string): ReceiptBody {
  const lines: LineBody[] = draft.lines
    .filter((entry) => entry.include)
    .map((entry) => {
      const { line } = entry
      const base: LineBody = { purchaseOrderLineId: line.purchaseOrderLineId, ...(text(entry.differenceReason) ? { differenceReason: text(entry.differenceReason) } : {}), ...(text(entry.note) ? { note: text(entry.note) } : {}) }
      if (line.item.tracking === 'HIDE' || line.item.tracking === 'LOT') {
        base.lots = entry.lots.map((lot) => ({
          ...(text(lot.supplierLotRef) ? { supplierLotRef: text(lot.supplierLotRef) } : {}),
          ...(text(lot.dyeBatch) ? { dyeBatch: text(lot.dyeBatch) } : {}),
          ...(text(lot.shade) ? { shade: text(lot.shade) } : {}),
          ...(lot.hold && text(lot.holdReason) ? { holdReason: text(lot.holdReason) } : {}),
          ...(line.item.tracking === 'LOT' ? { quantity: typedDecimal(lot.quantity) ?? lot.quantity.trim() } : {}),
          ...(line.item.tracking === 'HIDE'
            ? {
                hides: lot.hides.map((hide) => ({
                  area: typedDecimal(hide.area) ?? hide.area.trim(),
                  areaUom: hide.areaUom,
                  ...(text(hide.supplierCode) ? { supplierCode: text(hide.supplierCode) } : {}),
                  ...(text(hide.grade) ? { grade: text(hide.grade) } : {}),
                  ...(text(hide.shade) ? { shade: text(hide.shade) } : {}),
                  ...(text(hide.thicknessMm) ? { thicknessMm: typedDecimal(hide.thicknessMm) ?? hide.thicknessMm.trim() } : {}),
                  ...(text(hide.defects) ? { defects: text(hide.defects) } : {}),
                })),
              }
            : {}),
        }))
      } else {
        base.quantity = typedDecimal(entry.quantity) ?? entry.quantity.trim()
      }
      return base
    })
  const receivedAt = instantOf(draft.receivedAt, timeZone)
  return {
    purchaseOrderId: draft.orderId,
    ...(text(draft.ddtNumber) ? { supplierDdtNumber: text(draft.ddtNumber) } : {}),
    ...(draft.ddtDate ? { supplierDdtDate: draft.ddtDate } : {}),
    ...(receivedAt ? { receivedAt } : {}),
    ...(text(draft.note) ? { note: text(draft.note) } : {}),
    lines,
  }
}

/** The hide fields a pasted column can fill, in the sheet's order. */
export const HIDE_COLUMNS = ['supplierCode', 'area', 'grade', 'thicknessMm', 'shade', 'defects'] as const
export type HideColumn = (typeof HIDE_COLUMNS)[number]

/**
 * A paste into a hide cell: one value per line of the clipboard (a column from a spreadsheet; a tab-separated row fills
 * the columns to the right). The hides from `row` down take the values; new rows are added as needed.
 */
export function pasteHides(hides: readonly HideDraft[], row: number, column: HideColumn, clipboard: string, make: () => HideDraft): HideDraft[] {
  const rows = clipboard.replace(/\r/g, '').split('\n').filter((line, index, all) => line.trim() !== '' || index < all.length - 1)
  if (rows.length <= 1 && !clipboard.includes('\t')) return [...hides]
  const next = [...hides]
  const start = HIDE_COLUMNS.indexOf(column)
  rows.forEach((line, offset) => {
    const at = row + offset
    while (next.length <= at) next.push(make())
    const values = line.split('\t')
    const hide = { ...next[at]! }
    values.forEach((value, index) => {
      const field = HIDE_COLUMNS[start + index]
      if (field) hide[field] = field === 'area' || field === 'thicknessMm' ? value.trim().replace(',', '.') : value.trim()
    })
    next[at] = hide
  })
  return next
}

/** How many moves a reversal posts (one per hide, per lot, or per untracked line: the receipt's own moves). */
export function reversalMoves(receipt: Pick<Receipt, 'lines'>): number {
  return receipt.lines.reduce((sum, line) => sum + (line.item.tracking === 'HIDE' ? line.lots.reduce((inner, lot) => inner + lot.hideCount, 0) : line.item.tracking === 'LOT' ? line.lots.length : 1), 0)
}

// ---- the page models --------------------------------------------------------------------------------------------------------

export interface ReceiptsListModel {
  prefix: string
  can: BuyingCan
  view: ReceiptView
  q: string
  rows: { items: ReceiptRow[] | null; more: boolean; problem: string | null }
  expected: { items: ExpectedLine[] | null; problem: string | null }
  counts: ReceiptCounts | null
  asOf: string | null
  live: LiveState
  updates: number
  notice: { tone: 'success' | 'danger' | 'info'; words: Phrase } | null
  selected?: readonly string[]
  focusRow?: number
  helpOpen?: boolean
  timeZone?: string
  /** B-W2a-63: the tannery hide list (Import hide list on the band, its totals after). */
  hideList?: HideListModel
}

export interface ReceiptsListActions {
  onView?: (view: ReceiptView) => void
  onSearch?: (q: string) => void
  onMore?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string) => void
  onReceive?: (orderId: string | null, lineIds?: string[]) => void
  onExport?: (ids: string[]) => void
  onDismissNotice?: () => void
  hideList?: HideListActions
}

export interface ReceiveModel {
  prefix: string
  can: BuyingCan
  /** The orders that take goods (no `?order=` yet: pick one). */
  orders: Loaded<ExpectedLine[]>
  draft: ReceiveDraft | null
  posting: boolean
  problem: Phrase | null
  result: Recorded | null
  timeZone?: string
  today?: string
}

export interface ReceiveActions {
  onPickOrder?: (orderId: string) => void
  onChange?: (draft: ReceiveDraft) => void
  onPost?: () => void
  onRetry?: () => void
  onAnother?: () => void
}

/** B-W2a-63 adds Documents check (the DDT photo, Request from supplier) and Discrepancies, in the design's order. */
export type ReceiptTab = 'lines' | 'lots' | 'documents' | 'discrepancies' | 'activity'
export const RECEIPT_TABS: readonly ReceiptTab[] = Object.freeze(['lines', 'lots', 'documents', 'discrepancies', 'activity'])
/** The tabs whose words are the `warehouse-receipts` catalogue's (W2a). */
export const DAILY_TABS: readonly ReceiptTab[] = Object.freeze(['documents', 'discrepancies'])
export const receiptTabOf = (value: string | null | undefined): ReceiptTab => ((RECEIPT_TABS as readonly string[]).includes(value ?? '') ? (value as ReceiptTab) : 'lines')

export interface ReceiptRecordModel {
  prefix: string
  can: BuyingCan
  tab: ReceiptTab
  receipt: Loaded<Receipt>
  lots: Part<LotWithHides[]>
  live: LiveState
  dockOpen: boolean
  changed: { at: string } | null
  notice: { tone: 'success' | 'danger' | 'info'; words: Phrase } | null
  /** The notes the post answered (the receiving page hands them over once). */
  notes: Recorded['notes'] | null
  busy: boolean
  dialog: { kind: 'reverse'; reason: string } | null
  dialogProblem: Phrase | null
  panelsPreview?: RecordPanelsViewModel
  selected?: readonly string[]
  timeZone?: string
  /** B-W2a-63: discrepancies, the report, the DDT photo, Request from supplier (absent: the W1 tabs only). */
  daily?: ReceiptDailyModel
}

export interface ReceiptRecordActions {
  onRetry?: () => void
  onReload?: () => void
  onDock?: () => void
  onDialog?: (dialog: ReceiptRecordModel['dialog']) => void
  onReverse?: () => void
  onDismissNotice?: () => void
  onRetryLots?: () => void
  onExportHides?: (ids: string[]) => void
  daily?: ReceiptDailyActions
}
