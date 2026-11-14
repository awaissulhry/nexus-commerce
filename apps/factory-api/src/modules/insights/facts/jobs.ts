import type { FactoryDatabase } from '@nexus/factory-db'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { measuresOfSource, type MeasureSource } from '@nexus/factory-domain/insights/kpis/measures'
import { callerFor } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock } from '../../../core/time'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { activeTenants, systemContext } from '../../../platform/outbox/system'
import { rebuildFacts, type RebuildTrigger } from './rebuild'
import { factCompanies } from './rows'
import { SOURCE_EVENTS, sourcesOfEvent } from './sources'

/**
 * The facts kept fresh (B-W2b-428; ANA-069; design home.dashboards "Reporting projections refresh hourly; tiles show AsOf and
 * turn 'stale' after 3 h"), in each tenant's system context, through the clustered scheduler and the outbox:
 *
 *   cron insights.factsHourly    minute 5 of every hour: today and yesterday of every company
 *   cron insights.factsNightly   02:40 Europe/Rome: the 35 days before yesterday (corrections and late postings)
 *   handler insights.facts       an event that changes what a source counts (sources/index.ts SOURCE_EVENTS): the event's
 *                                company, today on its clock, only those sources — unless that day of that source was
 *                                rebuilt less than 5 minutes ago (the hour's rebuild catches what comes meanwhile)
 *
 * Every run is a rebuild (rebuild.ts): safe to repeat. Nothing here leaves the database: no provider, no message.
 */

const NIGHTLY_DAYS = 35
export const EVENT_QUIET_MS = 5 * 60_000

export interface FactsJobOptions {
  readonly database: FactoryDatabase
  readonly log: Log
}

/** One pass over every active tenant: per company, its days `[today − back … today − skip]` on its own clock. */
export async function rebuildAllTenants(options: FactsJobOptions, trigger: RebuildTrigger, range: { readonly back: number; readonly skip: number }): Promise<{ tenants: number; companies: number; failed: number }> {
  const tenants = await activeTenants(options.database)
  let companies = 0
  let failed = 0
  for (const tenantId of tenants) {
    const caller = callerFor(options.database, systemContext(tenantId, `insights-facts-${trigger.toLowerCase()}-${Date.now()}`))
    try {
      for (const company of await caller.withClient((db) => factCompanies(db))) {
        const today = businessDate(serverClock.now(), company.timezone)
        await rebuildFacts(caller, { from: plusDays(today, -range.back), to: plusDays(today, -range.skip), companyIds: [company.id], trigger })
        companies++
      }
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId, trigger }, 'the facts of a tenant could not be rebuilt')
    }
  }
  const outcome = { tenants: tenants.length, companies, failed }
  if (companies + failed > 0) options.log.info({ ...outcome, trigger }, 'facts rebuilt')
  return outcome
}

export function factsHourlyCron(options: FactsJobOptions): CronJob {
  return defineCron({
    name: 'insights.factsHourly',
    schedule: '5 * * * *',
    async run() {
      await rebuildAllTenants(options, 'HOURLY', { back: 1, skip: 0 })
    },
  })
}

export function factsNightlyCron(options: FactsJobOptions): CronJob {
  return defineCron({
    name: 'insights.factsNightly',
    schedule: '40 2 * * *',
    async run() {
      await rebuildAllTenants(options, 'NIGHTLY', { back: NIGHTLY_DAYS + 1, skip: 2 })
    },
  })
}

/** The event types the handler listens to (every source's). */
export const FACTS_EVENTS: readonly string[] = [...new Set(Object.values(SOURCE_EVENTS).flat())].sort()

export function factsHandler(): EventHandler {
  return defineHandler({
    name: 'insights.facts',
    events: FACTS_EVENTS,
    attempts: 5,
    async handle(event, { caller }) {
      const companyId = event.companyId
      if (!companyId) return
      const sources = sourcesOfEvent(event.type)
      if (sources.length === 0) return
      const company = (await caller.withClient((db) => factCompanies(db, [companyId])))[0]
      if (!company) return
      const today: BusinessDate = businessDate(serverClock.now(), company.timezone)
      // Quiet: a source whose day was rebuilt in the last 5 minutes waits for the next event or the hour's rebuild.
      const since = new Date(serverClock.now().getTime() - EVENT_QUIET_MS)
      const due: MeasureSource[] = []
      for (const source of sources) {
        const fresh = await caller.withClient((db) =>
          db.factDaily.findFirst({ where: { companyId, day: new Date(`${today}T00:00:00.000Z`), measureKey: measuresOfSource(source)[0]!.key, rebuiltAt: { gte: since } }, select: { id: true } }),
        )
        if (!fresh) due.push(source)
      }
      if (due.length === 0) return
      await rebuildFacts(caller, { from: today, to: today, companyIds: [companyId], sources: due, trigger: 'EVENT', causationId: event.eventId })
    },
  })
}
