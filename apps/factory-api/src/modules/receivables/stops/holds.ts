import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { HeldReason } from '@nexus/factory-domain/receivables/reminders'
import { STOP_HELD, type StopReason } from '@nexus/factory-domain/receivables/stops/stops'
import type { Reader } from '../store'

/**
 * What holds the reminders of some invoices on a day (B-W2b-402; FIN-112), for the reminder views (their `held`) and the
 * trusted levels (a held reminder never goes by itself):
 *
 *   STOP_<REASON>        a stop a person recorded on the invoice, in force (not lifted; its last day today or later, or none)
 *   RIBA_IN_COLLECTION   one of its instalments is in an issued Ri.Ba. batch, not settled yet (the bank is collecting it)
 *   PAYMENT_PROCESSING   a card or SEPA payment of it in progress (a payment intent not finished), or a bank line that surely
 *                        pays it (a HIGH suggestion) waits to be accepted
 * W2a's own (money on account, a credit note drafted, a deposit to carry) stay in the reminder view.
 */
export async function reminderHoldsOf(db: Reader, invoiceIds: readonly string[], today: BusinessDate): Promise<Map<string, HeldReason[]>> {
  const ids = [...new Set(invoiceIds)]
  const held = new Map<string, Set<HeldReason>>()
  if (ids.length === 0) return new Map()
  const add = (invoiceId: string, reason: HeldReason) => {
    const set = held.get(invoiceId) ?? new Set<HeldReason>()
    set.add(reason)
    held.set(invoiceId, set)
  }
  // One query at a time: a transaction client runs one statement at a time.
  const stops = await db.reminderStop.findMany({ where: { invoiceId: { in: ids }, liftedAt: null }, select: { invoiceId: true, reason: true, until: true } })
  for (const stop of stops) if (stop.until === null || businessDate(stop.until, 'UTC') >= today) add(stop.invoiceId, STOP_HELD[stop.reason as StopReason])
  const collecting = await db.ribaItem.findMany({ where: { invoiceId: { in: ids }, status: 'ISSUED', batch: { status: 'ISSUED' } }, select: { invoiceId: true } })
  for (const item of collecting) add(item.invoiceId, 'RIBA_IN_COLLECTION')
  const intents = await db.paymentIntent.findMany({ where: { invoiceId: { in: ids }, status: { in: ['CREATED', 'WAITING'] } }, select: { invoiceId: true } })
  for (const intent of intents) if (intent.invoiceId) add(intent.invoiceId, 'PAYMENT_PROCESSING')
  const lines = await db.bankMatch.findMany({ where: { acceptedAt: null, confidence: 'HIGH', invoiceIds: { hasSome: ids } }, select: { invoiceIds: true } })
  for (const line of lines) for (const invoiceId of line.invoiceIds) if (ids.includes(invoiceId)) add(invoiceId, 'PAYMENT_PROCESSING')
  return new Map([...held].map(([invoiceId, reasons]) => [invoiceId, [...reasons]]))
}
