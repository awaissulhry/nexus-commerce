import { toUtcIso } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { events as salesEvents } from '@nexus/factory-domain/sales/events'
import { command } from '../../../core/command'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { labelChanged } from './book'

/**
 * A return label used (B-W2b-398; LOG-112): when the return's goods reach our dock (`return.received`, W2a's dock receipt),
 * every BOOKED label of the return is USED — the carrier had the parcel — at the receipt's time (never in the future), in
 * ONE command with an audit row and return_label.changed per label. An offered label stays offered (the customer sent the
 * goods another way; the office may withdraw it). The carrier's own scans of a return label are not read: the label keeps
 * no carrier id to ask with (named in the step's notes).
 */

export const RETURN_LABELS_USED_HANDLER = 'shipping.returnLabelsUsed'

const received = salesEvents.find((event) => event.type === 'return.received')!.payload

export function returnLabelsUsedHandler(): EventHandler {
  return defineHandler({
    name: RETURN_LABELS_USED_HANDLER,
    events: ['return.received'],
    attempts: 5,
    async handle(event, { caller }) {
      const payload = received.parse(event.payload)
      const booked = await caller.withClient((db) => db.returnLabel.count({ where: { returnId: payload.returnId, status: 'BOOKED' } }))
      if (booked === 0) return
      await command(caller, { name: 'shipping.returnLabelsUsed', input: { returnId: payload.returnId, receiptId: payload.receiptId }, causationId: event.eventId }, async (tools) => {
        const { tx, now } = tools
        const receipt = await tx.returnReceipt.findUnique({ where: { id: payload.receiptId }, select: { receivedAt: true } })
        const at = receipt && receipt.receivedAt.getTime() <= now.getTime() ? receipt.receivedAt : now
        const rows = await tx.returnLabel.findMany({ where: { returnId: payload.returnId, status: 'BOOKED' }, select: { id: true, companyId: true, siteId: true } })
        for (const row of rows) {
          await tx.returnLabel.update({ where: { id: row.id }, data: { status: 'USED', usedAt: at, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
          tools.audit({ action: 'shipping.returnLabelUsed', recordType: 'ReturnAuthorisation', recordId: payload.returnId, companyId: row.companyId, siteId: row.siteId, before: { status: 'BOOKED' }, after: { labelId: row.id, status: 'USED', usedAt: toUtcIso(at), receiptId: payload.receiptId } })
          tools.emit(eventFor(labelChanged, { subject: payload.returnId, companyId: row.companyId, siteId: row.siteId, payload: { returnId: payload.returnId, number: payload.number, labelId: row.id, status: 'USED', via: 'DOCK' } }))
        }
        return { used: rows.length }
      })
    },
  })
}
