import type { FactoryClient } from '@nexus/factory-db'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { cleanBody } from '@nexus/factory-domain/threads/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { ensureThread, writeMessage } from '../../../platform/threads/threads'
import { ordersOfShipment } from './orders-of'

/**
 * B-CW-040 (customer Work tab plan §4; lead settle S10): when orders go on a shipment or come off it, each order's OWN thread gets
 * ONE office-only system line, in the company's language — so the people of an order read where its garments travel where they
 * work. The tracking line's shape (../own-transport/tracking-notes.ts): one command per event and order, an internal note by the
 * system (audience OFFICE: the customer never reads it, the portal never shows it; a draft shipment is ours alone), one audit row
 * on the order.
 *
 *   shipment.created                              every order the shipment carries when the line is written:
 *                                                 "On draft shipment SH-0012 with SO-0003, SO-0004." (alone: no "with …")
 *   shipment.orders_changed ADDED                 each order that came on (`added`): the same line. Not when the change rides with
 *                                                 the shipment's creation (`atCreation`: shipment.created tells every order).
 *   shipment.orders_changed REMOVED               each order that came off (`removed`): "No longer on draft shipment SH-0012."
 *   shipment.status_changed → CANCELLED           every order it carried: "Shipment SH-0012 was cancelled."
 *
 * "draft" is said only while the shipment is a DRAFT when the line is written. An order that stays on a shipment gets no line when
 * another order joins. At most 20 sibling orders are named, then "and N more".
 *
 * The brand wall: a shipment's lines are its own customer's by the database's rule (the line's key carries the party); the handler
 * still writes only on an order of the shipment's own customer and names only such siblings. The line holds a shipment number and
 * order numbers — never a customer's name, an amount or a person.
 *
 * One bell per event: every line of one event carries the event's id as its batch (the followers' notifications of a batch fold
 * into one item). Run again (a retry), an event writes nothing more: the command's key is the event and the order.
 *
 * cw-fx1: which orders get a line is decided before any command (`noteTargets`): an event that names an order of another customer,
 * an id of no order or a shipment that is not there makes the handler do nothing — it never fails (a failed handler is retried).
 */

export const ORDER_NOTES_HANDLER = 'shipping.orderNotes'
export const ORDER_NOTE_EVENTS = ['shipment.created', 'shipment.orders_changed', 'shipment.status_changed'] as const

/** What a line says of its order: it is ON the shipment, it came OFF it, or the shipment was CANCELLED. */
export type ShipmentOrderNote = 'ON' | 'OFF' | 'CANCELLED'

type NoteLocale = 'it' | 'en'
const localeOf = (value: string | null | undefined): NoteLocale => (value === 'en' ? 'en' : 'it')

/** At most this many sibling orders are named on a line ("and N more" after them). */
export const NOTE_SIBLINGS = 20

/** The office line, in the company's language (lead settle S10: exactly these words). `siblings`: the other orders it travels with. */
export function shipmentOrderLineOf(input: { readonly kind: ShipmentOrderNote; readonly shipment: string; readonly draft: boolean; readonly siblings?: readonly string[] }, locale: NoteLocale): string {
  if (input.kind === 'CANCELLED') return locale === 'it' ? `La spedizione ${input.shipment} è stata annullata.` : `Shipment ${input.shipment} was cancelled.`
  if (input.kind === 'OFF') {
    if (locale === 'it') return `Non più nella spedizione${input.draft ? ' in bozza' : ''} ${input.shipment}.`
    return `No longer on ${input.draft ? 'draft ' : ''}shipment ${input.shipment}.`
  }
  const siblings = input.siblings ?? []
  const named = siblings.slice(0, NOTE_SIBLINGS)
  const more = siblings.length - named.length
  const list = named.join(', ')
  const others = more <= 0 ? list : locale === 'it' ? `${list} ${more === 1 ? 'e un altro' : `e altri ${more}`}` : `${list} and ${more} more`
  if (locale === 'it') return `In spedizione${input.draft ? ' in bozza' : ''} ${input.shipment}${others === '' ? '' : ` con ${others}`}.`
  return `On ${input.draft ? 'draft ' : ''}shipment ${input.shipment}${others === '' ? '' : ` with ${others}`}.`
}

/** What one event asks of the handler. */
export interface NotePlan {
  readonly shipmentId: string
  readonly kind: ShipmentOrderNote
  /** The orders the event itself names; null: every order the shipment carries when the lines are written. */
  readonly orderIds: readonly string[] | null
}

const idsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && isUuid(id)) : [])

/** What an event asks: which line, on which orders (null: nothing to write). Exported for its unit test. */
export function notePlanOf(event: Pick<EventEnvelope, 'type' | 'payload'>): NotePlan | null {
  const payload = event.payload as { shipmentId?: unknown; to?: unknown; change?: unknown; added?: unknown; removed?: unknown; atCreation?: unknown } | null
  if (!payload || typeof payload.shipmentId !== 'string' || !isUuid(payload.shipmentId)) return null
  const shipmentId = payload.shipmentId
  if (event.type === 'shipment.created') return { shipmentId, kind: 'ON', orderIds: null }
  if (event.type === 'shipment.status_changed') return payload.to === 'CANCELLED' ? { shipmentId, kind: 'CANCELLED', orderIds: null } : null
  if (event.type !== 'shipment.orders_changed') return null
  // An event written before the payload named who came on or off (no `added`, no `removed`) cannot say it: no line.
  if (payload.change === 'ADDED') {
    const added = idsOf(payload.added)
    return payload.atCreation === true || added.length === 0 ? null : { shipmentId, kind: 'ON', orderIds: added }
  }
  if (payload.change === 'REMOVED') {
    const removed = idsOf(payload.removed)
    return removed.length === 0 ? null : { shipmentId, kind: 'OFF', orderIds: removed }
  }
  return null
}

const byNumber = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true })

/** The numbers of the other orders of the shipment's own customer it carries now, by number. */
async function siblingNumbers(db: FactoryClient | CommandTx, shipment: { readonly id: string; readonly salesOrderId: string; readonly partyId: string }, orderId: string): Promise<string[]> {
  const ids = (await ordersOfShipment(db, shipment)).filter((id) => id !== orderId)
  if (ids.length === 0) return []
  const rows = await db.salesOrder.findMany({ where: { id: { in: ids }, partyId: shipment.partyId }, select: { number: true } })
  return rows.map((row) => row.number).sort(byNumber)
}

/**
 * cw-fx1: the orders one event writes on, decided BEFORE any command — a command must record an audit row, so "nothing to write" is
 * never a command (a skip inside one made the handler fail, and a failing handler is retried). Only a shipment that exists, and of
 * the orders the event names (or the shipment carries now) only those that exist and are the shipment's own customer's: an order of
 * another customer, an id of no order and a shipment that is not there make the handler do nothing.
 */
async function noteTargets(caller: CommandCaller, plan: NotePlan): Promise<string[]> {
  return caller.withClient(async (client) => {
    const shipment = await client.shipment.findUnique({ where: { id: plan.shipmentId }, select: { id: true, salesOrderId: true, partyId: true } })
    if (!shipment) return []
    const named = [...new Set(plan.orderIds ?? (await ordersOfShipment(client, shipment)))]
    if (named.length === 0) return []
    const rows = await client.salesOrder.findMany({ where: { id: { in: named }, partyId: shipment.partyId }, select: { id: true } })
    return rows.map((row) => row.id).sort()
  })
}

/** One event's lines (the handler's work; tests call it with the system caller): the line written on each order's own thread. */
export async function shipmentOrderNotes(caller: CommandCaller, event: Pick<EventEnvelope, 'eventId' | 'type' | 'payload'>): Promise<{ orderId: string; messageId: string }[]> {
  const plan = notePlanOf(event)
  if (!plan) return []
  const out: { orderId: string; messageId: string }[] = []
  for (const orderId of await noteTargets(caller, plan)) {
    const { result } = await command(
      caller,
      { name: ORDER_NOTES_HANDLER, idempotencyKey: `shipment-order-notes:${event.eventId}:${orderId}`, input: { eventId: event.eventId, shipmentId: plan.shipmentId, orderId, kind: plan.kind }, causationId: event.eventId },
      async (tools) => {
        const shipment = await tools.tx.shipment.findUnique({ where: { id: plan.shipmentId }, select: { id: true, number: true, status: true, partyId: true, salesOrderId: true } })
        const order = await tools.tx.salesOrder.findUnique({ where: { id: orderId }, select: { id: true, companyId: true, partyId: true } })
        // The hard guard, inside the write's own transaction: only an order of the shipment's own customer gets a line. noteTargets
        // decided the same just before, and a shipment or an order is never deleted nor moved to another customer, so this does not
        // happen. If it ever did, no line is written and nothing is thrown (a throw would fail the handler): one audit row says that
        // nothing was written — every command records one (the keeper's rule, production/brand/keeper.ts).
        if (!shipment || !order || order.partyId !== shipment.partyId) {
          tools.audit({ action: ORDER_NOTES_HANDLER, recordType: 'Shipment', recordId: plan.shipmentId, after: { eventType: event.type, kind: plan.kind, written: false } })
          return null
        }
        const company = await tools.tx.company.findUnique({ where: { id: order.companyId }, select: { locale: true } })
        const siblings = plan.kind === 'ON' ? await siblingNumbers(tools.tx, shipment, order.id) : []
        const text = shipmentOrderLineOf({ kind: plan.kind, shipment: shipment.number, draft: shipment.status === 'DRAFT', siblings }, localeOf(company?.locale))
        const { thread } = await ensureThread(tools, { type: 'SalesOrder', id: order.id }, null)
        // The event's id is the batch: the lines of one act on N orders are one bell item for each reader.
        const message = await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'SYSTEM', id: null, name: null }, bodyText: cleanBody(text), batchId: event.eventId })
        tools.audit({ action: ORDER_NOTES_HANDLER, recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { eventType: event.type, shipmentId: shipment.id, messageId: message.id, kind: plan.kind, ...(plan.kind === 'ON' ? { siblings: siblings.length } : {}) } })
        return { orderId: order.id, messageId: message.id }
      },
    )
    if (result) out.push(result)
  }
  return out
}

/** The worker's `shipping.orderNotes` (background.ts W2B_OP30_HANDLERS; golden-flow/daily/testing/day.ts names it too). */
export function shipmentOrderNotesHandler(): EventHandler {
  return defineHandler({
    name: ORDER_NOTES_HANDLER,
    events: ORDER_NOTE_EVENTS,
    attempts: 5,
    async handle(event, { caller }) {
      await shipmentOrderNotes(caller, event)
    },
  })
}
