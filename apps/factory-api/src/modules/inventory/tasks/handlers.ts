import { newId } from '@nexus/factory-domain/core/ids'
import { callerFor } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { activeTenants, systemContext } from '../../../platform/outbox/system'
import type { FactoryDatabase } from '@nexus/factory-db'
import { TASK_SOURCES, TIMED_TASK_SOURCES } from './sources'

/**
 * The warehouse task sources at work (B-W2b-292; SCM-274), listed in background.ts: the worker's handler
 * `inventory.warehouseTaskSources` hands each event to the sources that follow it (./sources/index.ts), as the tenant's
 * system caller; the scheduler's cron `inventory.warehouseTaskTimed` (hourly at minute 17) runs the timed sources per tenant.
 */

export function warehouseTaskHandlers(): EventHandler[] {
  const events = [...new Set(TASK_SOURCES.flatMap((source) => source.events))]
  return [
    defineHandler({
      name: 'inventory.warehouseTaskSources',
      events,
      async handle(event, { caller }) {
        for (const source of TASK_SOURCES) if (source.events.includes(event.type)) await source.handle(caller, event)
      },
    }),
  ]
}

/** One pass of the timed sources over every tenant (the cron's body; tests call it with their own time). */
export async function runTimedTaskSources(options: { readonly database: FactoryDatabase; readonly log: Log; readonly now?: Date }): Promise<{ readonly made: number; readonly cancelled: number; readonly failed: number }> {
  const now = options.now ?? new Date()
  let made = 0
  let cancelled = 0
  let failed = 0
  for (const tenantId of await activeTenants(options.database)) {
    for (const source of TIMED_TASK_SOURCES) {
      try {
        const outcome = await source.tick(callerFor(options.database, systemContext(tenantId, `task-sources-${newId()}`)), now)
        made += outcome.made
        cancelled += outcome.cancelled
      } catch (error) {
        failed++
        options.log.error({ err: error, tenantId, source: source.name }, 'a warehouse task source could not run')
      }
    }
  }
  if (made + cancelled + failed > 0) options.log.info({ made, cancelled, failed }, 'warehouse task sources ran')
  return { made, cancelled, failed }
}

/** The clustered cron (scheduler only; one replica per tick): hourly at minute 17. */
export function warehouseTaskCron(options: { readonly database: FactoryDatabase; readonly log: Log }): CronJob {
  return defineCron({
    name: 'inventory.warehouseTaskTimed',
    schedule: '17 * * * *',
    async run() {
      await runTimedTaskSources(options)
    },
  })
}
