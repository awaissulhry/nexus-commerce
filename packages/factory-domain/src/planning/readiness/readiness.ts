import type { BusinessDate } from '../../core/time'
import { decimalOf, QUANTITY_SCALE, type Uom } from '../../product/units/units'
import type { Decimal } from 'decimal.js'
import { quantityWords } from '../explain'
import type { MaterialPegging } from '../mrp/net'

/**
 * Material readiness (B-W2a-22; PLN-086 "planning derives readiness from pegging, stock and reservations"; design
 * warehouse.picking "readiness (one word: Not booked / Not enough / Requested / Delayed / Expected 3 Nov / Received)"),
 * pure. ONE word per work order, from how the plan covers each of its materials, with the reason a click away:
 *
 *   RECEIVED     every material is issued to it or reserved for it
 *   NOT_BOOKED   some of it is in stock, but not reserved for it (reserve it: B-W2a-11)
 *   EXPECTED     some of it comes with a purchase order line that arrives in time (the latest such date)
 *   REQUESTED    some of it is only in a DRAFT purchase order, or a firm planned order arriving in time
 *   DELAYED      some of it comes late: a purchase order line past its date and not received, a later purchase line,
 *                or a firm planned order dated after the need
 *   NOT_ENOUGH   some of it is covered by nothing (the plan suggests buying or making it)
 *   NOT_PLANNED  the plan has no demand for it: its order is not planned, its style has no released BOM, or it is a
 *                repair (the release check decides by itself)
 *
 * The worst material decides the word (in the order NOT_ENOUGH, DELAYED, REQUESTED, EXPECTED, NOT_BOOKED, RECEIVED).
 * A material is needed on its order line's date (the plan's netting date; backward scheduling of the start, B-W2a-34,
 * comes later). Quantities only: no money, no person.
 */

export const READINESS_WORDS = ['NOT_ENOUGH', 'DELAYED', 'REQUESTED', 'EXPECTED', 'NOT_BOOKED', 'RECEIVED', 'NOT_PLANNED'] as const
export type ReadinessWord = (typeof READINESS_WORDS)[number]

/** Worst first (NOT_PLANNED is not ranked: it is said only when there is nothing to rank). */
const RANK: Readonly<Record<Exclude<ReadinessWord, 'NOT_PLANNED'>, number>> = { NOT_ENOUGH: 0, DELAYED: 1, REQUESTED: 2, EXPECTED: 3, NOT_BOOKED: 4, RECEIVED: 5 }

export const READINESS_LABELS: Readonly<Record<ReadinessWord, string>> = Object.freeze({
  NOT_ENOUGH: 'Not enough',
  DELAYED: 'Delayed',
  REQUESTED: 'Requested',
  EXPECTED: 'Expected',
  NOT_BOOKED: 'Not booked',
  RECEIVED: 'Received',
  NOT_PLANNED: 'Not planned',
})

/** What readiness reads of an open purchase order line. */
export interface PurchaseFacts {
  readonly purchaseOrderNumber: string
  readonly purchaseOrderStatus: string
  readonly dueDate: BusinessDate
}

/** One material of a plan (a requirement), with the names its words use. */
export interface ReadinessMaterial {
  readonly itemId: string
  readonly itemColourId: string | null
  readonly label: string
  readonly uom: Uom
  readonly pegging: Pick<MaterialPegging, 'coverage' | 'purchases' | 'firm'>
}

export interface MaterialReadiness {
  readonly itemId: string
  readonly itemColourId: string | null
  readonly label: string
  readonly uom: Uom
  readonly word: Exclude<ReadinessWord, 'NOT_PLANNED'>
  /** EXPECTED: the latest arrival; DELAYED: when the late supply comes (or was due). */
  readonly date: BusinessDate | null
  readonly needed: string
  readonly issued: string
  readonly reserved: string
  readonly inStock: string
  readonly onOrder: string
  readonly firm: string
  readonly short: string
  /** The purchase order lines it counts on (numbers, dates). */
  readonly purchaseOrderLineIds: readonly string[]
  readonly reason: string
}

export interface WorkOrderReadiness {
  readonly workOrderId: string
  readonly word: ReadinessWord
  readonly label: string
  readonly date: BusinessDate | null
  /** One sentence: the worst material's reason (and how many more need attention). */
  readonly reason: string
  readonly materials: readonly MaterialReadiness[]
}

const ZERO = decimalOf('0')
const q = (value: Decimal): string => value.toFixed(QUANTITY_SCALE)
const later = (a: BusinessDate | null, b: BusinessDate | null): BusinessDate | null => (a === null ? b : b === null ? a : a > b ? a : b)
const DRAFT = 'DRAFT'

/** The readiness of each work order asked for (an id the plan has no part of: NOT_PLANNED). */
export function readinessOf(workOrderIds: readonly string[], materials: readonly ReadinessMaterial[], purchaseOf: (purchaseOrderLineId: string) => PurchaseFacts | undefined, today: BusinessDate): WorkOrderReadiness[] {
  return workOrderIds.map((workOrderId) => {
    const rows: MaterialReadiness[] = []
    for (const material of materials) {
      const coverages = material.pegging.coverage.filter((coverage) => coverage.part.workOrderId === workOrderId)
      if (coverages.length === 0) continue
      rows.push(materialReadiness(material, coverages, purchaseOf, today))
    }
    if (rows.length === 0) {
      return { workOrderId, word: 'NOT_PLANNED', label: READINESS_LABELS.NOT_PLANNED, date: null, reason: 'The plan has no material need for this work order: its order is not planned, its style has no released BOM, its pieces are already made or planned on another work order, or it is a repair.', materials: [] }
    }
    rows.sort((a, b) => RANK[a.word] - RANK[b.word] || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    const worst = rows[0]!
    const same = rows.filter((row) => row.word === worst.word)
    const date = worst.word === 'EXPECTED' || worst.word === 'DELAYED' ? same.reduce<BusinessDate | null>((latest, row) => later(latest, row.date), null) : null
    const others = rows.filter((row) => row !== worst && row.word !== 'RECEIVED' && row.word !== 'EXPECTED').length
    return {
      workOrderId,
      word: worst.word,
      label: worst.word === 'EXPECTED' && date ? `${READINESS_LABELS.EXPECTED} ${date}` : READINESS_LABELS[worst.word],
      date,
      reason: others > 0 && worst.word !== 'RECEIVED' ? `${worst.reason} ${others === 1 ? '1 more material needs' : `${others} more materials need`} attention.` : worst.reason,
      materials: rows,
    }
  })
}

function materialReadiness(material: ReadinessMaterial, coverages: MaterialPegging['coverage'], purchaseOf: (id: string) => PurchaseFacts | undefined, today: BusinessDate): MaterialReadiness {
  const sum = { needed: ZERO, issued: ZERO, reserved: ZERO, inStock: ZERO, onOrder: ZERO, draft: ZERO, firm: ZERO, firmLate: ZERO, short: ZERO }
  let expected: BusinessDate | null = null
  const found: { overdue: { line: string; date: BusinessDate } | null } = { overdue: null }
  let firmLateDate: BusinessDate | null = null
  let draftLine: string | null = null
  const days: BusinessDate[] = []
  const lines = new Set<string>()
  for (const coverage of coverages) {
    sum.needed = sum.needed.plus(decimalOf(coverage.part.quantity))
    sum.issued = sum.issued.plus(decimalOf(coverage.part.issued))
    days.push(coverage.day)
    for (const supply of coverage.supplies) {
      const quantity = decimalOf(supply.quantity)
      if (supply.kind === 'RESERVATION') sum.reserved = sum.reserved.plus(quantity)
      else if (supply.kind === 'STOCK') sum.inStock = sum.inStock.plus(quantity)
      else if (supply.kind === 'PLANNED') sum.short = sum.short.plus(quantity)
      else if (supply.kind === 'FIRM') {
        if (supply.late) {
          sum.firmLate = sum.firmLate.plus(quantity)
          firmLateDate = later(firmLateDate, supply.date ?? null)
        } else sum.firm = sum.firm.plus(quantity)
      } else if (supply.kind === 'PURCHASE_ORDER' && supply.purchaseOrderLineId) {
        lines.add(supply.purchaseOrderLineId)
        const facts = purchaseOf(supply.purchaseOrderLineId)
        if (facts?.purchaseOrderStatus === DRAFT) {
          sum.draft = sum.draft.plus(quantity)
          draftLine ??= facts.purchaseOrderNumber
        } else {
          sum.onOrder = sum.onOrder.plus(quantity)
          const due = supply.date ?? facts?.dueDate ?? null
          if (due !== null && due < today) {
            if (found.overdue === null || due < found.overdue.date) found.overdue = { line: facts?.purchaseOrderNumber ?? 'a purchase order', date: due }
          }
          else expected = later(expected, due)
        }
      }
    }
  }
  const firstDay: BusinessDate | null = days.sort()[0] ?? null
  const w = (value: Decimal): string => quantityWords(q(value), material.uom)
  // A purchase line that arrives after the need (not counted) makes a short part "delayed", not "not enough".
  const tooLate = material.pegging.purchases.filter((purchase) => purchase.why === 'TOO_LATE' && decimalOf(purchase.notCounted).gt(0))
  const lateLine = tooLate[0] ?? null
  let word: MaterialReadiness['word']
  let date: BusinessDate | null = null
  let reason: string
  if (sum.short.gt(0) && lateLine === null) {
    word = 'NOT_ENOUGH'
    reason = `${material.label}: ${w(sum.short)} short and nothing ordered for it yet.`
  } else if (sum.short.gt(0) || found.overdue !== null || sum.firmLate.gt(0)) {
    const overdue = found.overdue
    word = 'DELAYED'
    if (sum.short.gt(0) && lateLine) {
      date = lateLine.line.dueDate
      reason = `${material.label}: ${lateLine.line.purchaseOrderNumber} arrives ${lateLine.line.dueDate}, after it is needed on ${firstDay ?? today}.`
    } else if (overdue) {
      date = overdue.date
      reason = `${material.label}: ${overdue.line} was due ${overdue.date} and is not received yet.`
    } else {
      date = firmLateDate
      reason = `${material.label}: the firm planned order comes ${firmLateDate ?? ''}, after it is needed on ${firstDay ?? today}.`
    }
  } else if (sum.draft.gt(0) || sum.firm.gt(0)) {
    word = 'REQUESTED'
    reason = sum.draft.gt(0) ? `${material.label}: ${w(sum.draft)} in draft ${draftLine}, not sent to the supplier yet.` : `${material.label}: ${w(sum.firm)} in a firm planned order, not ordered yet.`
  } else if (sum.onOrder.gt(0)) {
    word = 'EXPECTED'
    date = expected
    reason = `${material.label}: ${w(sum.onOrder)} expected${expected ? ` by ${expected}` : ''} on purchase orders.`
  } else if (sum.inStock.gt(0)) {
    word = 'NOT_BOOKED'
    reason = `${material.label}: ${w(sum.inStock)} in stock, not reserved for it yet.`
  } else {
    word = 'RECEIVED'
    reason = `${material.label}: ${sum.issued.gt(0) && sum.reserved.isZero() ? 'issued' : 'reserved or issued'}.`
  }
  return {
    itemId: material.itemId,
    itemColourId: material.itemColourId,
    label: material.label,
    uom: material.uom,
    word,
    date,
    needed: q(sum.needed),
    issued: q(sum.issued),
    reserved: q(sum.reserved),
    inStock: q(sum.inStock),
    onOrder: q(sum.onOrder.plus(sum.draft)),
    firm: q(sum.firm.plus(sum.firmLate)),
    short: q(sum.short),
    purchaseOrderLineIds: [...lines].sort(),
    reason,
  }
}
