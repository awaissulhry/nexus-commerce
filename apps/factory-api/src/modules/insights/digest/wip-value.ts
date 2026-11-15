import type { Prisma } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { can, holds, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { workOrderStageOf } from '@nexus/factory-domain/insights/flow'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import type { CommandCaller } from '../../../core/command'
import { scopeFilterOf, viewerOf } from '../viewer'

/**
 * GET /home/flow/value?companyId&siteId (B-W2b-435; design home.today `flow`: "Counts only; value per stage (cost) for people with
 * cost rights, W2b"): Today's work-order flow with its value at cost per stage — the work-order cost ledger's balance
 * (WorkOrderCostEntry: what sits on each work order at cost; the same ledger the metric layer's WIP value, wip.cost, sums per
 * site and day) of the work orders in each stage of the flow (draft, released, in progress, completed), in the company's currency.
 * home.view; the value only for a person with the cost grain AND costing.view over the work order's company and site (else
 * `valued: false` and no amount — the strip stays counts only); work orders read as the flow reads them (production.work-orders
 * view scope, the top bar's company and site). One currency only: work orders of companies keeping other currencies give
 * `mixedCurrencies` and no amount. Never per person or station.
 */

const OPEN = ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'COMPLETED'] as const
const LIMIT = 5000

export async function flowValue(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly siteId?: string | undefined }) {
  const viewer = viewerOf(caller)
  const actor = viewer.actor
  const asOf = toUtcIso(viewer.now)
  const valued = heldGrains(actor).has('cost') && holds(actor, COSTING_VIEW) && holds(actor, WORKORDERS_VIEW)
  if (!valued) return { asOf, lens: 'WORK_ORDERS' as const, valued: false, currency: null, mixedCurrencies: false, complete: true, stages: [] }
  const filter = await scopeFilterOf(caller, query)
  const companyId = filter.site?.companyId ?? filter.companyId
  return caller.withClient(async (db) => {
    const orders = await db.workOrder.findMany({
      where: {
        AND: [
          scopeWhere(actor, WORKORDERS_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderWhereInput,
          companyId ? { companyId } : {},
          filter.site ? { siteId: filter.site.id } : {},
          { status: { in: [...OPEN] } },
        ],
      },
      take: LIMIT + 1,
      select: { id: true, status: true, companyId: true, siteId: true },
    })
    const shown = orders.slice(0, LIMIT).filter((order) => can(actor, COSTING_VIEW, { companyId: order.companyId, siteId: order.siteId }))
    const balances = new Map<string, number>()
    for (let index = 0; index < shown.length; index += 1000) {
      const ids = shown.slice(index, index + 1000).map((order) => order.id)
      for (const row of await db.workOrderCostEntry.groupBy({ by: ['workOrderId'], where: { workOrderId: { in: ids } }, _sum: { amount: true } })) balances.set(row.workOrderId, row._sum.amount ?? 0)
    }
    const currencies = new Map((await db.company.findMany({ where: { id: { in: [...new Set(shown.map((order) => order.companyId))] } }, select: { id: true, currency: true } })).map((row) => [row.id, row.currency]))
    const used = new Set(shown.filter((order) => balances.has(order.id)).map((order) => currencies.get(order.companyId)!))
    const mixed = used.size > 1
    const sums = new Map<string, { value: number; workOrders: number }>(OPEN.map((status) => [status, { value: 0, workOrders: 0 }]))
    for (const order of shown) {
      const stage = workOrderStageOf(order.status)
      if (!stage) continue
      const entry = sums.get(stage)!
      entry.workOrders += 1
      entry.value += balances.get(order.id) ?? 0
    }
    const currency = mixed ? null : (used.values().next().value ?? currencies.values().next().value ?? null)
    return {
      asOf,
      lens: 'WORK_ORDERS' as const,
      valued: true,
      currency,
      mixedCurrencies: mixed,
      complete: orders.length <= LIMIT,
      stages: [...sums.entries()].map(([key, entry]) => ({ key, workOrders: entry.workOrders, value: asMoney('cost', mixed ? null : entry.value) })),
    }
  })
}
