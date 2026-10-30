import { ConflictError, InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { amountText } from '@nexus/factory-domain/invoicing/invoices'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { PAYMENTS_RECORD, PAYMENTS_VIEW } from '@nexus/factory-domain/payments/permissions'
import { overpaidOf, releasePlan, unplacedOf } from '@nexus/factory-domain/payments/refunds'
import { command, type CommandCaller, type CommandTools } from '../../core/command'
import { ordersOfInvoices, settleOrders } from '../invoicing/from-shipment/settlement'
import { lockAll, lockMoney } from './locks'
import { assertMay, officeContextOf, type Reader } from './store'

/**
 * The customer's credit balance (B-W2a-61; FIN-122; design finance.payments rec allocation "Overpayment → customer credit
 * balance", its empty state "the money becomes a credit balance"). Not a column (factory-domain payments/refunds): per
 * currency, the RECEIVED payments' amounts less their allocations less their live refunds. A payment larger than what it
 * pays keeps the rest (W1); this module shows it, lets it be refunded (refunds.ts, a refund of the payment) or placed on a
 * later invoice (the W1 allocation of that payment), and carries a credit note's excess into it:
 *
 *   GET  /payments/credit-balance?companyId&partyId   payments.view: the balance per currency and the payments that hold it
 *                                                     (oldest first, with what each has unplaced)
 *   POST /payments/release-overpayment                payments.record: "carry the credit" — an issued TD01/TD24 paid beyond
 *                                                     what it is worth after its credit notes gives the excess back to its
 *                                                     payments' unplaced part, ONE command: the newest allocations first,
 *                                                     each reversed whole (a reversal row with the note: the ledger is
 *                                                     append-only) and the part that still fits placed again. Refused in
 *                                                     words while a refund of its credit notes is live (refund OR carry,
 *                                                     not both), and for a deposit invoice (TD02: paid through its deposit
 *                                                     request, whose payments stay — refund its credit note instead)
 *
 * How a credit balance is carried in the books (a customer advance account, the statement's words) is the accountant's;
 * Nexus keeps the money on the payment. Locks: the payments (id order), then the invoice: the …_money_guards order.
 */

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const day = (value: Date): string => value.toISOString().slice(0, 10)
const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/** The RECEIVED payments of a customer in a company with what each has unplaced (oldest first). */
export async function unplacedPayments(db: Reader, scope: { companyId: string; partyId: string }) {
  const payments = await db.payment.findMany({ where: { companyId: scope.companyId, partyId: scope.partyId, status: 'RECEIVED' }, select: { id: true, amount: true, currency: true, receivedOn: true, externalRef: true, status: true }, orderBy: [{ receivedOn: 'asc' }, { id: 'asc' }] })
  if (payments.length === 0) return []
  const ids = payments.map((payment) => payment.id)
  const allocated = await db.paymentAllocation.groupBy({ by: ['paymentId'], where: { paymentId: { in: ids } }, _sum: { amount: true } })
  const refunded = await db.refund.groupBy({ by: ['paymentId'], where: { paymentId: { in: ids }, status: { in: ['DUE', 'PAID'] } }, _sum: { amount: true } })
  return payments
    .map((payment) => {
      const placed = allocated.find((row) => row.paymentId === payment.id)?._sum.amount ?? 0
      const back = refunded.find((row) => row.paymentId === payment.id)?._sum.amount ?? 0
      return { ...payment, allocated: placed, refunded: back, unplaced: unplacedOf({ status: payment.status, amount: payment.amount, allocated: placed, refunded: back }) }
    })
    .filter((payment) => payment.unplaced > 0)
}

/** The credit balance per currency (the sum of the unplaced parts). */
export function balancesOf(payments: readonly { currency: string; unplaced: number }[]): { currency: string; amount: number }[] {
  const sums = new Map<string, number>()
  for (const payment of payments) sums.set(payment.currency, (sums.get(payment.currency) ?? 0) + payment.unplaced)
  return [...sums.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({ currency, amount }))
}

/** payments.view: a customer's credit balance in a company and the payments that hold it. */
export async function creditBalance(caller: CommandCaller, query: { companyId: string; partyId: string }) {
  const context = officeContextOf(caller)
  assertMay(context, PAYMENTS_VIEW, PAYMENTS_VIEW, { companyId: query.companyId, partyId: query.partyId }, 'Customer')
  return caller.withClient(async (client) => {
    const payments = await unplacedPayments(client, query)
    return {
      companyId: query.companyId,
      partyId: query.partyId,
      balances: balancesOf(payments).map((entry) => ({ currency: entry.currency, amount: asMoney('price', entry.amount) })),
      payments: payments.map((payment) => ({
        id: payment.id,
        receivedOn: day(payment.receivedOn),
        externalRef: payment.externalRef,
        currency: payment.currency,
        amount: asMoney('price', payment.amount),
        allocated: asMoney('price', payment.allocated),
        refunded: asMoney('price', payment.refunded),
        unplacedAmount: asMoney('price', payment.unplaced),
      })),
    }
  })
}

/** The live allocations of an invoice (positive rows not reversed), oldest first. */
async function liveAllocations(db: Reader, invoiceId: string) {
  const rows = await db.paymentAllocation.findMany({ where: { invoiceId }, select: { id: true, paymentId: true, amount: true, reversalOfId: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const reversed = new Set(rows.flatMap((row) => (row.reversalOfId ? [row.reversalOfId] : [])))
  return rows.filter((row) => row.amount > 0 && !reversed.has(row.id)).map((row) => ({ id: row.id, paymentId: row.paymentId, amount: row.amount }))
}

/** payments.record: carries an invoice's overpayment (after its credit notes) to its payments' unplaced part. */
export async function releaseOverpayment(caller: CommandCaller, body: { invoiceId: string; note: string }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const note = blankToNull(body.note)
  if (!note) throw new ValidationError('Say why the overpayment is carried to the credit balance.', [{ path: 'body/note', message: 'Required.' }])
  const invoice = isUuid(body.invoiceId) ? await caller.withClient((client) => client.invoice.findUnique({ where: { id: body.invoiceId }, select: { id: true, companyId: true, buyerPartyId: true, docType: true, status: true, number: true, currency: true, grossTotal: true } })) : null
  assertMay(context, PAYMENTS_VIEW, PAYMENTS_RECORD, invoice ? { companyId: invoice.companyId, partyId: invoice.buyerPartyId } : null, 'Invoice')
  const current = invoice!
  if (current.docType === 'TD02') throw new InvalidStateError(`Deposit invoice ${current.number} is paid through its deposit request, whose payments stay: refund what its credit note credits (Payments › Refunds).`)
  if (current.docType !== 'TD01' && current.docType !== 'TD24') throw new InvalidStateError('A credit note is not paid: carry the overpayment of the invoice it credits.')
  if (current.status === 'DRAFT') throw new InvalidStateError('The invoice is a draft: nothing is paid on it.')
  const { result } = await command(caller, { name: 'payments.releaseOverpayment', idempotencyKey, input: { invoiceId: current.id, note } }, async (tools) => {
    const { tx } = tools
    const before = await liveAllocations(tx, current.id)
    await lockAll(tx, tools.context, 'payment', before.map((row) => row.paymentId))
    await lockMoney(tx, tools.context, 'invoice', current.id)
    const allocations = await liveAllocations(tx, current.id)
    const creditedGross = (await tx.invoice.aggregate({ where: { creditOfId: current.id, docType: 'TD04', status: { not: 'DRAFT' } }, _sum: { grossTotal: true } }))._sum.grossTotal ?? 0
    const paid = (await tx.paymentAllocation.aggregate({ where: { invoiceId: current.id }, _sum: { amount: true } }))._sum.amount ?? 0
    const refunding = (await tx.refund.aggregate({ where: { status: { in: ['DUE', 'PAID'] }, creditNote: { creditOfId: current.id } }, _sum: { amount: true } }))._sum.amount ?? 0
    const excess = overpaidOf({ docType: current.docType, grossTotal: current.grossTotal, creditedGross, paid })
    if (excess <= 0) throw new ConflictError(`Invoice ${current.number} is not paid beyond what it is worth: ${amountText(paid, current.currency)} paid on ${amountText(current.grossTotal - creditedGross, current.currency)} (its credit notes counted). Nothing to carry.`)
    if (refunding > 0) throw new ConflictError(`${amountText(refunding, current.currency)} of what invoice ${current.number} was paid beyond its worth is refunded or due to be on its credit notes: refund the rest the same way, or cancel that refund first and carry it all.`)
    if (allocations.some((row) => !before.some((seen) => seen.paymentId === row.paymentId))) throw new ConflictError('A payment was placed on this invoice meanwhile: try again.')
    const plan = releasePlan(allocations, excess)
    const touched: string[] = []
    for (const step of plan.steps) {
      const reversalId = newId()
      await tx.paymentAllocation.create({ data: { id: reversalId, companyId: current.companyId, partyId: current.buyerPartyId, paymentId: step.paymentId, invoiceId: current.id, amount: -step.reversed, reversalOfId: step.allocationId, note: `${note} (carried to the credit balance)`, createdAt: tools.now, createdById: actorIdOf(tools) }, select: { id: true } })
      tools.audit({ action: 'payments.reverseAllocation', recordType: 'PaymentAllocation', recordId: reversalId, companyId: current.companyId, after: { paymentId: step.paymentId, reversalOfId: step.allocationId, target: 'INVOICE', targetId: current.id, amount: markMoney('price', -step.reversed) }, reason: note })
      tools.emit({ type: 'payment.allocation_reversed', subject: step.paymentId, companyId: current.companyId, payload: { paymentId: step.paymentId, allocationId: reversalId, reversalOfId: step.allocationId, target: 'INVOICE', targetId: current.id } })
      if (step.placedAgain > 0) {
        const againId = newId()
        await tx.paymentAllocation.create({ data: { id: againId, companyId: current.companyId, partyId: current.buyerPartyId, paymentId: step.paymentId, invoiceId: current.id, amount: step.placedAgain, createdAt: tools.now, createdById: actorIdOf(tools) }, select: { id: true } })
        tools.audit({ action: 'payments.allocate', recordType: 'PaymentAllocation', recordId: againId, companyId: current.companyId, after: { paymentId: step.paymentId, target: 'INVOICE', targetId: current.id, amount: markMoney('price', step.placedAgain) } })
        tools.emit({ type: 'payment.allocated', subject: step.paymentId, companyId: current.companyId, payload: { paymentId: step.paymentId, allocationId: againId, target: 'INVOICE', targetId: current.id } })
      }
      if (!touched.includes(step.paymentId)) touched.push(step.paymentId)
    }
    tools.audit({ action: 'payments.releaseOverpayment', recordType: 'Invoice', recordId: current.id, companyId: current.companyId, after: { released: markMoney('price', plan.released), paymentIds: touched }, reason: note })
    tools.emit({ type: 'payment.overpayment_released', subject: current.id, companyId: current.companyId, payload: { invoiceId: current.id, partyId: current.buyerPartyId, paymentIds: touched } })
    await settleOrders(tools, await ordersOfInvoices(tx, [current.id]))
    const after = await unplacedPayments(tx, { companyId: current.companyId, partyId: current.buyerPartyId })
    const paidNow = (await tx.paymentAllocation.aggregate({ where: { invoiceId: current.id }, _sum: { amount: true } }))._sum.amount ?? 0
    return {
      invoice: { id: current.id, number: current.number, paidAmount: asMoney('price', paidNow), worthAmount: asMoney('price', current.grossTotal - creditedGross) },
      releasedAmount: asMoney('price', plan.released),
      payments: touched.map((paymentId) => ({ paymentId, unplacedAmount: asMoney('price', after.find((row) => row.id === paymentId)?.unplaced ?? 0) })),
      balances: balancesOf(after).map((entry) => ({ currency: entry.currency, amount: asMoney('price', entry.amount) })),
    }
  })
  return result
}
