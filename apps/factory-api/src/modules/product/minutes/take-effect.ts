import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { settles } from '@nexus/factory-domain/product/minutes/rules'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandSettings } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { activeTenants, systemContext } from '../../../platform/outbox/system'
import { dateOf, lockOperation, readVersions, settleOperation, storedMinutesOf, todayOf, MINUTES_OPERATION_COLUMNS, type Settled } from './store'

/**
 * An approved SMV version takes effect on its day (B-W2b-215; PRD-113): the clustered cron `product.smvTakeEffect` (hourly,
 * at minute 7; one replica per tick) finds, per ACTIVE tenant, the operations with an APPROVED version whose first day has
 * come, and settles each one that has something to do (./store settleOperation: the versions before it SUPERSEDED, the
 * operation's numbers set to it, `operation.smv_changed` by SCHEDULE) in ONE system command keyed by the operation and the
 * hour (a second tick of the hour answers from its receipt). An hour with nothing to do writes nothing. An approval whose
 * day has come settles in its own command, so this job only catches the days that come later.
 */

export interface SmvTakeEffectOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

export const TAKE_EFFECT_LIMIT = 500

export async function runSmvTakeEffect(options: SmvTakeEffectOptions): Promise<{ readonly tenants: number; readonly settled: number; readonly failed: number }> {
  const settings: CommandSettings = { ...COMMAND_SETTINGS, clock: options.clock ?? serverClock }
  const requestId = `smv-take-effect-${newId()}`
  const now = settings.clock.now()
  const today = todayOf(now)
  const hour = now.toISOString().slice(0, 13)
  let settled = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    const caller = callerFor(options.database, systemContext(tenantId, requestId))
    const due = await caller.withClient((client) =>
      client.operationTimeVersion.findMany({ where: { status: 'APPROVED', effectiveFrom: { lte: dateOf(today) } }, select: { operationId: true }, distinct: ['operationId'], orderBy: { operationId: 'asc' }, take: TAKE_EFFECT_LIMIT }),
    )
    for (const { operationId } of due) {
      try {
        const needed = await caller.withClient(async (client) => {
          const operation = await client.operation.findUnique({ where: { id: operationId }, select: MINUTES_OPERATION_COLUMNS })
          return operation !== null && settles(await readVersions(client, operationId), today, storedMinutesOf(operation))
        })
        if (!needed) continue
        await runCommand(
          caller,
          { name: 'product.smv.takeEffect', idempotencyKey: `smv-take-effect:${operationId}:${hour}`, input: { operationId, day: today } },
          async (tools): Promise<Settled> => settleOperation(tools, await lockOperation(tools.tx, operationId), 'SCHEDULE'),
          settings,
        )
        settled++
      } catch (error) {
        failed++
        options.log.error({ err: error, tenantId, operationId }, 'an approved SMV version could not take effect')
      }
    }
  }
  if (settled + failed > 0) options.log.info({ tenants: tenants.length, settled, failed }, 'SMV versions took effect')
  return { tenants: tenants.length, settled, failed }
}

/** The clustered cron (scheduler only; one replica per tick): hourly, at minute 7. */
export function smvTakeEffectCron(options: SmvTakeEffectOptions): CronJob {
  return defineCron({
    name: 'product.smvTakeEffect',
    schedule: '7 * * * *',
    async run() {
      await runSmvTakeEffect(options)
    },
  })
}
