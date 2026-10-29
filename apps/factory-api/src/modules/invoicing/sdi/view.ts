import { toUtcIso, businessDate } from '@nexus/factory-domain/core/time'
import type { IssueProblem } from '@nexus/factory-domain/invoicing/checks'
import { deadlineState, type DeadlineState } from '@nexus/factory-domain/invoicing/sdi/deadline'
import { sdiErrorsOf, type SdiErrorView } from '@nexus/factory-domain/invoicing/sdi/errors'
import { failureOf, maySend, type SdiSendStatus, type SendFailureCode } from '@nexus/factory-domain/invoicing/sdi/states'
import { NOTIFICATION_WORDS, sdiStateWords, type SdiStateWords } from '@nexus/factory-domain/invoicing/sdi/words'
import type { SdiNotificationType } from '@nexus/factory-domain/ports/sdi'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { reviewIssue } from '../facts'
import { officeInvoice, readLines, type InvoiceRow, type Reader } from '../store'
import { readCopies, type CourtesyCopies } from './copy'
import { resendProblems } from './correct'
import { readArchive, readNotifications, readSends, type ArchiveRecord } from './store'

/**
 * The invoice's SDI status (A2 SCR-081 tab "SDI status"; SCR-080's SDI column; FIN-086, FIN-087, FIN-088, FIN-092): where
 * it stands in plain words with the next step, the deadline of a rejected file, the checks a resend runs, every send
 * with SDI's notifications (an NS's errors in words, with what to fix), the legal archive, the courtesy copies. Office
 * only (invoices.view); the provider's own id is not shown.
 */

export interface SdiNotificationView {
  readonly id: string
  readonly type: SdiNotificationType
  readonly words: string
  readonly receivedAt: string
  readonly recordedAt: string
  readonly source: 'webhook' | 'poll'
  readonly errors: SdiErrorView[]
}

export interface SdiSendView {
  readonly id: string
  readonly attempt: number
  readonly fileName: string
  readonly status: SdiSendStatus
  readonly sdiIdentifier: string | null
  readonly sentAt: string | null
  readonly outcomeAt: string | null
  readonly failure: { readonly code: SendFailureCode | 'UNKNOWN'; readonly uncertain: boolean; readonly words: string } | null
  readonly createdAt: string
  readonly notifications: SdiNotificationView[]
}

export interface SdiView {
  readonly invoiceId: string
  readonly number: string | null
  readonly issueDate: string | null
  readonly invoiceStatus: InvoiceRow['status']
  readonly version: number
  readonly state: SdiStateWords
  readonly canSend: boolean
  readonly deadline: DeadlineState | null
  readonly resend: { readonly ready: boolean; readonly problems: IssueProblem[] } | null
  readonly sends: SdiSendView[]
  readonly archive: ArchiveRecord | null
  readonly courtesyCopies: CourtesyCopies
}

const at = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

/** The view of an invoice the caller may see (the route checked it). */
export async function sdiView(db: Reader, invoice: InvoiceRow, now: Date = serverClock.now()): Promise<SdiView> {
  const sends = await readSends(db, invoice.id)
  const notifications = await readNotifications(db, invoice.id)
  const latest = sends.at(-1) ?? null
  const views: SdiSendView[] = sends.map((send) => ({
    id: send.id,
    attempt: send.attempt,
    fileName: send.fileName,
    status: send.status,
    sdiIdentifier: send.sdiIdentifier,
    sentAt: at(send.sentAt),
    outcomeAt: at(send.outcomeAt),
    failure: send.status === 'FAILED' ? failureOf(send.failureReason) : null,
    createdAt: toUtcIso(send.createdAt),
    notifications: notifications
      .filter((row) => row.submissionId === send.id)
      .map((row) => ({
        id: row.id,
        type: row.type,
        words: NOTIFICATION_WORDS[row.type],
        receivedAt: toUtcIso(row.receivedAt),
        recordedAt: toUtcIso(row.recordedAt),
        source: row.inboundWebhookId ? 'webhook' : 'poll',
        errors: row.type === 'NS' ? sdiErrorsOf(row.payload) : [],
      })),
  }))

  let deadline: DeadlineState | null = null
  let resend: SdiView['resend'] = null
  if (invoice.status === 'REJECTED' && latest) {
    const ns = notifications.filter((row) => row.submissionId === latest.id && row.type === 'NS').sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())[0]
    const rejectedAt = ns?.receivedAt ?? latest.outcomeAt
    deadline = rejectedAt ? deadlineState(rejectedAt, businessDate(now)) : null
    const problems = resendProblems((await reviewIssue(db, invoice, await readLines(db, invoice.id), invoice.issueDate!.toISOString().slice(0, 10), now)).problems)
    resend = { ready: problems.length === 0, problems }
  }
  const courtesyCopies = await readCopies(db, invoice.id)
  const rejection = latest?.status === 'REJECTED' ? latest.failureReason : null
  const state = sdiStateWords({
    invoiceStatus: invoice.status,
    latest: latest ? { status: latest.status, fileName: latest.fileName, failureReason: latest.failureReason, rejection } : null,
    deadline,
    copy: courtesyCopies.queued.length > 0 ? 'QUEUED' : courtesyCopies.missing ? 'MISSING' : null,
  })
  return {
    invoiceId: invoice.id,
    number: invoice.number,
    issueDate: invoice.issueDate ? invoice.issueDate.toISOString().slice(0, 10) : null,
    invoiceStatus: invoice.status,
    version: invoice.version,
    state,
    canSend: maySend(invoice.status) && latest?.status !== 'SENDING',
    deadline,
    resend,
    sends: views,
    archive: await readArchive(db, invoice.id),
    courtesyCopies,
  }
}

/** invoices.view (GET /invoicing/invoices/:invoiceId/sdi). */
export async function getSdiStatus(caller: CommandCaller, invoiceId: string): Promise<{ sdi: SdiView }> {
  const invoice = await officeInvoice(caller, invoiceId)
  return { sdi: await caller.withClient((client) => sdiView(client, invoice)) }
}
