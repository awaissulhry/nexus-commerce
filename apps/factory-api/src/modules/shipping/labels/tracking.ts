import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { latestByParcel, trackingMoveOf, trackingNews, type TrackingFact, type TrackingMove, type TrackingSource, type TrackingStatus } from '@nexus/factory-domain/shipping/labels/tracking'
import { SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { officeShipment } from '../shipments/shipments'
import { readShipment } from '../store'
import { latestStatuses, readTracking, statusMap, type TrackingRow } from './store'

/**
 * Recording tracking (B-W1-48; LOG-025, LOG-059), inside a command: Sendcloud's webhook (the inbound ledger's
 * processing command, ./webhook.ts) or a poll (./poll.ts). One shipment at a time: its row is locked first (FOR
 * UPDATE), so a webhook and a poll of one shipment queue and the second reads what the first recorded. Then:
 *
 *   news    each event not recorded yet (its id; the same status of the same parcel from the other source within
 *           hours is the same event: factory-domain trackingNews) becomes a TrackingEvent row (append-only)
 *   move    every tracked parcel delivered → the SHIPPED shipment DELIVERED; every one returned → RETURNED (at the
 *           carrier's time of the last such event); partly delivered, partly returned, or not handed over yet: no move
 *   events  shipment.tracking_recorded (and shipment.status_changed on a move)
 */

export interface IncomingTracking {
  readonly parcelId: string
  readonly status: TrackingStatus
  readonly carrierStatusCode: string | null
  readonly description: string | null
  readonly location: string | null
  readonly occurredAt: Date
  readonly externalEventId: string
}

export interface TrackingOutcome {
  readonly recorded: number
  readonly move: TrackingMove
}

const factOf = (row: TrackingRow): TrackingFact & { recordedAt: Date } => ({
  parcelId: row.parcelId,
  status: row.status,
  source: row.source,
  occurredAt: row.occurredAt,
  externalEventId: row.externalEventId,
  recordedAt: row.recordedAt,
})

export async function recordTracking(tools: CommandTools, shipmentId: string, incoming: readonly IncomingTracking[], source: Exclude<TrackingSource, 'MANUAL'>): Promise<TrackingOutcome> {
  const { tx } = tools
  // One recorder per shipment at a time (the webhooks' and the poll's commands).
  await tx.$queryRaw`SELECT 1 FROM "Shipment" WHERE "id" = ${shipmentId}::uuid FOR UPDATE`
  const shipment = await readShipment(tx, shipmentId)
  if (!shipment) throw new InvalidStateError('The shipment is gone.')
  const facts = (await readTracking(tx, shipmentId)).map(factOf)
  let recorded = 0
  let lastStatus: TrackingStatus | null = null
  for (const event of [...incoming].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())) {
    const fact = { parcelId: event.parcelId, status: event.status, source, occurredAt: event.occurredAt, externalEventId: event.externalEventId }
    if (trackingNews(facts, fact) === 'duplicate') continue
    const id = newId()
    await tx.trackingEvent.create({
      data: {
        id,
        siteId: shipment.siteId,
        partyId: shipment.partyId,
        shipmentId,
        parcelId: event.parcelId,
        status: event.status,
        carrierStatusCode: event.carrierStatusCode?.slice(0, 64) ?? null,
        description: event.description?.slice(0, 500) ?? null,
        location: event.location?.slice(0, 200) ?? null,
        occurredAt: event.occurredAt,
        recordedAt: tools.now,
        source,
        externalEventId: event.externalEventId,
      },
      select: { id: true },
    })
    facts.push({ ...fact, recordedAt: tools.now })
    tools.audit({ action: 'shipping.recordTracking', recordType: 'TrackingEvent', recordId: id, companyId: shipment.companyId, siteId: shipment.siteId, after: { shipmentId, parcelId: event.parcelId, status: event.status, source, occurredAt: toUtcIso(event.occurredAt) } })
    recorded++
    lastStatus = event.status
  }

  const parcels = await tx.parcel.findMany({ where: { shipmentId }, select: { id: true, seq: true, trackingNumber: true }, orderBy: { seq: 'asc' } })
  const labelled = parcels.filter((parcel) => parcel.trackingNumber !== null)
  const latest = latestByParcel(facts)
  const move = trackingMoveOf(shipment.status, labelled, new Map([...latest].map(([parcelId, fact]) => [parcelId, fact.status])))
  if (move.kind === 'move') {
    // The carrier's time of the last parcel's arrival (never before the goods left).
    const at = new Date(Math.max(shipment.shippedAt?.getTime() ?? 0, ...labelled.map((parcel) => latest.get(parcel.id)?.occurredAt.getTime() ?? 0)))
    await tx.shipment.update({
      where: { id: shipmentId },
      data: { status: move.to, ...(move.to === 'DELIVERED' ? { deliveredAt: at } : { returnedAt: at }), version: { increment: 1 } },
      select: { id: true },
    })
    tools.audit({ action: 'shipping.trackingMove', recordType: 'Shipment', recordId: shipmentId, companyId: shipment.companyId, siteId: shipment.siteId, before: { status: shipment.status }, after: { status: move.to, at: toUtcIso(at), source } })
    tools.emit({ type: 'shipment.status_changed', subject: shipmentId, companyId: shipment.companyId, siteId: shipment.siteId, payload: { shipmentId, number: shipment.number, from: shipment.status, to: move.to } })
  }
  if (recorded > 0 && lastStatus !== null) {
    tools.emit({ type: 'shipment.tracking_recorded', subject: shipmentId, companyId: shipment.companyId, siteId: shipment.siteId, payload: { shipmentId, number: shipment.number, events: recorded, status: lastStatus, source } })
  }
  return { recorded, move }
}

// ---- reading ------------------------------------------------------------------------------------------------------------

/** shipping.view: a shipment's tracking (SCR-067 Tracking): each parcel's latest status, every event newest first. */
export async function getTracking(caller: CommandCaller, shipmentId: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_VIEW)
  return caller.withClient(async (client) => {
    const events = await readTracking(client, shipment.id)
    const parcels = await client.parcel.findMany({ where: { shipmentId: shipment.id }, select: { id: true, seq: true, trackingNumber: true, labelledAt: true }, orderBy: { seq: 'asc' } })
    const latest = latestStatuses(events)
    const seqOf = new Map(parcels.map((parcel) => [parcel.id, parcel.seq]))
    const move = trackingMoveOf(shipment.status, parcels.filter((parcel) => parcel.trackingNumber !== null), statusMap(latest))
    return {
      shipment: {
        id: shipment.id,
        number: shipment.number,
        status: shipment.status,
        carrierCode: shipment.carrierCode,
        carrierName: shipment.carrierName,
        shippedAt: shipment.shippedAt ? toUtcIso(shipment.shippedAt) : null,
        deliveredAt: shipment.deliveredAt ? toUtcIso(shipment.deliveredAt) : null,
        returnedAt: shipment.returnedAt ? toUtcIso(shipment.returnedAt) : null,
      },
      parcels: parcels.map((parcel) => {
        const last = latest.get(parcel.id)
        return { parcelId: parcel.id, seq: parcel.seq, trackingNumber: parcel.trackingNumber, labelledAt: parcel.labelledAt ? toUtcIso(parcel.labelledAt) : null, status: last?.status ?? null, lastEventAt: last ? toUtcIso(last.occurredAt) : null }
      }),
      events: [...events].reverse().map((event) => ({
        id: event.id,
        parcelId: event.parcelId,
        seq: event.parcelId ? (seqOf.get(event.parcelId) ?? null) : null,
        status: event.status,
        carrierStatusCode: event.carrierStatusCode,
        description: event.description,
        location: event.location,
        occurredAt: toUtcIso(event.occurredAt),
        recordedAt: toUtcIso(event.recordedAt),
        source: event.source,
      })),
      problem: move.kind === 'mixed' || move.kind === 'waits' ? move.problem : null,
    }
  })
}
