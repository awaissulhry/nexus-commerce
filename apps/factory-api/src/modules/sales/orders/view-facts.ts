import type { Prisma } from '@nexus/factory-db'
import { thresholdOf } from '@nexus/factory-domain/alerts/kinds'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { invoicedOf, type Invoiced } from '@nexus/factory-domain/sales/orders/invoiced'
import { AT_RISK_STATUSES, riskDaysFor } from '@nexus/factory-domain/sales/orders/later-columns'
import { plusCalendarDays } from '@nexus/factory-domain/timers/rules'
import { asDay, LEFT, type Reader } from './store'

/**
 * What the orders of a whole view are, read in bulk (B-TH-058 / B-TH-059; threads plan TH-4; SHEET-G08): the overall view's
 * totals (./summary) and the list's Invoiced and At risk terms (./orders viewWhere) read the same facts the rows carry, by
 * the view's own filter (relation filters: no id list is sent for the view), so a total and the rows it opens never disagree.
 *
 *   piecesOf        each order's pieces ordered (its lines), closed short and shipped (its shipments that left, the row's
 *                   `shippedUnits`)
 *   invoicedByOrder each order's Invoiced (factory-domain invoicedOf, rule C8: the row's `invoiced`); an order without lines
 *                   is absent (None, nothing to invoice)
 *   riskRulesOf     the enabled ORDER_LATE_RISK rules' places and thresholds (factory-domain alerts thresholdOf), and
 *   atRiskWhere     the orders they call at risk now (factory-domain atRiskOf as a filter: per company its widest covering
 *                   threshold; no rule: no order)
 */

export interface OrderPieces {
  readonly ordered: number
  readonly closedShort: number
  readonly shipped: number
}

export async function piecesOf(client: Reader, where: Prisma.SalesOrderWhereInput): Promise<Map<string, OrderPieces>> {
  const lines = await client.salesOrderLine.groupBy({ by: ['orderId'], where: { order: where }, _sum: { quantity: true, closedShortQuantity: true } })
  const shipments = await client.shipment.findMany({ where: { salesOrder: where, status: { in: [...LEFT] } }, select: { id: true, salesOrderId: true } })
  const left = shipments.length > 0 ? await client.shipmentLine.groupBy({ by: ['shipmentId'], where: { shipmentId: { in: shipments.map((row) => row.id) } }, _sum: { quantity: true } }) : []
  const orderOfShipment = new Map(shipments.map((row) => [row.id, row.salesOrderId]))
  const shipped = new Map<string, number>()
  for (const row of left) {
    const orderId = orderOfShipment.get(row.shipmentId)
    if (orderId) shipped.set(orderId, (shipped.get(orderId) ?? 0) + (row._sum.quantity ?? 0))
  }
  const out = new Map<string, OrderPieces>()
  for (const row of lines) out.set(row.orderId, { ordered: row._sum.quantity ?? 0, closedShort: row._sum.closedShortQuantity ?? 0, shipped: shipped.get(row.orderId) ?? 0 })
  for (const [orderId, pieces] of shipped) if (!out.has(orderId)) out.set(orderId, { ordered: 0, closedShort: 0, shipped: pieces })
  return out
}

export async function invoicedByOrder(client: Reader, where: Prisma.SalesOrderWhereInput): Promise<Map<string, Invoiced>> {
  const lines = await client.salesOrderLine.findMany({ where: { order: where }, select: { id: true, orderId: true, kind: true, quantity: true, closedShortQuantity: true, feeCreditedAt: true } })
  if (lines.length === 0) return new Map()
  const billed = await client.invoiceLine.findMany({
    where: { salesOrderLine: { order: where }, kind: { in: ['GOODS', 'SERVICE'] } },
    select: { salesOrderLineId: true, kind: true, quantity: true, netAmount: true, invoice: { select: { docType: true, status: true } } },
  })
  const orderOfLine = new Map(lines.map((line) => [line.id, line.orderId]))
  const linesOf = new Map<string, typeof lines>()
  for (const line of lines) linesOf.set(line.orderId, [...(linesOf.get(line.orderId) ?? []), line])
  const billedOf = new Map<string, typeof billed>()
  for (const row of billed) {
    const orderId = row.salesOrderLineId ? orderOfLine.get(row.salesOrderLineId) : undefined
    if (orderId) billedOf.set(orderId, [...(billedOf.get(orderId) ?? []), row])
  }
  const out = new Map<string, Invoiced>()
  for (const [orderId, own] of linesOf) {
    out.set(
      orderId,
      invoicedOf(
        own.map((line) => ({ id: line.id, kind: line.kind, quantity: line.quantity, closedShortQuantity: line.closedShortQuantity, feeCredited: line.kind === 'FEE' && line.feeCreditedAt !== null })),
        (billedOf.get(orderId) ?? []).map((row) => ({ docType: row.invoice.docType, status: row.invoice.status, kind: row.kind, salesOrderLineId: row.salesOrderLineId, quantity: row.quantity.toString(), netAmount: row.netAmount })),
      ),
    )
  }
  return out
}

export interface RiskRule {
  readonly companyId: string | null
  readonly daysBeforePromise: number
}

export async function riskRulesOf(client: Reader): Promise<RiskRule[]> {
  const rules = await client.alertRule.findMany({ where: { ruleKind: 'ORDER_LATE_RISK', enabled: true }, select: { companyId: true, threshold: true } })
  return rules.map((rule) => ({ companyId: rule.companyId, daysBeforePromise: Number(thresholdOf('ORDER_LATE_RISK', rule.threshold).daysBeforePromise) }))
}

export function atRiskWhere(rules: readonly RiskRule[], today: BusinessDate): Prisma.SalesOrderWhereInput {
  if (rules.length === 0) return { id: { in: [] } }
  const within = (days: number): Prisma.SalesOrderWhereInput => ({ status: { in: [...AT_RISK_STATUSES] }, promiseDate: { gte: asDay(today), lte: asDay(plusCalendarDays(today, days)) } })
  const companies = [...new Set(rules.flatMap((rule) => (rule.companyId ? [rule.companyId] : [])))]
  const everywhere = rules.some((rule) => rule.companyId === null) ? Math.max(...rules.filter((rule) => rule.companyId === null).map((rule) => rule.daysBeforePromise)) : null
  return {
    OR: [
      ...companies.map((companyId) => ({ AND: [{ companyId }, within(riskDaysFor(rules, companyId)!)] })),
      ...(everywhere !== null ? [{ AND: [companies.length > 0 ? { companyId: { notIn: companies } } : {}, within(everywhere)] }] : []),
    ],
  }
}
