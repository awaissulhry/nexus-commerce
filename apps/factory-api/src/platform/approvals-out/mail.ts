import { DomainError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { fromLine, messageIdFor } from '@nexus/factory-domain/email/headers'
import type { ApprovalLocale } from '@nexus/factory-domain/approvals-out/kinds'
import type { CommandCaller, CommandTools } from '../../core/command'
import type { Clock } from '../../core/time'
import { sendingIdentity } from '../email-out/outbound'
import { processEmail } from '../email-out/service'
import { deliverLinkMail } from '../links/mail'

/**
 * The approval mails (B-W2b-184), as platform/links does its own: INSIDE the command the EmailOutbound row (QUEUED, NO body,
 * the subject only) with its audit row; after the commit the body is composed in memory (with the link, for a request) and
 * sent at once (deliverOutbound through deliverLinkMail; never retried by a job: a failed one stays FAILED and the office
 * asks again). FAKE accounts locally and in tests. Sender: the office person's own mail (CONVERSATION, their name in the
 * From line) when one asks, the company's NOTIFICATION identity (else CONVERSATION) for the system's (a receipt).
 */

export interface QueuedMail {
  readonly companyId: string
  /** The row the mail is about: the link of a request mail, the request of a receipt. */
  readonly record: { readonly type: string; readonly id: string }
  readonly template: string
  readonly to: string
  readonly locale: ApprovalLocale
  readonly subject: string
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

/** Inside the command: the QUEUED outbound row and its audit row. Returns its id. */
export async function queueMail(tools: Pick<CommandTools, 'tx' | 'now' | 'audit'>, mail: QueuedMail): Promise<string> {
  const identity = await identityFor(tools, mail.companyId, mail.sender === null)
  const from = fromLine(identity, mail.sender ? { name: mail.sender.name, email: mail.sender.email } : null)
  const outboundId = newId()
  await tools.tx.emailOutbound.create({
    data: {
      id: outboundId,
      companyId: identity.companyId,
      identityId: identity.id,
      recordType: mail.record.type,
      recordId: mail.record.id,
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
  tools.audit({ recordType: 'EmailOutbound', recordId: outboundId, companyId: identity.companyId, after: { templateKey: mail.template, recordType: mail.record.type, recordId: mail.record.id, identityId: identity.id, recipients: 1, attachments: 0, status: 'QUEUED' } })
  return outboundId
}

/** After the commit: the mail composed with its body and sent at once, as the tenant's system. */
export async function deliverMail(system: CommandCaller, outboundId: string, body: string, senderName: string | null, clock: Clock): Promise<'SENT' | 'FAILED' | 'QUEUED'> {
  return deliverLinkMail(processEmail(), system, outboundId, body, senderName, clock)
}
