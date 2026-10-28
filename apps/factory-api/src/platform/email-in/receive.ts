import { newId } from '@nexus/factory-domain/core/ids'
import { events as emailInEvents } from '@nexus/factory-domain/email-in/events'
import { eventFor } from '@nexus/factory-domain/events/define'
import type { CommandTools } from '../../core/command'
import type { InboundProcessor, InboundReceipt } from '../inbound/providers'
import { receivedMailOf, type ReceivedMail } from './notification'

/**
 * Receiving one mail (plan A1 §3.7 "Receiving"; COL-020): SES's "Received" notification, applied by the inbound ledger's
 * job (platform/inbound/process.ts) inside its processing command, once per receipt. It only records what SES said;
 * reading the raw mail is the worker's own job (fetch.ts), through the gateway, never inside this command:
 *
 *   - a mail this tenant has already (the same SES id, or the same Message-ID: SES delivered it twice) → nothing new,
 *     an audit row names the earlier one;
 *   - SES's virus verdict FAIL → the row REJECTED (VIRUS) and email.inbound_sorted: the mail is never read;
 *   - otherwise → the row RECEIVED, with the envelope, the common headers and SES's verdicts, and the event
 *     email.inbound_received (the worker reads it).
 * The SES account's company (the receipt's) is the mail's company: whose staff sort it while it waits.
 *
 * Every other SES notification (delivery, bounce, complaint) goes on to email out's processor: `emailInProcessor` wraps it
 * (platform/inbound/providers.ts INBOUND_PROVIDERS.SES).
 */

const [received, , sorted] = emailInEvents

async function recordReceived(receipt: InboundReceipt, mail: ReceivedMail, tools: CommandTools): Promise<void> {
  const { tx, now } = tools
  if (!mail.location) throw new Error('SES receiving must store the raw mail in S3: the receipt rule has no S3 action with a bucket and a key.')
  const earlier = await tx.inboundEmail.findFirst({
    where: { OR: [{ sesMessageId: mail.sesMessageId }, ...(mail.emailMessageId ? [{ emailMessageId: mail.emailMessageId }] : [])] },
    select: { id: true, companyId: true, status: true },
  })
  if (earlier) {
    tools.audit({ action: 'emailIn.receiveAgain', recordType: 'InboundEmail', recordId: earlier.id, companyId: earlier.companyId, after: { receiptId: receipt.id, status: earlier.status } })
    return
  }
  const id = newId()
  const virus = mail.verdicts.virus === 'FAIL'
  const status = virus ? 'REJECTED' : 'RECEIVED'
  await tx.inboundEmail.create({
    data: {
      id,
      companyId: receipt.companyId,
      accountId: receipt.accountId,
      receiptId: receipt.id,
      sesMessageId: mail.sesMessageId,
      s3Bucket: mail.location.bucket,
      s3Key: mail.location.key,
      receivedAt: mail.receivedAt ?? receipt.receivedAt,
      envelopeFrom: mail.envelopeFrom,
      envelopeTo: [...mail.envelopeTo],
      fromAddress: mail.from.address,
      fromName: mail.from.name,
      to: [...mail.to],
      cc: [...mail.cc],
      subject: mail.subject,
      emailMessageId: mail.emailMessageId,
      spfVerdict: mail.verdicts.spf,
      dkimVerdict: mail.verdicts.dkim,
      dmarcVerdict: mail.verdicts.dmarc,
      dmarcPolicy: mail.dmarcPolicy,
      spamVerdict: mail.verdicts.spam,
      virusVerdict: mail.verdicts.virus,
      status,
      ...(virus ? { rejectReason: 'VIRUS', sortedAt: now } : {}),
      createdAt: now,
      updatedAt: now,
    },
    select: { id: true },
  })
  // The audit row keeps what SES said, never an address or a subject (personal data stays on the row).
  tools.audit({ action: 'emailIn.receive', recordType: 'InboundEmail', recordId: id, companyId: receipt.companyId, after: { receiptId: receipt.id, status, verdicts: mail.verdicts, ...(virus ? { rejectReason: 'VIRUS' } : {}) } })
  const where = { subject: id, companyId: receipt.companyId }
  if (virus) tools.emit(eventFor(sorted, { ...where, payload: { inboundEmailId: id, status: 'REJECTED', threadId: null, messageId: null } }))
  else tools.emit(eventFor(received, { ...where, payload: { inboundEmailId: id } }))
}

/** SES's processor with email in in front: a "Received" notification is a received mail, anything else goes to `next`. */
export function emailInProcessor(next: InboundProcessor): InboundProcessor {
  return {
    async process(receipt, tools) {
      const mail = receivedMailOf(receipt.body)
      if (!mail) return next.process(receipt, tools)
      await recordReceived(receipt, mail, tools)
    },
  }
}
