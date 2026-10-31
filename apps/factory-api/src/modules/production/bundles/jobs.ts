import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { stuckEpisodeKey } from '@nexus/factory-domain/production/bundles/where'
import { callerFor, COMMAND_SETTINGS, runCommand } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { activeTenants, systemContext } from '../../../platform/outbox/system'
import { FINDINGS_CRON, runScanFindings } from './findings'
import { BUNDLE_COLUMNS } from './store'
import { trackBundles } from './track'
import { MAX_TRACKED } from './tracked'

/**
 * The bundles' scheduled work (B-W2b-41), clustered crons of the scheduler (core/cron.ts: one replica per tick):
 *
 *   production.stuckBundles   every 15 minutes: per ACTIVE tenant, in its system context, the ACTIVE bundles of open work
 *                             orders tracked (track.ts); each bundle stuck now (no scan past its site's limit, in working
 *                             hours) is told ONCE per wait: one system command per bundle and wait, its Idempotency-Key
 *                             `bundle-stuck:<bundle>:<last scan>` (a replay answers from the receipt and tells nothing),
 *                             an audit row and the event production.bundle_stuck (MES-168: the floor-now board and the
 *                             bundles list refresh). A new scan starts a new wait.
 *   production.scanFindings   hourly: the scan-pattern checks (findings.ts), only at sites whose checks are ON.
 *
 * A failing bundle, site or tenant is logged and the others go on.
 */

export interface JobOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

export interface StuckRun {
  readonly tenants: number
  readonly stuck: number
  readonly told: number
  readonly failed: number
}

const OPEN_WORK_ORDERS = ['RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const

/** One pass over every active tenant (the cron's tick; tests call it directly). */
export async function runStuckBundles(options: JobOptions): Promise<StuckRun> {
  const clock = options.clock ?? serverClock
  const settings = { ...COMMAND_SETTINGS, clock }
  const requestId = `stuck-bundles-${newId()}`
  const totals = { stuck: 0, told: 0, failed: 0 }
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    const caller = callerFor(options.database, systemContext(tenantId, requestId))
    const now = clock.now()
    const stuck = await caller.withClient(async (db) => {
      const bundles = await db.bundle.findMany({ where: { status: 'ACTIVE', workOrder: { is: { status: { in: [...OPEN_WORK_ORDERS] } } } }, select: BUNDLE_COLUMNS, orderBy: { id: 'desc' }, take: MAX_TRACKED })
      return (await trackBundles(db, bundles, now)).filter((row) => row.stuck.stuck)
    })
    totals.stuck += stuck.length
    for (const row of stuck) {
      const lastScanId = row.lastScan?.id ?? null
      try {
        const { replayed } = await runCommand(
          caller,
          { name: 'production.tellBundleStuck', idempotencyKey: stuckEpisodeKey(row.bundle.id, lastScanId), input: { bundleId: row.bundle.id, lastScanId } },
          async (tools) => {
            const scope = { companyId: row.workOrder.companyId, siteId: row.workOrder.siteId }
            const place = row.place.place as 'CUTTING' | 'LINE'
            tools.audit({ recordType: 'Bundle', recordId: row.bundle.id, ...scope, after: { stuck: true, place, lastScanId, workingHours: row.stuck.hours, limitHours: row.limitHours } })
            tools.emit({
              type: 'production.bundle_stuck',
              subject: row.workOrder.id,
              ...scope,
              payload: { workOrderId: row.workOrder.id, number: row.workOrder.number, bundleId: row.bundle.id, code: row.bundle.code, siteId: row.bundle.siteId, place, lastScanId, workingHours: row.stuck.hours, limitHours: row.limitHours },
            })
            return { bundleId: row.bundle.id }
          },
          settings,
        )
        if (!replayed) totals.told += 1
      } catch (error) {
        totals.failed += 1
        options.log.error({ err: error, tenantId, bundleId: row.bundle.id }, 'a stuck bundle could not be told')
      }
    }
  }
  const run = { tenants: tenants.length, ...totals }
  if (run.told > 0 || run.failed > 0) options.log.info({ ...run }, 'stuck bundles')
  return run
}

/** The scheduler's cron: every 15 minutes. */
export function stuckBundlesCron(options: JobOptions): CronJob {
  return defineCron({
    name: 'production.stuckBundles',
    schedule: '*/15 * * * *',
    async run() {
      await runStuckBundles(options)
    },
  })
}

/** The scheduler's cron: hourly at 25 past (after a shift's end window of 15 minutes has closed). */
export function scanFindingsCron(options: JobOptions): CronJob {
  return defineCron({
    name: FINDINGS_CRON,
    schedule: '25 * * * *',
    async run() {
      await runScanFindings(options)
    },
  })
}
