import type { FactoryDatabase } from '@nexus/factory-db'
import { isDomainError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { callerFor } from '../../core/command'
import { defineCron, type CronJob } from '../../core/cron'
import type { Log } from '../../core/queue'
import { serverClock, type Clock } from '../../core/time'
import { activeTenants, asSystem, systemContext } from '../../platform/outbox/system'
import { runScheduledPlan } from './run'
import { SITE_COLUMNS } from './store'

/**
 * MRP every day (B-W2a-22): the scheduler's clustered cron `planning.nightlyRun` (every five minutes; one replica per
 * tick) runs the plan of each ACTIVE site whose PlanningSettings name a nightly time (scheduledRunTime, B-W2a-16), once
 * that time has come in the site's own time zone and no SCHEDULED run of that day exists yet. Each run is the tenant's
 * system (trigger SCHEDULED, no person), its Idempotency-Key fixed per site and day, so a doubled tick answers from the
 * first one's receipt. A site whose plan is being run by a person is left for the next tick; a failure becomes a FAILED
 * run of its own (the previous plan stays) and the next sites go on. Null time: the site plans on demand only.
 */

export interface NightlyOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

export interface NightlyResult {
  readonly due: number
  readonly ran: number
  readonly skipped: number
  readonly failed: number
}

/** "HH:MM" of an instant in a time zone. */
const clockOf = (instant: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant)

/** One tick over every active tenant (the cron's; tests call it directly). */
export async function runNightlyPlans(options: NightlyOptions): Promise<NightlyResult> {
  const now = (options.clock ?? serverClock).now()
  const requestId = `planning-nightly-${newId()}`
  let due = 0
  let ran = 0
  let skipped = 0
  let failed = 0
  for (const tenantId of await activeTenants(options.database)) {
    try {
      const sites = await asSystem(options.database, tenantId, requestId, async (client) => {
        const rows = await client.planningSettings.findMany({ where: { scheduledRunTime: { not: null }, site: { status: 'ACTIVE' } }, select: { id: true, scheduledRunTime: true, site: { select: SITE_COLUMNS } }, orderBy: { id: 'asc' } })
        const out: { site: (typeof rows)[number]['site']; day: BusinessDate }[] = []
        for (const row of rows) {
          const day = businessDate(now, row.site.timezone)
          if (clockOf(now, row.site.timezone) < row.scheduledRunTime!) continue
          const start = new Date(`${day}T00:00:00.000Z`)
          // A SCHEDULED run of the site started on its day already (any outcome): nothing more tonight.
          const done = await client.planningRun.findFirst({ where: { siteId: row.site.id, trigger: 'SCHEDULED', startedAt: { gte: new Date(start.getTime() - 14 * 3_600_000) } }, select: { startedAt: true }, orderBy: { startedAt: 'desc' } })
          if (done && businessDate(done.startedAt, row.site.timezone) === day) continue
          out.push({ site: row.site, day })
        }
        return out
      })
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      for (const { site, day } of sites) {
        due++
        try {
          const { replayed } = await runScheduledPlan(caller, site, day)
          if (replayed) skipped++
          else ran++
        } catch (error) {
          if (isDomainError(error)) skipped++
          else {
            failed++
            options.log.error({ err: error, tenantId, siteId: site.id }, 'the nightly plan of a site could not be run')
          }
        }
      }
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId }, 'the nightly plans of a tenant could not be read')
    }
  }
  const result = { due, ran, skipped, failed }
  if (due > 0) options.log.info({ ...result }, 'nightly plans run')
  return result
}

/** The scheduler's cron: every five minutes (a site's nightly time is honoured within five minutes). */
export function nightlyPlanCron(options: NightlyOptions): CronJob {
  return defineCron({
    name: 'planning.nightlyRun',
    schedule: '*/5 * * * *',
    lockTtlMs: 240_000,
    async run() {
      await runNightlyPlans(options)
    },
  })
}
