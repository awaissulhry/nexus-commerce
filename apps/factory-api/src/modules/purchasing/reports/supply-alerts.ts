import type { Prisma } from '@nexus/factory-db'
import { thresholdOf } from '@nexus/factory-domain/alerts/kinds'
import type { Finding, RulePlace } from '@nexus/factory-domain/alerts/rules'
import { businessDate } from '@nexus/factory-domain/core/time'
import { OPEN_ORDER_STATUSES, SUPPLY_ALERT_STATUSES, UNSENT_ORDER_STATUSES, worstConfirmedLate } from '@nexus/factory-domain/purchasing/reports/rules'
import type { CommandTx } from '../../../core/command'
import { atRiskOf, blocksOf, workLinesOf } from '../expediting/lines'

/**
 * The supply alerts' finders (B-W2b-350; SCM-174 "Supply alerts are daily running"; factory-domain alerts/kinds
 * PO_CONFIRMED_LATE and SUPPLIER_STATUS_CHANGED; platform/alerts/evaluators FINDERS), in the tenant's system scope, reads only.
 * The third supply alert, "not confirmed in time", is the W2a kind PO_NOT_CONFIRMED (its confirm-by time). No money, no person.
 *
 *   PO_CONFIRMED_LATE        one alert per purchase order of the rule's place with an open line the supplier confirmed at least
 *                            the rule's days later than it is needed (the expediting worklist's lines: B-W2b-305's workLinesOf,
 *                            next delivery first); the facts name the worst line's dates and the customer orders the order's late
 *                            lines put at risk (the latest finished plan's pegging, blocksOf), the first by its promise.
 *   SUPPLIER_STATUS_CHANGED  one alert per supplier (a party of the rule's company, or shared) whose supplier status was set to
 *                            approved with conditions, on hold, blocked or inactive within the rule's days and still is; the facts
 *                            say the status, the day and how many of its orders are open or not sent yet at the rule's place.
 */

const DAY = 86_400_000
const placeWhere = (rule: RulePlace): Prisma.PurchaseOrderWhereInput => ({ ...(rule.companyId ? { companyId: rule.companyId } : {}), ...(rule.siteId ? { siteId: rule.siteId } : {}) })

/** PO_CONFIRMED_LATE: purchase orders with an open line confirmed later than needed by at least the rule's days. */
export async function confirmedLateFindings(tx: CommandTx, rule: RulePlace & { readonly threshold: unknown }, now: Date, only?: readonly string[]): Promise<Finding[]> {
  const { days } = thresholdOf('PO_CONFIRMED_LATE', rule.threshold) as { days: number }
  const today = businessDate(now)
  const read = await workLinesOf(tx, [placeWhere(rule), only ? { id: { in: [...only] } } : {}], today, now)
  const late = read.lines.filter((line) => line.confirmedLaterBy >= days)
  if (late.length === 0) return []
  const { blocks } = await blocksOf(
    tx,
    late.map((line) => ({ id: line.lineId, siteId: line.order.siteId, expectedDate: line.expectedDate })),
  )
  const byOrder = new Map<string, typeof late>()
  for (const line of late) byOrder.set(line.purchaseOrderId, [...(byOrder.get(line.purchaseOrderId) ?? []), line])
  const findings: Finding[] = []
  for (const [orderId, lines] of byOrder) {
    const worst = worstConfirmedLate(lines)
    if (!worst) continue
    const order = lines[0]!.order
    const entries = lines.flatMap((line) => blocks.get(line.lineId) ?? [])
    const risk = atRiskOf(entries)
    const first = entries
      .filter((entry) => entry.lateBy > 0 && entry.salesOrder)
      .sort((a, b) => (a.salesOrder!.promiseDate ?? a.demandDate).localeCompare(b.salesOrder!.promiseDate ?? b.demandDate) || a.salesOrder!.number.localeCompare(b.salesOrder!.number))[0]
    findings.push({
      recordType: 'PurchaseOrder',
      recordId: orderId,
      label: order.number,
      scope: { companyId: order.companyId, siteId: order.siteId, partyId: order.partyId },
      facts: {
        days: worst.days,
        threshold: days,
        needDate: worst.needDate,
        confirmedDate: worst.confirmedDate,
        seq: worst.line.seq,
        lines: lines.length,
        salesOrdersAtRisk: risk.salesOrders,
        workOrdersAtRisk: risk.workOrders,
        // The customer order it puts at risk first (its number: the alert's words), else none.
        salesOrder: first?.salesOrder?.number ?? '',
      },
    })
  }
  return findings
}

/** SUPPLIER_STATUS_CHANGED: suppliers set to a status that limits or stops buying within the rule's days, still in it. */
export async function supplierStatusFindings(tx: CommandTx, rule: RulePlace & { readonly threshold: unknown }, now: Date, only?: readonly string[]): Promise<Finding[]> {
  const { days } = thresholdOf('SUPPLIER_STATUS_CHANGED', rule.threshold) as { days: number }
  const rows = await tx.party.findMany({
    where: {
      ...(only ? { id: { in: [...only] } } : {}),
      ...(rule.companyId ? { OR: [{ companyId: rule.companyId }, { companyId: null }] } : {}),
      supplierStatus: { in: [...SUPPLY_ALERT_STATUSES] },
      supplierStatusChangedAt: { gte: new Date(now.getTime() - days * DAY) },
    },
    orderBy: [{ supplierStatusChangedAt: 'desc' }, { id: 'asc' }],
    take: 500,
    select: { id: true, code: true, legalName: true, tradeName: true, companyId: true, supplierStatus: true, supplierStatusChangedAt: true },
  })
  if (rows.length === 0) return []
  const counted = await tx.purchaseOrder.groupBy({
    by: ['partyId', 'status'],
    where: { ...placeWhere(rule), partyId: { in: rows.map((row) => row.id) }, status: { in: [...OPEN_ORDER_STATUSES, ...UNSENT_ORDER_STATUSES] } },
    _count: { _all: true },
  })
  const countOf = (partyId: string, statuses: readonly string[]) => counted.filter((row) => row.partyId === partyId && statuses.includes(row.status)).reduce((sum, row) => sum + row._count._all, 0)
  return rows.map((row) => ({
    recordType: 'Party',
    recordId: row.id,
    label: `${row.code} ${row.tradeName ?? row.legalName}`,
    scope: { companyId: row.companyId, siteId: null, partyId: row.id },
    facts: {
      status: row.supplierStatus!,
      changedOn: businessDate(row.supplierStatusChangedAt!),
      days: Math.floor((now.getTime() - row.supplierStatusChangedAt!.getTime()) / DAY),
      threshold: days,
      openOrders: countOf(row.id, OPEN_ORDER_STATUSES),
      unsentOrders: countOf(row.id, UNSENT_ORDER_STATUSES),
    },
  }))
}
