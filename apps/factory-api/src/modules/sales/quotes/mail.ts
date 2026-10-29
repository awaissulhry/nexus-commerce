import { compose } from '@nexus/factory-domain/email/compose'
import { privacyNoticeUrl } from '@nexus/factory-domain/email/footer'
import { replyAddress } from '@nexus/factory-domain/email/headers'
import { buildMime } from '@nexus/factory-domain/email/mime'
import { localeOf } from '@nexus/factory-domain/email/rules'
import { cleanBody } from '@nexus/factory-domain/threads/rules'
import { COMMAND_SETTINGS, type CommandCaller, type CommandTools } from '../../../core/command'
import { companyLegalOf } from '../../../platform/documents/documents'
import { deliverOutbound, sendEmail, type DeliveryOutcome } from '../../../platform/email-out/outbound'
import type { EmailRuntime } from '../../../platform/email-out/service'

/**
 * The quote's mail (B-W1-24; plan A1 §3.3, §3.7; w0-21 email out; SAL-093, SAL-192). Every mail of a quote is a message on
 * the quote's record thread, from the company's conversation identity, with the PDF attached.
 *
 * The mail that carries the accept link is special: the link is a bearer token, and a token never enters a stored row
 * (A1 §3.10 "Links"). So, inside the send command, `queueLinkMail` writes the thread message and the EmailOutbound row
 * through email out's own `sendEmail` (its recipient, suppression, attachment and identity checks) with the text that
 * says WHERE the link is but not the link, and withholds its `email.queued` event: the worker, which would build the
 * mail from the stored text, never sees it. Right after the command commits, `deliverLinkMail` sends it in this process
 * (email out's `deliverOutbound`, as sign-in mail does) with a builder that composes the text WITH the link and attaches
 * the PDF bytes already in memory. A failed delivery leaves the mail FAILED, with why; it is not retried (its link exists
 * nowhere else): the office sends a new link. A mail without a link (the acceptance's confirmation) goes the usual way.
 */

export interface LinkMailInput {
  readonly quoteId: string
  readonly sender: { readonly userId: string; readonly name: string; readonly email: string | null }
  readonly to: string
  readonly cc: readonly string[]
  readonly subject: string
  /** The mail's text without the link (what the thread keeps). */
  readonly storedText: string
  readonly attachments: readonly string[]
  readonly locale: string
}

/** Inside the send (or new-link) command: the thread message and the QUEUED mail, without the link and without its event. */
export async function queueLinkMail(tools: CommandTools, input: LinkMailInput) {
  const quiet = {
    tx: tools.tx,
    context: tools.context,
    now: tools.now,
    audit: tools.audit,
    // The worker builds a queued mail from its stored text, which has no link: this mail is delivered in-process.
    emit: (event: Parameters<CommandTools['emit']>[0]) => (event.type === 'email.queued' ? undefined : tools.emit(event)),
  }
  return sendEmail(quiet, {
    record: { type: 'Quote', id: input.quoteId },
    sender: input.sender,
    to: [input.to],
    cc: [...input.cc],
    subject: input.subject,
    body: input.storedText,
    attachments: [...input.attachments],
    locale: input.locale,
  })
}

export interface LinkDelivery {
  /** The mail's text with the link, made in memory (never stored). */
  readonly text: string
  readonly attachment: { readonly filename: string; readonly content: Uint8Array }
}

/**
 * After the command committed: sends the queued link mail once (the claim makes a second call a no-op), as the
 * tenant's system caller. Never throws for a mail that could not go: the outcome says so and the row records why.
 */
export async function deliverLinkMail(runtime: EmailRuntime, caller: CommandCaller, outboundId: string, delivery: LinkDelivery): Promise<DeliveryOutcome> {
  try {
    return await deliverOutbound(runtime, caller, outboundId, {
      retry: false,
      build: async (row) => {
        if (!row.threadId || !row.messageId) throw new Error('A quote mail names its thread and message.')
        const { threadId, messageId } = row
        const { thread, message } = await caller.withClient(async (client) => ({
          thread: await client.thread.findUniqueOrThrow({ where: { id: threadId }, select: { replyToken: true } }),
          message: await client.message.findUniqueOrThrow({ where: { id: messageId }, select: { authorName: true } }),
        }))
        const company = await companyLegalOf(caller, row.companyId)
        const mail = compose(
          { template: 'thread.message', body: cleanBody(delivery.text), senderName: message.authorName, companyName: row.identity.displayName, attachmentNames: [delivery.attachment.filename] },
          { locale: localeOf(row.locale), company, privacyUrl: privacyNoticeUrl(runtime.webOrigin, row.companyId) },
        )
        return buildMime({
          id: row.id,
          from: { name: row.fromName, address: row.fromAddress },
          to: row.to,
          cc: row.cc,
          replyTo: replyAddress(thread.replyToken, row.identity.replyDomain),
          subject: row.subject,
          messageId: row.emailMessageId,
          inReplyTo: row.inReplyTo,
          references: row.referenceIds,
          date: COMMAND_SETTINGS.clock.now(),
          text: mail.text,
          html: mail.html,
          automatic: false,
          attachments: [{ filename: delivery.attachment.filename, contentType: 'application/pdf', content: delivery.attachment.content }],
        })
      },
    })
  } catch {
    return 'failed'
  }
}
