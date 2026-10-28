import { newId } from '@nexus/factory-domain/core/ids'
import { events as emailEvents } from '@nexus/factory-domain/email/events'
import { failureText, isAddress, normalizeAddress, statusAfter, type OutboundStatus, type SuppressionReason } from '@nexus/factory-domain/email/rules'
import { eventFor } from '@nexus/factory-domain/events/define'
import { parseSesNotification } from '../../adapters/ses/sns'
import type { CommandTools } from '../../core/command'
import type { InboundProcessor, InboundReceipt } from '../inbound/providers'

/**
 * SES's delivery, bounce and complaint notifications (plan A1 §3.7 "Bounces and complaints"; feature PLT-149), applied
 * by the inbound ledger's job (platform/inbound/process.ts) inside its processing command, once per receipt:
 *
 *   Delivery     the mail is DELIVERED (unless a bounce or a complaint already made it worse), deliveredAt
 *   Bounce       Permanent: every bounced address is suppressed (BOUNCE) and the mail is BOUNCED; Transient or
 *                Undetermined (a full mailbox, a greylist): only noted on the mail (lastError), nothing suppressed
 *   Complaint    every complaining address is suppressed (COMPLAINT) and the mail is COMPLAINED
 *   anything else (Send, DeliveryDelay, an SNS subscription confirmation …) changes nothing: a subscription is
 *                confirmed by hand when the SES account is set up (W0-27, PLT-230)
 *
 * The mail is found by SES's message id in the receipt's tenant (row-level security); an event about a mail this tenant
 * does not know still suppresses its addresses. A suppressed address is refused by every later send (outbound.ts).
 * Events: email.status_changed (the thread panel), email.address_suppressed (the parties module flags the contact).
 */

const [, statusChanged, addressSuppressed] = emailEvents

/** Puts an address on the list, or renews its entry; answers the row's id. */
async function suppress(tools: CommandTools, address: string, reason: SuppressionReason, detail: string, at: Date, outboundId: string | null): Promise<string> {
  const { tx, now } = tools
  const existing = await tx.suppression.findFirst({ where: { address }, select: { id: true, reason: true, version: true } })
  let id: string
  if (existing) {
    id = existing.id
    await tx.suppression.update({ where: { id }, data: { reason, detail, at, outboundId, version: existing.version + 1 }, select: { id: true } })
    tools.audit({ action: 'email.suppress', recordType: 'Suppression', recordId: id, companyId: null, before: { reason: existing.reason }, after: { reason, detail } })
  } else {
    id = newId()
    await tx.suppression.create({ data: { id, address, reason, detail, at, outboundId, createdAt: now, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'email.suppress', recordType: 'Suppression', recordId: id, companyId: null, after: { reason, detail } })
  }
  tools.emit(eventFor(addressSuppressed, { subject: id, companyId: null, payload: { suppressionId: id, reason, outboundId } }))
  return id
}

const TIMESTAMP = { DELIVERED: 'deliveredAt', BOUNCED: 'bouncedAt', COMPLAINED: 'complainedAt' } as const

export const sesNotificationProcessor: InboundProcessor = {
  async process(receipt: InboundReceipt, tools: CommandTools): Promise<void> {
    const notification = parseSesNotification(receipt.body)
    if (!notification) throw new Error('The receipt is not an SES notification.')
    if (notification.kind !== 'event' || notification.event === 'Other') return

    const { tx } = tools
    const at = notification.at ?? tools.now
    const row = notification.sesMessageId
      ? await tx.emailOutbound.findFirst({
          where: { sesMessageId: notification.sesMessageId },
          select: { id: true, companyId: true, threadId: true, recordType: true, recordId: true, status: true, deliveredAt: true, bouncedAt: true, complainedAt: true },
        })
      : null

    let reported: 'DELIVERED' | 'BOUNCED' | 'COMPLAINED' | null = null
    let note: string | null = null
    if (notification.event === 'Delivery') reported = 'DELIVERED'
    if (notification.event === 'Bounce' && notification.bounce) {
      const { type, subType, recipients } = notification.bounce
      note = failureText(`bounce ${type}/${subType}`)
      if (type === 'Permanent') {
        reported = 'BOUNCED'
        for (const address of new Set(recipients.map(normalizeAddress).filter(isAddress))) await suppress(tools, address, 'BOUNCE', `${type}/${subType}`, at, row?.id ?? null)
      }
    }
    if (notification.event === 'Complaint' && notification.complaint) {
      reported = 'COMPLAINED'
      note = failureText(`complaint ${notification.complaint.feedbackType ?? 'unspecified'}`)
      for (const address of new Set(notification.complaint.recipients.map(normalizeAddress).filter(isAddress))) {
        await suppress(tools, address, 'COMPLAINT', notification.complaint.feedbackType ?? 'complaint', at, row?.id ?? null)
      }
    }
    if (!row) return

    const status: OutboundStatus = reported ? statusAfter(row.status, reported) : row.status
    const stamp = reported ? TIMESTAMP[reported] : null
    const data = {
      ...(status !== row.status ? { status } : {}),
      ...(stamp && row[stamp] === null ? { [stamp]: at } : {}),
      ...(note ? { lastError: note } : {}),
    }
    if (Object.keys(data).length === 0) return
    await tx.emailOutbound.update({ where: { id: row.id }, data, select: { id: true } })
    tools.audit({
      action: `email.${notification.event.toLowerCase()}`,
      recordType: 'EmailOutbound',
      recordId: row.id,
      companyId: row.companyId,
      before: { status: row.status },
      after: { status, ...(note ? { lastError: note } : {}) },
    })
    if (status !== row.status) {
      tools.emit(
        eventFor(statusChanged, { subject: row.id, companyId: row.companyId, payload: { outboundId: row.id, threadId: row.threadId, recordType: row.recordType, recordId: row.recordId, status } }),
      )
    }
  },
}
