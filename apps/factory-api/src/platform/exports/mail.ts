import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { footerOf, privacyNoticeUrl } from '@nexus/factory-domain/email/footer'
import { fromLine, messageIdFor } from '@nexus/factory-domain/email/headers'
import { buildMime } from '@nexus/factory-domain/email/mime'
import { identityReady } from '@nexus/factory-domain/email/rules'
import { EXPORT_MAIL, exportLink, exportMailDue, exportMailText } from '@nexus/factory-domain/views/export/mail'
import { command, type CommandCaller } from '../../core/command'
import { serverClock, type Clock } from '../../core/time'
import { companyLegalOf } from '../documents/documents'
import { deliverOutbound } from '../email-out/outbound'
import { processEmail, type EmailRuntime } from '../email-out/service'
import { defineHandler, type EventHandler } from '../outbox/dispatch'
import { JOB, queryOf } from './jobs'
import { exportSourceOf } from './registry'
import { pageOf } from './source'

/**
 * The e-mail of a finished export (B-W2b-11; design shell.lists pop:export-job "You can close this window — we'll
 * e-mail you a link"; factory-domain views/export/mail.ts says when and in which words). Handler `exports.mailLink`, on
 * `export.finished`, in the job's tenant's system context:
 *
 *   1. the job, DONE, not mailed yet, and long enough after it was asked for its window to have been closed
 *      (EXPORT_MAIL.afterMs); anything else: nothing to send;
 *   2. ONE EmailOutbound row (record ExportJob, template exports.ready, NO body) from the tenant's default NOTIFICATION
 *      identity to the person who asked, in the export's language: the LINK to the list's page with `?export=<job>`
 *      (behind sign-in; the file itself is never attached), the number of rows and the day the file is deleted —
 *      never a cell of the list; sent at once through deliverOutbound (suppression and identity checked again; FAKE
 *      accounts locally and in tests);
 *   3. sent: ONE command exports.emailed writes ExportJob.emailedAt (once).
 *
 * Safe to repeat: the queue command is keyed by the job (a second run finds the same mail, which deliverOutbound sends
 * once). A mail that cannot go (no verified identity, a suppressed address) leaves emailedAt empty and says so in the
 * worker log; the file still waits under Export › My recent exports.
 */

export const MAIL_HANDLER = 'exports.mailLink'

export type MailOutcome = 'sent' | 'skipped' | 'failed'

const IDENTITY = { id: true, companyId: true, domain: true, fromAddress: true, displayName: true, displayNamePolicy: true, status: true, verificationStatus: true, dkimStatus: true } as const

export interface MailWork {
  readonly runtime?: EmailRuntime
  readonly clock?: Clock
  readonly causationId?: string
}

/** Sends a finished export's link when it is due (the handler's work; tests call it too). */
export async function mailExportLink(caller: CommandCaller, jobId: string, work: MailWork = {}): Promise<MailOutcome> {
  const facts = await caller.withClient(async (client) => {
    const job = await client.exportJob.findUnique({ where: { id: jobId }, select: { ...JOB } })
    if (!job) return null
    const user = await client.user.findUnique({ where: { id: job.requestedById }, select: { email: true, displayName: true, status: true } })
    const company = job.companyId ? await client.company.findUnique({ where: { id: job.companyId }, select: { code: true } }) : null
    const identities = await client.emailIdentity.findMany({ where: { status: 'ACTIVE', isDefault: true, kind: { in: ['NOTIFICATION', 'CONVERSATION'] } }, orderBy: [{ kind: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }], select: IDENTITY })
    return { job, user, companyCode: company?.code ?? null, identity: identities.find((entry) => identityReady(entry)) ?? null }
  })
  if (!facts || !exportMailDue(facts.job)) return 'skipped'
  const { job, user, identity } = facts
  const rows = job.rowCount
  const expiresAt = job.expiresAt
  if (!job.fileId || rows === null || !expiresAt) return 'skipped'
  if (!user || user.status !== 'ACTIVE' || !identity) return 'failed'

  const runtime = work.runtime ?? processEmail()
  const query = queryOf(job)
  const source = exportSourceOf(job.listKey)
  const page = source ? pageOf(source) : `/${job.listKey.split('.').join('/')}`
  const link = exportLink(runtime.webOrigin, facts.companyCode, page, job.id)
  const words = exportMailText({
    locale: query.locale,
    name: user.displayName,
    title: query.title,
    viewName: query.viewName,
    rows,
    format: job.format as 'CSV' | 'XLSX' | 'XLSX_REIMPORT',
    link,
    deletedOn: businessDate(expiresAt),
  })
  const legal = await companyLegalOf(caller, identity.companyId)
  const footer = footerOf(legal, privacyNoticeUrl(runtime.webOrigin, identity.companyId), query.locale)
  const text = `${words.text}\n\n${footer.text}`
  const html = `${words.html}${footer.html}`
  const from = fromLine(identity, null)
  const { result: outboundId } = await command(caller, { name: 'email.queueSystem', idempotencyKey: `export-mail-${job.id}`, input: { kind: EXPORT_MAIL.templateKey, jobId: job.id }, ...(work.causationId ? { causationId: work.causationId } : {}) }, async ({ tx, now, audit }) => {
    const id = newId()
    await tx.emailOutbound.create({
      data: {
        id,
        companyId: identity.companyId,
        identityId: identity.id,
        recordType: 'ExportJob',
        recordId: job.id,
        templateKey: EXPORT_MAIL.templateKey,
        locale: query.locale,
        fromAddress: from.address,
        fromName: from.name,
        to: [user.email.toLowerCase()],
        subject: words.subject,
        emailMessageId: messageIdFor(id, identity.domain),
        status: 'QUEUED',
        queuedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      select: { id: true },
    })
    audit({ recordType: 'EmailOutbound', recordId: id, companyId: identity.companyId, after: { templateKey: EXPORT_MAIL.templateKey, exportJobId: job.id, identityId: identity.id, status: 'QUEUED' } })
    return id
  })
  const date = (work.clock ?? serverClock).now()
  const delivered = await deliverOutbound(runtime, caller, outboundId, {
    retry: false,
    ...(work.clock ? { clock: work.clock } : {}),
    ...(work.causationId ? { causationId: work.causationId } : {}),
    build: async (row) => buildMime({ id: row.id, from: { name: row.fromName, address: row.fromAddress }, to: row.to, cc: [], replyTo: null, subject: row.subject, messageId: row.emailMessageId, inReplyTo: null, references: [], date, text, html, automatic: true }),
  })
  if (delivered !== 'sent' && delivered !== 'settled') return 'failed'
  const sent = await caller.withClient((client) => client.emailOutbound.findUnique({ where: { id: outboundId }, select: { status: true } }))
  if (sent?.status !== 'SENT' && sent?.status !== 'DELIVERED') return 'failed'
  await command(caller, { name: 'exports.emailed', idempotencyKey: `export-emailed-${job.id}`, input: { jobId: job.id, outboundId }, record: { type: 'ExportJob', id: job.id }, ...(work.causationId ? { causationId: work.causationId } : {}) }, async (tools) => {
    const row = await tools.tx.exportJob.findUniqueOrThrow({ where: { id: job.id }, select: { emailedAt: true, status: true } })
    if (row.emailedAt !== null || row.status !== 'DONE') return { emailed: false }
    await tools.tx.exportJob.update({ where: { id: job.id }, data: { emailedAt: tools.now }, select: { id: true } })
    tools.audit({ recordType: 'ExportJob', recordId: job.id, companyId: job.companyId, after: { emailedAt: tools.now.toISOString(), emailOutboundId: outboundId } })
    return { emailed: true }
  })
  return 'sent'
}

export function exportMailHandler(): EventHandler {
  return defineHandler({
    name: MAIL_HANDLER,
    events: ['export.finished'],
    async handle(event, { caller }) {
      const { jobId, status } = event.payload as { jobId: string; status: string }
      if (status !== 'DONE') return
      await mailExportLink(caller, jobId, { causationId: event.eventId })
    },
  })
}
