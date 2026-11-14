import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { leadSummary, type LeadKind } from '@nexus/factory-domain/insights/kpis/lead-times'
import { PRODUCT_TYPES, type ProductType } from '@nexus/factory-domain/product/styles/rules'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { SalesOrderPriorityLevel } from '@nexus/factory-domain/sales/orders-depth/rules'
import type { CommandCaller } from '../../../../core/command'
import { readLeadOrders } from '../../facts/sources/lead-times'
import { asOf, companiesFor, drillActor, groupBy, limited, namesOf, refOf, spanOf } from './access'

/**
 * GET /insights/kpis/drills/lead-times (B-W2b-429; ANA-014; KPIs sales.quote_to_order_days, delivery.order_to_ship_days,
 * production.order_to_start_days): the orders whose time of one kind ended in the period (the lead-times source's own read),
 * with the median, the spread (the middle half) and the average, overall and by product family. Filters: period, kind,
 * customer, style (an order with a line of it), season, priority, family. orders.view over the order's company and customer.
 */

export interface LeadDrillQuery {
  readonly from?: BusinessDate | undefined
  readonly to?: BusinessDate | undefined
  readonly kind?: LeadKind | undefined
  readonly companyId?: string | undefined
  readonly partyId?: string | undefined
  readonly styleId?: string | undefined
  readonly seasonId?: string | undefined
  readonly priority?: SalesOrderPriorityLevel | undefined
  readonly family?: ProductType | undefined
}

const KPI_OF_LEAD: Record<LeadKind, string> = {
  QUOTE_TO_ORDER: 'sales.quote_to_order_days',
  ORDER_TO_SHIP: 'delivery.order_to_ship_days',
  ORDER_TO_START: 'production.order_to_start_days',
}

export async function leadDrill(caller: CommandCaller, query: LeadDrillQuery) {
  const kind = query.kind ?? 'ORDER_TO_SHIP'
  const kpiKey = KPI_OF_LEAD[kind]
  const actor = drillActor(caller, [kpiKey])
  const span = spanOf(kpiKey, query)
  return caller.withClient(async (db) => {
    const companies = await companiesFor(db, actor, ORDERS_VIEW, query.companyId)
    const zone = new Map(companies.map((company) => [company.id, company.timezone]))
    const extra: Prisma.SalesOrderWhereInput = {
      ...(query.partyId ? { partyId: query.partyId } : {}),
      ...(query.seasonId ? { seasonId: query.seasonId } : {}),
      ...(query.priority ? { priorityLevel: query.priority } : {}),
      ...(query.styleId ? { lines: { some: { styleId: query.styleId } } } : {}),
    }
    const orders = (await readLeadOrders(db, { kind, companyIds: companies.map((company) => company.id), from: span.from, to: span.to, timeZoneOf: (companyId) => zone.get(companyId)!, where: scopeWhere(actor, ORDERS_VIEW, { company: 'companyId', party: 'partyId' }), extra })).filter((order) => !query.family || order.family === query.family)
    const names = await namesOf(db, { parties: orders.map((order) => order.partyId), seasons: orders.map((order) => order.seasonId) })
    const rank = (family: string | null) => (family === null ? PRODUCT_TYPES.length : PRODUCT_TYPES.indexOf(family as ProductType))
    const { rows, more } = limited(orders)
    return {
      kpiKey,
      kind,
      period: span,
      asOf: asOf(),
      overall: leadSummary(orders.map((order) => order.days)),
      families: [...groupBy(orders, (order) => order.family ?? 'NONE')].map(([family, mine]) => ({ family: family === 'NONE' ? null : (family as ProductType), ...leadSummary(mine.map((order) => order.days)) })).sort((a, b) => rank(a.family) - rank(b.family)),
      rows: rows.map((order) => ({
        record: { type: 'SalesOrder', id: order.orderId, label: order.number },
        order: { id: order.orderId, number: order.number, orderDate: order.orderDate },
        customer: refOf(names.party, order.partyId),
        family: order.family as ProductType | null,
        season: refOf(names.season, order.seasonId),
        priority: order.priorityLevel as SalesOrderPriorityLevel,
        fromDay: order.fromDay,
        toDay: order.toDay,
        days: order.days,
      })),
      more,
    }
  })
}
