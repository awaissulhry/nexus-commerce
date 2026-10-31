import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { fromMinorUnits } from '@nexus/factory-domain/core/money'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import {
  closeWarningsOf,
  effectWithAmount,
  effectWords,
  followUpOf,
  freightPayerOf,
  isSafetyReturn,
  restockHeldWords,
  returnActions,
  RETURN_REASON_LIST,
  statusWords,
  STOCK_OUTCOMES,
  suggestedOutcome,
  trackingOf,
  valueOf,
  type GoodsOutcome,
  type ReturnCause,
  type ReturnDisposition,
  type ReturnGrade,
  type ReturnPolicy,
  type ReturnStatus,
} from '@nexus/factory-domain/sales/returns/rules'
import type { CommandTx } from '../../../core/command'
import { reasonWords } from '../../../platform/reasons/service'
import { sourceDdtsOf } from '../../shipping/ddt/sources-store'
import { policyOf } from './policy'

/**
 * The customer returns' reads (factory-db returns.prisma ReturnAuthorisation, ReturnLine, ReturnReceipt; B-W2a-43). Every
 * read names its columns and selects no relation (inside a command's transaction Prisma would send relation reads
 * together on its one connection); a reader takes the command's transaction or a scoped client, and row-level security
 * decides what it finds. The floor's reads never select a price, a discount or a credit value (the floor role cannot
 * read those columns) nor the internal note.
 */

export type Reader = FactoryClient | CommandTx

export const RETURN_RECORD = 'ReturnAuthorisation'
export const RECEIPT_RECORD = 'ReturnReceipt'
export const LINE_RECORD = 'ReturnLine'

export const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
export const dayOrNull = (value: Date | null): BusinessDate | null => (value ? dayOf(value) : null)
export const asDay = (value: BusinessDate): Date => new Date(`${value}T00:00:00.000Z`)
const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

export const RMA_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  partyId: true,
  number: true,
  contactId: true,
  customerRef: true,
  salesOrderId: true,
  status: true,
  requestedAt: true,
  authorisedAt: true,
  authorisedById: true,
  goodsDueBy: true,
  receivedAt: true,
  inspectedAt: true,
  replacementOrderId: true,
  ownerId: true,
  closedAt: true,
  statusReason: true,
  internalNote: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.ReturnAuthorisationSelect
export type RmaRow = Prisma.ReturnAuthorisationGetPayload<{ select: typeof RMA_COLUMNS }>

/** What the dock reads of an RMA (no internal note). */
export const FLOOR_RMA_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  partyId: true,
  number: true,
  customerRef: true,
  salesOrderId: true,
  status: true,
  goodsDueBy: true,
  receivedAt: true,
  inspectedAt: true,
  version: true,
} as const satisfies Prisma.ReturnAuthorisationSelect
export type FloorRmaRow = Prisma.ReturnAuthorisationGetPayload<{ select: typeof FLOOR_RMA_COLUMNS }>

/** A line as the dock reads it: never a price, a discount or a credit value. */
export const FLOOR_LINE_COLUMNS = {
  id: true,
  siteId: true,
  partyId: true,
  returnId: true,
  seq: true,
  salesOrderLineId: true,
  size: true,
  invoiceLineId: true,
  description: true,
  serial: true,
  batchNumber: true,
  quantity: true,
  reasonCode: true,
  reasonNote: true,
  receivedQuantity: true,
  receivedAt: true,
  receiptId: true,
  grade: true,
  cause: true,
  conditionNote: true,
  inspectedAt: true,
  inspectedById: true,
  disposition: true,
  goodsOutcome: true,
  decidedAt: true,
  decidedById: true,
  replacementLineId: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ReturnLineSelect
export type FloorLineRow = Prisma.ReturnLineGetPayload<{ select: typeof FLOOR_LINE_COLUMNS }>

export const LINE_COLUMNS = { ...FLOOR_LINE_COLUMNS, unitPrice: true, discountPct: true, creditAmount: true } as const satisfies Prisma.ReturnLineSelect
export type LineRow = Prisma.ReturnLineGetPayload<{ select: typeof LINE_COLUMNS }>

export const RECEIPT_COLUMNS = {
  id: true,
  siteId: true,
  returnId: true,
  receivedAt: true,
  parcels: true,
  parcelCondition: true,
  carrierName: true,
  trackingNumber: true,
  customerDdtNumber: true,
  customerDdtDate: true,
  note: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.ReturnReceiptSelect
export type ReceiptRow = Prisma.ReturnReceiptGetPayload<{ select: typeof RECEIPT_COLUMNS }>

// ---- what a line sold (its order line and invoice line) -------------------------------------------------------------

export interface SoldFacts {
  /** The order line, when the return line names one. */
  readonly orderLine: {
    readonly id: string
    readonly orderId: string
    readonly orderNumber: string
    readonly seq: number
    readonly kind: string
    readonly styleId: string
    readonly colourwayId: string
    readonly description: string | null
    readonly quantity: number
    readonly netAmount: number
    readonly currency: string
  } | null
  readonly invoiceLine: {
    readonly id: string
    readonly invoiceId: string
    readonly invoiceNumber: string | null
    readonly issueDate: BusinessDate | null
    readonly seq: number
    readonly description: string
    readonly quantity: string
    readonly netAmount: number
    readonly currency: string
  } | null
  readonly style: { readonly id: string; readonly code: string; readonly name: string; readonly ppe: boolean } | null
  readonly colourway: { readonly id: string; readonly code: string; readonly name: string } | null
}

/** The order lines and invoice lines the lines name, with their order, invoice, style and colourway (flat reads). */
export async function soldFactsOf(db: Reader, lines: readonly { readonly salesOrderLineId: string | null; readonly invoiceLineId: string | null }[]): Promise<Map<string, SoldFacts>> {
  const orderLineIds = [...new Set(lines.flatMap((line) => (line.salesOrderLineId ? [line.salesOrderLineId] : [])))]
  const invoiceLineIds = [...new Set(lines.flatMap((line) => (line.invoiceLineId ? [line.invoiceLineId] : [])))]
  const invoiceLines = invoiceLineIds.length
    ? await db.invoiceLine.findMany({ where: { id: { in: invoiceLineIds } }, select: { id: true, invoiceId: true, seq: true, description: true, quantity: true, netAmount: true, salesOrderLineId: true } })
    : []
  for (const line of invoiceLines) if (line.salesOrderLineId && !orderLineIds.includes(line.salesOrderLineId)) orderLineIds.push(line.salesOrderLineId)
  const orderLines = orderLineIds.length
    ? await db.salesOrderLine.findMany({ where: { id: { in: orderLineIds } }, select: { id: true, orderId: true, seq: true, kind: true, styleId: true, colourwayId: true, description: true, quantity: true, netAmount: true } })
    : []
  const orders = orderLines.length ? await db.salesOrder.findMany({ where: { id: { in: [...new Set(orderLines.map((line) => line.orderId))] } }, select: { id: true, number: true, currency: true } }) : []
  const invoices = invoiceLines.length ? await db.invoice.findMany({ where: { id: { in: [...new Set(invoiceLines.map((line) => line.invoiceId))] } }, select: { id: true, number: true, issueDate: true, currency: true } }) : []
  const styleIds = [...new Set(orderLines.map((line) => line.styleId))]
  const styles = styleIds.length ? await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true, ppeCategory: true } }) : []
  const colourways = orderLines.length ? await db.colourway.findMany({ where: { id: { in: [...new Set(orderLines.map((line) => line.colourwayId))] } }, select: { id: true, code: true, name: true } }) : []
  const orderOf = new Map(orders.map((row) => [row.id, row]))
  const invoiceOf = new Map(invoices.map((row) => [row.id, row]))
  const styleOf = new Map(styles.map((row) => [row.id, row]))
  const colourwayOf = new Map(colourways.map((row) => [row.id, row]))
  const orderLineOf = new Map(orderLines.map((row) => [row.id, row]))
  const invoiceLineOf = new Map(invoiceLines.map((row) => [row.id, row]))
  const facts = new Map<string, SoldFacts>()
  for (const line of lines) {
    const invoiceLine = line.invoiceLineId ? invoiceLineOf.get(line.invoiceLineId) : undefined
    const orderLine = (line.salesOrderLineId ?? invoiceLine?.salesOrderLineId) ? orderLineOf.get((line.salesOrderLineId ?? invoiceLine?.salesOrderLineId)!) : undefined
    const order = orderLine ? orderOf.get(orderLine.orderId) : undefined
    const invoice = invoiceLine ? invoiceOf.get(invoiceLine.invoiceId) : undefined
    const style = orderLine ? styleOf.get(orderLine.styleId) : undefined
    const colourway = orderLine ? colourwayOf.get(orderLine.colourwayId) : undefined
    facts.set(lineKeyOf(line), {
      orderLine: orderLine && order ? { ...orderLine, orderNumber: order.number, currency: order.currency } : null,
      invoiceLine: invoiceLine && invoice ? { id: invoiceLine.id, invoiceId: invoiceLine.invoiceId, invoiceNumber: invoice.number, issueDate: dayOrNull(invoice.issueDate), seq: invoiceLine.seq, description: invoiceLine.description, quantity: invoiceLine.quantity.toString(), netAmount: invoiceLine.netAmount, currency: invoice.currency } : null,
      style: style ? { id: style.id, code: style.code, name: style.name, ppe: style.ppeCategory !== 'NOT_PPE' } : null,
      colourway: colourway ?? null,
    })
  }
  return facts
}

export const lineKeyOf = (line: { readonly salesOrderLineId: string | null; readonly invoiceLineId: string | null }): string => `${line.salesOrderLineId ?? '-'}|${line.invoiceLineId ?? '-'}`

/** The currency of what a line sold: the invoice's, else the order's. */
export const currencyOf = (sold: SoldFacts | undefined): string | null => sold?.invoiceLine?.currency ?? sold?.orderLine?.currency ?? null

/** What `pieces` of the line are worth, net (minor units): the invoice line's amount, else the order line's. */
export function lineValue(sold: SoldFacts | undefined, pieces: number): number | null {
  if (!sold) return null
  const currency = currencyOf(sold)
  if (!currency) return null
  if (sold.invoiceLine) return valueOf({ netAmount: sold.invoiceLine.netAmount, quantity: sold.invoiceLine.quantity }, pieces, currency)
  if (sold.orderLine) return valueOf({ netAmount: sold.orderLine.netAmount, quantity: sold.orderLine.quantity }, pieces, currency)
  return null
}

// ---- reads of one RMA -----------------------------------------------------------------------------------------------

export async function readRma(db: Reader, returnId: string): Promise<RmaRow | null> {
  return db.returnAuthorisation.findUnique({ where: { id: returnId }, select: RMA_COLUMNS })
}

export async function readLines(db: Reader, returnId: string): Promise<LineRow[]> {
  return db.returnLine.findMany({ where: { returnId }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } })
}

export async function readFloorLines(db: Reader, returnId: string): Promise<FloorLineRow[]> {
  return db.returnLine.findMany({ where: { returnId }, select: FLOOR_LINE_COLUMNS, orderBy: { seq: 'asc' } })
}

/** Photo counts per record id of a record type (not deleted). */
export async function photoCounts(db: Reader, recordType: string, recordIds: readonly string[]): Promise<Map<string, number>> {
  if (recordIds.length === 0) return new Map()
  const rows = await db.storedFile.groupBy({ by: ['recordId'], where: { recordType, recordId: { in: [...recordIds] }, kind: 'PHOTO', status: { not: 'DELETED' } }, _count: { _all: true } })
  return new Map(rows.map((row) => [row.recordId, row._count._all]))
}

/** The stock moves a line's decision posted (their own idempotency keys `return-line:<lineId>:<n>`), with their place. */
export async function lineMoves(db: Reader, lineIds: readonly string[]): Promise<Map<string, { id: string; locationId: string | null; locationCode: string | null; quantity: string }[]>> {
  const out = new Map<string, { id: string; locationId: string | null; locationCode: string | null; quantity: string }[]>()
  if (lineIds.length === 0) return out
  // B-W2b-16: a CUSTOMER_RETURN names its line; a move made before W2b (an ADJUSTMENT) is found by its key.
  const moves = await db.stockMove.findMany({
    where: { OR: [{ returnLineId: { in: [...lineIds] }, reversalOfId: null }, ...lineIds.map((id) => ({ idempotencyKey: { startsWith: `${moveKeyPrefix(id)}` } }))] },
    select: { id: true, idempotencyKey: true, returnLineId: true, toLocationId: true, quantity: true },
    orderBy: { createdAt: 'asc' },
  })
  const places = moves.length ? await db.location.findMany({ where: { id: { in: [...new Set(moves.flatMap((move) => (move.toLocationId ? [move.toLocationId] : [])))] } }, select: { id: true, code: true } }) : []
  const codeOf = new Map(places.map((place) => [place.id, place.code]))
  for (const move of moves) {
    const lineId = move.returnLineId ?? move.idempotencyKey.split(':')[1]!
    const list = out.get(lineId) ?? []
    list.push({ id: move.id, locationId: move.toLocationId, locationCode: move.toLocationId ? (codeOf.get(move.toLocationId) ?? null) : null, quantity: move.quantity.toString() })
    out.set(lineId, list)
  }
  return out
}

export const moveKeyPrefix = (lineId: string): string => `return-line:${lineId}:`

// ---- the record view ------------------------------------------------------------------------------------------------

export interface RecordFacts {
  readonly rma: RmaRow
  readonly lines: LineRow[]
  readonly receipts: ReceiptRow[]
  readonly sold: Map<string, SoldFacts>
  readonly party: { readonly id: string; readonly code: string; readonly legalName: string } | null
  readonly company: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly site: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly salesOrder: { readonly id: string; readonly number: string } | null
  readonly replacementOrder: { readonly id: string; readonly number: string; readonly status: string } | null
  readonly reasons: Map<string, { readonly labelIt: string; readonly labelEn: string; readonly active: boolean }>
  readonly linePhotos: Map<string, number>
  readonly receiptPhotos: Map<string, number>
  readonly moves: Map<string, { id: string; locationId: string | null; locationCode: string | null; quantity: string }[]>
  readonly ddts: { readonly live: readonly { id: string; number: string; lineIds: readonly string[] }[]; readonly cancelled: readonly { id: string; number: string; lineIds: readonly string[] }[] }
  readonly policy: ReturnPolicy
  /** B-W2b-16: the repair orders made from each line that are not cancelled. */
  readonly repairs: Map<string, number>
}

/** Everything the record shows (flat reads, in order). */
export async function readRecordFacts(db: Reader, rma: RmaRow): Promise<RecordFacts> {
  const lines = await readLines(db, rma.id)
  const receipts = await db.returnReceipt.findMany({ where: { returnId: rma.id }, select: RECEIPT_COLUMNS, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }] })
  const sold = await soldFactsOf(db, lines)
  const party = await db.party.findUnique({ where: { id: rma.partyId }, select: { id: true, code: true, legalName: true } })
  const companyRow = await db.company.findUnique({ where: { id: rma.companyId }, select: { id: true, code: true, legalName: true } })
  const company = companyRow ? { id: companyRow.id, code: companyRow.code, name: companyRow.legalName } : null
  const site = await db.site.findUnique({ where: { id: rma.siteId }, select: { id: true, code: true, name: true } })
  const salesOrder = rma.salesOrderId ? await db.salesOrder.findUnique({ where: { id: rma.salesOrderId }, select: { id: true, number: true } }) : null
  const replacementOrder = rma.replacementOrderId ? await db.salesOrder.findUnique({ where: { id: rma.replacementOrderId }, select: { id: true, number: true, status: true } }) : null
  const reasons = await reasonWords(db, RETURN_REASON_LIST)
  const linePhotos = await photoCounts(db, LINE_RECORD, lines.map((line) => line.id))
  const receiptPhotos = await photoCounts(db, RECEIPT_RECORD, receipts.map((receipt) => receipt.id))
  const moves = await lineMoves(db, lines.map((line) => line.id))
  const ddts = await sourceDdtsOf(db as CommandTx, { type: 'ReturnAuthorisation', id: rma.id })
  const policy = await policyOf(db, rma.companyId)
  const repairs = await liveRepairsByLine(db, lines.map((line) => line.id))
  return { rma, lines, receipts, sold, party, company, site, salesOrder, replacementOrder, reasons, linePhotos, receiptPhotos, moves, ddts, policy, repairs }
}

/** B-W2b-16: the repair orders made from each of these lines that are not cancelled (one per garment received). */
export async function liveRepairsByLine(db: Reader, lineIds: readonly string[]): Promise<Map<string, number>> {
  if (lineIds.length === 0) return new Map()
  const rows = await db.repairOrder.groupBy({ by: ['returnLineId'], where: { returnLineId: { in: [...lineIds] }, stage: { not: 'CANCELLED' } }, _count: { _all: true } })
  return new Map(rows.flatMap((row) => (row.returnLineId ? [[row.returnLineId, row._count._all] as const] : [])))
}

/** B-W2b-16: what a close would leave behind (factory-domain closeWarningsOf), for the record and for the close itself. */
export const closeWarningsFor = (lines: readonly Pick<LineRow, 'id' | 'seq' | 'receivedQuantity' | 'disposition' | 'goodsOutcome' | 'replacementLineId'>[], repairs: ReadonlyMap<string, number>, liveReturnDdt: boolean) =>
  closeWarningsOf(
    lines.map((line) => ({ id: line.id, seq: line.seq, received: line.receivedQuantity, disposition: line.disposition as ReturnDisposition | null, goodsOutcome: line.goodsOutcome as GoodsOutcome | null, replaced: line.replacementLineId !== null, repairs: repairs.get(line.id) ?? 0 })),
    liveReturnDdt,
  )

const price = <T>(value: T) => asMoney('price', value)

/** One line of the record (prices and credit values marked with the price grain). */
export function lineView(line: LineRow, facts: Pick<RecordFacts, 'sold' | 'reasons' | 'linePhotos' | 'moves'>) {
  const sold = facts.sold.get(lineKeyOf(line))
  const ppe = sold?.style?.ppe ?? false
  const reason = facts.reasons.get(line.reasonCode)
  const currency = currencyOf(sold)
  const value = lineValue(sold, line.receivedQuantity)
  const moves = facts.moves.get(line.id) ?? []
  const place = moves[0]?.locationCode ?? null
  const decided = line.disposition !== null
  const decision = decided ? { disposition: line.disposition as ReturnDisposition, goodsOutcome: line.goodsOutcome as GoodsOutcome | null, creditAmount: line.creditAmount } : null
  const graded = line.grade ? { grade: line.grade as ReturnGrade, cause: line.cause as ReturnCause | null, ppe, reasonCode: line.reasonCode } : null
  const amountText = decision && decision.creditAmount !== null && currency ? `${fromMinorUnits(decision.creditAmount, currency).toFixed(2)} ${currency}` : null
  return {
    id: line.id,
    seq: line.seq,
    salesOrderLineId: line.salesOrderLineId,
    size: line.size,
    invoiceLineId: line.invoiceLineId,
    order: sold?.orderLine ? { id: sold.orderLine.orderId, number: sold.orderLine.orderNumber, lineSeq: sold.orderLine.seq } : null,
    invoice: sold?.invoiceLine ? { id: sold.invoiceLine.invoiceId, number: sold.invoiceLine.invoiceNumber, issueDate: sold.invoiceLine.issueDate, lineSeq: sold.invoiceLine.seq } : null,
    style: sold?.style ? { id: sold.style.id, code: sold.style.code, name: sold.style.name } : null,
    colourway: sold?.colourway ?? null,
    ppe,
    safety: isSafetyReturn({ ppe, reasonCode: line.reasonCode, cause: line.cause as ReturnCause | null }),
    description: line.description,
    serial: line.serial,
    batchNumber: line.batchNumber,
    quantity: line.quantity,
    reasonCode: line.reasonCode,
    reason: reason ? { code: line.reasonCode, labelIt: reason.labelIt, labelEn: reason.labelEn, active: reason.active } : null,
    reasonNote: line.reasonNote,
    currency,
    unitPrice: price(line.unitPrice === null ? null : line.unitPrice.toString()),
    discountPct: price(line.discountPct === null ? null : line.discountPct.toString()),
    receivedQuantity: line.receivedQuantity,
    receivedAt: iso(line.receivedAt),
    receiptId: line.receiptId,
    receivedValue: price(value),
    grade: line.grade,
    cause: line.cause,
    conditionNote: line.conditionNote,
    inspectedAt: iso(line.inspectedAt),
    inspectedById: line.inspectedById,
    photos: facts.linePhotos.get(line.id) ?? 0,
    suggestedOutcome: graded ? suggestedOutcome(graded) : null,
    restockHeld: graded ? restockHeldWords(graded) : null,
    disposition: line.disposition,
    goodsOutcome: line.goodsOutcome,
    decidedAt: iso(line.decidedAt),
    decidedById: line.decidedById,
    creditAmount: price(line.creditAmount),
    followUp: decision ? followUpOf(decision.disposition, decision.creditAmount ?? 0) : null,
    effect: decision ? effectWords(decision, place) : null,
    effectWithAmount: price(decision ? effectWithAmount(decision, place, amountText) : null),
    stock: moves.map((move) => ({ moveId: move.id, locationId: move.locationId, locationCode: move.locationCode, quantity: move.quantity })),
    replacementLineId: line.replacementLineId,
    version: line.version,
  }
}

/** The record: header, lines, receipts, status steps, what it offers now, the policy in force (office). */
export function returnView(facts: RecordFacts, now: Date) {
  const { rma } = facts
  const today = businessDate(now)
  const received = facts.lines.filter((line) => line.receivedQuantity > 0)
  const decided = received.filter((line) => line.disposition !== null)
  const lines = facts.lines.map((line) => lineView(line, facts))
  const credit = facts.lines.reduce((sum, line) => sum + (line.creditAmount ?? 0), 0)
  const currency = lines.find((line) => line.currency)?.currency ?? null
  const ddtOf = (row: { id: string; number: string; lineIds: readonly string[] }) => ({ id: row.id, number: row.number, lineIds: [...row.lineIds] })
  return {
    id: rma.id,
    number: rma.number,
    companyId: rma.companyId,
    company: facts.company,
    siteId: rma.siteId,
    site: facts.site,
    partyId: rma.partyId,
    party: facts.party,
    contactId: rma.contactId,
    customerRef: rma.customerRef,
    salesOrder: facts.salesOrder,
    status: rma.status,
    statusWords: statusWords({ status: rma.status as ReturnStatus, goodsDueBy: dayOrNull(rma.goodsDueBy), linesReceived: received.length, linesDecided: decided.length }, today),
    requestedAt: toUtcIso(rma.requestedAt),
    authorisedAt: iso(rma.authorisedAt),
    authorisedById: rma.authorisedById,
    goodsDueBy: dayOrNull(rma.goodsDueBy),
    late: rma.status === 'AUTHORISED' && rma.goodsDueBy !== null && dayOf(rma.goodsDueBy) < today,
    receivedAt: iso(rma.receivedAt),
    inspectedAt: iso(rma.inspectedAt),
    closedAt: iso(rma.closedAt),
    statusReason: rma.statusReason,
    ownerId: rma.ownerId,
    internalNote: rma.internalNote,
    replacementOrder: facts.replacementOrder,
    currency,
    creditTotal: price(credit),
    lines,
    receipts: facts.receipts.map((receipt) => ({
      id: receipt.id,
      receivedAt: toUtcIso(receipt.receivedAt),
      parcels: receipt.parcels,
      parcelCondition: receipt.parcelCondition,
      carrierName: receipt.carrierName,
      trackingNumber: receipt.trackingNumber,
      customerDdtNumber: receipt.customerDdtNumber,
      customerDdtDate: dayOrNull(receipt.customerDdtDate),
      note: receipt.note,
      photos: facts.receiptPhotos.get(receipt.id) ?? 0,
      lineIds: facts.lines.filter((line) => line.receiptId === receipt.id).map((line) => line.id),
      createdById: receipt.createdById,
    })),
    ddts: { live: facts.ddts.live.map(ddtOf), cancelled: facts.ddts.cancelled.map(ddtOf) },
    tracking: trackingOf({
      status: rma.status as ReturnStatus,
      requestedAt: toUtcIso(rma.requestedAt),
      authorisedAt: iso(rma.authorisedAt),
      goodsDueBy: dayOrNull(rma.goodsDueBy),
      receivedAt: iso(rma.receivedAt),
      inspectedAt: iso(rma.inspectedAt),
      closedAt: iso(rma.closedAt),
      linesReceived: received.length,
      linesDecided: decided.length,
    }),
    actions: returnActions({
      status: rma.status as ReturnStatus,
      lines: facts.lines.map((line) => ({ quantity: line.quantity, received: line.receivedQuantity, graded: line.grade !== null, disposition: line.disposition as ReturnDisposition | null, goodsOutcome: line.goodsOutcome as GoodsOutcome | null, replaced: line.replacementLineId !== null })),
      replacementOrder: rma.replacementOrderId !== null,
    }),
    // B-W2b-16: said in the close dialog before the click (the close answers the same warnings).
    closeWarnings: closeWarningsFor(facts.lines, facts.repairs, facts.ddts.live.length > 0),
    policy: { ...facts.policy, freightPaidByNow: freightPayerOf(facts.policy, (received.find((line) => line.cause)?.cause as ReturnCause | undefined) ?? null) },
    stockOutcomes: [...STOCK_OUTCOMES],
    version: rma.version,
    createdAt: toUtcIso(rma.createdAt),
    updatedAt: toUtcIso(rma.updatedAt),
  }
}

export type ReturnView = ReturnType<typeof returnView>
