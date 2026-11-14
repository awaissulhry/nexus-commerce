import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { otifOf, type OtifOutcome, type OtifPromise } from '@nexus/factory-domain/insights/kpis/otif'
import { onTimePct } from '@nexus/factory-domain/insights/kpis/supplier-on-time'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { SalesOrderPriorityLevel } from '@nexus/factory-domain/sales/orders-depth/rules'
import type { CommandCaller } from '../../../../core/command'
import { serverClock } from '../../../../core/time'
import { readOtifLines } from '../../facts/sources/delivery'
import { asOf, companiesFor, drillActor, groupBy, limited, namesOf, refOf, spanOf } from './access'

/**
 * GET /insights/kpis/drills/otif (B-W2b-429; ANA-013; KPI delivery.otif / delivery.otif_current): the garment order lines due
 * in the period on their first (or current) promise, as the facts count them (the delivery source's own read), each with its
 * promise, the day it was complete and how late; by customer, site (the line's making site) and month. Filters: period,
 * customer, style, season, priority, site, outcome. orders.view over the line's company and customer.
 */

export interface OtifDrillQuery {
  readonly from?: BusinessDate | undefined
  readonly to?: BusinessDate | undefined
  readonly promise?: OtifPromise | undefined
  readonly outcome?: OtifOutcome | undefined
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
  readonly partyId?: string | undefined
  readonly styleId?: string | undefined
  readonly seasonId?: string | undefined
  readonly priority?: SalesOrderPriorityLevel | undefined
}

const rateOf = (rows: readonly { outcome: OtifOutcome }[]) => {
  const onTime = rows.filter((row) => row.outcome === 'ON_TIME').length
  return { due: rows.length, onTime, pct: onTimePct(onTime, rows.length) }
}

export async function otifDrill(caller: CommandCaller, query: OtifDrillQuery) {
  const promise = query.promise ?? 'FIRST'
  const kpiKey = promise === 'FIRST' ? 'delivery.otif' : 'delivery.otif_current'
  const actor = drillActor(caller, [kpiKey])
  const span = spanOf(kpiKey, query)
  return caller.withClient(async (db) => {
    const companies = await companiesFor(db, actor, ORDERS_VIEW, query.companyId)
    const zone = new Map(companies.map((company) => [company.id, company.timezone]))
    const extra: Prisma.SalesOrderLineWhereInput = {
      ...(query.siteId ? { siteId: query.siteId } : {}),
      ...(query.partyId ? { partyId: query.partyId } : {}),
      ...(query.styleId ? { styleId: query.styleId } : {}),
      ...(query.seasonId || query.priority ? { order: { ...(query.seasonId ? { seasonId: query.seasonId } : {}), ...(query.priority ? { priorityLevel: query.priority } : {}) } } : {}),
    }
    const lines = await readOtifLines(db, { companyIds: companies.map((company) => company.id), from: span.from, to: span.to, timeZoneOf: (companyId) => zone.get(companyId)!, where: scopeWhere(actor, ORDERS_VIEW, { company: 'companyId', party: 'partyId' }), extra })
    const all = lines.flatMap((line) => {
      const today = businessDate(serverClock.now(), zone.get(line.row.companyId)!)
      const result = otifOf(line, promise, today)
      if (!result || result.promise < span.from || result.promise > span.to) return []
      if (query.outcome && result.outcome !== query.outcome) return []
      return [{ line, result, outcome: result.outcome }]
    })
    // Late first, the most days late first; then the promise and the order.
    all.sort((a, b) => (a.outcome !== b.outcome ? (a.outcome === 'LATE' ? -1 : 1) : b.result.lateDays - a.result.lateDays || (a.result.promise < b.result.promise ? -1 : a.result.promise > b.result.promise ? 1 : a.line.row.order.number < b.line.row.order.number ? -1 : a.line.row.order.number > b.line.row.order.number ? 1 : a.line.row.seq - b.line.row.seq)))
    const names = await namesOf(db, { parties: all.map((row) => row.line.row.partyId), sites: all.map((row) => row.line.row.siteId), seasons: all.map((row) => row.line.row.order.seasonId) })
    const totals = rateOf(all)
    const { rows, more } = limited(all)
    return {
      kpiKey,
      promise,
      period: span,
      asOf: asOf(),
      overall: { ...totals, late: totals.due - totals.onTime },
      byCustomer: [...groupBy(all, (row) => row.line.row.partyId)].map(([partyId, mine]) => ({ customer: refOf(names.party, partyId), ...rateOf(mine) })).sort((a, b) => b.due - a.due || (a.customer?.code ?? '').localeCompare(b.customer?.code ?? '')),
      bySite: [...groupBy(all, (row) => row.line.row.siteId ?? 'none')].map(([siteId, mine]) => ({ site: siteId === 'none' ? null : refOf(names.site, siteId), ...rateOf(mine) })).sort((a, b) => (a.site?.code ?? '~').localeCompare(b.site?.code ?? '~')),
      byMonth: [...groupBy(all, (row) => row.result.promise.slice(0, 7))].map(([month, mine]) => ({ month, ...rateOf(mine) })).sort((a, b) => a.month.localeCompare(b.month)),
      rows: rows.map(({ line, result }) => ({
        record: { type: 'SalesOrder', id: line.row.orderId, label: line.row.order.number },
        lineId: line.row.id,
        seq: line.row.seq,
        order: { id: line.row.orderId, number: line.row.order.number },
        customer: refOf(names.party, line.row.partyId),
        style: { id: line.row.styleId, code: line.row.style.code, name: line.row.style.name },
        family: line.row.style.productType,
        site: refOf(names.site, line.row.siteId),
        season: refOf(names.season, line.row.order.seasonId),
        priority: line.row.order.priorityLevel,
        due: result.due,
        firstPromise: line.firstPromise,
        currentPromise: line.currentPromise,
        promise: result.promise,
        shippedByPromise: result.shippedByPromise,
        completeOn: result.completeOn,
        outcome: result.outcome,
        lateDays: result.lateDays,
      })),
      more,
    }
  })
}
