import { z } from 'zod'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { COLLECTED_WORDS } from '@nexus/factory-domain/shipping/collection/rules'
import { command } from '../../../core/command'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'

/**
 * The customer's collection is its delivery (B-W2b-395; LOG-053; Incoterms 2020 EXW and FCA at our premises: the risk passes
 * when the customer's carrier takes the goods). Handler `shipping.collectionDelivered` (worker): shipment.status_changed to
 * SHIPPED of a shipment the customer collects (transportBy RECIPIENT; W1's leaving command refused it without who collected,
 * the plate and the signed DDT) → ONE command: a MANUAL tracking event DELIVERED of the whole shipment at the time it left,
 * the shipment DELIVERED then, W1's shipment.tracking_recorded and shipment.status_changed (the order follows, as for a
 * delivery typed by hand). Keyed by the shipment: once. Any other shipment, or one that moved on meanwhile: nothing.
 */

export const COLLECTION_DELIVERED_HANDLER = 'shipping.collectionDelivered'

const payloadSchema = z.object({ shipmentId: z.uuid(), to: z.string() })

export function collectionDeliveredHandler(): EventHandler {
  return defineHandler({
    name: COLLECTION_DELIVERED_HANDLER,
    events: ['shipment.status_changed'],
    attempts: 5,
    async handle(event, { caller }) {
      const payload = payloadSchema.parse(event.payload)
      if (payload.to !== 'SHIPPED') return
      const found = await caller.withClient((client) => client.shipment.findUnique({ where: { id: payload.shipmentId }, select: { status: true, transportBy: true } }))
      if (!found || found.transportBy !== 'RECIPIENT' || found.status !== 'SHIPPED') return
      await command(caller, { name: 'shipping.collectionDelivered', idempotencyKey: `collection-delivered:${payload.shipmentId}`, input: { shipmentId: payload.shipmentId }, causationId: event.eventId }, async (tools) => {
        const rows = await tools.tx.$queryRaw<{ status: string }[]>`SELECT status::text AS status FROM "Shipment" WHERE id = ${payload.shipmentId}::uuid FOR UPDATE`
        const shipment = await tools.tx.shipment.findUniqueOrThrow({ where: { id: payload.shipmentId }, select: { id: true, number: true, companyId: true, siteId: true, partyId: true, transportBy: true, shippedAt: true } })
        if (rows[0]?.status !== 'SHIPPED' || shipment.transportBy !== 'RECIPIENT') {
          tools.audit({ action: 'shipping.collectionDelivered', recordType: 'Shipment', recordId: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, after: { moved: false, status: rows[0]?.status ?? null } })
          return { moved: false }
        }
        const at = shipment.shippedAt ?? tools.now
        const eventId = newId()
        await tools.tx.trackingEvent.create({
          data: { id: eventId, siteId: shipment.siteId, partyId: shipment.partyId, shipmentId: shipment.id, parcelId: null, status: 'DELIVERED', description: COLLECTED_WORDS, location: null, occurredAt: at, recordedAt: tools.now, source: 'MANUAL', externalEventId: null, createdById: null },
          select: { id: true },
        })
        await tools.tx.shipment.update({ where: { id: shipment.id }, data: { status: 'DELIVERED', deliveredAt: at }, select: { id: true } })
        tools.audit({ action: 'shipping.collectionDelivered', recordType: 'Shipment', recordId: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, before: { status: 'SHIPPED' }, after: { moved: true, status: 'DELIVERED', at: toUtcIso(at), trackingEventId: eventId } })
        tools.emit({ type: 'shipment.tracking_recorded', subject: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, payload: { shipmentId: shipment.id, number: shipment.number, events: 1, status: 'DELIVERED', source: 'MANUAL' } })
        tools.emit({ type: 'shipment.status_changed', subject: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, payload: { shipmentId: shipment.id, number: shipment.number, from: 'SHIPPED', to: 'DELIVERED' } })
        return { moved: true }
      })
    },
  })
}
