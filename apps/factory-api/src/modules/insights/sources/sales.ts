import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { AttentionCandidate } from '@nexus/factory-domain/insights/attention'
import { AT_RISK_DAYS, orderPromiseState } from '@nexus/factory-domain/insights/states'
import { orderPromiseWords, quoteApprovalWords } from '@nexus/factory-domain/insights/words'
import { addDays } from '@nexus/factory-domain/invoicing/from-shipment/deadlines'
import { OPEN_STATUSES } from '@nexus/factory-domain/sales/orders/orders'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import { LEFT } from '../../sales/orders/store'
import { asDay, capped, dayOrNull, partyNames, SOURCE_LIMIT, type Source } from './common'

/**
 * Sales (B-W1-25 orders, B-W1-21 quotes): orders late or at risk against their promise (the orders module's daysLate),
 * and quote versions waiting for an approval (never shown to the person who asked; a margin-floor request only to an
 * approver who sees margins: the quotes module's own rules for deciding it).
 */

/** ORDER_PROMISE: open orders whose promise passed or comes within AT_RISK_DAYS. */
export const orderPromise: Source = async ({ caller, viewer }) => {
  const scope = scopeWhere(viewer.actor, ORDERS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.SalesOrderWhereInput
  return caller.withClient(async (db) => {
    const found = await db.salesOrder.findMany({
      where: { AND: [scope, { status: { in: [...OPEN_STATUSES] } }, { promiseDate: { lte: asDay(addDays(viewer.today, AT_RISK_DAYS)) } }] },
      orderBy: [{ promiseDate: 'asc' }, { id: 'asc' }],
      take: SOURCE_LIMIT + 1,
      select: { id: true, number: true, companyId: true, partyId: true, status: true, promiseDate: true, createdAt: true, currency: true, netAmount: true },
    })
    const { rows, complete } = capped(found, SOURCE_LIMIT)
    const ids = rows.map((row) => row.id)
    const ordered = ids.length > 0 ? await db.salesOrderLine.groupBy({ by: ['orderId'], where: { orderId: { in: ids } }, _sum: { quantity: true } }) : []
    const shipments = ids.length > 0 ? await db.shipment.findMany({ where: { salesOrderId: { in: ids }, status: { in: [...LEFT] } }, select: { id: true, salesOrderId: true } }) : []
    const shipped = shipments.length > 0 ? await db.shipmentLine.groupBy({ by: ['shipmentId'], where: { shipmentId: { in: shipments.map((row) => row.id) } }, _sum: { quantity: true } }) : []
    const names = await partyNames(db, rows.map((row) => row.partyId))
    const candidates: AttentionCandidate[] = []
    for (const row of rows) {
      const promiseDate = dayOrNull(row.promiseDate)
      const state = orderPromiseState(row.status, promiseDate, viewer.today)
      if (!state || promiseDate === null) continue
      const units = ordered.find((entry) => entry.orderId === row.id)?._sum.quantity ?? 0
      const left = shipped.filter((entry) => shipments.some((shipment) => shipment.id === entry.shipmentId && shipment.salesOrderId === row.id)).reduce((sum, entry) => sum + (entry._sum.quantity ?? 0), 0)
      const customer = names.get(row.partyId) ?? 'the customer'
      const words = orderPromiseWords({ number: row.number, customer, state: state.state, days: state.days, promiseDate, toShip: Math.max(0, units - left) })
      candidates.push({
        kind: 'ORDER_PROMISE',
        state: state.state,
        severity: state.severity,
        record: { type: 'SalesOrder', id: row.id, label: row.number },
        scope: { companyId: row.companyId, siteId: null, partyId: row.partyId },
        ...words,
        due: promiseDate,
        since: row.createdAt,
        amounts: { currency: row.currency, netAmount: row.netAmount },
      })
    }
    return { kind: 'ORDER_PROMISE', candidates, complete }
  })
}

/** QUOTE_APPROVAL: the waiting approval request of each quote version PENDING_APPROVAL. */
export const quoteApproval: Source = async ({ caller, viewer }) => {
  const scope = scopeWhere(viewer.actor, QUOTES_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.QuoteWhereInput
  return caller.withClient(async (db) => {
    const found = await db.quote.findMany({
      where: { AND: [scope, { status: 'PENDING_APPROVAL' }] },
      orderBy: { id: 'asc' },
      take: SOURCE_LIMIT + 1,
      select: { id: true, number: true, companyId: true, partyId: true },
    })
    const { rows: quotes, complete } = capped(found, SOURCE_LIMIT)
    if (quotes.length === 0) return { kind: 'QUOTE_APPROVAL', candidates: [], complete }
    const versions = await db.quoteVersion.findMany({
      where: { quoteId: { in: quotes.map((quote) => quote.id) }, status: 'PENDING_APPROVAL' },
      select: { id: true, quoteId: true, validUntil: true, currency: true, netAmount: true, marginPct: true, marginAmount: true },
    })
    const approvals = await db.quoteApproval.findMany({
      where: { versionId: { in: versions.map((version) => version.id) }, status: 'PENDING' },
      select: { id: true, versionId: true, reasons: true, createdAt: true, createdById: true },
    })
    const names = await partyNames(db, quotes.map((quote) => quote.partyId))
    const candidates: AttentionCandidate[] = []
    for (const approval of approvals) {
      const version = versions.find((entry) => entry.id === approval.versionId)!
      const quote = quotes.find((entry) => entry.id === version.quoteId)!
      const margin = approval.reasons.includes('MARGIN_FLOOR')
      candidates.push({
        kind: 'QUOTE_APPROVAL',
        state: 'PENDING',
        severity: 'MEDIUM',
        record: { type: 'Quote', id: quote.id, label: quote.number },
        scope: { companyId: quote.companyId, siteId: null, partyId: quote.partyId },
        ...quoteApprovalWords({ number: quote.number, customer: names.get(quote.partyId) ?? 'the customer', reasons: approval.reasons }),
        due: dayOrNull(version.validUntil),
        since: approval.createdAt,
        notBy: approval.createdById ? [approval.createdById] : [],
        ...(margin ? { needsGrain: 'margin' as const } : {}),
        amounts: {
          currency: version.currency,
          netAmount: version.netAmount,
          marginPct: version.marginPct === null ? null : version.marginPct.toString(),
          marginAmount: version.marginAmount,
          inSentence: margin ? 'marginPct' : 'netAmount',
        },
      })
    }
    return { kind: 'QUOTE_APPROVAL', candidates, complete }
  })
}
