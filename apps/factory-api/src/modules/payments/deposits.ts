import { DomainError, ForbiddenError, InvalidStateError } from '@nexus/factory-domain/core/errors'
import { businessDate } from '@nexus/factory-domain/core/time'
import { depositInvoiceDecision, depositRuleNow, type DepositInvoiceDecision } from '@nexus/factory-domain/invoicing/deposit'
import { INVOICES_ISSUE } from '@nexus/factory-domain/invoicing/permissions'
import { PAYMENTS_RECORD, PAYMENTS_VIEW } from '@nexus/factory-domain/payments/permissions'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../core/command'
import { serverClock } from '../../core/time'
import type { FilesRuntime } from '../../platform/files/service'
import { insertDepositDraft, readDepositRequest } from '../invoicing/drafts'
import { partyFacts } from '../invoicing/facts'
import { filesAfterIssue, issueInCommand, refusal, seriesKindFor } from '../invoicing/issue'
import { invoiceDetail, readInvoice, type InvoiceDetail } from '../invoicing/store'
import { lockMoney } from './locks'
import { settleOrders } from '../invoicing/from-shipment/settlement'
import { allocateInCommand, checkPayment, insertPayment, recordingCommand } from './payments'
import { assertMay, mayOn, officeContextOf, paymentDetail, readPayment, type PaymentDetail } from './store'

/**
 * "Deposit received" (B-W1-28; FIN-066, FIN-121; Q12: an acconto paid by bank transfer; A2 SCR-082 "Record a payment"
 * with "Issue the deposit invoice (TD02) now"; stage 06b-deposit): ONE command records the transfer, allocates it to the
 * deposit request (never more than the request still asks: the rest of a larger transfer stays unallocated), marks the
 * request PAID when it is covered, and, when the rule requires one (DPR 633/1972 art. 6 c.4: paid before the goods
 * ship, and the request's fiscal document is TD02), makes the TD02 for the amount allocated and issues it. Lock order:
 * the payment, then the request (allocate BEFORE issuing), then the series (allocateNumber). After the commit the TD02's
 * XML and PDF are made (invoicing/issue filesAfterIssue): a failure there leaves the TD02 ISSUED with its files pending.
 *
 * Issuing needs invoices.issue and a fresh step-up (A1 §3.10), asked only when a TD02 will be issued. The checks before
 * issue run first (a blocked customer, a missing VIES proof…): when they fail, nothing is recorded and the answer says
 * what to fix, or to record the payment without the deposit invoice (`issueDepositInvoice: false`) and issue it later
 * (POST /invoicing/invoices/deposit-draft, then issue).
 */

export interface DepositReceivedInput {
  readonly depositRequestId: string
  readonly amount?: number | undefined
  readonly receivedOn: string
  readonly externalRef: string
  readonly internalNote?: string | null | undefined
  /** Default true: issue the TD02 now when the rule requires one. */
  readonly issueDepositInvoice?: boolean | undefined
}

export interface DepositReceivedAnswer {
  readonly payment: PaymentDetail
  readonly depositRequest: { readonly id: string; readonly status: string }
  readonly depositInvoice: {
    readonly required: boolean
    readonly reason: string
    /** The rule of B-W1-05 for this customer today, beside the request's own decision. */
    readonly ruleNow: string | null
    readonly invoice: InvoiceDetail | null
    readonly filesPending: boolean
    readonly filesProblem: string | null
  }
}

/** The day the order's first goods left (a shipment SHIPPED or later), or null. */
async function goodsLeftOn(db: CommandTx, orderId: string | null): Promise<string | null> {
  if (!orderId) return null
  const first = await db.shipment.findFirst({ where: { salesOrderId: orderId, shippedAt: { not: null } }, orderBy: { shippedAt: 'asc' }, select: { shippedAt: true } })
  return first?.shippedAt ? businessDate(first.shippedAt) : null
}

export async function depositReceived(files: FilesRuntime, caller: CommandCaller, body: DepositReceivedInput, idempotencyKey: string | undefined, stepUp: () => void): Promise<DepositReceivedAnswer> {
  const context = officeContextOf(caller)
  const request = await caller.withClient((client) => readDepositRequest(client, body.depositRequestId))
  assertMay(context, PAYMENTS_VIEW, PAYMENTS_RECORD, request ? { companyId: request.companyId, partyId: request.partyId } : null, 'Deposit request')
  const current = request!
  if (current.status !== 'OPEN') throw new InvalidStateError(`The deposit request is ${current.status}: a payment goes to an OPEN request.`)
  const checked = await checkPayment(caller, { companyId: current.companyId, partyId: current.partyId, amount: body.amount, currency: current.currency, receivedOn: body.receivedOn, externalRef: body.externalRef, internalNote: body.internalNote })

  // The plan, without a lock: what the payment will pay on the request, and whether a TD02 follows.
  const plan = await caller.withClient(async (client) => {
    const allocated = (await client.paymentAllocation.aggregate({ where: { depositRequestId: current.id }, _sum: { amount: true } }))._sum.amount ?? 0
    const paidAmount = Math.min(checked.amount, Math.max(0, current.amount - allocated))
    const decision = depositInvoiceDecision({ fiscalDocument: current.fiscalDocument, fiscalRule: current.fiscalRule, paidAmount, paidOn: checked.receivedOn, goodsLeftOn: await goodsLeftOn(client, current.orderId) })
    const facts = await partyFacts(client, current.partyId, businessDate(serverClock.now()), serverClock.now())
    const ruleNow = facts?.profile ? depositRuleNow(facts.profile) : null
    return { paidAmount, decision, ruleNow: ruleNow ? `${ruleNow.documentType ?? 'NONE'}${ruleNow.ruleId ? ` (${ruleNow.ruleId})` : ''}: ${ruleNow.reason}` : null }
  })
  if (plan.paidAmount <= 0) throw new DomainError('conflict', 'The deposit request asks for nothing more: its payments cover it.')
  const issuing = plan.decision.required && body.issueDepositInvoice !== false
  if (issuing) {
    if (!mayOn(context, INVOICES_ISSUE, { companyId: current.companyId, partyId: current.partyId })) {
      throw new ForbiddenError('Issuing the deposit invoice needs invoices.issue: record the payment without it (issueDepositInvoice: false) and let finance issue it.')
    }
    stepUp()
  }

  const outcome = await recordingCommand(() =>
    command(caller, { name: 'payments.depositReceived', idempotencyKey, input: body }, async (tools) => {
      const payment = await insertPayment(tools, checked)
      // Allocate BEFORE issuing: the payment's lock, then the request's (allocateInCommand), then the series.
      const [allocation] = await allocateInCommand(tools, payment, [{ depositRequestId: current.id }], 'body/allocations', { settle: false })
      const decision: DepositInvoiceDecision = depositInvoiceDecision({ fiscalDocument: current.fiscalDocument, fiscalRule: current.fiscalRule, paidAmount: allocation?.amount ?? 0, paidOn: checked.receivedOn, goodsLeftOn: await goodsLeftOn(tools.tx, current.orderId) })
      let invoiceId: string | null = null
      if (decision.required && body.issueDepositInvoice !== false) invoiceId = await issueDeposit(tools, current, allocation!.amount, checked.receivedOn)
      const status = (await tools.tx.depositRequest.findUnique({ where: { id: current.id }, select: { status: true } }))!.status
      // B-W1-51: the order's settlement, announced at the end (after the TD02's series).
      await settleOrders(tools, current.orderId ? [current.orderId] : [])
      return { paymentId: payment.id, invoiceId, required: decision.required, reason: decision.reason, status }
    }),
  )
  const result = outcome.result
  const made = result.invoiceId ? await filesAfterIssue(files, caller, result.invoiceId) : { filesPending: false, filesProblem: null }
  return caller.withClient(async (client) => ({
    payment: await paymentDetail(client, (await readPayment(client, result.paymentId))!),
    depositRequest: { id: current.id, status: result.status },
    depositInvoice: {
      required: result.required,
      reason: result.reason,
      ruleNow: plan.ruleNow,
      invoice: result.invoiceId ? await invoiceDetail(client, (await readInvoice(client, result.invoiceId))!) : null,
      ...made,
    },
  }))
}

/** Inside the deposit command, the request's lock held: the TD02 draft of the amount paid, issued (or 409 with its problems). */
async function issueDeposit(tools: CommandTools, request: NonNullable<Awaited<ReturnType<typeof readDepositRequest>>>, amount: number, paidOn: string): Promise<string> {
  await lockMoney(tools.tx, tools.context, 'deposit', request.id)
  if ((await seriesKindFor(tools.tx, request.companyId, 'TD02')) === null) {
    throw refusal([{ code: 'SERIES', path: 'numbering', message: 'This company has no active deposit invoice or invoice number series: an admin sets it up under numbering.' }])
  }
  const invoiceId = await insertDepositDraft(tools, request, amount, paidOn)
  await issueInCommand(tools, invoiceId)
  return invoiceId
}
