import { newId } from '@nexus/factory-domain/core/ids'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { compose } from '@nexus/factory-domain/email/compose'
import { privacyNoticeUrl } from '@nexus/factory-domain/email/footer'
import { fromLine, messageIdFor } from '@nexus/factory-domain/email/headers'
import { buildMime } from '@nexus/factory-domain/email/mime'
import type { Locale } from '@nexus/factory-domain/email/rules'
import { cleanBody } from '@nexus/factory-domain/threads/rules'
import type { CommandCaller, CommandTools } from '../../core/command'
import { serverClock, type Clock } from '../../core/time'
import { companyLegalOf } from '../documents/documents'
import { deliverOutbound, sendingIdentity, type ClaimedOutbound } from '../email-out/outbound'
import type { EmailRuntime } from '../email-out/service'

/**
 * The mail of a link that platform/links makes itself (B-W2b-163: a set of files, a renewal), as B-W2b-54's payroll Send
 * does it: INSIDE the link's command the EmailOutbound row (QUEUED, NO body, the subject only, record = the link,
 * template links.files or links.files_renewed) with its audit row; after the commit the mail is composed in memory WITH
 * the link and sent at once (deliverOutbound, never retried by a job: a failed one stays FAILED and the office makes a
 * new link). The link is in the sent mail only. Sender: the company's default identity — the office person's own mail
 * (CONVERSATION, their name in the From line), the system's (NOTIFICATION, else CONVERSATION). Mail goes through the
 * tenant's mail account: FAKE locally and in tests.
 */

export const LINK_MAIL_TEMPLATES = { files: 'links.files', renewed: 'links.files_renewed' } as const

export interface QueuedLinkMail {
  readonly companyId: string
  readonly linkId: string
  readonly to: string
  readonly locale: Locale
  readonly subject: string
  readonly template: (typeof LINK_MAIL_TEMPLATES)[keyof typeof LINK_MAIL_TEMPLATES]
  /** The office person who sends; null for the system. */
  readonly sender: { readonly userId: string; readonly name: string; readonly email: string | null } | null
}

async function identityFor(tools: Pick<CommandTools, 'tx'>, companyId: string, system: boolean) {
  if (!system) return sendingIdentity(tools.tx, companyId, null, 'CONVERSATION')
  try {
    return await sendingIdentity(tools.tx, companyId, null, 'NOTIFICATION')
  } catch (error) {
    if (error instanceof DomainError) return sendingIdentity(tools.tx, companyId, null, 'CONVERSATION')
    throw error
  }
}

/** Inside the link's command: the QUEUED outbound row (no body, no link) and its audit row. Returns its id. */
export async function queueLinkMail(tools: Pick<CommandTools, 'tx' | 'now' | 'audit' | 'context'>, mail: QueuedLinkMail): Promise<string> {
  const identity = await identityFor(tools, mail.companyId, mail.sender === null)
  const from = fromLine(identity, mail.sender ? { name: mail.sender.name, email: mail.sender.email } : null)
  const outboundId = newId()
  await tools.tx.emailOutbound.create({
    data: {
      id: outboundId,
      companyId: identity.companyId,
      identityId: identity.id,
      recordType: 'OneOffLink',
      recordId: mail.linkId,
      templateKey: mail.template,
      locale: mail.locale,
      fromAddress: from.address,
      fromName: from.name,
      to: [mail.to],
      subject: mail.subject,
      emailMessageId: messageIdFor(outboundId, identity.domain),
      status: 'QUEUED',
      queuedAt: tools.now,
      createdAt: tools.now,
      updatedAt: tools.now,
      createdById: mail.sender?.userId ?? null,
    },
    select: { id: true },
  })
  tools.audit({ recordType: 'EmailOutbound', recordId: outboundId, companyId: identity.companyId, after: { templateKey: mail.template, linkId: mail.linkId, identityId: identity.id, recipients: 1, attachments: 0, status: 'QUEUED' } })
  return outboundId
}

/** After the commit: the mail composed WITH its link, in memory, and sent at once. */
export async function deliverLinkMail(
  email: EmailRuntime,
  caller: CommandCaller,
  outboundId: string,
  body: string,
  senderName: string | null,
  clock: Clock = serverClock,
): Promise<'SENT' | 'FAILED' | 'QUEUED'> {
  const outcome = await deliverOutbound(email, caller, outboundId, { retry: false, clock, build: (row) => mimeOf(email, caller, row, body, senderName, clock) })
  return outcome === 'sent' ? 'SENT' : outcome === 'failed' ? 'FAILED' : 'QUEUED'
}

async function mimeOf(email: EmailRuntime, caller: CommandCaller, row: ClaimedOutbound, body: string, senderName: string | null, clock: Clock): Promise<string> {
  const company = await companyLegalOf(caller, row.companyId)
  const locale = row.locale === 'en' ? 'en' : 'it'
  const mail = compose({ template: 'thread.message', body: cleanBody(body), senderName, companyName: row.identity.displayName, attachmentNames: [] }, { locale, company, privacyUrl: privacyNoticeUrl(email.webOrigin, row.companyId) })
  return buildMime({ id: row.id, from: { name: row.fromName, address: row.fromAddress }, to: row.to, cc: row.cc, replyTo: null, subject: row.subject, messageId: row.emailMessageId, inReplyTo: null, references: [], date: clock.now(), text: mail.text, html: mail.html, automatic: senderName === null })
}
