import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import type { WorkOrderKind, WorkOrderStatus } from '../work-orders/machine'

/**
 * Report finished to stock (B-W2a-12; GAP-003, MES-011; design production.workorders pop-up "Report finished to stock":
 * "released quantity per size into finished goods"), pure: what a work order's cells may put into finished-goods stock
 * now, the refusals in words, the finished-goods item of a SKU and the standard cost a receipt is valued at. apps/factory-api's
 * modules/production/completion reads the facts under its locks and posts the receipt through
 * modules/inventory/finished (a PRODUCTION_RECEIPT stock move per cell, factory-db wave 5).
 *
 *   released      only garments quality released go into stock: per cell its releases less their reversals
 *                 (B-W1-45). The database caps a cell's receipts at its quantity (StockMove_bound_to_production); the
 *                 released cap is this rule.
 *   in stock      the cell's receipts less their reversals (whatever moved them since: a receipt is counted once).
 *   on shipments  garments on shipments that are not CANCELLED. W1 ships released garments straight from the release
 *                 (B-W1-46), so a garment on a shipment never goes into stock as well. B-W2a-48 (ship from
 *                 finished-goods stock) passes only the garments its shipments did NOT take from stock here.
 *   held          a released serial under an ACTIVE quality hold (wave 6) stays out of stock until the hold is released.
 *   can report    released − in stock − on shipments − held, and never more than the cell's quantity − in stock; from 0.
 *   partial       any number from 1 to what can be reported, per cell (MES-011); none named: every cell, all it can.
 *   the work order  IN_PROGRESS or COMPLETED (the database's rule too; ON_HOLD never: the gate), not under an ACTIVE
 *                 quality hold of the work order, never a REPAIR (a customer's garment goes back with its repair's DDT,
 *                 not into our stock), and its site has a finished-goods place.
 */

/** One cell's figures as the report reads them (whole garments). */
export interface FinishedCellFacts {
  readonly cellId: string
  /** "BLK 52". */
  readonly label: string
  readonly quantity: number
  readonly released: number
  readonly reversed: number
  readonly onShipments: number
  /** Receipts of the cell's SKU from this work order, less their reversals. */
  readonly received: number
  /** Released serials of the cell under an ACTIVE quality hold, not on a shipment. */
  readonly heldSerials: number
}

export interface FinishedCell extends FinishedCellFacts {
  readonly netReleased: number
  readonly canReport: number
  /** Why nothing more can be reported (null while something can). */
  readonly why: string | null
}

const max0 = (value: number): number => (value > 0 ? value : 0)
const garments = (count: number): string => `${count} garment${count === 1 ? '' : 's'}`

export function finishedCell(facts: FinishedCellFacts): FinishedCell {
  const netReleased = max0(facts.released - facts.reversed)
  const byRelease = netReleased - facts.received - facts.onShipments - facts.heldSerials
  const byCell = facts.quantity - facts.received
  const canReport = max0(Math.min(byRelease, byCell))
  return { ...facts, netReleased, canReport, why: canReport > 0 ? null : whyNot({ ...facts, netReleased }) }
}

function whyNot(cell: FinishedCellFacts & { readonly netReleased: number }): string {
  if (cell.received >= cell.quantity) return `${cell.label}: all ${garments(cell.quantity)} of the cell are in finished goods already.`
  if (cell.netReleased === 0) return `${cell.label}: no garment is released yet; only garments quality released go into finished goods.`
  const parts = [`${garments(cell.netReleased)} released`, `${cell.received} in stock`]
  if (cell.onShipments > 0) parts.push(`${cell.onShipments} on shipments`)
  if (cell.heldSerials > 0) parts.push(`${cell.heldSerials} on quality hold`)
  return `${cell.label}: ${parts.join(', ')}, so none is left to report.`
}

/** "BLK 52: 1 released garment is not in stock yet; 2 asked." */
export function tooManyWords(cell: FinishedCell, asked: number): string {
  if (cell.canReport === 0) return `${cell.why} ${asked} asked.`
  const parts = [`${garments(cell.netReleased)} released`, `${cell.received} in stock`]
  if (cell.onShipments > 0) parts.push(`${cell.onShipments} on shipments`)
  if (cell.heldSerials > 0) parts.push(`${cell.heldSerials} on quality hold`)
  return `${cell.label}: ${parts.join(', ')}, so ${cell.canReport} can go into finished goods; ${asked} asked.`
}

export interface ReportLine {
  readonly cellId: string
  readonly quantity: number
}

/** The request's shape against the work order's cells (400): a cell of it, named once, whole garments from 1. */
export function reportShapeProblems(lines: readonly ReportLine[], cellIds: ReadonlySet<string>, path = 'body/cells'): Issue[] {
  const problems: Issue[] = []
  const seen = new Set<string>()
  lines.forEach((line, index) => {
    const at = `${path}/${index}`
    if (!cellIds.has(line.cellId)) problems.push({ path: `${at}/cellId`, message: 'Not a cell of this work order.' })
    else if (seen.has(line.cellId)) problems.push({ path: `${at}/cellId`, message: 'Name each cell once.' })
    seen.add(line.cellId)
    if (!Number.isInteger(line.quantity) || line.quantity < 1) problems.push({ path: `${at}/quantity`, message: 'Whole garments, from 1.' })
  })
  return problems
}

/** The lines asked, or every cell with all it can report; each line at most what its cell can report (409 words). */
export function planReport(cells: readonly FinishedCell[], asked: readonly ReportLine[] | undefined): { readonly lines: ReportLine[]; readonly refusals: Issue[] } {
  const byId = new Map(cells.map((cell) => [cell.cellId, cell]))
  if (asked === undefined) {
    return { lines: cells.filter((cell) => cell.canReport > 0).map((cell) => ({ cellId: cell.cellId, quantity: cell.canReport })), refusals: [] }
  }
  const refusals: Issue[] = []
  asked.forEach((line, index) => {
    const cell = byId.get(line.cellId)
    if (cell && line.quantity > cell.canReport) refusals.push({ path: `body/cells/${index}/quantity`, message: tooManyWords(cell, line.quantity) })
  })
  return { lines: [...asked], refusals }
}

/** Nothing to report on the whole work order, in words. */
export function nothingToReport(number: string, cells: readonly FinishedCell[]): string {
  const reasons = cells.map((cell) => cell.why).filter((why): why is string => why !== null)
  return `Work order ${number} has nothing to report to finished goods: ${reasons.length > 0 ? reasons.join(' ') : 'it has no cells.'}`
}

// ---- the work order -------------------------------------------------------------------------------------------------

export const FINISH_STATUSES: readonly WorkOrderStatus[] = Object.freeze(['IN_PROGRESS', 'COMPLETED'])

export interface FinishOrderFacts {
  readonly number: string
  readonly kind: WorkOrderKind
  readonly status: WorkOrderStatus
  readonly holdReason: string | null
  /** The reason codes of the ACTIVE quality holds of the work order itself. */
  readonly qualityHolds: readonly string[]
  readonly siteCode: string
  /** The site's finished-goods places (FINISHED_GOODS locations and places inside them that take stock). */
  readonly places: number
}

/** What stops a report on the whole work order, each in words (empty: nothing). */
export function finishBlockers(facts: FinishOrderFacts): string[] {
  const blockers: string[] = []
  if (facts.kind === 'REPAIR') {
    blockers.push(`Work order ${facts.number} repairs a customer's garment: it goes back with its repair's transport document (DDT), never into finished goods.`)
    return blockers
  }
  if (facts.status === 'ON_HOLD') {
    blockers.push(`Work order ${facts.number} is on hold${facts.holdReason ? ` (${facts.holdReason})` : ''}: its garments go into finished goods once the hold is lifted.`)
  } else if (facts.status === 'DRAFT' || facts.status === 'RELEASED') {
    blockers.push(`Work order ${facts.number} is ${facts.status}; its garments go into finished goods once it is IN_PROGRESS (its first issue, cut or scan starts it).`)
  } else if (facts.status === 'CLOSED' || facts.status === 'CANCELLED') {
    blockers.push(`Work order ${facts.number} is ${facts.status}: nothing more goes into finished goods from it.`)
  }
  if (facts.qualityHolds.length > 0) {
    blockers.push(`Work order ${facts.number} is on quality hold (${[...new Set(facts.qualityHolds)].join(', ')}): its garments go into finished goods once the hold is released.`)
  }
  if (facts.places === 0) {
    blockers.push(`Site ${facts.siteCode} has no finished-goods place: add a location of kind Finished goods (Warehouse › Locations) first.`)
  }
  return blockers
}

// ---- the finished-goods item of a SKU ----------------------------------------------------------------------------------

export interface SkuFacts {
  /** Variant.sku: the item's code. */
  readonly sku: string
  readonly styleName: string
  readonly colourwayName: string
  readonly size: string
  /** The style's garment tracking (Q31): a serial-tracked style's item says SERIAL. */
  readonly garmentTracking: 'BATCH' | 'SERIAL'
}

/**
 * The FINISHED item of a SKU (factory-db wave 5: one item per SKU, kind FINISHED, its variantId, PCS; never by hide, never
 * a Cr VI test of its own). Its stock carries no lot: the batch is the receipt's work order and reference (the batch
 * number), and a shipment line names the cell, so the trail keeps the batch; a serial-tracked style keeps its serials as
 * they are (GarmentSerial), the item only says SERIAL.
 */
export function finishedItemDraft(sku: SkuFacts) {
  return {
    code: sku.sku,
    name: `${sku.styleName}, ${sku.colourwayName}, size ${sku.size}`,
    kind: 'FINISHED' as const,
    sourcing: 'MAKE' as const,
    tracking: sku.garmentTracking === 'SERIAL' ? ('SERIAL' as const) : ('NONE' as const),
    baseUom: 'PCS' as const,
    purchaseUom: 'PCS' as const,
    consumptionUom: 'PCS' as const,
  }
}

// ---- the standard cost a receipt is valued at ----------------------------------------------------------------------------

export interface StandardCostFacts {
  readonly id: string
  readonly status: string
  readonly validFrom: BusinessDate
  readonly validTo: BusinessDate | null
  readonly unitCost: string
  readonly currency: string
}

/**
 * The FROZEN standard cost (wave 7 StandardCost, FIN-024) in force on the day, the latest to start; null when none. The
 * company's costing method is UNDECIDED until the accountant answers (GATE-ACCOUNTANT): a production receipt is valued at
 * the standard cost meanwhile (this one, else the item's own standard cost; without either it stays unvalued).
 */
export function standardCostOn(rows: readonly StandardCostFacts[], day: BusinessDate, currency: string): StandardCostFacts | null {
  const inForce = rows.filter((row) => row.status === 'FROZEN' && row.currency === currency && row.validFrom <= day && (row.validTo === null || row.validTo >= day))
  return [...inForce].sort((a, b) => (a.validFrom < b.validFrom ? 1 : a.validFrom > b.validFrom ? -1 : 0))[0] ?? null
}

// ---- taking a report back --------------------------------------------------------------------------------------------------

export interface ReportMoveFacts {
  readonly moveId: string
  readonly reversed: boolean
}

/** What is left to take back of a report, or why nothing is. */
export function reversalPlan(reportId: string, moves: readonly ReportMoveFacts[]): { readonly moveIds: string[]; readonly problem: string | null } {
  if (moves.length === 0) return { moveIds: [], problem: `Report ${reportId} is not a report of this work order.` }
  const open = moves.filter((move) => !move.reversed).map((move) => move.moveId)
  if (open.length === 0) return { moveIds: [], problem: 'This report was taken back already: its garments left finished goods.' }
  return { moveIds: open, problem: null }
}

// ---- a release reversal takes the garments out of finished goods (B-W2b-10; B-W2a-12's follow-up) ---------------------

/**
 * When quality takes released garments back (quality/final reversals; Reg. (EU) 2016/425 art. 8(8)), garments of the cell
 * that sit in finished goods beyond what stays released leave stock in the same command: what may stay in stock is the
 * garments still released less those on shipments that did not take them from stock; the garments taken out are at most
 * the ones reversed (garments not in stock yet are taken first: nothing moves for them).
 *
 *   how      a receipt is taken back whole (its reversal mirrors it: the database's rule), newest first, from a place that
 *            still holds all of it; when that takes more than is needed, the rest goes back in at once as a new receipt
 *            into the same place (only while the work order takes receipts: IN_PROGRESS or COMPLETED). Otherwise only
 *            receipts that fit are taken back and the rest is said in words (the office takes it out by hand).
 */
export interface TakeOutReceipt {
  readonly moveId: string
  readonly quantity: number
  readonly placeId: string
}

export interface TakeOutFacts {
  /** "BLK 52". */
  readonly label: string
  /** The cell's figures once the reversal is written: released less reversed, on shipments not taken from stock, in stock. */
  readonly netReleased: number
  readonly onShipments: number
  readonly received: number
  /** The garments this reversal took back. */
  readonly reversed: number
  /** The cell's receipts still in stock (not taken back), newest first. */
  readonly receipts: readonly TakeOutReceipt[]
  /** What each place holds of the cell's item now. */
  readonly placeHolds: ReadonlyMap<string, number>
  /** The work order takes a receipt now (IN_PROGRESS or COMPLETED): the rest of a receipt taken back goes in again. */
  readonly canReceive: boolean
}

export interface TakeOutPlan {
  /** Garments that leave finished goods. */
  readonly takeOut: number
  /** The receipts taken back whole. */
  readonly reverse: readonly string[]
  /** Garments of them that go back in as a new receipt, and where (the last receipt's place). */
  readonly putBack: number
  readonly putBackPlaceId: string | null
  /** Garments that should leave and could not here. */
  readonly left: number
  readonly words: string
}

export function releaseTakeOut(facts: TakeOutFacts): TakeOutPlan {
  const mayStay = max0(facts.netReleased - facts.onShipments)
  const need = Math.min(max0(facts.reversed), max0(facts.received - mayStay))
  const none = { reverse: [], putBack: 0, putBackPlaceId: null } as const
  if (need === 0) return { ...none, takeOut: 0, left: 0, words: `${facts.label}: no garment in finished goods is beyond what stays released; nothing leaves stock.` }
  const holds = new Map(facts.placeHolds)
  const reverse: string[] = []
  let taken = 0
  let lastPlace: string | null = null
  for (const receipt of facts.receipts) {
    if (taken >= need) break
    if ((holds.get(receipt.placeId) ?? 0) < receipt.quantity) continue
    if (!facts.canReceive && taken + receipt.quantity > need) continue
    reverse.push(receipt.moveId)
    holds.set(receipt.placeId, (holds.get(receipt.placeId) ?? 0) - receipt.quantity)
    taken += receipt.quantity
    lastPlace = receipt.placeId
  }
  const takeOut = Math.min(taken, need)
  const putBack = taken - takeOut
  const left = need - takeOut
  if (takeOut === 0) {
    return { takeOut: 0, reverse: [], putBack: 0, putBackPlaceId: null, left, words: `${facts.label}: ${garments(left)} in finished goods should leave with the reversal; no report could be taken back here: take that report back by hand (Report finished to stock).` }
  }
  const words =
    `${facts.label}: ${garments(takeOut)} left finished goods with the reversal` +
    (putBack > 0 ? ` (${putBack} went back in at once: a report is taken back whole).` : '.') +
    (left > 0 ? ` ${garments(left)} more should leave: take that report back by hand (Report finished to stock).` : '')
  return { takeOut, reverse, putBack, putBackPlaceId: putBack > 0 ? lastPlace : null, left, words }
}
