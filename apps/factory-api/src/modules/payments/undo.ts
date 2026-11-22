import type { PeriodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { dayWords } from '@nexus/factory-domain/accounting/periods'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { voidProblems } from '@nexus/factory-domain/payments/payments'
import { PAYMENTS_RECORD, PAYMENTS_VOID } from '@nexus/factory-domain/payments/permissions'
import { undoVerdictOf } from '@nexus/factory-domain/sales/orders/money-plan'
import { command, type CommandCaller, type CommandTools } from '../../core/command'
import { actorOf } from '../../core/context'
import { honourPeriodLocks } from '../accounting/period-guard'
import { settleOrders } from '../invoicing/from-shipment/settlement'
import { lockMoney } from './locks'
import { refundedOf } from './refunds'
import { allocatedOf, officeContextOf, officePayment, paymentDetail, readPayment, type PaymentDetail } from './store'

/**
 * B-OM-017 (order money tab, lead L5): undo a payment on a deposit request — POST /payments/:paymentId/undo { depositRequestId,
 * reason, version?, periodLockOverride? }, payments.record (and payments.void when the payment pays nothing after). ONE command:
 * the payment's money lock, then the request's (reverseAllocation's order); every live allocation of the payment on THIS request
 * reversed (append-only rows, the reason in their note); when the payment then pays nothing, voided with the same reason (the
 * void's checks: nothing refunded, the month's HARD lock refused, a SOFT one with an override reason); the request's order settled
 * again at the end. Held in words (the plan read's verdict, factory-domain money-plan `undoVerdictOf`): the request PAID (a NONE
 * one is carried), a deposit invoice (TD02) of the request issued and not credited in full ("a credit note first, in Finance"),
 * its draft, a write-off standing on the payment. Never deleted: reversed and voided rows stay. Audit payments.undoDepositPayment.
 */

export interface UndoPaymentBody {
  readonly depositRequestId: string
  readonly reason: string
  /** The payment's version as read (an edit-conflict guard). */
  readonly version?: number | undefined
  readonly periodLockOverride?: PeriodLockOverride | undefined
}

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/** POST /payments/:paymentId/undo. */
export async function undoDepositPayment(caller: CommandCaller, paymentId: string, body: UndoPaymentBody, idempotencyKey?: string): Promise<{ payment: PaymentDetail; undone: { depositRequestId: string; reversed: string[]; voided: boolean } }> {
  const payment = await officePayment(caller, paymentId, PAYMENTS_RECORD)
  const context = officeContextOf(caller)
  const reason = body.reason.trim()
  if (reason.length < 3 || reason.length > 500) throw new ValidationError('Say why the payment is undone.', [{ path: 'body/reason', message: 'Say why (3 to 500 characters): it stays on the reversed rows.' }])
  const { result } = await command(
    caller,
    { name: 'payments.undoDepositPayment', idempotencyKey, input: { paymentId, ...body }, record: { type: 'Payment', id: payment.id, ...(body.version === undefined ? {} : { expectedVersion: body.version }) } },
    async (tools) => {
      const { tx, now } = tools
      await lockMoney(tx, tools.context, 'payment', payment.id)
      if (!isUuid(body.depositRequestId)) throw new NotFoundError('Deposit request not found on this payment.')
      await lockMoney(tx, tools.context, 'deposit', body.depositRequestId)
      const current = (await readPayment(tx, payment.id))!
      if (current.status !== 'RECEIVED') throw new InvalidStateError('This payment is voided already: there is nothing to undo.')
      const request = await tx.depositRequest.findUnique({ where: { id: body.depositRequestId }, select: { id: true, status: true, fiscalDocument: true, orderId: true, partyId: true } })
      if (!request || request.partyId !== current.partyId) throw new NotFoundError('Deposit request not found on this payment.')
      const allocations = await tx.paymentAllocation.findMany({ where: { paymentId: current.id }, select: { id: true, amount: true, invoiceId: true, depositRequestId: true, reversalOfId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
      const reversedIds = new Set(allocations.flatMap((row) => (row.reversalOfId ? [row.reversalOfId] : [])))
      const live = allocations.filter((row) => row.reversalOfId === null && !reversedIds.has(row.id) && row.depositRequestId === request.id)
      if (live.length === 0) throw new InvalidStateError('This payment places nothing on this deposit request: there is nothing to undo.')
      // Held in words, as the plan read says it (its verdict; the HARD month lock is the void's own refusal below).
      const td02s = await tx.invoice.findMany({ where: { docType: 'TD02', depositRequestId: request.id }, select: { id: true, status: true, grossTotal: true } })
      const issued = td02s.filter((row) => row.status !== 'DRAFT' && row.status !== 'REJECTED')
      const credits = issued.length > 0 ? await tx.invoice.findMany({ where: { docType: 'TD04', status: { not: 'DRAFT' }, creditOfId: { in: issued.map((row) => row.id) } }, select: { creditOfId: true, grossTotal: true } }) : []
      const standing = await tx.paymentWriteOff.findFirst({ where: { paymentId: current.id, reversalOfId: null, reversals: { none: {} } }, select: { id: true } })
      const verdict = undoVerdictOf({
        mayAct: true,
        request: { status: request.status, fiscalDocument: request.fiscalDocument },
        depositInvoiceIssued: issued.some((row) => credits.filter((credit) => credit.creditOfId === row.id).reduce((sum, credit) => sum + credit.grossTotal, 0) < row.grossTotal),
        depositInvoiceDraft: td02s.some((row) => row.status === 'DRAFT'),
        writeOffStanding: standing !== null,
        hardLocked: false,
      })
      if (!verdict.may) throw new DomainError('conflict', verdict.why!.en, [{ path: `undo/${verdict.code}`, message: verdict.why!.en }])
      // The payment's allocations on this request reversed (append-only rows).
      const reversed: string[] = []
      for (const allocation of live) {
        const id = newId()
        await tx.paymentAllocation.create({ data: { id, companyId: current.companyId, partyId: current.partyId, paymentId: current.id, invoiceId: null, depositRequestId: request.id, amount: -allocation.amount, reversalOfId: allocation.id, note: reason, createdAt: now, createdById: actorIdOf(tools) }, select: { id: true } })
        tools.audit({ action: 'payments.reverseAllocation', recordType: 'PaymentAllocation', recordId: id, companyId: current.companyId, after: { paymentId: current.id, reversalOfId: allocation.id, target: 'DEPOSIT_REQUEST', targetId: request.id, amount: markMoney('price', -allocation.amount) }, reason })
        tools.emit({ type: 'payment.allocation_reversed', subject: current.id, companyId: current.companyId, payload: { paymentId: current.id, allocationId: id, reversalOfId: allocation.id, target: 'DEPOSIT_REQUEST', targetId: request.id, partyId: current.partyId } })
        reversed.push(allocation.id)
      }
      // A payment that pays nothing now is voided with the same reason (the rest of one that pays more stays on it, in Finance).
      let voided = false
      if ((await allocatedOf(tx, current.id)) === 0) {
        if (!can(actorOf(context), PAYMENTS_VOID, { companyId: current.companyId, partyId: current.partyId })) throw new ForbiddenError('The payment would pay nothing after: voiding it needs the right to void payments.')
        const problems = voidProblems({ status: current.status, allocated: 0, refunded: await refundedOf(tx, current.id) })
        if (problems.length > 0) throw new InvalidStateError(problems.join(' '))
        const receivedOn = current.receivedOn.toISOString().slice(0, 10)
        await honourPeriodLocks(tools, [{ companyId: current.companyId, day: receivedOn, refused: `the payment received on ${dayWords(receivedOn)} (bank reference ${current.externalRef}) is not voided`, path: 'paymentId', record: { type: 'Payment', id: current.id } }], body.periodLockOverride)
        await tx.payment.update({ where: { id: current.id }, data: { status: 'VOIDED', voidedAt: now, voidReason: reason }, select: { id: true } })
        tools.audit({ action: 'payments.void', recordType: 'Payment', recordId: current.id, companyId: current.companyId, before: { status: 'RECEIVED' }, after: { status: 'VOIDED' }, reason })
        tools.emit({ type: 'payment.voided', subject: current.id, companyId: current.companyId, payload: { paymentId: current.id, partyId: current.partyId } })
        voided = true
      }
      const undone = live.reduce((sum, row) => sum + row.amount, 0)
      tools.audit({ action: 'payments.undoDepositPayment', recordType: 'Payment', recordId: current.id, companyId: current.companyId, before: { status: 'RECEIVED', depositRequestId: request.id }, after: { depositRequestId: request.id, reversed, amount: markMoney('price', undone), voided }, reason })
      // Taking money back unsettles a settled order: announced at the end (its 'order' lock last).
      await settleOrders(tools, request.orderId ? [request.orderId] : [])
      return { reversed, voided }
    },
  )
  return { payment: await caller.withClient(async (client) => paymentDetail(client, (await readPayment(client, payment.id))!)), undone: { depositRequestId: body.depositRequestId, reversed: result.reversed, voided: result.voided } }
}
