import { z } from 'zod'
import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { callerFor, command, COMMAND_SETTINGS, runCommand, type CommandSettings } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { activeTenants, asSystem, systemContext } from '../../../platform/outbox/system'
import { problemsDue, raiseDueInCommand, resolveOpenInCommand } from './raise'

/**
 * Tracking problems found by themselves (B-W2b-398; LOG-063; plan rule 1: deliveries are checked every day):
 *
 *   handler   `shipping.trackingProblems` (worker): shipment.tracking_recorded whose newest news is an EXCEPTION → ONE command
 *             raises what is due (the carrier's delay, address problem or failed delivery, with its task);
 *             shipment.status_changed to DELIVERED or RETURNED → ONE command resolves the open ones (their tasks done)
 *   cron      `shipping.deliveryCheck`, daily at 07:10 (clustered: one replica): for every ACTIVE tenant, in its system
 *             context, the SHIPPED shipments with carrier labels (never a TEST label: factory-domain exceptionsDue): no
 *             carrier news for 3 days (NO_SCAN), the carrier's expected day passed (DELAYED); ONE command per shipment with
 *             something due, keyed by the tenant, the shipment and the day (a second replica's tick answers from the receipt)
 */

export const TRACKING_PROBLEMS_HANDLER = 'shipping.trackingProblems'
/** The most travelling shipments one tenant's daily check reads. */
export const CHECK_BATCH = 1000

const payloadSchema = z.object({ shipmentId: z.uuid(), status: z.string().optional(), to: z.string().optional() })

export function trackingProblemsHandler(): EventHandler {
  return defineHandler({
    name: TRACKING_PROBLEMS_HANDLER,
    events: ['shipment.tracking_recorded', 'shipment.status_changed'],
    attempts: 5,
    async handle(event, { caller }) {
      const payload = payloadSchema.parse(event.payload)
      if (event.type === 'shipment.tracking_recorded') {
        if (payload.status !== 'EXCEPTION') return
        const due = await caller.withClient((client) => problemsDue(client, payload.shipmentId, serverClock.now()))
        if (due.length === 0) return
        await command(caller, { name: 'shipping.raiseTrackingProblems', input: { shipmentId: payload.shipmentId }, causationId: event.eventId }, async (tools) => ({ raised: await raiseDueInCommand(tools, payload.shipmentId) }))
        return
      }
      if (payload.to !== 'DELIVERED' && payload.to !== 'RETURNED') return
      const open = await caller.withClient((client) => client.trackingException.count({ where: { shipmentId: payload.shipmentId, resolvedAt: null } }))
      if (open === 0) return
      await command(caller, { name: 'shipping.resolveTrackingProblems', input: { shipmentId: payload.shipmentId, to: payload.to }, causationId: event.eventId }, async (tools) => ({ resolved: await resolveOpenInCommand(tools, payload.shipmentId) }))
    },
  })
}

export interface DeliveryCheckOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

export interface DeliveryCheckRun {
  readonly tenants: number
  readonly raised: number
  readonly failed: number
}

/** One daily tick over every active tenant (the cron's run; tests call it directly). */
export async function runDeliveryCheck(options: DeliveryCheckOptions): Promise<DeliveryCheckRun> {
  const clock = options.clock ?? serverClock
  const settings: CommandSettings = { ...COMMAND_SETTINGS, clock }
  const now = clock.now()
  const day = now.toISOString().slice(0, 10)
  const requestId = `delivery-check-${newId()}`
  let raised = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    try {
      const travelling = await asSystem(options.database, tenantId, requestId, (client) =>
        client.shipment.findMany({ where: { status: 'SHIPPED', transportBy: 'CARRIER', integrationAccountId: { not: null }, parcels: { some: { trackingNumber: { not: null } } } }, select: { id: true }, orderBy: { id: 'asc' }, take: CHECK_BATCH }),
      )
      if (travelling.length === 0) continue
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      for (const { id } of travelling) {
        const due = await caller.withClient((client) => problemsDue(client, id, now))
        if (due.length === 0) continue
        const { result } = await runCommand(caller, { name: 'shipping.deliveryCheck', idempotencyKey: `delivery-check:${tenantId}:${id}:${day}`, input: { shipmentId: id, day } }, async (tools) => ({ raised: (await raiseDueInCommand(tools, id)).length }), settings)
        raised += result.raised
      }
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId }, 'the delivery check of a tenant failed')
    }
  }
  const result = { tenants: tenants.length, raised, failed }
  options.log.info({ ...result }, 'delivery check done')
  return result
}

/** The scheduler's daily cron. */
export function deliveryCheckCron(options: DeliveryCheckOptions): CronJob {
  return defineCron({
    name: 'shipping.deliveryCheck',
    schedule: '10 7 * * *',
    async run() {
      await runDeliveryCheck(options)
    },
  })
}
