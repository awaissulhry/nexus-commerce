import { z } from 'zod'
import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { latestByParcel, POLL_BATCH, pollDue, statusOfSendcloudCode, trackingMoveOf, type TrackingStatus } from '@nexus/factory-domain/shipping/labels/tracking'
import { callerFor, command, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSettings } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { activeTenants, asSystem, systemContext } from '../../../platform/outbox/system'
import { carrierProblem, processCarrier, type CarrierRuntime } from './carrier'
import { recordTracking, type IncomingTracking } from './tracking'

/**
 * The tracking poll (B-W1-48; LOG-059): the safety net under Sendcloud's webhooks, which may be lost.
 *
 *   cron      `shipping.trackingPoll`, hourly (clustered: one replica per tick). For every ACTIVE tenant, in its system
 *             context: the PACKED and SHIPPED shipments carried with a Sendcloud account and labelled; due are those
 *             with a parcel silent for 12, 24, 36 … hours (factory-domain pollDue), and SHIPPED ones whose parcels all
 *             arrived but which did not move (the goods were marked handed over after the last event). ONE command per
 *             tenant and tick emits `shipment.tracking_poll_due` per shipment (its key fixed per tenant and hour: a
 *             second replica's tick answers from the receipt).
 *   handler   `shipping.pollTracking` (worker): per parcel not delivered or returned, ONE gateway call carrier.tracking
 *             (outside any transaction); the events newer than the parcel's latest are its lost updates. Then ONE
 *             command records them (./tracking.ts, source POLL) and makes the move. A failed call is retried by the
 *             queue (after the others are recorded).
 */

export const TRACKING_POLL_HANDLER = 'shipping.pollTracking'

export interface TrackingPollOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

const SHIPMENTS_SELECT = {
  id: true,
  status: true,
  parcels: { select: { id: true, seq: true, trackingNumber: true, carrierParcelId: true, labelledAt: true }, orderBy: { seq: 'asc' } },
  trackingEvents: { select: { parcelId: true, status: true, source: true, occurredAt: true, recordedAt: true, externalEventId: true } },
} as const

/** The shipments of one tenant due for a poll now, with their due parcels. */
async function dueShipments(database: FactoryDatabase, tenantId: string, requestId: string, now: Date) {
  const rows = await asSystem(database, tenantId, requestId, (client) =>
    client.shipment.findMany({
      where: { status: { in: ['PACKED', 'SHIPPED'] }, transportBy: 'CARRIER', integrationAccountId: { not: null }, parcels: { some: { trackingNumber: { not: null } } } },
      select: SHIPMENTS_SELECT,
      orderBy: { id: 'asc' },
      take: POLL_BATCH * 5,
    }),
  )
  return rows
    .map((row) => {
      const latest = latestByParcel(row.trackingEvents)
      const labelled = row.parcels.filter((parcel) => parcel.trackingNumber !== null)
      const due = labelled.filter((parcel) => pollDue({ labelledAt: parcel.labelledAt, latest: latest.get(parcel.id) ?? null }, now))
      const statuses = new Map<string, TrackingStatus>([...latest].map(([parcelId, event]) => [parcelId, event.status]))
      const stuck = trackingMoveOf(row.status, labelled, statuses).kind === 'move'
      return { id: row.id, due: due.length, poll: due.length > 0 || stuck }
    })
    .filter((row) => row.poll)
    .slice(0, POLL_BATCH)
}

export interface TrackingPollRun {
  readonly tenants: number
  readonly shipments: number
  readonly failed: number
}

/** One tick over every active tenant (the cron's run; tests call it directly). */
export async function runTrackingPoll(options: TrackingPollOptions): Promise<TrackingPollRun> {
  const clock = options.clock ?? serverClock
  const settings: CommandSettings = { ...COMMAND_SETTINGS, clock }
  const now = clock.now()
  const requestId = `tracking-poll-${newId()}`
  const hour = now.toISOString().slice(0, 13)
  let shipments = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    try {
      const due = await dueShipments(options.database, tenantId, requestId, now)
      if (due.length === 0) continue
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      await runCommand(
        caller,
        { name: 'shipping.requestTrackingPoll', idempotencyKey: `tracking-poll:${tenantId}:${hour}`, input: { hour, shipments: due.map((row) => row.id) } },
        async ({ audit, emit, tx }) => {
          for (const row of due) {
            const shipment = await tx.shipment.findUnique({ where: { id: row.id }, select: { companyId: true, siteId: true } })
            if (!shipment) continue
            audit({ recordType: 'Shipment', recordId: row.id, companyId: shipment.companyId, siteId: shipment.siteId, after: { duePolls: row.due } })
            emit({ type: 'shipment.tracking_poll_due', subject: row.id, companyId: shipment.companyId, siteId: shipment.siteId, payload: { shipmentId: row.id, parcels: row.due } })
          }
          return { shipments: due.length }
        },
        settings,
      )
      shipments += due.length
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId }, 'the tracking poll of a tenant could not be asked for')
    }
  }
  const result = { tenants: tenants.length, shipments, failed }
  options.log.info({ ...result }, 'tracking poll asked for')
  return result
}

/** The scheduler's hourly cron. */
export function trackingPollCron(options: TrackingPollOptions): CronJob {
  return defineCron({
    name: 'shipping.trackingPoll',
    schedule: '17 * * * *',
    async run() {
      await runTrackingPoll(options)
    },
  })
}

/** A carrier call of the poll failed: the queue tries the job again (what was found is recorded first). */
class PollIncomplete extends Error {
  override name = 'PollIncomplete'
}

/**
 * Polls one shipment (the handler's work): the carrier's events of each parcel not delivered or returned, the newer
 * ones recorded with source POLL, and the move. Answers what it recorded.
 */
export async function pollShipment(carrier: CarrierRuntime, caller: CommandCaller, shipmentId: string, causationId?: string): Promise<{ recorded: number; moved: string | null; failures: string[] }> {
  const shipment = await caller.withClient((client) => client.shipment.findUnique({ where: { id: shipmentId }, select: { ...SHIPMENTS_SELECT, integrationAccountId: true } }))
  if (!shipment || (shipment.status !== 'PACKED' && shipment.status !== 'SHIPPED') || shipment.integrationAccountId === null) return { recorded: 0, moved: null, failures: [] }
  const latest = latestByParcel(shipment.trackingEvents)
  const incoming: IncomingTracking[] = []
  const failures: string[] = []
  for (const parcel of shipment.parcels) {
    const last = latest.get(parcel.id)
    if (parcel.trackingNumber === null || (last && (last.status === 'DELIVERED' || last.status === 'RETURNED'))) continue
    if (parcel.carrierParcelId === null) continue
    try {
      const events = await carrier.tracking(caller, shipment.integrationAccountId, { providerId: parcel.carrierParcelId, trackingNumber: parcel.trackingNumber })
      for (const event of events) {
        const status = statusOfSendcloudCode(event.code)
        const occurredAt = new Date(event.occurredAt)
        // The lost updates: what happened after the parcel's latest recorded event.
        if (status === null || Number.isNaN(occurredAt.getTime()) || (last && occurredAt.getTime() <= last.occurredAt.getTime())) continue
        incoming.push({ parcelId: parcel.id, status, carrierStatusCode: event.code, description: event.description, location: event.location, occurredAt, externalEventId: event.externalEventId })
      }
    } catch (error) {
      failures.push(`parcel ${parcel.seq}: ${carrierProblem(error)}`)
    }
  }
  const { result } = await command(caller, { name: 'shipping.recordTracking', input: { shipmentId, source: 'POLL', events: incoming.length }, ...(causationId ? { causationId } : {}) }, async (tools) => {
    const outcome = await recordTracking(tools, shipmentId, incoming, 'POLL')
    const row = await tools.tx.shipment.findUniqueOrThrow({ where: { id: shipmentId }, select: { companyId: true, siteId: true } })
    tools.audit({ action: 'shipping.pollTracking', recordType: 'Shipment', recordId: shipmentId, companyId: row.companyId, siteId: row.siteId, after: { asked: incoming.length, recorded: outcome.recorded, move: outcome.move.kind === 'move' ? outcome.move.to : null, failures } })
    return { recorded: outcome.recorded, moved: outcome.move.kind === 'move' ? outcome.move.to : null }
  })
  return { ...result, failures }
}

const payloadSchema = z.object({ shipmentId: z.uuid() })

/** The worker's handler of shipment.tracking_poll_due. */
export function trackingPollHandler(runtime: () => CarrierRuntime = processCarrier): EventHandler {
  return defineHandler({
    name: TRACKING_POLL_HANDLER,
    events: ['shipment.tracking_poll_due'],
    attempts: 5,
    async handle(event, tools) {
      const { shipmentId } = payloadSchema.parse(event.payload)
      const outcome = await pollShipment(runtime(), tools.caller, shipmentId, event.eventId)
      if (outcome.failures.length > 0) throw new PollIncomplete(`The carrier did not answer for ${outcome.failures.join('; ')}.`)
    },
  })
}
