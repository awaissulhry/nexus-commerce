import type { FactoryClient, FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { callerFor } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { activeTenants, systemContext } from '../../../platform/outbox/system'
import { postWorkOrderCosts } from './post'
import { unique, type Reader } from './store'

/**
 * The cost ledger's catch-up (B-W2b-22, follow-up Z9:04; B-W2a-21's gap "no catch-up cron: what waits posts at the work
 * order's next event or by POST …/post"). The worker posts a work order's cost after each of its events (./handlers.ts);
 * what could not post then waits — a move the stock ledger had not valued yet, a scan with no cost per minute in force
 * for its kind of work centre, a rework's scrap — and nothing posts it until the next event of that work order. This
 * cron finds, per tenant, the work orders with such a source and posts each one's ledger (./post.ts, the ONE writer):
 *
 *   cron `costing.catchUp` (every day at 03:20 Rome, clustered), per active tenant, in the tenant's SYSTEM context:
 *     the work orders with a valued kind of stock move (issue, return, scrap, production receipt, or a reversal of one)
 *     that has no cost entry, a standing report or correction with garments and no cost entry, or a rework DONE with
 *     scrap and no scrap record — at most MAX_CATCH_UP_WORK_ORDERS a night, oldest work order first; each posted by
 *     postWorkOrderCosts (a dry plan first: a work order whose sources still wait writes nothing — no command, no audit
 *     row), key `costing-catch-up:<tick>:<work order>` (a tick run twice posts once; the entries' own keys hold too).
 * A work order that fails is logged and left for the next night; the run's figures are logged when anything posted.
 */

/** Work orders per tenant and night; the rest waits for the next night. */
export const MAX_CATCH_UP_WORK_ORDERS = 200

const VALUED_REASONS = ['ISSUE', 'RETURN', 'SCRAP', 'PRODUCTION_RECEIPT'] as const

/** The work orders of the tenant with a source that has no cost entry yet (at most `take`, by id). */
export async function waitingWorkOrderIds(db: Reader, take: number): Promise<string[]> {
  const moves = await db.stockMove.findMany({
    where: { workOrderId: { not: null }, reason: { in: [...VALUED_REASONS] }, costEntries: { none: {} } },
    select: { workOrderId: true },
    distinct: ['workOrderId'],
    orderBy: { workOrderId: 'asc' },
    take,
  })
  const scans = await db.operationScan.findMany({
    where: { kind: { in: ['REPORT', 'CORRECTION'] }, OR: [{ goodQuantity: { gt: 0 } }, { scrapQuantity: { gt: 0 } }], correctedBy: { none: {} }, costEntries: { none: {} } },
    select: { workOrderId: true },
    distinct: ['workOrderId'],
    orderBy: { workOrderId: 'asc' },
    take,
  })
  const reworks = await db.reworkOrder.findMany({ where: { status: 'DONE', scrapQuantity: { gt: 0 } }, select: { id: true, workOrderId: true } })
  const recorded = new Set(
    reworks.length === 0 ? [] : (await db.workOrderCostEntry.findMany({ where: { sourceType: 'ReworkOrder', sourceId: { in: reworks.map((row) => row.id) } }, select: { sourceId: true } })).map((row) => row.sourceId),
  )
  return unique([...moves.map((row) => row.workOrderId), ...scans.map((row) => row.workOrderId), ...reworks.filter((row) => !recorded.has(row.id)).map((row) => row.workOrderId)])
    .sort()
    .slice(0, take)
}

export interface CatchUpOptions {
  readonly database: FactoryDatabase
  readonly log: Log
}

export interface CatchUpRun {
  readonly tenants: number
  /** Work orders with a source that had no entry. */
  readonly workOrders: number
  /** Of them, the ones whose ledger posted something now. */
  readonly posted: number
  readonly entries: number
  readonly failed: number
}

/** One pass over every active tenant (the cron's tick; tests call it directly). `tick` makes the commands' keys. */
export async function runCostCatchUp(options: CatchUpOptions, tick: Date = new Date()): Promise<CatchUpRun> {
  const requestId = `costing-catch-up-${newId()}`
  const totals = { workOrders: 0, posted: 0, entries: 0, failed: 0 }
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    const caller = callerFor(options.database, systemContext(tenantId, requestId))
    const ids = await caller.withClient((client) => waitingWorkOrderIds(client as FactoryClient, MAX_CATCH_UP_WORK_ORDERS))
    totals.workOrders += ids.length
    for (const workOrderId of ids) {
      try {
        const outcome = await postWorkOrderCosts(caller, workOrderId, { idempotencyKey: `costing-catch-up:${tick.getTime()}:${workOrderId}` })
        if (outcome.posted.length > 0) {
          totals.posted += 1
          totals.entries += outcome.posted.length
        }
      } catch (error) {
        totals.failed += 1
        options.log.error({ err: error, tenantId, workOrderId }, 'the cost catch-up could not post a work order')
      }
    }
  }
  const run = { tenants: tenants.length, ...totals }
  if (run.posted > 0 || run.failed > 0) options.log.info({ ...run }, 'cost catch-up')
  return run
}

/** The scheduler's cron: every day at 03:20 (Europe/Rome), after the night's reservation clean-up. */
export function costCatchUpCron(options: CatchUpOptions): CronJob {
  return defineCron({
    name: 'costing.catchUp',
    schedule: '20 3 * * *',
    async run({ scheduledAt }) {
      await runCostCatchUp(options, scheduledAt)
    },
  })
}
