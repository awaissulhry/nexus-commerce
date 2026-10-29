import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { daysLate, orderActions, type Progress, type SettlementAnswer } from '@nexus/factory-domain/sales/orders/orders'
import { priceBasisOf, priceText } from '@nexus/factory-domain/sales/quotes/quotes'
import { depositViewOf, DEPOSIT_COLUMNS } from '../deposits/deposits'
import { dayOf, dayOrNull, moveFactsOf, readOrderFacts, type OrderRow, type Reader } from './store'

/**
 * The order record as the office reads it (A2 SCR-039; the design's Order record): the header with its dates (the
 * first promise beside the promise now, days late), the lines with their size grids and per-size progress (ordered, in
 * work orders, made (null until the floor's scans), released, shipped, invoiced, to ship), the record chain (quote and
 * version → order → deposit requests → work orders → shipments → invoices), every promise change with who and why,
 * whether it is settled, and what may be done next. Prices are marked price, costs cost: the API drops what the
 * caller's grains do not reach.
 */

const text = (value: { toString(): string } | null): string | null => (value === null ? null : priceText(value.toString()))
const instantOrNull = (value: Date | null): string | null => (value === null ? null : toUtcIso(value))

interface PromiseAudit {
  promiseDate?: unknown
  previous?: unknown
  lineIds?: unknown
  originalPromiseDate?: unknown
}

/** Every promise change of the order, newest first (from its audit rows: who, when, from → to, which lines, why). */
async function promiseHistory(db: Reader, orderId: string) {
  const rows = await db.auditLog.findMany({
    where: { recordType: 'SalesOrder', recordId: orderId, action: 'orders.changePromise' },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    select: { at: true, actorId: true, after: true, reason: true },
  })
  return rows.map((row) => {
    const after = (row.after ?? {}) as PromiseAudit
    return {
      at: toUtcIso(row.at),
      actorId: row.actorId,
      from: typeof after.previous === 'string' ? after.previous : null,
      to: typeof after.promiseDate === 'string' ? after.promiseDate : '',
      lineIds: Array.isArray(after.lineIds) ? after.lineIds.filter((id): id is string => typeof id === 'string') : [],
      reason: row.reason,
    }
  })
}

export async function orderView(db: Reader, order: OrderRow, today: BusinessDate, settlement: SettlementAnswer) {
  const facts = await readOrderFacts(db, order)
  const party = await db.party.findUnique({ where: { id: order.partyId }, select: { code: true, legalName: true } })
  const styleIds = [...new Set(facts.lines.map((line) => line.styleId))]
  const styles = new Map((styleIds.length > 0 ? await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true, sizes: true } }) : []).map((row) => [row.id, row]))
  const colourwayIds = [...new Set(facts.lines.map((line) => line.colourwayId))]
  const colourways = new Map((colourwayIds.length > 0 ? await db.colourway.findMany({ where: { id: { in: colourwayIds } }, select: { id: true, code: true, name: true } }) : []).map((row) => [row.id, row]))
  const revisionIds = [...new Set(facts.lines.flatMap((line) => (line.styleRevisionId ? [line.styleRevisionId] : [])))]
  const revisions = new Map((revisionIds.length > 0 ? await db.styleRevision.findMany({ where: { id: { in: revisionIds } }, select: { id: true, revision: true, status: true } }) : []).map((row) => [row.id, row]))
  const version = order.quoteVersionId ? await db.quoteVersion.findUnique({ where: { id: order.quoteVersionId }, select: { id: true, quoteId: true, revision: true } }) : null
  const quote = version ? await db.quote.findUnique({ where: { id: version.quoteId }, select: { id: true, number: true } }) : null
  const deposits = await db.depositRequest.findMany({
    where: { OR: [{ orderId: order.id }, ...(order.quoteVersionId ? [{ quoteVersionId: order.quoteVersionId }] : [])] },
    select: DEPOSIT_COLUMNS,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const history = await promiseHistory(db, order.id)

  const progressOf = (lineId: string, size: string | null) => facts.progress.rows.find((row) => row.lineId === lineId && row.size === size)
  const strip = (row: Progress) => ({ ordered: row.ordered, inWorkOrders: row.inWorkOrders, made: row.made, released: row.released, shipped: row.shipped, invoiced: row.invoiced, toShip: row.toShip })
  const promiseDate = dayOrNull(order.promiseDate)

  return {
    id: order.id,
    number: order.number,
    companyId: order.companyId,
    partyId: order.partyId,
    party: party ? { code: party.code, legalName: party.legalName } : null,
    customerRef: order.customerRef,
    status: order.status,
    orderDate: dayOf(order.orderDate),
    currency: order.currency,
    language: order.language,
    taxMode: order.taxMode,
    priceBasis: priceBasisOf(order.taxMode),
    billTo: order.billTo as Record<string, unknown>,
    shipTo: order.shipTo as Record<string, unknown>,
    paymentTerms: order.paymentTerms,
    requestedDate: dayOrNull(order.requestedDate),
    promiseDate,
    originalPromiseDate: dayOrNull(order.originalPromiseDate),
    daysLate: daysLate(order.status, promiseDate, today),
    priority: order.priority,
    noWithdrawal: order.noWithdrawal,
    depositRequired: order.depositRequired,
    netAmount: asMoney('price', order.netAmount),
    vatAmount: asMoney('price', order.vatAmount),
    grossAmount: asMoney('price', order.grossAmount),
    costAmount: asMoney('cost', order.costAmount),
    reapprovalNeededAt: instantOrNull(order.reapprovalNeededAt),
    cancelReason: order.cancelReason,
    closedAt: instantOrNull(order.closedAt),
    internalNote: order.internalNote,
    version: order.version,
    createdAt: toUtcIso(order.createdAt),
    updatedAt: toUtcIso(order.updatedAt),
    createdById: order.createdById,
    lines: facts.lines.map((line) => {
      const style = styles.get(line.styleId)
      const range = style?.sizes ?? []
      const place = (size: string) => (range.indexOf(size) === -1 ? range.length : range.indexOf(size))
      const sizes = [...line.sizes].sort((a, b) => place(a.size) - place(b.size) || a.size.localeCompare(b.size))
      const revision = line.styleRevisionId ? revisions.get(line.styleRevisionId) : undefined
      const colourway = colourways.get(line.colourwayId)
      const totals = facts.progress.lines.find((entry) => entry.lineId === line.id)!
      return {
        id: line.id,
        seq: line.seq,
        kind: line.kind,
        quoteLineId: line.quoteLineId,
        styleId: line.styleId,
        style: style ? { code: style.code, name: style.name } : null,
        styleRevisionId: line.styleRevisionId,
        styleRevision: revision ? { revision: revision.revision, status: revision.status } : null,
        colourwayId: line.colourwayId,
        colourway: colourway ? { code: colourway.code, name: colourway.name } : null,
        measurementProfileId: line.measurementProfileId,
        baseSize: line.baseSize,
        description: line.description,
        note: line.note,
        quantity: line.quantity,
        unitPrice: asMoney('price', text(line.unitPrice)!),
        netAmount: asMoney('price', line.netAmount),
        vatRatePct: line.vatRatePct.toFixed(2),
        vatNature: line.vatNature,
        vatAmount: asMoney('price', line.vatAmount),
        unitCost: asMoney('cost', text(line.unitCost)),
        costAmount: asMoney('cost', line.costAmount),
        requestedDate: dayOrNull(line.requestedDate),
        promiseDate: dayOrNull(line.promiseDate),
        priority: line.priority,
        siteId: line.siteId,
        version: line.version,
        sizes:
          sizes.length > 0
            ? sizes.map((size) => ({ size: size.size, quantity: size.quantity, unitPrice: asMoney('price', text(size.unitPrice)), progress: strip(progressOf(line.id, size.size)!) }))
            : [{ size: null, quantity: line.quantity, unitPrice: asMoney('price', null), progress: strip(progressOf(line.id, null)!) }],
        progress: strip(totals),
      }
    }),
    progress: strip(facts.progress.totals),
    chain: {
      quote: quote && version ? { id: quote.id, number: quote.number, versionId: version.id, revision: version.revision } : null,
      depositRequests: deposits.map((row) => {
        const view = depositViewOf(row)
        return { ...view, amount: asMoney('price', view.amount) }
      }),
      workOrders: facts.workOrders.map((row) => ({ id: row.id, number: row.number, status: row.status, siteId: row.siteId, releasedAt: instantOrNull(row.releasedAt) })),
      shipments: facts.shipments.map((row) => ({ id: row.id, number: row.number, status: row.status, shippedAt: instantOrNull(row.shippedAt), deliveredAt: instantOrNull(row.deliveredAt) })),
      invoices: facts.invoices.map((row) => ({ id: row.id, number: row.number, docType: row.docType, status: row.status, issueDate: dayOrNull(row.issueDate) })),
    },
    promiseHistory: history,
    settlement: { settled: settlement.settled, missing: settlement.missing.map((entry) => ({ code: entry.code, message: entry.message })), source: settlement.source },
    actions: orderActions(order.status, moveFactsOf(facts, settlement)),
  }
}

export type OrderView = Awaited<ReturnType<typeof orderView>>
