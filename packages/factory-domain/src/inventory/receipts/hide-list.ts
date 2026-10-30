import type { Uom } from '../../product/units/units'
import { cell, type CellValue } from '../../imports/cells'
import { defineImporter, type ExistingRecord, type RecordValues, type RowIssue, type RowPlan, type RowValues } from '../../imports/importer'
import { Dec, ZERO, type Decimal } from '../../tax/decimal'
import { QUANTITY_SCALE } from '../ledger/moves'
import { lineDifference, MAX_THICKNESS_MM, RECEIPT_LIMITS, type LineDifference } from './rules'

/**
 * The tannery's hide list (B-W2a-31; SCM-248; design warehouse.receipts rec "Lots & hides" › rc-hides "Import the
 * tannery's hide list (ImportFlow, totals compared with PO …)"), pure: a CSV or Excel sheet with one row per hide — the
 * tannery's number, the measured area and its unit, grade, thickness, shade, defects, the dye batch (one lot per dye
 * batch and supplier lot) — for ONE of our purchase orders, received as ONE goods receipt. The import engine
 * (platform/imports) reads, maps and checks it in a dry run first; its apply records the receipt in one command
 * (apps/factory-api modules/inventory/receipts/hide-list.ts, through the same work as POST /inventory/receipts).
 *
 * This is the generic layout (Italian and English headers, any order). A tannery's own layout (Q29) is an alias list
 * added here once a sample file arrives; until then the person maps its headers in the import screen.
 *
 * Key: the order and the tannery's number on the hide. A hide of the list received on the order before (by an earlier
 * import or typed at the dock with its tannery number) is UNCHANGED when the area is the same, else an error: a hide is
 * never received twice. So a list re-imported after a partial delivery receives only the rest.
 */

export const HIDE_LIST_IMPORTER_KEY = 'inventory.hideList'

/** One list is one delivery: one receipt posts at most this many hides. */
export const HIDE_LIST_LIMITS = Object.freeze({ rows: RECEIPT_LIMITS.moves, code: RECEIPT_LIMITS.code })

const AREA_ALIASES = { m2: 'M2', mq: 'M2', 'm²': 'M2', 'metri quadri': 'M2', 'square metres': 'M2', ft2: 'FT2', 'ft²': 'FT2', sqft: 'FT2', 'sq ft': 'FT2', piedi: 'FT2', 'piedi quadri': 'FT2', 'square feet': 'FT2', dm2: 'DM2', 'dm²': 'DM2', dmq: 'DM2' } as const satisfies Record<string, Uom>

const code = () => cell.code({ max: HIDE_LIST_LIMITS.code, upper: true })
/** A number as written (a purchase order's, the tannery's): matched without regard to case by the API. */
const number = () => cell.code({ max: HIDE_LIST_LIMITS.code })

export const hideListImporter = defineImporter({
  key: HIDE_LIST_IMPORTER_KEY,
  label: "Tannery's hide list",
  description: "The tannery's list of the hides of a delivery, one row per hide, for one of our purchase orders: the import receives them as one goods receipt (lots by dye batch, hides one by one with their areas). Check the totals against the order in the dry run first.",
  columns: {
    order: { label: 'Purchase order', aliases: ['ordine', 'numero ordine', 'n ordine', 'nostro ordine', 'rif ordine', 'vs ordine', 'po', 'po number', 'order', 'order number'], required: true, type: number(), description: 'Our purchase order number (PO-2026-0042): every row of one list names the same order.' },
    tanneryNumber: { label: 'Tannery number', aliases: ['numero pelle', 'n pelle', 'pelle', 'numero conceria', 'n conceria', 'cartellino', 'hide', 'hide number', 'hide no', 'tannery no', 'tag'], required: true, type: number(), description: "The tannery's own number on the hide: unique on the order." },
    area: { label: 'Area', aliases: ['superficie', 'misura', 'metratura', 'mq pelle', 'measured area', 'size'], required: true, type: cell.decimal({ precision: 18, scale: QUANTITY_SCALE, min: '0' }), description: 'The measured area, above 0.' },
    unit: { label: 'Unit', aliases: ['um', 'u m', 'unita', 'unita di misura', 'uom', 'area unit'], type: cell.oneOf(['M2', 'DM2', 'FT2'] as const, AREA_ALIASES), description: 'M2, DM2 or FT2; blank: the order line\'s area unit.' },
    line: { label: 'Order line', aliases: ['riga', 'riga ordine', 'n riga', 'order line no', 'po line'], type: cell.integer({ min: 1, max: 9_999 }), description: "The order line's number (10, 20 …); blank: the order's one leather line." },
    article: { label: 'Article', aliases: ['articolo', 'codice articolo', 'materiale', 'article code', 'material', 'item'], type: code(), description: "Our material's code, or the supplier's article code on the order line: picks the order line when Order line is blank." },
    dyeBatch: { label: 'Dye batch', aliases: ['bagno', 'partita', 'bagno colore', 'bagno di tintura', 'dye lot', 'batch'], type: code(), description: 'The tannery\'s dye batch (one shade): the hides of one batch make one lot.' },
    supplierLotRef: { label: 'Supplier lot', aliases: ['lotto', 'lotto fornitore', 'supplier lot no', 'lot'], type: code() },
    grade: { label: 'Grade', aliases: ['scelta', 'selezione', 'qualita', 'selection'], type: cell.text({ max: 40 }) },
    thicknessMm: { label: 'Thickness (mm)', aliases: ['spessore', 'spessore mm', 'thickness', 'thickness mm'], type: cell.decimal({ precision: 6, scale: 2, min: '0' }) },
    shade: { label: 'Shade', aliases: ['tonalita', 'tono', 'sfumatura', 'nuance'], type: cell.text({ max: 60 }) },
    defects: { label: 'Defects', aliases: ['difetti', 'note pelle', 'hide notes'], type: cell.text({ max: 1000 }) },
    ddtNumber: { label: 'Delivery note', aliases: ['ddt', 'numero ddt', 'n ddt', 'documento di trasporto', 'delivery note number', 'dn'], type: cell.text({ max: RECEIPT_LIMITS.code }), description: "The tannery's DDT number: the same on every row (or blank)." },
    ddtDate: { label: 'Delivery note date', aliases: ['data ddt', 'data documento', 'ddt date', 'dn date'], type: cell.date() },
    location: { label: 'Location', aliases: ['ubicazione', 'codice ubicazione', 'location code', 'bin'], type: code(), description: "Where the hides go: a location of the order's site (the same on every row); blank: its goods-in dock." },
    differenceReason: { label: 'Difference reason', aliases: ['motivo differenza', 'motivo', 'reason for the difference'], type: cell.text({ max: RECEIPT_LIMITS.text }), description: "Why more than the order line's tolerance is taken (needed only then)." },
  },
  keyColumns: ['order', 'tanneryNumber'],
  maxRows: HIDE_LIST_LIMITS.rows,
  // One list is one receipt: its apply is ONE batch (one command).
  batchSize: HIDE_LIST_LIMITS.rows,
  validateRow: (values: RowValues): RowIssue[] => {
    const issues: RowIssue[] = []
    if (values.area !== undefined && new Dec(String(values.area)).lessThanOrEqualTo(0)) issues.push({ column: 'area', message: 'A hide has an area above 0.' })
    if (values.thicknessMm !== undefined && new Dec(String(values.thicknessMm)).greaterThan(MAX_THICKNESS_MM)) issues.push({ column: 'thicknessMm', message: `At most ${MAX_THICKNESS_MM} mm.` })
    if (values.thicknessMm !== undefined && new Dec(String(values.thicknessMm)).lessThanOrEqualTo(0)) issues.push({ column: 'thicknessMm', message: 'Above 0.' })
    return issues
  },
  plan: (values, existing) => planHide(values, existing),
})

// ---- a hide received before ------------------------------------------------------------------------------------------------

const RECEIVED = '$received'

/** What a hide of the order received before holds (the adapter's load answers it beside the columns). */
export interface ReceivedHide {
  readonly receiptNumber: string
  readonly tag: string
  readonly area: string
  readonly unit: Uom
}

export function receivedHideValues(order: string, tanneryNumber: string, received: ReceivedHide): RecordValues {
  return { order, tanneryNumber, area: new Dec(received.area).toString(), unit: received.unit, [RECEIVED]: JSON.stringify(received) }
}

const receivedOf = (existing: ExistingRecord): ReceivedHide | null => {
  const raw = existing.values[RECEIVED]
  return typeof raw === 'string' ? (JSON.parse(raw) as ReceivedHide) : null
}

/** A new hide is a CREATE (its facts are the adapter's check); one received before is UNCHANGED with the same area, else an error. */
export function planHide(values: RowValues, existing: ExistingRecord | null): RowPlan {
  if (existing === null) return { action: 'CREATE', after: values }
  const received = receivedOf(existing)
  const sameArea = received !== null && new Dec(received.area).equals(new Dec(String(values.area))) && (values.unit === undefined || values.unit === received.unit)
  if (sameArea) return { action: 'UNCHANGED' }
  return {
    action: 'ERROR',
    errors: [
      {
        column: 'tanneryNumber',
        message: `Hide ${String(values.tanneryNumber)} was received on this order before${received ? ` (${received.receiptNumber}, tag ${received.tag}, ${received.area} ${received.unit})` : ''} with another area: a hide is never received twice. Reverse that receipt to receive it again, or fix the list.`,
      },
    ],
  }
}

// ---- the rows as one receipt -----------------------------------------------------------------------------------------------

/** An open leather line of the order, as the list's rows find it. */
export interface HideListOrderLine {
  readonly id: string
  readonly seq: number
  readonly itemCode: string
  readonly supplierArticleCode: string | null
  readonly uom: Uom
  /** The material is leather (tracked by HIDE). */
  readonly leather: boolean
  /** Expected, received before and tolerance, in the base unit (for the totals). */
  readonly expected: string
  readonly received: string
  readonly tolerancePct: string | null
  readonly baseUom: Uom
}

/** A row of the list as the check reads it (its number in the sheet and its values). */
export interface HideListRow {
  readonly rowNumber: number
  readonly values: RowValues
}

const text = (value: CellValue | undefined): string | null => (value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim())

/** The order line a row names: its seq, else its article (our code or the supplier's), else the order's one leather line. */
export function lineOfRow(values: RowValues, lines: readonly HideListOrderLine[]): { readonly line: HideListOrderLine; readonly problem?: undefined } | { readonly problem: RowIssue } {
  const leather = lines.filter((line) => line.leather)
  if (values.line !== undefined) {
    const line = lines.find((entry) => entry.seq === Number(values.line))
    if (!line) return { problem: { column: 'line', message: `The order has no line ${String(values.line)}.` } }
    if (!line.leather) return { problem: { column: 'line', message: `Order line ${line.seq} (${line.itemCode}) is not leather: it is not received hide by hide.` } }
    return { line }
  }
  const article = text(values.article)?.toUpperCase() ?? null
  if (article !== null) {
    const found = leather.filter((line) => line.itemCode.toUpperCase() === article || line.supplierArticleCode?.toUpperCase() === article)
    if (found.length === 1) return { line: found[0]! }
    if (found.length === 0) return { problem: { column: 'article', message: `No leather line of the order is article ${article}: give the order line.` } }
    return { problem: { column: 'line', message: `Several leather lines of the order are article ${article}: give the order line.` } }
  }
  if (leather.length === 1) return { line: leather[0]! }
  return { problem: { column: 'line', message: leather.length === 0 ? 'The order has no open leather line.' : 'The order has several leather lines: give the order line (or the article) on each row.' } }
}

/** The rows' problems among themselves: one order per list, one DDT, each tannery number once. */
export function listProblems(rows: readonly HideListRow[]): RowIssue[][] {
  const answers = rows.map((): RowIssue[] => [])
  const firstOrder = rows.length > 0 ? String(rows[0]!.values.order) : null
  const seen = new Map<string, number>()
  const ddt = rows.map((row) => text(row.values.ddtNumber)).find((value) => value !== null) ?? null
  const ddtDate = rows.map((row) => text(row.values.ddtDate)).find((value) => value !== null) ?? null
  rows.forEach((row, index) => {
    const order = String(row.values.order)
    if (order !== firstOrder) answers[index]!.push({ column: 'order', message: `One list is one delivery: the list is for ${firstOrder}, this row names ${order}. Import each order's hides apart.` })
    const key = `${order}|${String(row.values.tanneryNumber)}`
    const before = seen.get(key)
    if (before !== undefined) answers[index]!.push({ column: 'tanneryNumber', message: `Hide ${String(row.values.tanneryNumber)} is on the list twice (row ${before} too).` })
    else seen.set(key, row.rowNumber)
    const ownDdt = text(row.values.ddtNumber)
    if (ownDdt !== null && ddt !== null && ownDdt !== ddt) answers[index]!.push({ column: 'ddtNumber', message: `One list is one delivery note: ${ddt} on an earlier row, ${ownDdt} here.` })
    const location = rows.map((entry) => text(entry.values.location)).find((value) => value !== null) ?? null
    const ownLocation = text(row.values.location)
    if (ownLocation !== null && location !== null && ownLocation !== location) answers[index]!.push({ column: 'location', message: `One list goes to one place: ${location} on an earlier row, ${ownLocation} here.` })
    const ownDate = text(row.values.ddtDate)
    if (ownDate !== null && ddtDate !== null && ownDate !== ddtDate) answers[index]!.push({ column: 'ddtDate', message: `One delivery note has one date: ${ddtDate} on an earlier row, ${ownDate} here.` })
  })
  return answers
}

/** What a list brings to one order line against what it expects (the totals of the dry run). */
export interface HideListTotal {
  readonly line: HideListOrderLine
  readonly hides: number
  /** In the base unit. */
  readonly baseArea: string
  readonly lots: number
  readonly difference: LineDifference
  /** Beyond the tolerance over: the rows must give the reason. */
  readonly needsReason: boolean
}

/** The totals per order line: the rows' base areas (the API converts each hide) against expected and received before. */
export function hideListTotals(rows: readonly { readonly line: HideListOrderLine; readonly baseArea: Decimal; readonly lotKey: string; readonly differenceReason: string | null }[]): HideListTotal[] {
  const byLine = new Map<string, { line: HideListOrderLine; base: Decimal; hides: number; lots: Set<string>; reason: boolean }>()
  for (const row of rows) {
    const entry = byLine.get(row.line.id) ?? { line: row.line, base: ZERO, hides: 0, lots: new Set<string>(), reason: false }
    entry.base = entry.base.plus(row.baseArea)
    entry.hides += 1
    entry.lots.add(row.lotKey)
    entry.reason ||= row.differenceReason !== null
    byLine.set(row.line.id, entry)
  }
  return [...byLine.values()]
    .sort((a, b) => a.line.seq - b.line.seq)
    .map((entry) => {
      const difference = lineDifference({ expected: entry.line.expected, receivedBefore: entry.line.received, receiving: entry.base, tolerancePct: entry.line.tolerancePct })
      return { line: entry.line, hides: entry.hides, baseArea: entry.base.toFixed(QUANTITY_SCALE), lots: entry.lots.size, difference, needsReason: difference.kind === 'OVER' && !entry.reason }
    })
}

/** The lot a row's hide joins: its dye batch and supplier lot (blank: one lot for the rest of the line). */
export const lotKeyOf = (values: RowValues): string => `${text(values.dyeBatch) ?? ''}|${text(values.supplierLotRef) ?? ''}`

/** The receipt body the list makes (POST /inventory/receipts' shape): its lines, lots by dye batch and hides in row order. */
export function hideListBody(rows: readonly { readonly line: HideListOrderLine; readonly values: RowValues }[], header: { readonly purchaseOrderId: string; readonly locationId?: string | undefined }) {
  const lines = new Map<string, { line: HideListOrderLine; lots: Map<string, { dyeBatch: string | null; supplierLotRef: string | null; shade: string | null; hides: { supplierCode: string; area: string; areaUom?: Uom; grade: string | null; shade: string | null; thicknessMm: string | null; defects: string | null }[] }>; reason: string | null }>()
  for (const row of rows) {
    const entry = lines.get(row.line.id) ?? { line: row.line, lots: new Map(), reason: null }
    const key = lotKeyOf(row.values)
    const lot = entry.lots.get(key) ?? { dyeBatch: text(row.values.dyeBatch), supplierLotRef: text(row.values.supplierLotRef), shade: text(row.values.shade), hides: [] }
    lot.hides.push({
      supplierCode: String(row.values.tanneryNumber),
      area: String(row.values.area),
      ...(row.values.unit !== undefined ? { areaUom: row.values.unit as Uom } : {}),
      grade: text(row.values.grade),
      shade: text(row.values.shade),
      thicknessMm: text(row.values.thicknessMm),
      defects: text(row.values.defects),
    })
    entry.lots.set(key, lot)
    entry.reason ??= text(row.values.differenceReason)
    lines.set(row.line.id, entry)
  }
  const ddtNumber = rows.map((row) => text(row.values.ddtNumber)).find((value) => value !== null) ?? null
  const ddtDate = rows.map((row) => text(row.values.ddtDate)).find((value) => value !== null) ?? null
  return {
    purchaseOrderId: header.purchaseOrderId,
    ...(header.locationId ? { locationId: header.locationId } : {}),
    supplierDdtNumber: ddtNumber,
    supplierDdtDate: ddtDate,
    lines: [...lines.values()]
      .sort((a, b) => a.line.seq - b.line.seq)
      .map((entry) => ({
        purchaseOrderLineId: entry.line.id,
        lots: [...entry.lots.values()].map((lot) => ({ supplierLotRef: lot.supplierLotRef, dyeBatch: lot.dyeBatch, shade: lot.shade, hides: lot.hides })),
        ...(entry.reason ? { differenceReason: entry.reason } : {}),
      })),
  }
}
