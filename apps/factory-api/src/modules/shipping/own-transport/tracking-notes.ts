import { carrierNameFor } from '@nexus/factory-domain/shipping/labels/labels'
import { cleanBody } from '@nexus/factory-domain/threads/rules'
import { command, type CommandCaller } from '../../../core/command'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { ensureThread, writeMessage } from '../../../platform/threads/threads'

/**
 * B-OP-030 (order page plan N5; review R-15: no customer e-mail): a tracking number typed, corrected or cleared for a carrier booked
 * by hand (shipment.tracking_changed, ./own-transport.ts) writes ONE office-only system line on the thread of each order the
 * shipment carries — "Tracking for SH-0012 (BRT): 123…" — in the company's language, so the people of the order read it where they
 * work. An internal note (audience OFFICE): the customer never reads it; the portal and the tracking page show the number itself.
 * One line per event and order (the command's key), the number as the shipment holds it when the line is written.
 */

export const TRACKING_NOTES_HANDLER = 'shipping.trackingNotes'
export const TRACKING_NOTE_EVENTS = ['shipment.tracking_changed'] as const

type NoteLocale = 'it' | 'en'
const localeOf = (value: string | null | undefined): NoteLocale => (value === 'en' ? 'en' : 'it')

/** The office line, in the company's language. */
export function trackingLineOf(input: { readonly shipment: string; readonly carrier: string | null; readonly number: string | null }, locale: NoteLocale): string {
  const carrier = input.carrier ? ` (${input.carrier})` : ''
  if (input.number === null) return locale === 'it' ? `Numero di tracciamento di ${input.shipment}${carrier} cancellato.` : `Tracking number of ${input.shipment}${carrier} cleared.`
  return locale === 'it' ? `Tracciamento di ${input.shipment}${carrier}: ${input.number}` : `Tracking for ${input.shipment}${carrier}: ${input.number}`
}

interface TrackingChanged {
  readonly shipmentId: string
  readonly salesOrderIds: readonly string[]
}

const payloadOf = (event: Pick<EventEnvelope, 'payload'>): TrackingChanged | null => {
  const payload = event.payload as { shipmentId?: unknown; salesOrderIds?: unknown } | null
  if (!payload || typeof payload.shipmentId !== 'string' || !Array.isArray(payload.salesOrderIds)) return null
  return { shipmentId: payload.shipmentId, salesOrderIds: payload.salesOrderIds.filter((id): id is string => typeof id === 'string') }
}

/** One event's lines (the handler's work; tests call it with the system caller): the line written on each order's thread. */
export async function trackingNotes(caller: CommandCaller, event: Pick<EventEnvelope, 'eventId' | 'type' | 'payload'>): Promise<{ orderId: string; messageId: string }[]> {
  const payload = payloadOf(event)
  if (!payload) return []
  const out: { orderId: string; messageId: string }[] = []
  for (const orderId of [...new Set(payload.salesOrderIds)].sort()) {
    const { result } = await command(
      caller,
      { name: TRACKING_NOTES_HANDLER, idempotencyKey: `tracking-notes:${event.eventId}:${orderId}`, input: { eventId: event.eventId, shipmentId: payload.shipmentId, orderId }, causationId: event.eventId },
      async (tools) => {
        const shipment = await tools.tx.shipment.findUnique({ where: { id: payload.shipmentId }, select: { id: true, number: true, transportBy: true, carrierCode: true, carrierName: true, manualTrackingNumber: true } })
        const order = await tools.tx.salesOrder.findUnique({ where: { id: orderId }, select: { id: true, companyId: true } })
        if (!shipment || !order) return null
        const company = await tools.tx.company.findUnique({ where: { id: order.companyId }, select: { locale: true } })
        const text = trackingLineOf({ shipment: shipment.number, carrier: shipment.carrierName ?? carrierNameFor(shipment.transportBy, shipment.carrierCode), number: shipment.manualTrackingNumber }, localeOf(company?.locale))
        const { thread } = await ensureThread(tools, { type: 'SalesOrder', id: order.id }, null)
        const message = await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'SYSTEM', id: null, name: null }, bodyText: cleanBody(text) })
        tools.audit({ action: TRACKING_NOTES_HANDLER, recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { eventType: event.type, shipmentId: shipment.id, messageId: message.id, hasNumber: shipment.manualTrackingNumber !== null } })
        return { orderId: order.id, messageId: message.id }
      },
    )
    if (result) out.push(result)
  }
  return out
}

/** The worker's `shipping.trackingNotes` (background.ts W2B_OP30_HANDLERS; golden-flow/daily/testing/day.ts names it too). */
export function trackingNotesHandler(): EventHandler {
  return defineHandler({
    name: TRACKING_NOTES_HANDLER,
    events: TRACKING_NOTE_EVENTS,
    attempts: 5,
    async handle(event, { caller }) {
      await trackingNotes(caller, event)
    },
  })
}
