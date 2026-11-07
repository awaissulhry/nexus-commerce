import { businessDate } from '@nexus/factory-domain/core/time'
import { markMoney } from '@nexus/factory-domain/money/marked'
import type { ProviderIntentEvent } from '@nexus/factory-domain/payments/online/port'
import { failureCodeOf, isFinalIntent, mayMove, statusOfEvent, type IntentMethod, type IntentStatus } from '@nexus/factory-domain/payments/online/rules'
import { readIntentEvent } from '@nexus/factory-domain/payments/online/webhook'
import type { CommandTools } from '../../../core/command'
import type { InboundProcessor, InboundReceipt } from '../../../platform/inbound/providers'
import { closeTasksInCommand } from '../../../platform/portal/tasks/store'
import { lockMoney } from '../locks'
import { allocateInCommand, insertPayment } from '../payments'
import { finishInCommand } from './start'
import { INTENT_COLUMNS, targetFacts, targetOf, type IntentRow } from './store'

/**
 * The payment provider's webhook, applied (B-W2b-185; plan "the provider's signed webhook moves the intent and records a
 * Payment through W2a's payments command; a repeated webhook changes nothing"). platform/inbound verified it (the fake's
 * signature for a FAKE account, Stripe's for a Stripe one), stored the receipt once per event id, and runs this processor
 * once, inside its processing command as the tenant's system:
 *
 *   find      the intent by our id in the event's metadata, else by the provider's id, of the receipt's account; an
 *             event about anything else changes nothing
 *   lock      the intent's row (FOR UPDATE): two events of one intent apply one after the other
 *   WAITING   the bank asks or the money is on its way (processing): CREATED → WAITING
 *   FAILED    declined (payment_failed: the provider's code kept, said in our words) · CANCELLED: `payment_intent.finished`
 *   SUCCEEDED ONE Payment (method CARD or SEPA_DEBIT, received today, the provider's id as its reference: insertPayment, so
 *             audited with payment.recorded), allocated to what it pays as far as it is still open (a deposit request it
 *             covers becomes PAID; the rest stays unplaced, the customer's credit, for the office to refund or place), the
 *             intent SUCCEEDED naming it, the invoice's PAY_INVOICE request DONE when nothing is open any more
 *   final     an intent that ended already changes nothing — but a provider's success for an intent we hold as FAILED or
 *             CANCELLED (the money was taken all the same) still records its Payment once (by its reference), never lost
 * The receipt mail, the deposit invoice (TD02) and cancelling a failed intent at the provider follow in the worker
 * (./follow-up.ts, on payment_intent.finished), each in its own command: none of them can undo the payment.
 */

export function onlinePaymentProcessor(): InboundProcessor {
  return {
    async process(receipt: InboundReceipt, tools: CommandTools) {
      const event = readIntentEvent(receipt.body)
      if (!event) return
      await applyIntentEvent(tools, receipt.accountId, event)
    },
  }
}

export type Applied = 'unknown' | 'nothing' | 'waiting' | 'failed' | 'cancelled' | 'succeeded' | 'late_success'

/** Applies one provider event inside the caller's command (see the file's comment). */
export async function applyIntentEvent(tools: CommandTools, accountId: string, event: ProviderIntentEvent): Promise<Applied> {
  const { tx } = tools
  const found = await tx.paymentIntent.findFirst({
    where: { providerAccountId: accountId, ...(event.intentId ? { OR: [{ id: event.intentId }, { providerRef: event.providerRef }] } : { providerRef: event.providerRef }) },
    select: { id: true },
  })
  if (!found) return 'unknown'
  await tx.$queryRaw`SELECT id FROM "PaymentIntent" WHERE id = ${found.id}::uuid FOR UPDATE`
  const row = (await tx.paymentIntent.findUniqueOrThrow({ where: { id: found.id }, select: INTENT_COLUMNS }))
  if (row.providerRef !== null && row.providerRef !== event.providerRef) return 'unknown'
  const next = statusOfEvent(event.type, event.state)
  if (next === null) return 'nothing'
  const current = row.status as IntentStatus
  if (isFinalIntent(current)) {
    if (next === 'SUCCEEDED' && current !== 'SUCCEEDED') return (await recordPaymentOf(tools, row, event, true)) ? 'late_success' : 'nothing'
    return 'nothing'
  }
  if (next === current || !mayMove(current, next)) return 'nothing'
  switch (next) {
    case 'WAITING':
      await tx.paymentIntent.update({ where: { id: row.id }, data: { status: 'WAITING', ...(row.providerRef === null ? { providerRef: event.providerRef } : {}), version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
      tools.audit({ action: 'payments.onlineWaiting', recordType: 'PaymentIntent', recordId: row.id, companyId: row.companyId, before: { status: current }, after: { status: 'WAITING', event: event.type } })
      return 'waiting'
    case 'FAILED':
      await finishInCommand(tools, row, 'FAILED', failureCodeOf(event.failureCode))
      return 'failed'
    case 'CANCELLED':
      await finishInCommand(tools, row, 'CANCELLED', null)
      return 'cancelled'
    case 'SUCCEEDED':
      await recordPaymentOf(tools, row, event, false)
      return 'succeeded'
    default:
      return 'nothing'
  }
}

/**
 * The Payment of a succeeded intent, allocated, the intent SUCCEEDED naming it (`late`: the intent ended already and stays
 * as it is; the payment is recorded and allocated all the same). Returns false when its payment exists already.
 */
async function recordPaymentOf(tools: CommandTools, row: IntentRow, event: ProviderIntentEvent, late: boolean): Promise<boolean> {
  const { tx, context } = tools
  if (event.amount !== null && event.amount !== row.amount) throw new Error(`The provider says ${event.amount} was paid on intent ${row.id}, which asked ${row.amount}: a person checks it.`)
  if (event.currency !== null && event.currency !== row.currency) throw new Error(`The provider says the payment of intent ${row.id} was in ${event.currency}, the intent asked ${row.currency}.`)
  const reference = row.providerRef ?? event.providerRef
  if (await tx.payment.findFirst({ where: { companyId: row.companyId, externalRef: reference }, select: { id: true } })) return false
  const payment = await insertPayment(tools, {
    companyId: row.companyId,
    partyId: row.partyId,
    amount: row.amount,
    currency: row.currency,
    receivedOn: businessDate(tools.now),
    externalRef: reference,
    method: row.method as IntentMethod,
    internalNote: null,
  })
  // Payment first, then its target (the money locks' order); what is still open is read under both.
  const { target, targetId } = targetOf(row)
  await lockMoney(tx, context, 'payment', payment.id)
  await lockMoney(tx, context, target === 'INVOICE' ? 'invoice' : 'deposit', targetId)
  const facts = await targetFacts(tx, target, targetId)
  const fits = facts !== null && facts.refusal === null && facts.open > 0 && facts.currency === row.currency
  if (fits) await allocateInCommand(tools, payment, [target === 'INVOICE' ? { invoiceId: targetId, amount: Math.min(facts.open, row.amount) } : { depositRequestId: targetId, amount: Math.min(facts.open, row.amount) }])
  if (!late) {
    await tx.paymentIntent.update({ where: { id: row.id }, data: { status: 'SUCCEEDED', ...(row.providerRef === null ? { providerRef: reference } : {}), finishedAt: tools.now, paymentId: payment.id, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    tools.emit({ type: 'payment_intent.finished', subject: row.id, companyId: row.companyId, payload: { intentId: row.id, partyId: row.partyId, target, targetId, method: row.method as IntentMethod, status: 'SUCCEEDED', paymentId: payment.id } })
  }
  tools.audit({
    action: late ? 'payments.onlineLateSuccess' : 'payments.onlineSucceeded',
    recordType: 'PaymentIntent',
    recordId: row.id,
    companyId: row.companyId,
    before: { status: row.status },
    after: { status: late ? row.status : 'SUCCEEDED', paymentId: payment.id, allocated: fits ? markMoney('price', Math.min(facts!.open, row.amount)) : null, unplaced: fits ? null : 'nothing was open on its target' },
  })
  // The invoice's request to pay is answered once nothing is open on it (the portal person who paid did it).
  if (target === 'INVOICE') {
    const after = await targetFacts(tx, 'INVOICE', targetId)
    if (after && after.open <= 0) await closeTasksInCommand(tools, { recordType: 'Invoice', recordId: targetId, kinds: ['PAY_INVOICE'], status: 'DONE', doneById: row.createdById })
  }
  return true
}

/**
 * A PAYMENT_FAKE account that is not in FAKE mode verifies nothing (the fake provider has no live endpoint): its
 * deliveries are refused and kept as REJECTED. A FAKE account's are checked by platform/inbound's fake verifier.
 */
export const FAKE_PROVIDER_VERIFIER = { verify: () => ({ ok: false as const, reason: 'fake_provider_live' }) }
