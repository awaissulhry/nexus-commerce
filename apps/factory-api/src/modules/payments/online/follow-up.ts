import { DomainError, InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate, businessDayRange, toUtcIso } from '@nexus/factory-domain/core/time'
import { depositInvoiceDecision } from '@nexus/factory-domain/invoicing/deposit'
import { amountText, receiptMail, type IntentMethod } from '@nexus/factory-domain/payments/online/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { sendEmail } from '../../../platform/email-out/outbound'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { closeTasksInCommand, moveDueInCommand, openTaskInCommand, reopenInCommand, tasksOfRecord } from '../../../platform/portal/tasks/store'
import { insertDepositDraft, readDepositRequest } from '../../invoicing/drafts'
import { issueInCommand, seriesKindFor } from '../../invoicing/issue'
import { lockMoney } from '../locks'
import { processPayments, type PaymentsRuntime } from './runtime'
import { readIntent, targetFacts, targetOf, type IntentRow, type Reader } from './store'
import { payInvoiceKey } from './task-source'

/**
 * What follows an online payment, in the worker (B-W2b-185), each in its own command so none of it can undo the payment:
 *
 *   payments.payInvoiceTask   the PAY_INVOICE request of an issued TD01 / TD24 invoice kept to what is open on it: opened
 *                             when it is issued (due at the end of its first open instalment's day, Europe/Rome), its due
 *                             date moved with the instalments, DONE when nothing is open (any payment: online, a bank
 *                             transfer the office typed, a credit note), opened again when an allocation is taken back,
 *                             left alone once the office cancelled it. On invoice.issued (a TD04: its credited invoice),
 *                             payment.allocated | allocation_reversed (an invoice), payment.overpayment_released,
 *                             invoice.sdi_status_changed (a REJECTED invoice asks nothing until it is sent again)
 *   payments.onlineFinished   on payment_intent.finished:
 *                               FAILED with the provider's id   the provider's intent cancelled (it can never take money
 *                                                               later; a refusal of the provider is only logged)
 *                               SUCCEEDED of a deposit request  the deposit invoice (TD02) when the rule requires one (DPR
 *                                                               633/1972 art. 6 c.4), issued as the office's "deposit
 *                                                               received" does; when its checks refuse (a missing tax
 *                                                               identity, no series) the refusal is audited on the request
 *                                                               and the office issues it (deposit-draft, then issue)
 *                               SUCCEEDED                       the receipt mail to whoever paid (the link's address, the
 *                                                               portal person's), from the office person who sent the link or
 *                                                               issued the document, on the record's thread (FAKE locally);
 *                                                               nobody to send it as: audited, no mail
 */

const PAY_TASK_EVENTS = ['invoice.issued', 'payment.allocated', 'payment.allocation_reversed', 'payment.overpayment_released', 'invoice.sdi_status_changed'] as const

/** The end of a business day (Europe/Rome), the last millisecond: a request due that day is overdue the next. */
const endOfDay = (day: string): Date => new Date(businessDayRange(day).end.getTime() - 1)

/** The invoice a pay-task event is about, or null. */
async function invoiceOfEvent(db: Reader, type: string, payload: Record<string, unknown>): Promise<string | null> {
  if (type === 'payment.allocated' || type === 'payment.allocation_reversed') return payload.target === 'INVOICE' && typeof payload.targetId === 'string' ? payload.targetId : null
  if (typeof payload.invoiceId !== 'string') return null
  if (type === 'invoice.issued' && payload.docType === 'TD04') return (await db.invoice.findUnique({ where: { id: payload.invoiceId }, select: { creditOfId: true } }))?.creditOfId ?? null
  if (type === 'invoice.issued' && payload.docType !== 'TD01' && payload.docType !== 'TD24') return null
  return payload.invoiceId
}

type PayTaskMove = 'open' | 'reopen' | 'move' | 'close' | null

async function payTaskMove(db: Reader, invoiceId: string): Promise<{ readonly move: PayTaskMove; readonly facts: Awaited<ReturnType<typeof targetFacts>>; readonly dueAt: Date | null }> {
  const facts = await targetFacts(db, 'INVOICE', invoiceId)
  if (!facts || (facts.docType !== 'TD01' && facts.docType !== 'TD24')) return { move: null, facts, dueAt: null }
  const asks = facts.open > 0 && facts.status !== 'REJECTED'
  const dueAt = facts.dueDate ? endOfDay(facts.dueDate) : null
  const [task] = await tasksOfRecord(db, 'Invoice', invoiceId, { kinds: ['PAY_INVOICE'], sourceKey: payInvoiceKey(invoiceId) })
  if (!asks) return { move: task?.status === 'OPEN' ? 'close' : null, facts, dueAt }
  if (!task) return { move: 'open', facts, dueAt }
  if (task.status === 'DONE') return { move: 'reopen', facts, dueAt }
  if (task.status === 'OPEN' && (task.dueAt?.getTime() ?? null) !== (dueAt?.getTime() ?? null)) return { move: 'move', facts, dueAt }
  return { move: null, facts, dueAt }
}

/** Keeps the invoice's PAY_INVOICE request to what is open on it (see the file's comment). Returns what it did. */
export async function syncPayTask(caller: CommandCaller, invoiceId: string, causationId?: string): Promise<PayTaskMove> {
  const planned = await caller.withClient((db) => payTaskMove(db, invoiceId))
  if (planned.move === null) return null
  const { result } = await command(caller, { name: 'payments.payInvoiceTask', input: { invoiceId }, ...(causationId ? { causationId } : {}) }, async (tools) => {
    const { move, facts, dueAt } = await payTaskMove(tools.tx, invoiceId)
    const [task] = await tasksOfRecord(tools.tx, 'Invoice', invoiceId, { kinds: ['PAY_INVOICE'], sourceKey: payInvoiceKey(invoiceId) })
    if (move === 'open') await openTaskInCommand(tools, { companyId: facts!.companyId, partyId: facts!.partyId, kind: 'PAY_INVOICE', record: { type: 'Invoice', id: invoiceId, label: facts!.number ?? '' }, sourceKey: payInvoiceKey(invoiceId), dueAt, askedBy: null })
    else if (move === 'reopen' && task) {
      await reopenInCommand(tools, task, false)
      if ((task.dueAt?.getTime() ?? null) !== (dueAt?.getTime() ?? null)) await moveDueInCommand(tools, { ...task, status: 'OPEN', version: task.version + 1 }, dueAt)
    } else if (move === 'move' && task) await moveDueInCommand(tools, task, dueAt)
    else if (move === 'close') await closeTasksInCommand(tools, { recordType: 'Invoice', recordId: invoiceId, kinds: ['PAY_INVOICE'], sourceKey: payInvoiceKey(invoiceId), status: 'DONE', doneById: null })
    tools.audit({ action: 'payments.payInvoiceTask', recordType: 'Invoice', recordId: invoiceId, companyId: facts?.companyId ?? null, after: { move, open: facts ? facts.open > 0 : false, dueAt: dueAt ? toUtcIso(dueAt) : null } })
    return { move }
  })
  return result.move
}

// ---- after an intent finished ----------------------------------------------------------------------------------------

export interface FinishedOutcome {
  readonly cancelledAtProvider: boolean
  readonly depositInvoice: 'issued' | 'held' | 'not_required' | 'exists' | null
  readonly receipt: 'queued' | 'held' | null
}

/** On payment_intent.finished (see the file's comment). */
export async function afterIntentFinished(caller: CommandCaller, intentId: string, causationId: string, runtime: PaymentsRuntime = processPayments()): Promise<FinishedOutcome> {
  const intent = await caller.withClient((db) => readIntent(db, intentId))
  if (!intent) return { cancelledAtProvider: false, depositInvoice: null, receipt: null }
  if (intent.status === 'FAILED' && intent.providerRef) {
    const done = await runtime.cancelIntent(caller, intent.providerAccountId, intent.providerRef).then(() => true, () => false)
    return { cancelledAtProvider: done, depositInvoice: null, receipt: null }
  }
  if (intent.status !== 'SUCCEEDED' || !intent.paymentId) return { cancelledAtProvider: false, depositInvoice: null, receipt: null }
  const depositInvoice = intent.depositRequestId ? await depositInvoiceOf(caller, intent, causationId) : null
  const receipt = await receiptOf(caller, intent, depositInvoice === 'issued', causationId)
  return { cancelledAtProvider: false, depositInvoice, receipt }
}

/** The TD02 of a deposit paid online, when the rule requires one (see the file's comment). */
async function depositInvoiceOf(caller: CommandCaller, intent: IntentRow, causationId: string): Promise<FinishedOutcome['depositInvoice']> {
  const requestId = intent.depositRequestId!
  const plan = await caller.withClient(async (db) => {
    const request = await db.depositRequest.findUnique({ where: { id: requestId }, select: { id: true, companyId: true, fiscalDocument: true, fiscalRule: true, orderId: true } })
    if (!request) return null
    const existing = await db.invoice.findFirst({ where: { depositRequestId: requestId, docType: 'TD02' }, select: { id: true } })
    const allocated = (await db.paymentAllocation.aggregate({ where: { paymentId: intent.paymentId!, depositRequestId: requestId }, _sum: { amount: true } }))._sum.amount ?? 0
    const shipped = request.orderId ? await db.shipment.findFirst({ where: { salesOrderId: request.orderId, shippedAt: { not: null } }, orderBy: { shippedAt: 'asc' }, select: { shippedAt: true } }) : null
    const paidOn = businessDate(intent.finishedAt ?? new Date())
    const decision = depositInvoiceDecision({ fiscalDocument: request.fiscalDocument, fiscalRule: request.fiscalRule, paidAmount: allocated, paidOn, goodsLeftOn: shipped?.shippedAt ? businessDate(shipped.shippedAt) : null })
    return { request, existing, allocated, paidOn, decision }
  })
  if (!plan) return null
  if (!plan.decision.required || plan.allocated <= 0) return 'not_required'
  if (plan.existing) return 'exists'
  try {
    await command(caller, { name: 'payments.onlineDepositInvoice', idempotencyKey: `online-td02.${intent.id}`, input: { intentId: intent.id, depositRequestId: requestId }, causationId }, async (tools) => {
      await lockMoney(tools.tx, tools.context, 'deposit', requestId)
      if (await tools.tx.invoice.findFirst({ where: { depositRequestId: requestId, docType: 'TD02' }, select: { id: true } })) throw new InvalidStateError('The deposit request has its deposit invoice already.')
      if ((await seriesKindFor(tools.tx, plan.request.companyId, 'TD02')) === null) throw new DomainError('conflict', 'This company has no active deposit invoice or invoice number series: an admin sets it up under numbering.', [{ path: 'numbering', message: 'No series.' }])
      const request = (await readDepositRequest(tools.tx, requestId))!
      const invoiceId = await insertDepositDraft(tools, request, plan.allocated, plan.paidOn)
      const issued = await issueInCommand(tools, invoiceId)
      tools.audit({ action: 'payments.onlineDepositInvoice', recordType: 'DepositRequest', recordId: requestId, companyId: plan.request.companyId, after: { intentId: intent.id, paymentId: intent.paymentId, invoiceId, number: issued.number } })
      return { invoiceId }
    })
    return 'issued'
  } catch (error) {
    if (!(error instanceof DomainError)) throw error
    const reason = `${error.message}${error.issues && error.issues.length > 1 ? ` ${error.issues.map((issue) => issue.message).join(' ')}` : ''}`.slice(0, 500)
    await command(caller, { name: 'payments.onlineDepositInvoiceHeld', idempotencyKey: `online-td02-held.${intent.id}`, input: { intentId: intent.id }, causationId }, async (tools) => {
      tools.audit({ action: 'payments.onlineDepositInvoiceHeld', recordType: 'DepositRequest', recordId: requestId, companyId: plan.request.companyId, after: { intentId: intent.id, paymentId: intent.paymentId, reason } })
      return { held: true }
    })
    return 'held'
  }
}

/** The receipt mail (see the file's comment). */
async function receiptOf(caller: CommandCaller, intent: IntentRow, depositInvoiceFollows: boolean, causationId: string): Promise<FinishedOutcome['receipt']> {
  const facts = await caller.withClient(async (db) => {
    const link = intent.linkId ? await db.oneOffLink.findUnique({ where: { id: intent.linkId }, select: { email: true, createdById: true } }) : null
    const person = intent.createdById ? await db.user.findUnique({ where: { id: intent.createdById }, select: { email: true, locale: true } }) : null
    const target = await targetFacts(db, targetOf(intent).target, targetOf(intent).targetId)
    const party = await db.party.findUnique({ where: { id: intent.partyId }, select: { language: true } })
    const company = await db.company.findUnique({ where: { id: intent.companyId }, select: { legalName: true, tradeName: true } })
    const payment = intent.paymentId ? await db.payment.findUnique({ where: { id: intent.paymentId }, select: { receivedOn: true, externalRef: true } }) : null
    // Who it is sent as: the office person who sent the link, else who issued the invoice or asked the deposit (active).
    const senderIds = [link?.createdById ?? null, target?.issuedById ?? null, target?.deposit?.createdById ?? null].filter((id): id is string => id !== null)
    const senders = senderIds.length === 0 ? [] : await db.user.findMany({ where: { id: { in: senderIds }, status: 'ACTIVE', audience: 'OFFICE' }, select: { id: true, displayName: true, email: true } })
    const sender = senderIds.map((id) => senders.find((user) => user.id === id)).find((user) => user !== undefined) ?? null
    // The thread: the invoice's; a deposit request's quote, else its order.
    let record: { type: 'Invoice' | 'Quote' | 'SalesOrder'; id: string } | null = intent.invoiceId ? { type: 'Invoice', id: intent.invoiceId } : null
    if (!record && intent.depositRequestId) {
      const request = await db.depositRequest.findUnique({ where: { id: intent.depositRequestId }, select: { quoteVersionId: true, orderId: true } })
      const version = request?.quoteVersionId ? await db.quoteVersion.findUnique({ where: { id: request.quoteVersionId }, select: { quoteId: true } }) : null
      record = version ? { type: 'Quote', id: version.quoteId } : request?.orderId ? { type: 'SalesOrder', id: request.orderId } : null
    }
    return { to: link?.email ?? person?.email ?? null, locale: (person?.locale ?? party?.language) === 'en' ? ('en' as const) : ('it' as const), target, company, payment, sender, record }
  })
  const why = !facts.to ? 'no address' : !facts.sender ? 'nobody to send it as' : !facts.record || !facts.target ? 'no thread' : null
  try {
    if (why) throw new InvalidStateError(why)
    const mail = receiptMail({
      locale: facts.locale,
      what: facts.target!.label[facts.locale],
      amount: amountText(intent.amount, intent.currency),
      method: intent.method as IntentMethod,
      paidOn: facts.payment ? (facts.locale === 'it' ? facts.payment.receivedOn.toISOString().slice(0, 10).split('-').reverse().join('/') : facts.payment.receivedOn.toISOString().slice(0, 10)) : '',
      reference: facts.payment?.externalRef ?? intent.providerRef ?? intent.id,
      companyName: facts.company?.tradeName ?? facts.company?.legalName ?? '',
      depositInvoiceFollows,
    })
    await command(caller, { name: 'payments.onlineReceipt', idempotencyKey: `online-receipt.${intent.id}`, input: { intentId: intent.id }, causationId }, async (tools: CommandTools) => {
      const sent = await sendEmail(tools, { record: facts.record!, sender: { userId: facts.sender!.id, name: facts.sender!.displayName, email: facts.sender!.email }, to: [facts.to!], subject: mail.subject, body: mail.body, locale: facts.locale })
      tools.audit({ action: 'payments.onlineReceipt', recordType: 'PaymentIntent', recordId: intent.id, companyId: intent.companyId, after: { paymentId: intent.paymentId, outboundId: sent.outbound.id, to: facts.to } })
      return { outboundId: sent.outbound.id }
    })
    return 'queued'
  } catch (error) {
    if (!(error instanceof ValidationError || error instanceof InvalidStateError)) throw error
    const reason = (error.message === why ? why : `${error.message}${error.issues?.length ? ` ${error.issues.map((issue) => issue.message).join(' ')}` : ''}`).slice(0, 500)
    await command(caller, { name: 'payments.onlineReceiptHeld', idempotencyKey: `online-receipt-held.${intent.id}`, input: { intentId: intent.id }, causationId }, async (tools) => {
      tools.audit({ action: 'payments.onlineReceiptHeld', recordType: 'PaymentIntent', recordId: intent.id, companyId: intent.companyId, after: { paymentId: intent.paymentId, reason } })
      return { held: true }
    })
    return 'held'
  }
}

// ---- the worker's handlers -------------------------------------------------------------------------------------------

/** The worker's handlers of paying online (background.ts W2B_185_HANDLERS). */
export function onlinePaymentHandlers(runtime?: () => PaymentsRuntime): EventHandler[] {
  return [
    defineHandler({
      name: 'payments.payInvoiceTask',
      events: [...PAY_TASK_EVENTS],
      async handle(event, tools) {
        const invoiceId = await tools.caller.withClient((db) => invoiceOfEvent(db, event.type, event.payload as Record<string, unknown>))
        if (invoiceId) await syncPayTask(tools.caller, invoiceId, event.eventId)
      },
    }),
    defineHandler({
      name: 'payments.onlineFinished',
      events: ['payment_intent.finished'],
      async handle(event, tools) {
        const { intentId } = event.payload as { intentId: string }
        await afterIntentFinished(tools.caller, intentId, event.eventId, runtime ? runtime() : processPayments())
      },
    }),
  ]
}
