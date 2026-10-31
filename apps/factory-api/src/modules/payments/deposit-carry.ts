import { ConflictError, DomainError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { markMoney, asMoney } from '@nexus/factory-domain/money/marked'
import { carryNote, depositCarryPlan, type CarryAllocation, type CarryInvoice } from '@nexus/factory-domain/payments/deposit-carry'
import { openOnInvoice } from '@nexus/factory-domain/payments/payments'
import { PAYMENTS_RECORD, PAYMENTS_VIEW } from '@nexus/factory-domain/payments/permissions'
import { command, type CommandCaller, type CommandTools } from '../../core/command'
import { ordersOfInvoices, ordersOfRequests, settleOrders } from '../invoicing/from-shipment/settlement'
import { lockAll, lockMoney } from './locks'
import { assertMay, officeContextOf, type Reader } from './store'

/**
 * A deposit paid without a deposit invoice, carried onto its order's invoice (B-W2b-21, Z8:01; B-W2a-61's gap: "a deposit
 * on a NONE request stays on its PAID request: the order's invoice keeps its full open amount (allocation, ageing,
 * reminders)"). The rule is factory-domain payments/deposit-carry; the database holds it (B-W2b-02's carry columns and
 * triggers).
 *
 *   POST /payments/deposit-requests/:depositRequestId/carry   payments.record (can() on the request's company AND customer):
 *        ONE command — the money locks (the request's payments in id order, then the request, then the order's invoices in
 *        id order: the …_money_guards order), the request PAID with fiscal document NONE and an order, its live
 *        allocations (not reversed), the order's issued TD01 / TD24 with what each is open for; then per allocation a
 *        reversal (the note says why) and an allocation of the same payment to the invoice naming it (carriedFromId); the
 *        order's settlement announced at the end. 409 in words when nothing is left to carry or the invoice cannot take it.
 *
 * A person carries it (the office's act, like every allocation; the ladder holds the invoice's reminders until then, and
 * the matcher's open items say what waits: payments/open-items `depositToCarry`). A carry made by mistake onto the wrong
 * invoice of the order is taken back like any allocation (its reversal leaves the money on the payment, placed again by
 * hand): the deposit request stays PAID with its allocations at 0.
 */

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/** The database's own refusal of a reversal without its carry (the deferred PaymentAllocation_carry_due at commit). */
const isCarryDue = (error: unknown): boolean => {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  return cause?.originalCode === '23514' && typeof cause.originalMessage === 'string' && cause.originalMessage.includes('carried onto an invoice')
}

/** The order's issued TD01 / TD24 (named on the invoice or on one of its lines), oldest first, with what each is open for. */
export async function orderInvoicesOpen(db: Reader, input: { readonly companyId: string; readonly partyId: string; readonly orderId: string }): Promise<(CarryInvoice & { readonly number: string })[]> {
  const invoices = await db.invoice.findMany({
    where: {
      companyId: input.companyId,
      buyerPartyId: input.partyId,
      docType: { in: ['TD01', 'TD24'] },
      status: { notIn: ['DRAFT', 'REJECTED'] },
      OR: [{ salesOrderId: input.orderId }, { lines: { some: { salesOrderLine: { orderId: input.orderId } } } }],
    },
    select: { id: true, number: true, currency: true, grossTotal: true, issueDate: true },
    orderBy: [{ issueDate: 'asc' }, { number: 'asc' }],
  })
  const out: (CarryInvoice & { number: string })[] = []
  for (const invoice of invoices) {
    const credited = (await db.invoice.aggregate({ where: { creditOfId: invoice.id, docType: 'TD04', status: { not: 'DRAFT' } }, _sum: { grossTotal: true } }))._sum.grossTotal ?? 0
    const allocated = (await db.paymentAllocation.aggregate({ where: { invoiceId: invoice.id }, _sum: { amount: true } }))._sum.amount ?? 0
    out.push({ id: invoice.id, number: invoice.number ?? '(no number)', currency: invoice.currency, open: openOnInvoice(invoice.grossTotal, credited, allocated) })
  }
  return out
}

/** The request's live allocations (above 0, not reversed), oldest first. */
export async function liveRequestAllocations(db: Reader, depositRequestId: string): Promise<CarryAllocation[]> {
  const rows = await db.paymentAllocation.findMany({ where: { depositRequestId }, select: { id: true, paymentId: true, amount: true, reversalOfId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const reversed = new Set(rows.flatMap((row) => (row.reversalOfId ? [row.reversalOfId] : [])))
  return rows.filter((row) => row.amount > 0 && !reversed.has(row.id)).map((row) => ({ id: row.id, paymentId: row.paymentId, amount: row.amount }))
}

export interface CarryInput {
  readonly invoiceId?: string | undefined
  readonly note?: string | null | undefined
}

/** payments.record: the PAID NONE deposit's money placed on its order's invoice, in ONE command. */
export async function carryDeposit(caller: CommandCaller, depositRequestId: string, body: CarryInput, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const seen = isUuid(depositRequestId) ? await caller.withClient((client) => client.depositRequest.findUnique({ where: { id: depositRequestId }, select: { id: true, companyId: true, partyId: true } })) : null
  assertMay(context, PAYMENTS_VIEW, PAYMENTS_RECORD, seen, 'Deposit request')
  try {
    const { result } = await command(caller, { name: 'payments.carryDeposit', idempotencyKey, input: { depositRequestId, ...body } }, async (tools) => {
      const { tx } = tools
      // The locks first, in the triggers' order: the payments, the request, the invoices.
      const paymentIds = (await tx.paymentAllocation.findMany({ where: { depositRequestId }, select: { paymentId: true }, distinct: ['paymentId'] })).map((row) => row.paymentId)
      await lockAll(tx, tools.context, 'payment', paymentIds)
      await lockMoney(tx, tools.context, 'deposit', depositRequestId)
      const request = (await tx.depositRequest.findUnique({ where: { id: depositRequestId }, select: { id: true, companyId: true, partyId: true, status: true, fiscalDocument: true, orderId: true, currency: true, order: { select: { number: true } } } }))!
      const candidates = request.orderId ? await orderInvoicesOpen(tx, { companyId: request.companyId, partyId: request.partyId, orderId: request.orderId }) : []
      await lockAll(tx, tools.context, 'invoice', candidates.map((invoice) => invoice.id))
      // Read again under the invoices' locks: what they are open for now.
      const invoices = request.orderId ? await orderInvoicesOpen(tx, { companyId: request.companyId, partyId: request.partyId, orderId: request.orderId }) : []
      const allocations = await liveRequestAllocations(tx, depositRequestId)
      const orderNumber = request.order?.number ?? null
      const plan = depositCarryPlan({ status: request.status, fiscalDocument: request.fiscalDocument, orderId: request.orderId, orderNumber, currency: request.currency }, allocations, invoices, body.invoiceId)
      if (plan.problem) throw new DomainError('conflict', plan.problem, [{ path: body.invoiceId ? 'body/invoiceId' : 'depositRequestId', message: plan.problem }])

      const carried: { paymentId: string; reversalId: string; allocationId: string; invoiceId: string; invoiceNumber: string | null; amount: number }[] = []
      for (const step of plan.steps) {
        const invoice = invoices.find((entry) => entry.id === step.invoiceId)!
        const note = carryNote(orderNumber, invoice.number, body.note)
        const reversalId = newId()
        const allocationId = newId()
        await tx.paymentAllocation.create({
          data: { id: reversalId, companyId: request.companyId, partyId: request.partyId, paymentId: step.paymentId, depositRequestId, amount: -step.amount, reversalOfId: step.allocationId, note, createdAt: tools.now, createdById: actorIdOf(tools) },
          select: { id: true },
        })
        await tx.paymentAllocation.create({
          data: { id: allocationId, companyId: request.companyId, partyId: request.partyId, paymentId: step.paymentId, invoiceId: step.invoiceId, amount: step.amount, carriedFromId: reversalId, note, createdAt: tools.now, createdById: actorIdOf(tools) },
          select: { id: true },
        })
        tools.audit({
          action: 'payments.carryDeposit',
          recordType: 'PaymentAllocation',
          recordId: allocationId,
          companyId: request.companyId,
          after: { paymentId: step.paymentId, depositRequestId, reversalOfId: step.allocationId, reversalId, invoiceId: step.invoiceId, invoiceNumber: invoice.number, orderId: request.orderId, amount: markMoney('price', step.amount) },
          reason: note,
        })
        tools.emit({ type: 'payment.allocation_reversed', subject: step.paymentId, companyId: request.companyId, payload: { paymentId: step.paymentId, allocationId: reversalId, reversalOfId: step.allocationId, target: 'DEPOSIT_REQUEST', targetId: depositRequestId } })
        tools.emit({ type: 'payment.allocated', subject: step.paymentId, companyId: request.companyId, payload: { paymentId: step.paymentId, allocationId, target: 'INVOICE', targetId: step.invoiceId } })
        carried.push({ paymentId: step.paymentId, reversalId, allocationId, invoiceId: step.invoiceId, invoiceNumber: invoice.number, amount: step.amount })
      }
      const invoiceIds = [...new Set(carried.map((row) => row.invoiceId))].sort()
      tools.emit({ type: 'payment.deposit_carried', subject: depositRequestId, companyId: request.companyId, payload: { depositRequestId, partyId: request.partyId, orderId: request.orderId!, invoiceIds, allocations: carried.length } })
      // The order's settlement: the deposit's money now counts on its invoice (BALANCE_DUE is unchanged in sum).
      await settleOrders(tools, [...(await ordersOfRequests(tx, [depositRequestId])), ...(await ordersOfInvoices(tx, invoiceIds))])
      const after = await orderInvoicesOpen(tx, { companyId: request.companyId, partyId: request.partyId, orderId: request.orderId! })
      return {
        depositRequestId,
        orderId: request.orderId!,
        orderNumber,
        amount: asMoney('price', plan.amount),
        carried: carried.map((row) => ({ ...row, amount: asMoney('price', row.amount) })),
        invoices: after.map((invoice) => ({ id: invoice.id, number: invoice.number, openAmount: asMoney('price', invoice.open) })),
      }
    })
    return result
  } catch (error) {
    if (isCarryDue(error)) throw new ConflictError('The deposit was taken back without being placed on the invoice: nothing was written. Try again.')
    throw error
  }
}

/** For the open items and the ladder: per order, the money PAID NONE deposits still hold (not carried yet), per request. */
export async function depositsToCarry(db: Reader, orderIds: readonly string[]): Promise<Map<string, { depositRequestId: string; amount: number }[]>> {
  const out = new Map<string, { depositRequestId: string; amount: number }[]>()
  if (orderIds.length === 0) return out
  const requests = await db.depositRequest.findMany({ where: { orderId: { in: [...new Set(orderIds)] }, fiscalDocument: 'NONE', status: 'PAID' }, select: { id: true, orderId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  if (requests.length === 0) return out
  const sums = await db.paymentAllocation.groupBy({ by: ['depositRequestId'], where: { depositRequestId: { in: requests.map((request) => request.id) } }, _sum: { amount: true } })
  for (const request of requests) {
    const amount = sums.find((entry) => entry.depositRequestId === request.id)?._sum.amount ?? 0
    if (amount <= 0) continue
    out.set(request.orderId!, [...(out.get(request.orderId!) ?? []), { depositRequestId: request.id, amount }])
  }
  return out
}
