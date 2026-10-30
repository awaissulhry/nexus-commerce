import { HIDE_AREA_UNITS, lineDifference, type LineDifference } from '@nexus/factory-domain/inventory/receipts/rules'
import { fixedRatio, type Uom } from '@nexus/factory-domain/product/units/units'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { FloorReceipt, OrderLine, OrderToReceive, TagJob } from './api'

/**
 * Receive goods (SCR-092) — the screen's rules, pure: the delivery as the tablet holds it until it is posted (per order
 * line: hides one by one in lots by dye batch, lots with a quantity, or a quantity), the hide being entered (grade,
 * thickness, dye batch and shade stay from the last hide; only the area and the tannery's number change most of the
 * time), the running totals against what the line expects and its tolerance (factory-domain `lineDifference`, the API's
 * own rule), what holds a lot for quality, the summary before posting, the body the API takes, and each tag's print state.
 * Quantities of lots and untracked lines are entered in the material's base unit (the unit the order line's expected,
 * received and open figures come in); a hide's area in the order line's area unit.
 */

export type Tracking = OrderLine['item']['tracking']

/** Defects seen on a hide (design "defect tiles"), kept on the hide as plain English words the office reads. */
export const DEFECTS = {
  hole: 'hole',
  scar: 'scar',
  brand: 'brand mark',
  wrinkle: 'wrinkle',
} as const
export type DefectCode = keyof typeof DEFECTS
export const DEFECT_CODES = Object.keys(DEFECTS) as DefectCode[]

/** A hide's grade tiles (design "grade tiles (A, B, C, D)"). */
export const GRADES = ['A', 'B', 'C', 'D'] as const

/** Why the receiver holds a lot for a quality check (the lot's holdReason: plain English, as the office lists read it). */
export const HOLD_REASONS = {
  damaged: 'Damaged on arrival',
  looksWrong: 'Looks different from the order',
  packaging: 'Packaging opened or wet',
  other: 'Held for a quality check',
} as const
export type HoldCode = keyof typeof HOLD_REASONS
export const HOLD_CODES = Object.keys(HOLD_REASONS) as HoldCode[]

/** Why more than the order line allows is taken (the line's differenceReason). */
export const OVER_REASONS = {
  supplierSent: 'The supplier sent more than ordered',
  keepForNext: 'Kept for the next order',
  buyerAgreed: 'Agreed with the buyer',
} as const
export type OverCode = keyof typeof OVER_REASONS
export const OVER_CODES = Object.keys(OVER_REASONS) as OverCode[]

export interface HideEntry {
  readonly key: string
  /** Entry order across the line (Undo takes the highest). */
  readonly n: number
  readonly supplierCode: string | null
  /** In `areaUom`. */
  readonly area: number
  readonly areaUom: string
  readonly grade: string | null
  readonly thicknessMm: number | null
  readonly shade: string | null
  readonly defects: readonly DefectCode[]
}

export interface LotEntry {
  readonly key: string
  readonly n: number
  readonly dyeBatch: string | null
  readonly supplierLotRef: string | null
  /** A lot-tracked material: how much came, in the base unit. */
  readonly quantity: number | null
  readonly hold: HoldCode | null
  readonly hides: readonly HideEntry[]
}

export interface LineEntry {
  readonly lineId: string
  readonly lots: readonly LotEntry[]
  /** An untracked material: how much came, in the base unit. */
  readonly quantity: number | null
  readonly over: OverCode | null
}

export interface Delivery {
  readonly orderId: string
  readonly version: number
  /** The supplier's delivery note number (scanned or typed), or null. */
  readonly ddtNumber: string | null
  readonly entries: Readonly<Record<string, LineEntry>>
}

/** The hide on the pad now. */
export interface HideForm {
  readonly supplierCode: string | null
  readonly area: number | null
  readonly grade: string | null
  readonly thicknessMm: number | null
  readonly dyeBatch: string | null
  readonly shade: string | null
  readonly defects: readonly DefectCode[]
  readonly hold: HoldCode | null
  /** What the pad types: the area (default) or the thickness. */
  readonly pad: 'area' | 'thickness'
  /** What a scan or typed code fills: the tannery's number (default), the dye batch or the shade. */
  readonly text: 'supplierCode' | 'dyeBatch' | 'shade'
}

/** A lot of a lot-tracked material, or the quantity of an untracked one, on the pad now. */
export interface QuantityForm {
  readonly quantity: number | null
  readonly supplierLotRef: string | null
  readonly hold: HoldCode | null
}

let counter = 0
const key = (prefix: string) => `${prefix}-${(++counter).toString(36)}`

const dec = (value: string | number | Decimal): Decimal => new Dec(value)
export const num = (value: string | number | Decimal): number => Number(dec(value).toFixed(4))

/** A pad number as the API takes it (at most four decimals). */
export function quantityText(value: number, decimals: number): string {
  return value.toFixed(Math.max(0, Math.min(4, decimals)))
}

const COUNT_UNITS = new Set(['PCS', 'PAIR', 'SET', 'HIDE', 'SIDE', 'ROLL', 'CONE', 'BOX'])
/** Decimals a quantity of this unit is counted in (whole pieces, else two). */
export const decimalsOf = (uom: string): number => (COUNT_UNITS.has(uom) ? 0 : 2)

// ---- units -----------------------------------------------------------------------------------------------------------------

/** The unit a hide of this line is measured in: the line's own area unit, else the base unit's, else m². */
export function hideUnitOf(line: Pick<OrderLine, 'areaUnits' | 'uom' | 'item'>): string {
  if (line.areaUnits[0]) return line.areaUnits[0]
  if ((HIDE_AREA_UNITS as readonly string[]).includes(line.uom)) return line.uom
  if ((HIDE_AREA_UNITS as readonly string[]).includes(line.item.baseUom)) return line.item.baseUom
  return 'M2'
}

/** `value` in `from` as `to` (null: the units do not convert). */
export function convert(value: Decimal, from: string, to: string): Decimal | null {
  const ratio = fixedRatio(from as Uom, to as Uom)
  return ratio === null ? null : value.times(ratio.toString())
}

// ---- the delivery ----------------------------------------------------------------------------------------------------------

export function emptyDelivery(order: OrderToReceive, ddtNumber: string | null = null): Delivery {
  return {
    orderId: order.order.id,
    version: order.order.version,
    ddtNumber,
    entries: {},
  }
}

export const emptyEntry = (lineId: string): LineEntry => ({
  lineId,
  lots: [],
  quantity: null,
  over: null,
})

export const entryOf = (delivery: Delivery, lineId: string): LineEntry => delivery.entries[lineId] ?? emptyEntry(lineId)

const withEntry = (delivery: Delivery, entry: LineEntry): Delivery => ({
  ...delivery,
  entries: { ...delivery.entries, [entry.lineId]: entry },
})

/** The first hide of a line: nothing carried over (the order line's grade, when it names one). */
export function firstHideForm(line: Pick<OrderLine, 'grade'>): HideForm {
  return {
    supplierCode: null,
    area: null,
    grade: line.grade && (GRADES as readonly string[]).includes(line.grade) ? line.grade : null,
    thicknessMm: null,
    dyeBatch: null,
    shade: null,
    defects: [],
    hold: null,
    pad: 'area',
    text: 'supplierCode',
  }
}

/** The next hide after a save: grade, thickness, dye batch, shade and the hold stay ("same as last"). */
export function nextHideForm(form: HideForm): HideForm {
  return {
    ...form,
    supplierCode: null,
    area: null,
    defects: [],
    pad: 'area',
    text: 'supplierCode',
  }
}

/** The hide form from the line's last hide (opening a line that has hides already, or after an Undo). */
export function formAfter(line: Pick<OrderLine, 'grade'>, entry: LineEntry): HideForm {
  const last = lastHide(entry)
  if (!last) return firstHideForm(line)
  return {
    ...firstHideForm(line),
    grade: last.hide.grade,
    thicknessMm: last.hide.thicknessMm,
    dyeBatch: last.lot.dyeBatch,
    shade: last.hide.shade,
    hold: last.lot.hold,
  }
}

const nOf = (entry: LineEntry) => Math.max(0, ...entry.lots.map((lot) => lot.n), ...entry.lots.flatMap((lot) => lot.hides.map((hide) => hide.n)))

export function lastHide(entry: LineEntry): { lot: LotEntry; hide: HideEntry } | null {
  let found: { lot: LotEntry; hide: HideEntry } | null = null
  for (const lot of entry.lots) for (const hide of lot.hides) if (!found || hide.n > found.hide.n) found = { lot, hide }
  return found
}

/** Why Save is held for this hide, or null (an area above 0 within the pad's range). */
export function hideProblem(form: HideForm): 'area' | null {
  return form.area === null || !(form.area > 0) ? 'area' : null
}

/** Saves the hide into the lot of its dye batch (a new dye batch starts a new lot; a lot's hold is the last asked). */
export function addHide(delivery: Delivery, line: OrderLine, form: HideForm): Delivery {
  if (hideProblem(form)) return delivery
  const entry = entryOf(delivery, line.id)
  const n = nOf(entry) + 1
  const hide: HideEntry = {
    key: key('h'),
    n,
    supplierCode: form.supplierCode,
    area: form.area!,
    areaUom: hideUnitOf(line),
    grade: form.grade,
    thicknessMm: form.thicknessMm,
    shade: form.shade,
    defects: form.defects,
  }
  const index = entry.lots.findIndex((lot) => (lot.dyeBatch ?? '') === (form.dyeBatch ?? ''))
  const lots =
    index >= 0
      ? entry.lots.map((lot, at) =>
          at === index
            ? {
                ...lot,
                hold: form.hold ?? lot.hold,
                hides: [...lot.hides, hide],
              }
            : lot,
        )
      : [
          ...entry.lots,
          {
            key: key('l'),
            n,
            dyeBatch: form.dyeBatch,
            supplierLotRef: null,
            quantity: null,
            hold: form.hold,
            hides: [hide],
          },
        ]
  return withEntry(delivery, { ...entry, lots })
}

/** Takes the line's last hide back (its lot goes when it was the only one). */
export function undoHide(delivery: Delivery, lineId: string): Delivery {
  const entry = entryOf(delivery, lineId)
  const last = lastHide(entry)
  if (!last) return delivery
  const lots = entry.lots
    .map((lot) =>
      lot.key === last.lot.key
        ? {
            ...lot,
            hides: lot.hides.filter((hide) => hide.key !== last.hide.key),
          }
        : lot,
    )
    .filter((lot) => lot.hides.length > 0 || lot.quantity !== null)
  return withEntry(delivery, { ...entry, lots })
}

/** Adds a lot of a lot-tracked material (its quantity in the base unit). */
export function addLot(delivery: Delivery, lineId: string, form: QuantityForm): Delivery {
  if (form.quantity === null || !(form.quantity > 0)) return delivery
  const entry = entryOf(delivery, lineId)
  const lot: LotEntry = {
    key: key('l'),
    n: nOf(entry) + 1,
    dyeBatch: null,
    supplierLotRef: form.supplierLotRef,
    quantity: form.quantity,
    hold: form.hold,
    hides: [],
  }
  return withEntry(delivery, { ...entry, lots: [...entry.lots, lot] })
}

export function undoLot(delivery: Delivery, lineId: string): Delivery {
  const entry = entryOf(delivery, lineId)
  if (entry.lots.length === 0) return delivery
  const last = entry.lots.reduce((top, lot) => (lot.n > top.n ? lot : top))
  return withEntry(delivery, {
    ...entry,
    lots: entry.lots.filter((lot) => lot.key !== last.key),
  })
}

/** An untracked material's quantity (null clears it). */
export function setQuantity(delivery: Delivery, lineId: string, quantity: number | null): Delivery {
  return withEntry(delivery, {
    ...entryOf(delivery, lineId),
    quantity: quantity !== null && quantity > 0 ? quantity : null,
  })
}

export function setOver(delivery: Delivery, lineId: string, over: OverCode | null): Delivery {
  return withEntry(delivery, { ...entryOf(delivery, lineId), over })
}

/** Something of this line is on the delivery. */
export function entered(entry: LineEntry | undefined): boolean {
  return Boolean(entry && (entry.quantity !== null || entry.lots.some((lot) => lot.quantity !== null || lot.hides.length > 0)))
}

// ---- totals --------------------------------------------------------------------------------------------------------------

/** What the line brings now, in the base unit (four decimals; leather: its hides' areas converted). */
export function receivingBase(line: OrderLine, entry: LineEntry): Decimal {
  if (line.item.tracking === 'HIDE') {
    return entry.lots
      .flatMap((lot) => lot.hides)
      .reduce<Decimal>((sum, hide) => sum.plus(convert(dec(hide.area), hide.areaUom, line.item.baseUom) ?? 0), dec(0))
      .toDecimalPlaces(4)
  }
  if (line.item.tracking === 'LOT') return entry.lots.reduce<Decimal>((sum, lot) => sum.plus(lot.quantity ?? 0), dec(0)).toDecimalPlaces(4)
  return dec(entry.quantity ?? 0).toDecimalPlaces(4)
}

/** The line against what it expects, with its tolerance (the API's own rule). */
export function differenceOf(line: OrderLine, entry: LineEntry): LineDifference {
  return lineDifference({
    expected: line.expected,
    receivedBefore: line.received,
    receiving: receivingBase(line, entry).toFixed(4),
    tolerancePct: line.tolerancePct,
  })
}

export interface HideTotals {
  readonly hides: number
  /** Hides the buyer expects still (estimate less those received before), or null. */
  readonly expectedHides: number | null
  /** In the hide unit. */
  readonly area: number
  readonly open: number
  readonly upTo: number
  readonly unit: string
}

/** The running totals of a leather line, in its hide unit (the base figures converted). */
export function hideTotals(line: OrderLine, entry: LineEntry): HideTotals {
  const unit = hideUnitOf(line)
  const hides = entry.lots.flatMap((lot) => lot.hides)
  const area = hides.reduce<Decimal>((sum, hide) => sum.plus(convert(dec(hide.area), hide.areaUom, unit) ?? 0), dec(0))
  const inUnit = (base: string) => convert(dec(base), line.item.baseUom, unit)
  const shown = inUnit('1') === null ? line.item.baseUom : unit
  const figure = (base: string) => num(inUnit(base) ?? dec(base))
  return {
    hides: hides.length,
    expectedHides: line.estimatedHides === null ? null : Math.max(0, line.estimatedHides - line.hidesReceived),
    area: num(area),
    open: figure(line.open),
    upTo: figure(line.upTo),
    unit: shown,
  }
}

/** The pad's range for a lot or a quantity, in the base unit: from a piece (or 0,01) up to a generous ceiling. */
export function quantityBounds(line: OrderLine): {
  min: number
  max: number
  decimals: number
  suggested: number
} {
  const decimals = decimalsOf(line.item.baseUom)
  const min = decimals === 0 ? 1 : 0.01
  const open = num(line.open)
  const ceiling = Math.max(num(line.expected) * 3, open, 1)
  return {
    min,
    max: Math.min(99_999, Math.ceil(ceiling)),
    decimals,
    suggested: open > 0 ? Number(open.toFixed(decimals)) : 0,
  }
}

export const AREA_BOUNDS = { min: 0.01, max: 999.99, decimals: 2 } as const
export const THICKNESS_BOUNDS = { min: 0.1, max: 99.99, decimals: 2 } as const

/** Why a lot of this line goes to quality hold: the line's own holds (Cr VI, PPE), the receiver's, or nothing. */
export function lotHolds(line: Pick<OrderLine, 'holds'>, hold: HoldCode | null): string[] {
  return [...line.holds, ...(hold ? ['QUALITY_HOLD'] : [])]
}

// ---- the summary before posting ---------------------------------------------------------------------------------------------

export interface LineSummary {
  readonly line: OrderLine
  readonly entry: LineEntry
  readonly difference: LineDifference
  readonly lots: number
  readonly hides: number
  readonly held: number
}

export interface DeliverySummary {
  readonly lines: readonly LineSummary[]
  readonly short: number
  readonly over: number
  readonly lots: number
  readonly hides: number
  readonly held: number
  /** Lines over their tolerance without a reason (Post waits for it). */
  readonly needReason: readonly string[]
}

export function deliverySummary(order: OrderToReceive, delivery: Delivery): DeliverySummary {
  const lines = order.lines
    .filter((line) => entered(delivery.entries[line.id]))
    .map((line) => {
      const entry = entryOf(delivery, line.id)
      const lots = line.item.tracking === 'HIDE' || line.item.tracking === 'LOT' ? entry.lots.length : 0
      const held = entry.lots.filter((lot) => lotHolds(line, lot.hold).length > 0).length
      return {
        line,
        entry,
        difference: differenceOf(line, entry),
        lots,
        hides: entry.lots.reduce((sum, lot) => sum + lot.hides.length, 0),
        held,
      }
    })
  return {
    lines,
    short: lines.filter((line) => line.difference.kind === 'SHORT').length,
    over: lines.filter((line) => line.difference.kind === 'OVER').length,
    lots: lines.reduce((sum, line) => sum + line.lots, 0),
    hides: lines.reduce((sum, line) => sum + line.hides, 0),
    held: lines.reduce((sum, line) => sum + line.held, 0),
    needReason: lines.filter((line) => line.difference.kind === 'OVER' && line.entry.over === null).map((line) => line.line.id),
  }
}

/** The receipt as the API takes it: the lines with something on them, each in its tracking's shape. */
export function receiveBody(order: OrderToReceive, delivery: Delivery, options: { printerId: string | null; language: 'it' | 'en' }) {
  const lines = order.lines
    .filter((line) => entered(delivery.entries[line.id]))
    .map((line) => {
      const entry = entryOf(delivery, line.id)
      const over = differenceOf(line, entry).kind === 'OVER' && entry.over ? { differenceReason: OVER_REASONS[entry.over] } : {}
      const holdOf = (lot: LotEntry) => (lot.hold ? { holdReason: HOLD_REASONS[lot.hold] } : {})
      if (line.item.tracking === 'HIDE') {
        return {
          purchaseOrderLineId: line.id,
          lots: entry.lots
            .filter((lot) => lot.hides.length > 0)
            .map((lot) => ({
              ...(lot.dyeBatch ? { dyeBatch: lot.dyeBatch } : {}),
              ...holdOf(lot),
              hides: lot.hides.map((hide) => ({
                area: quantityText(hide.area, AREA_BOUNDS.decimals),
                areaUom: hide.areaUom,
                ...(hide.supplierCode ? { supplierCode: hide.supplierCode } : {}),
                ...(hide.grade ? { grade: hide.grade } : {}),
                ...(hide.shade ? { shade: hide.shade } : {}),
                ...(hide.thicknessMm !== null
                  ? {
                      thicknessMm: quantityText(hide.thicknessMm, THICKNESS_BOUNDS.decimals),
                    }
                  : {}),
                ...(hide.defects.length > 0
                  ? {
                      defects: hide.defects.map((code) => DEFECTS[code]).join(', '),
                    }
                  : {}),
              })),
            })),
          ...over,
        }
      }
      const decimals = decimalsOf(line.item.baseUom)
      if (line.item.tracking === 'LOT') {
        return {
          purchaseOrderLineId: line.id,
          uom: line.item.baseUom,
          lots: entry.lots
            .filter((lot) => lot.quantity !== null)
            .map((lot) => ({
              quantity: quantityText(lot.quantity!, decimals),
              ...(lot.supplierLotRef ? { supplierLotRef: lot.supplierLotRef } : {}),
              ...holdOf(lot),
            })),
          ...over,
        }
      }
      return {
        purchaseOrderLineId: line.id,
        uom: line.item.baseUom,
        quantity: quantityText(entry.quantity!, decimals),
        ...over,
      }
    })
  return {
    version: delivery.version,
    ...(delivery.ddtNumber ? { supplierDdtNumber: delivery.ddtNumber } : {}),
    lines,
    ...(options.printerId ? { printerId: options.printerId } : {}),
    language: options.language,
  }
}

/** The index of a line in the body (the API names refused lines `body/lines/<i>`), back to its order line. */
export function lineIdAtBodyIndex(order: OrderToReceive, delivery: Delivery, index: number): string | null {
  return order.lines.filter((line) => entered(delivery.entries[line.id]))[index]?.id ?? null
}

/** The lines to show: open first in the order's sequence, received in full after them. */
export function linesInOrder(lines: readonly OrderLine[]): OrderLine[] {
  return [...lines].sort((a, b) => Number(num(a.open) <= 0) - Number(num(b.open) <= 0) || a.seq - b.seq)
}

// ---- the tags after posting -----------------------------------------------------------------------------------------------

export type TagState = 'queued' | 'sent' | 'printed' | 'failed' | 'notPrinted'

export function tagState(job: Pick<TagJob, 'status' | 'jobId'> | undefined): TagState {
  if (!job || !job.jobId || !job.status) return 'notPrinted'
  return job.status === 'QUEUED' ? 'queued' : job.status === 'SENT' ? 'sent' : job.status === 'PRINTED' ? 'printed' : 'failed'
}

/** The tags still on their way to the printer (the screen reads the receipt again while there are). */
export function tagsPending(receipt: Pick<FloorReceipt, 'tags'>): boolean {
  return receipt.tags.jobs.some((job) => job.status === 'QUEUED' || job.status === 'SENT')
}

export function tagCounts(receipt: Pick<FloorReceipt, 'tags' | 'hides'>): Record<TagState, number> {
  const counts: Record<TagState, number> = {
    queued: 0,
    sent: 0,
    printed: 0,
    failed: 0,
    notPrinted: 0,
  }
  const byHide = new Map(receipt.tags.jobs.map((job) => [job.hideId, job]))
  for (const hide of receipt.hides) counts[tagState(byHide.get(hide.id))] += 1
  return counts
}

/** A scanned code on the done step: one of this receipt's hide tags (any case), or null. */
export function hideOfCode(receipt: Pick<FloorReceipt, 'hides'>, code: string): string | null {
  const wanted = code.trim().toUpperCase()
  return receipt.hides.find((hide) => hide.code.toUpperCase() === wanted)?.id ?? null
}

/** Order states that take goods (the rest are refused with their state's words). */
export const RECEIVING_STATUSES = ['SENT', 'CONFIRMED', 'PARTLY_RECEIVED'] as const
export const receives = (status: string): boolean => (RECEIVING_STATUSES as readonly string[]).includes(status)
