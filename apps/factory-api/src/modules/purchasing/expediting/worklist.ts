import { Decimal } from 'decimal.js'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { expediteOrder, type ExpediteReason } from '@nexus/factory-domain/purchasing/expediting/worklist'
import type { PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { dayOf, officeOrder, readLines, type Reader } from '../store'
import { atRiskOf, blocksOf, namesOf, orderFiltersOf, workLinesOf, type Blocked, type WorkLine } from './lines'

/**
 * The expediting worklist and the demand each line serves (B-W2b-305; SCM-068, SCM-064; the rules: factory-domain
 * purchasing/expediting/worklist.ts). Read only, purchasing.view over the orders' company, site and supplier; no money.
 *
 *   GET /purchasing/expediting ?companyId&siteId&partyId&reason&atRisk&cursor&limit
 *       the open lines late, not confirmed in time or confirmed later than needed, ranked by the customer orders they put
 *       at risk; tiles per reason; each line with what it blocks
 *   GET /purchasing/orders/:purchaseOrderId/demand
 *       every line of one order (any status: a draft is planned as supply too) with the demand the plan pegs on it
 */

export interface WorklistQuery {
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
  readonly partyId?: string | undefined
  readonly reason?: ExpediteReason | undefined
  /** Only lines that put a customer order or a work order late. */
  readonly atRisk?: boolean | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

const offsetOf = (cursor: string | undefined): number => {
  const match = cursor ? /^o:(\d{1,6})$/.exec(cursor) : null
  return match ? Number.parseInt(match[1]!, 10) : 0
}

function rowOf(line: WorkLine, blocks: readonly Blocked[], names: Awaited<ReturnType<typeof namesOf>>) {
  const item = names.items.get(line.itemId)
  const colour = line.itemColourId ? names.colours.get(line.itemColourId) : undefined
  const risk = atRiskOf(blocks)
  return {
    lineId: line.lineId,
    seq: line.seq,
    purchaseOrderId: line.purchaseOrderId,
    number: line.order.number,
    status: line.order.status as PurchaseOrderStatus,
    revision: line.order.revision,
    version: line.order.version,
    companyId: line.order.companyId,
    siteId: line.order.siteId,
    partyId: line.order.partyId,
    supplierName: names.parties.get(line.order.partyId) ?? '',
    item: { code: item?.code ?? '', name: item?.name ?? '' },
    colour: colour ? { code: colour.code, name: colour.name } : null,
    baseUom: item?.baseUom ?? null,
    outstandingBase: line.outstandingBase,
    needDate: line.needDate,
    confirmedDate: line.confirmedDate,
    expectedDate: line.expectedDate,
    nextDelivery: line.nextDelivery,
    daysLate: line.daysLate,
    confirmedLaterBy: line.confirmedLaterBy,
    confirmBy: line.order.confirmBy ? toUtcIso(line.order.confirmBy) : null,
    reasons: line.reasons,
    blocks: { entries: [...blocks], salesOrdersAtRisk: risk.salesOrders, workOrdersAtRisk: risk.workOrders, earliestPromise: risk.earliestPromise },
  }
}

export async function expeditingWorklist(caller: CommandCaller, query: WorklistQuery) {
  const filters = orderFiltersOf(caller, query)
  const now = serverClock.now()
  const today = businessDate(now)
  return caller.withClient(async (client) => {
    const read = await workLinesOf(client, filters, today, now)
    const listed = read.lines.filter((line) => line.reasons.length > 0)
    const { runs, blocks } = await blocksOf(client, listed.map((line) => ({ id: line.lineId, siteId: line.order.siteId, expectedDate: line.expectedDate })))
    const ranked = listed
      .map((line) => ({ line, blocks: blocks.get(line.lineId) ?? [] }))
      .map((entry) => ({ ...entry, risk: atRiskOf(entry.blocks) }))
      .sort((a, b) =>
        expediteOrder(
          { salesOrdersAtRisk: a.risk.salesOrders, earliestPromise: a.risk.earliestPromise, workOrdersAtRisk: a.risk.workOrders, daysLate: a.line.daysLate, expectedDate: a.line.expectedDate, number: a.line.order.number, seq: a.line.seq },
          { salesOrdersAtRisk: b.risk.salesOrders, earliestPromise: b.risk.earliestPromise, workOrdersAtRisk: b.risk.workOrders, daysLate: b.line.daysLate, expectedDate: b.line.expectedDate, number: b.line.order.number, seq: b.line.seq },
        ),
      )
    const atRisk = (entry: (typeof ranked)[number]) => entry.risk.salesOrders > 0 || entry.risk.workOrders > 0
    const chosen = ranked.filter((entry) => (!query.reason || entry.line.reasons.includes(query.reason)) && (!query.atRisk || atRisk(entry)))
    const offset = offsetOf(query.cursor)
    const page = chosen.slice(offset, offset + query.limit)
    const names = await namesOf(client, page.map((entry) => entry.line), page.map((entry) => entry.line.order.partyId))
    const count = (reason: ExpediteReason) => listed.filter((line) => line.reasons.includes(reason)).length
    const salesOrders = new Set(ranked.flatMap((entry) => entry.blocks.filter((block) => block.lateBy > 0 && block.salesOrder).map((block) => block.salesOrder!.id)))
    return {
      today,
      // Every open line was read (W2a reads at most 5000): when false, the tiles say "at least".
      complete: read.complete,
      tiles: { late: count('LATE'), notConfirmed: count('NOT_CONFIRMED'), confirmedLate: count('CONFIRMED_LATE'), atRisk: ranked.filter(atRisk).length, salesOrdersAtRisk: salesOrders.size },
      // The plan each site's "what it blocks" is read from (null: the site has no finished run yet).
      plans: [...runs.entries()].map(([siteId, run]) => ({ siteId, runId: run?.id ?? null, finishedAt: run?.finishedAt ? toUtcIso(run.finishedAt) : null })),
      rows: page.map((entry) => rowOf(entry.line, entry.blocks, names)),
      nextCursor: chosen.length > offset + query.limit ? `o:${offset + query.limit}` : null,
    }
  })
}

// ---- the demand each line serves (SCM-064) ----------------------------------------------------------------------------

/** Every line of one order with the demand the plan pegs on it (also a draft's or a received one's). */
export async function demandOf(db: Reader, order: { readonly id: string; readonly siteId: string; readonly partyId: string }, today: string, now: Date) {
  const lines = await readLines(db, order.id)
  const open = await workLinesOf(db, [{ id: order.id }], today, now)
  const openById = new Map(open.lines.map((line) => [line.lineId, line]))
  const expectedOf = (line: (typeof lines)[number]) => openById.get(line.id)?.expectedDate ?? dayOf(line.confirmedDate) ?? dayOf(line.needDate)!
  const { runs, blocks } = await blocksOf(db, lines.map((line) => ({ id: line.id, siteId: order.siteId, expectedDate: expectedOf(line) })))
  const names = await namesOf(db, lines, [order.partyId])
  const run = runs.get(order.siteId) ?? null
  const all = lines.flatMap((line) => blocks.get(line.id) ?? [])
  const distinct = <T extends { readonly id: string }>(entries: readonly (T | null)[]): T[] => [...new Map(entries.flatMap((entry) => (entry ? [[entry.id, entry] as const] : []))).values()]
  return {
    orderId: order.id,
    plan: { runId: run?.id ?? null, finishedAt: run?.finishedAt ? toUtcIso(run.finishedAt) : null },
    lines: lines.map((line) => {
      const item = names.items.get(line.itemId)
      const entries = blocks.get(line.id) ?? []
      const risk = atRiskOf(entries)
      const live = openById.get(line.id)
      return {
        lineId: line.id,
        seq: line.seq,
        item: { code: item?.code ?? '', name: item?.name ?? '' },
        ended: line.cancelledAt !== null ? ('CANCELLED' as const) : line.closedShortAt !== null ? ('CLOSED_SHORT' as const) : null,
        expectedDate: expectedOf(line),
        outstandingBase: live ? live.outstandingBase : new Decimal(0).toFixed(4),
        demands: entries,
        salesOrdersAtRisk: risk.salesOrders,
        workOrdersAtRisk: risk.workOrders,
      }
    }),
    workOrders: distinct(all.map((entry) => entry.workOrder)),
    salesOrders: distinct(all.map((entry) => entry.salesOrder)),
  }
}

/** GET /purchasing/orders/:purchaseOrderId/demand (purchasing.view). */
export async function orderDemand(caller: CommandCaller, orderId: string) {
  const order = await officeOrder(caller, orderId)
  const now = serverClock.now()
  return caller.withClient(async (client) => ({ demand: await demandOf(client, order, businessDate(now), now) }))
}
