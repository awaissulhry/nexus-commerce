import type { Prisma } from '@nexus/factory-db'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { ageBucketOf, ageDays, waitingSince, WIP_AGE_BUCKETS, type WipAgeBucket } from '@nexus/factory-domain/insights/kpis/wip'
import { periodOf } from '@nexus/factory-domain/insights/periods/periods'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { PRODUCTION_REPORTS_VIEW } from '@nexus/factory-domain/production/reports/permissions'
import type { CommandCaller } from '../../../../core/command'
import { serverClock } from '../../../../core/time'
import { wipFor } from '../../../production/scans/progress'
import { asOf, drillActor, holdsGrain, limited, namesOf, refOf, sitesFor } from './access'

/**
 * GET /insights/kpis/drills/wip (B-W2b-429; ANA-015 "units and value in each stage and how long they waited, by line"; KPIs
 * production.wip_pieces, production.wip_age_days): every work order in work now (released, in progress, on hold) of the sites
 * I read, with its garments waiting at each stage (the floor's own WIP: factory-domain production/scans/wip, per operation of
 * its routing), how long they have waited (since its latest report, else its start, else its release) and its value at cost
 * (the cost ledger's balance: only with costing.view and the cost grain); per line and stage with the garments waiting in
 * each age band. Filters: site, line (or none), the week it was released, waited at least N days. production.reports.view
 * over the work order's company and site. Never per person or station.
 */

export interface WipDrillQuery {
  readonly siteId?: string | undefined
  readonly lineId?: string | undefined
  readonly week?: string | undefined
  readonly minWaitDays?: number | undefined
}

const OPEN = ['RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const
const emptyAgeing = (): Record<WipAgeBucket, number> => Object.fromEntries(WIP_AGE_BUCKETS.map((bucket) => [bucket, 0])) as Record<WipAgeBucket, number>

export async function wipDrill(caller: CommandCaller, query: WipDrillQuery) {
  const kpiKey = 'production.wip_pieces'
  const actor = drillActor(caller, [kpiKey])
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const sites = await sitesFor(db, actor, PRODUCTION_REPORTS_VIEW, { siteId: query.siteId })
    const zone = new Map(sites.map((site) => [site.id, site.timezone]))
    const orders = await db.workOrder.findMany({
      where: {
        AND: [
          scopeWhere(actor, PRODUCTION_REPORTS_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderWhereInput,
          { siteId: { in: sites.map((site) => site.id) }, status: { in: [...OPEN] }, releasedAt: { not: null } },
          query.lineId === 'none' ? { lineId: null } : query.lineId ? { lineId: query.lineId } : {},
        ],
      },
      select: { id: true, number: true, status: true, companyId: true, siteId: true, lineId: true, styleId: true, releasedAt: true, startedAt: true, sizes: { select: { quantity: true } } },
      orderBy: [{ releasedAt: 'asc' }, { number: 'asc' }],
    })
    const currencyOf = new Map((await db.company.findMany({ where: { id: { in: [...new Set(orders.map((order) => order.companyId))] } }, select: { id: true, currency: true } })).map((row) => [row.id, row.currency]))
    const reports = orders.length === 0 ? [] : await db.operationScan.groupBy({ by: ['workOrderId'], where: { workOrderId: { in: orders.map((order) => order.id) } }, _max: { serverTime: true } })
    const lastReport = new Map(reports.map((row) => [row.workOrderId, row._max.serverTime]))
    const valued = holdsGrain(actor, 'cost')
    const balances = new Map<string, number>()
    if (valued && orders.length > 0) {
      for (const row of await db.workOrderCostEntry.groupBy({ by: ['workOrderId'], where: { workOrderId: { in: orders.map((order) => order.id) } }, _sum: { amount: true } })) balances.set(row.workOrderId, row._sum.amount ?? 0)
    }
    const rowsAll = []
    for (const order of orders) {
      const timeZone = zone.get(order.siteId)!
      const today = businessDate(now, timeZone)
      const released = businessDate(order.releasedAt!, timeZone)
      const week = periodOf('WEEK', released).key
      if (query.week && week !== query.week) continue
      const since = waitingSince({ releasedAt: order.releasedAt, startedAt: order.startedAt, lastReportAt: lastReport.get(order.id) ?? null })!
      const waitedDays = ageDays(since, today, timeZone)
      if (query.minWaitDays !== undefined && waitedDays < query.minWaitDays) continue
      const wip = await wipFor(db, order)
      const mayValue = valued && can(actor, COSTING_VIEW, { companyId: order.companyId, siteId: order.siteId })
      rowsAll.push({
        order,
        week,
        released,
        waitedDays,
        ageDays: ageDays(order.releasedAt!, today, timeZone),
        pieces: order.sizes.reduce((total, size) => total + size.quantity, 0),
        value: mayValue ? (balances.get(order.id) ?? 0) : null,
        stages: wip.operations.filter((operation) => operation.waiting > 0).map((operation) => ({ code: operation.code, name: operation.name, waiting: operation.waiting })),
      })
    }
    // Longest waiting first.
    rowsAll.sort((a, b) => b.waitedDays - a.waitedDays || (a.order.number < b.order.number ? -1 : 1))
    const names = await namesOf(db, { sites: rowsAll.map((row) => row.order.siteId), lines: rowsAll.map((row) => row.order.lineId), styles: rowsAll.map((row) => row.order.styleId) })
    const stages = new Map<string, { line: string | null; code: string; name: string; workOrders: number; waiting: number; ageing: Record<WipAgeBucket, number> }>()
    for (const row of rowsAll) {
      for (const stage of row.stages) {
        const key = `${row.order.lineId ?? ''}|${stage.code}`
        const entry = stages.get(key) ?? { line: row.order.lineId, code: stage.code, name: stage.name, workOrders: 0, waiting: 0, ageing: emptyAgeing() }
        entry.workOrders += 1
        entry.waiting += stage.waiting
        entry.ageing[ageBucketOf(row.waitedDays)] += stage.waiting
        stages.set(key, entry)
      }
    }
    const currencies = [...new Set(rowsAll.filter((row) => row.value !== null).map((row) => currencyOf.get(row.order.companyId)!))]
    const { rows, more } = limited(rowsAll)
    return {
      kpiKey,
      asOf: asOf(),
      overall: {
        workOrders: rowsAll.length,
        pieces: rowsAll.reduce((total, row) => total + row.pieces, 0),
        waiting: rowsAll.reduce((total, row) => total + row.stages.reduce((sum, stage) => sum + stage.waiting, 0), 0),
        // One total only in one currency (the companies' ledgers are each in their own).
        value: asMoney('cost', valued && currencies.length === 1 ? rowsAll.reduce((total, row) => total + (row.value ?? 0), 0) : null),
        currency: valued && currencies.length === 1 ? currencies[0]! : null,
      },
      stages: [...stages.values()]
        .map((stage) => ({ line: refOf(names.line, stage.line), operation: { code: stage.code, name: stage.name }, workOrders: stage.workOrders, waiting: stage.waiting, ageing: stage.ageing }))
        .sort((a, b) => (a.line?.code ?? '~').localeCompare(b.line?.code ?? '~') || a.operation.code.localeCompare(b.operation.code)),
      rows: rows.map((row) => ({
        record: { type: 'WorkOrder', id: row.order.id, label: row.order.number },
        workOrder: { id: row.order.id, number: row.order.number, status: row.order.status },
        site: refOf(names.site, row.order.siteId),
        line: refOf(names.line, row.order.lineId),
        style: refOf(names.style, row.order.styleId),
        releasedOn: row.released,
        week: row.week,
        pieces: row.pieces,
        ageDays: row.ageDays,
        waitedDays: row.waitedDays,
        band: ageBucketOf(row.waitedDays),
        value: asMoney('cost', row.value),
        currency: row.value === null ? null : currencyOf.get(row.order.companyId)!,
        stages: row.stages,
      })),
      more,
    }
  })
}
