import type { FactoryDatabase } from '@nexus/factory-db'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import { BUSINESS_TIME_ZONE, businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { DAY_SHEET_LOOKBACK_DAYS, LEFT_STATUSES } from '@nexus/factory-domain/shipping/manifest/rules'
import { callerFor, COMMAND_SETTINGS, type CommandSettings } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { processFiles, type FilesRuntime } from '../../../platform/files/service'
import { activeTenants, asSystem, systemContext } from '../../../platform/outbox/system'
import { closeSheet } from './day'

/**
 * The dock closes every day (B-W2b-395; LOG-049, Rule 1): what a person did not close is closed by the system once the site's
 * day ended. Cron `shipping.closeDays`, hourly at minute 50 (clustered: one replica): for every ACTIVE tenant, in its system
 * context, each site and carrier with a sheet still open, or with carrier shipments that left and are on no sheet, within the
 * last DAY_SHEET_LOOKBACK_DAYS days: each of those past days (the site's zone), oldest first, is closed as a person's close
 * would close it (modules/shipping/manifest/day.ts closeSheet: the PDF stored first, then ONE command; closedById null, the
 * PDF says "system"), keyed by the tenant, the site, the carrier and the day (a second replica's tick answers from the
 * receipt). A day already closed passes its late hand-overs on to the next day. Nothing is printed.
 */

export interface CloseDaysOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
  /** The file store (default the process's). */
  readonly files?: FilesRuntime
}

export interface CloseDaysRun {
  readonly tenants: number
  readonly closed: number
  readonly failed: number
}

/** One tick over every active tenant (the cron's run; tests call it directly). */
export async function runCloseDays(options: CloseDaysOptions): Promise<CloseDaysRun> {
  const clock = options.clock ?? serverClock
  const settings: CommandSettings = { ...COMMAND_SETTINGS, clock }
  const files = options.files ?? processFiles()
  const now = clock.now()
  const since = new Date(now.getTime() - (DAY_SHEET_LOOKBACK_DAYS + 1) * 86_400_000)
  const requestId = `close-days-${newId()}`
  let closed = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    try {
      const found = await asSystem(options.database, tenantId, requestId, async (client) => {
        const open = await client.dispatchManifest.findMany({ where: { closedAt: null, day: { gte: new Date(`${businessDate(since, 'UTC')}T00:00:00.000Z`) } }, select: { siteId: true, carrierCode: true, day: true } })
        const left = await client.shipment.findMany({ where: { transportBy: 'CARRIER', carrierCode: { not: null }, status: { in: [...LEFT_STATUSES] }, manifestId: null, shippedAt: { gte: since } }, select: { siteId: true, carrierCode: true, shippedAt: true } })
        const siteIds = [...new Set([...open.map((row) => row.siteId), ...left.map((row) => row.siteId)])]
        const sites = siteIds.length === 0 ? [] : await client.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, companyId: true, code: true, name: true, timezone: true } })
        return { open, left, sites }
      })
      if (found.sites.length === 0) continue
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      for (const row of found.sites) {
        const site = { id: row.id, companyId: row.companyId, code: row.code, name: row.name, timeZone: row.timezone || BUSINESS_TIME_ZONE }
        const today = businessDate(now, site.timeZone)
        const oldest = plusDays(today, -DAY_SHEET_LOOKBACK_DAYS)
        // Per carrier, the first past day something waits on: from there to yesterday, each day in turn.
        const first = new Map<string, BusinessDate>()
        const note = (carrierCode: string, day: BusinessDate) => {
          const from = day < oldest ? oldest : day
          if (from >= today) return
          const kept = first.get(carrierCode)
          if (!kept || from < kept) first.set(carrierCode, from)
        }
        for (const sheet of found.open.filter((entry) => entry.siteId === site.id)) note(sheet.carrierCode, sheet.day.toISOString().slice(0, 10))
        for (const shipment of found.left.filter((entry) => entry.siteId === site.id)) note(shipment.carrierCode!, businessDate(shipment.shippedAt!, site.timeZone))
        for (const [carrierCode, from] of [...first.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          for (let day = from; day < today; day = plusDays(day, 1)) {
            const outcome = await closeSheet(files, caller, { site, carrierCode, day, bySystem: true, idempotencyKey: `close-day:${tenantId}:${site.id}:${day}`, settings })
            if (outcome.closed) closed++
          }
        }
      }
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId }, 'the day close of a tenant failed')
    }
  }
  const result = { tenants: tenants.length, closed, failed }
  options.log.info({ ...result }, 'day close done')
  return result
}

/** The scheduler's hourly cron. */
export function closeDaysCron(options: CloseDaysOptions): CronJob {
  return defineCron({
    name: 'shipping.closeDays',
    schedule: '50 * * * *',
    async run() {
      await runCloseDays(options)
    },
  })
}
