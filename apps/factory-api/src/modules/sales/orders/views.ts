import type { MinorUnits } from '@nexus/factory-domain/core/money'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { linkState } from '@nexus/factory-domain/links/purposes'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { cancelBlocksOf, cancelImpact, dailyActions } from '@nexus/factory-domain/sales/orders/daily'
import { CANCEL_STATUSES, daysLate, orderActions, type Progress, type SettlementAnswer } from '@nexus/factory-domain/sales/orders/orders'
import { priceBasisOf, priceText } from '@nexus/factory-domain/sales/quotes/quotes'
import { Dec, HUNDRED } from '@nexus/factory-domain/tax/decimal'
import { serverClock } from '../../../core/time'
import { depositViewOf, DEPOSIT_COLUMNS } from '../deposits/deposits'
import { readCancelFacts } from './impact'
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

/** Margin % of the net (4 places, as the quotes write it), or null without a cost or a net. */
function marginPctOf(net: MinorUnits, cost: MinorUnits | null): string | null {
  if (cost === null || net === 0) return null
  const pct = new Dec(net - cost).times(HUNDRED).dividedBy(net).toDecimalPlaces(4, Dec.ROUND_HALF_UP)
  return pct.abs().gte(100_000) ? null : decimalText(pct)
}

/** Each request's payments placed on it (allocations less their reversals) and its latest DEPOSIT_INFO page. */
async function depositFacts(db: Reader, requestIds: readonly string[], now: Date) {
  if (requestIds.length === 0) return { paid: new Map<string, number>(), links: new Map<string, { sentAt: string; to: string | null; expiresAt: string; state: ReturnType<typeof linkState> }>() }
  const placed = await db.paymentAllocation.groupBy({ by: ['depositRequestId'], where: { depositRequestId: { in: [...requestIds] } }, _sum: { amount: true } })
  const links = await db.oneOffLink.findMany({
    where: { purpose: 'DEPOSIT_INFO', recordType: 'DepositRequest', recordId: { in: [...requestIds] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { recordId: true, email: true, createdAt: true, expiresAt: true, revokedAt: true, uses: true, maxUses: true },
  })
  const latest = new Map<string, { sentAt: string; to: string | null; expiresAt: string; state: ReturnType<typeof linkState> }>()
  for (const link of links) {
    if (latest.has(link.recordId)) continue
    latest.set(link.recordId, { sentAt: toUtcIso(link.createdAt), to: link.email, expiresAt: toUtcIso(link.expiresAt), state: linkState(link, now) })
  }
  return { paid: new Map(placed.flatMap((row) => (row.depositRequestId ? [[row.depositRequestId, row._sum.amount ?? 0] as const] : []))), links: latest }
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
  const placed = await depositFacts(db, deposits.map((row) => row.id), serverClock.now())
  // B-W2a-F2: which step of the schedule names each request (the deposit, or a before-shipping step's own).
  const stepKinds = new Map(
    (deposits.length > 0 ? await db.salesOrderMilestone.findMany({ where: { depositRequestId: { in: deposits.map((row) => row.id) } }, select: { depositRequestId: true, kind: true } }) : []).flatMap((row) =>
      row.depositRequestId && (row.kind === 'DEPOSIT' || row.kind === 'BEFORE_SHIPPING') ? [[row.depositRequestId, row.kind] as const] : [],
    ),
  )
  const peopleIds = [...new Set([order.createdById, ...history.map((entry) => entry.actorId), ...facts.lines.map((line) => line.closedShortById)].filter((id): id is string => id !== null))]
  const people = peopleIds.length > 0 ? await db.user.findMany({ where: { id: { in: peopleIds } }, select: { id: true, displayName: true }, orderBy: { id: 'asc' } }) : []

  const progressOf = (lineId: string, size: string | null) => facts.progress.rows.find((row) => row.lineId === lineId && row.size === size)
  const strip = (row: Progress) => ({ ordered: row.ordered, inWorkOrders: row.inWorkOrders, made: row.made, released: row.released, shipped: row.shipped, invoiced: row.invoiced, toShip: row.toShip, closedShort: row.closedShort })
  // B-W2a-30: the amendments so far (the Changes tab reads them whole: GET …/amendments) and the daily actions.
  const amendments = await db.salesOrderAmendment.findMany({ where: { orderId: order.id }, select: { revision: true, createdAt: true }, orderBy: { revision: 'desc' } })
  // The cancel action is held by what the impact check says stops it (a shipment being packed, an invoice).
  const cancelBlocks = CANCEL_STATUSES.includes(order.status) ? cancelBlocksOf(cancelImpact(await readCancelFacts(db, order, facts))) : []
  const shortLines = facts.lines.map((line) => ({ id: line.id, seq: line.seq, quantity: line.quantity, shipped: facts.progress.lines.find((entry) => entry.lineId === line.id)?.shipped ?? 0, closedShort: line.closedShortQuantity !== null }))
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
    paymentTermsId: order.paymentTermsId,
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
    marginPct: asMoney('margin', marginPctOf(order.netAmount, order.costAmount)),
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
        closedShort:
          line.closedShortQuantity === null
            ? null
            : { quantity: line.closedShortQuantity, at: instantOrNull(line.closedShortAt), byId: line.closedShortById, reason: line.closeShortReason, reasonCode: line.closedShortReasonCode },
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
        // The percentage as the database holds it ("30.0000" → "30"; deposits.ts's own text turns a whole "30" into "3").
        const depositPct = row.depositPct === null ? null : decimalText(row.depositPct.toString())
        return { ...view, depositPct, amount: asMoney('price', view.amount), paidAmount: asMoney('price', placed.paid.get(row.id) ?? 0), link: placed.links.get(row.id) ?? null, stepKind: stepKinds.get(row.id) ?? null, version: row.version }
      }),
      workOrders: facts.workOrders.map((row) => ({ id: row.id, number: row.number, status: row.status, siteId: row.siteId, releasedAt: instantOrNull(row.releasedAt) })),
      shipments: facts.shipments.map((row) => ({ id: row.id, number: row.number, status: row.status, shippedAt: instantOrNull(row.shippedAt), deliveredAt: instantOrNull(row.deliveredAt) })),
      invoices: facts.invoices.map((row) => ({ id: row.id, number: row.number, docType: row.docType, status: row.status, issueDate: dayOrNull(row.issueDate), depositRequestId: row.depositRequestId })),
    },
    promiseHistory: history,
    people: people.map((user) => ({ id: user.id, name: user.displayName })),
    settlement: { settled: settlement.settled, missing: settlement.missing.map((entry) => ({ code: entry.code, message: entry.message })), source: settlement.source },
    actions: orderActions(order.status, { ...moveFactsOf(facts, settlement), cancelBlocks }),
    dailyActions: dailyActions(order.status, shortLines),
    amendments: { count: amendments.length, latestRevision: amendments[0]?.revision ?? null, latestAt: amendments[0] ? toUtcIso(amendments[0].createdAt) : null },
    /** SAL-209: a confirmed order's lines change only through an amendment. */
    locked: true,
  }
}

export type OrderView = Awaited<ReturnType<typeof orderView>>
