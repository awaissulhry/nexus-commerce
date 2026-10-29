import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { InvoiceStatus } from '@nexus/factory-domain/invoicing/invoices'
import { rejectionGist, sdiErrorsOf } from '@nexus/factory-domain/invoicing/sdi/errors'
import { decidedOutcome, invoicePath, invoiceStatusFromSends, isOutcome, outcomeOf, sendMoveFor, type SdiSendStatus } from '@nexus/factory-domain/invoicing/sdi/states'
import { messageKeyOf, type SdiMessage } from '@nexus/factory-domain/ports/sdi'
import type { CommandTools } from '../../../core/command'
import type { SendResult } from './runtime'
import { noteOrders, ordersOfInvoices, settleNoted } from '../from-shipment/settlement'
import { lockInvoice, readSend, readSends, type SendRow } from './store'

/**
 * Recording what SDI and the provider said, inside a command (B-W1-50; the rules: factory-domain invoicing/sdi/states).
 * Every function here takes the invoice's row lock first (store.ts lockInvoice), then reads the send again, so a
 * webhook, a poll and the send's own result never interleave on one invoice, and keeps the invoice's status equal to
 * what its sends decide (`syncInvoice`): the database does not tie them, this file does.
 */

type Tools = Pick<CommandTools, 'tx' | 'now' | 'audit' | 'emit' | 'context'>

const invoiceSelect = { id: true, status: true, companyId: true } as const

/**
 * Moves the invoice to the status its sends decide (rule 4), along the database's moves (one UPDATE per step; leaving
 * REJECTED runs the issue's checks again in the trigger). A status no path reaches is kept and reported (audit).
 */
export async function syncInvoice(tools: Tools, invoiceId: string): Promise<{ from: InvoiceStatus; to: InvoiceStatus; companyId: string }> {
  const invoice = await tools.tx.invoice.findUnique({ where: { id: invoiceId }, select: invoiceSelect })
  if (!invoice) throw new NotFoundError('Invoice not found.')
  const sends = await readSends(tools.tx, invoiceId)
  const target = invoiceStatusFromSends(sends, invoice.status)
  const path = invoicePath(invoice.status, target)
  if (path === null) {
    tools.audit({ action: 'invoices.sdiStatusKept', recordType: 'Invoice', recordId: invoiceId, companyId: invoice.companyId, before: { status: invoice.status }, after: { decided: target }, reason: 'no move of the invoice leads there' })
    return { from: invoice.status, to: invoice.status, companyId: invoice.companyId }
  }
  for (const step of path) {
    await tools.tx.invoice.update({ where: { id: invoiceId }, data: { status: step, version: { increment: 1 } }, select: { id: true } })
  }
  // B-W1-51: an outcome at the customer's side may settle the invoice's orders: noted here, announced at the end of the
  // command (settleNoted: the poll's and the webhook's), after every invoice row it locks.
  if (path.length > 0 && (target === 'DELIVERED' || target === 'NOT_DELIVERABLE')) noteOrders(tools, await ordersOfInvoices(tools.tx, [invoiceId]))
  if (path.length > 0) {
    tools.audit({ action: 'invoices.sdiStatus', recordType: 'Invoice', recordId: invoiceId, companyId: invoice.companyId, before: { status: invoice.status }, after: { status: target, ...(path.length > 1 ? { via: path.slice(0, -1) } : {}) } })
  }
  return { from: invoice.status, to: target, companyId: invoice.companyId }
}

/** After a send moved: the invoice follows, and the SDI column and the worker's handlers hear of it. */
export async function afterSendMove(tools: Tools, send: Pick<SendRow, 'id' | 'invoiceId' | 'attempt'>, sendStatus: SdiSendStatus): Promise<InvoiceStatus> {
  const { from, to, companyId } = await syncInvoice(tools, send.invoiceId)
  tools.emit({
    type: 'invoice.sdi_status_changed',
    subject: send.invoiceId,
    companyId,
    payload: { invoiceId: send.invoiceId, submissionId: send.id, attempt: send.attempt, sendStatus, invoiceStatus: to, previousStatus: from },
  })
  return to
}

async function companyOf(tools: Tools, invoiceId: string): Promise<string> {
  return (await tools.tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { companyId: true } })).companyId
}

/** The send's row as it is now, after the invoice's lock. */
async function lockedSend(tools: Tools, submissionId: string): Promise<SendRow> {
  const first = await readSend(tools.tx, submissionId)
  if (!first) throw new NotFoundError('SDI send not found.')
  await lockInvoice(tools.tx, first.invoiceId)
  return (await readSend(tools.tx, submissionId))!
}

const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

/**
 * The provider's answer to a send (the send command's second half): SENDING → SENT with the provider's id, or → FAILED
 * with why. A send a notification or the poll moved meanwhile keeps its state (the provider's id is named if missing).
 * Safe to repeat.
 */
export async function recordSendResult(tools: Tools, submissionId: string, result: SendResult): Promise<{ sendStatus: SdiSendStatus; invoiceStatus: InvoiceStatus | null }> {
  const send = await lockedSend(tools, submissionId)
  const companyId = await companyOf(tools, send.invoiceId)
  if (send.status !== 'SENDING') {
    if (result.ok && send.providerRef === null) {
      await tools.tx.sdiSubmission.update({ where: { id: send.id }, data: { providerRef: result.receipt.providerRef, version: { increment: 1 } }, select: { id: true } })
      tools.audit({ action: 'invoices.sdiSendResult', recordType: 'SdiSubmission', recordId: send.id, companyId, before: { status: send.status }, after: { status: send.status, providerRef: 'named', late: true } })
    }
    return { sendStatus: send.status, invoiceStatus: null }
  }
  const data: Prisma.SdiSubmissionUncheckedUpdateInput = result.ok
    ? { status: 'SENT', providerRef: result.receipt.providerRef, sentAt: new Date(result.receipt.acceptedAt), version: { increment: 1 } }
    : { status: 'FAILED', failureReason: result.failureReason, version: { increment: 1 } }
  await tools.tx.sdiSubmission.update({ where: { id: send.id }, data, select: { id: true } })
  const sendStatus: SdiSendStatus = result.ok ? 'SENT' : 'FAILED'
  tools.audit({ action: 'invoices.sdiSendResult', recordType: 'SdiSubmission', recordId: send.id, companyId, before: { status: 'SENDING' }, after: result.ok ? { status: sendStatus, providerFileName: result.receipt.providerFileName } : { status: sendStatus, failureReason: result.failureReason } })
  const invoiceStatus = await afterSendMove(tools, send, sendStatus)
  await settleNoted(tools)
  return { sendStatus, invoiceStatus }
}

export interface AppliedMessages {
  readonly recorded: number
  readonly duplicates: number
  readonly conflict: boolean
  readonly sendStatus: SdiSendStatus
}

/**
 * SDI's notifications about one send (a webhook, a poll, a late answer), in any order and any number of times
 * (factory-domain invoicing/sdi/states rules 1-4): each message is recorded ONCE per send (its SDI MessageId: the
 * duplicates are counted, not stored; the unique key backs it), the send moves to the outcome they decide (passing SENT
 * when it was still SENDING), its SDI id and the provider's id are named once, a notification that says another outcome
 * than the one the send ends with is kept and reported (`conflict`), never applied, and the invoice follows its sends.
 */
export async function applyMessages(tools: Tools, submissionId: string, messages: readonly SdiMessage[], source: { readonly inboundWebhookId: string | null }): Promise<AppliedMessages> {
  const send = await lockedSend(tools, submissionId)
  const companyId = await companyOf(tools, send.invoiceId)
  const stored = await tools.tx.sdiNotification.findMany({ where: { submissionId: send.id }, select: { type: true, sdiMessageId: true } })
  const seen = new Set(stored.map((row) => row.sdiMessageId))
  const fresh: SdiMessage[] = []
  let duplicates = 0
  for (const message of messages) {
    const key = messageKeyOf(message)
    if (seen.has(key)) {
      duplicates++
      continue
    }
    seen.add(key)
    fresh.push(message)
  }
  const decided = decidedOutcome([...stored.map((row) => row.type), ...fresh.map((message) => message.type)])
  const move = sendMoveFor(send.status, decided)
  // A message that says another outcome than the one the send ends with contradicts it: kept, reported, not applied.
  const finalStatus = move.steps.at(-1) ?? send.status
  const contradicts = (message: SdiMessage): boolean => isOutcome(finalStatus) && outcomeOf(message.type) !== finalStatus

  for (const message of fresh) {
    const id = newId()
    await tools.tx.sdiNotification.create({
      data: {
        id,
        partyId: send.partyId,
        invoiceId: send.invoiceId,
        submissionId: send.id,
        type: message.type,
        sdiMessageId: messageKeyOf(message),
        receivedAt: new Date(message.issuedAt),
        recordedAt: tools.now,
        payload: json(message),
        inboundWebhookId: source.inboundWebhookId,
        createdById: null,
      },
      select: { id: true },
    })
    const conflict = contradicts(message)
    tools.audit({ action: 'invoices.sdiNotification', recordType: 'SdiNotification', recordId: id, companyId, after: { submissionId: send.id, type: message.type, source: source.inboundWebhookId ? 'webhook' : 'poll', ...(conflict ? { conflict: `the send is ${send.status} already` } : {}) } })
    tools.emit({ type: 'invoice.sdi_notification_received', subject: send.invoiceId, companyId, payload: { invoiceId: send.invoiceId, submissionId: send.id, notificationId: id, type: message.type, conflict } })
  }

  const named: Prisma.SdiSubmissionUncheckedUpdateInput = {}
  const sdiIdentifier = fresh.find((message) => message.sdiIdentifier)?.sdiIdentifier
  if (send.sdiIdentifier === null && sdiIdentifier) named.sdiIdentifier = sdiIdentifier
  const providerRef = fresh.find((message) => message.providerRef)?.providerRef
  if (send.providerRef === null && providerRef) named.providerRef = providerRef

  let status = send.status
  for (const step of move.steps) {
    const data: Prisma.SdiSubmissionUncheckedUpdateInput = { ...named, status: step, version: { increment: 1 } }
    if (step === 'SENT') {
      const earliest = Math.min(tools.now.getTime(), ...fresh.map((message) => Date.parse(message.issuedAt)))
      data.sentAt = send.sentAt ?? new Date(earliest)
    } else {
      const deciding = [...fresh].filter((message) => outcomeOf(message.type) === step).sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt))[0]
      data.outcomeAt = deciding ? new Date(deciding.issuedAt) : tools.now
      if (step === 'REJECTED') data.failureReason = rejectionGist(sdiErrorsOf(deciding ?? null))
    }
    await tools.tx.sdiSubmission.update({ where: { id: send.id }, data, select: { id: true } })
    status = step
    for (const key of Object.keys(named)) delete (named as Record<string, unknown>)[key]
  }
  if (Object.keys(named).length > 0) await tools.tx.sdiSubmission.update({ where: { id: send.id }, data: { ...named, version: { increment: 1 } }, select: { id: true } })

  if (move.steps.length > 0) {
    tools.audit({ action: 'invoices.sdiOutcome', recordType: 'SdiSubmission', recordId: send.id, companyId, before: { status: send.status }, after: { status, decidedBy: fresh.map((message) => message.type) } })
    await afterSendMove(tools, send, status)
  }
  return { recorded: fresh.length, duplicates, conflict: fresh.some(contradicts), sendStatus: status }
}
