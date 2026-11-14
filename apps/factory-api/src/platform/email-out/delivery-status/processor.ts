import { eventFor } from '@nexus/factory-domain/events/define'
import { events as mailDepthEvents } from '@nexus/factory-domain/mail-depth/events'
import { bounceKindOf } from '@nexus/factory-domain/mail-depth/rules'
import { parseSesNotification } from '../../../adapters/ses/sns'
import type { InboundProcessor } from '../../inbound/providers'

/**
 * Soft bounces (B-W2b-394; COL-031 "each external message shows sent, delivered or bounced"): SES's processor with this in
 * front of email out's (platform/inbound/providers.ts). Email out applies the notification first (a Permanent bounce makes the
 * mail BOUNCED, and the database writes its bounceKind PERMANENT with bouncedAt, B-W2b-366); then a Transient or Undetermined
 * bounce of a mail still SENT is written here as its bounceKind (TRANSIENT, UNDETERMINED: the status stays SENT, nothing is
 * suppressed), in the same processing command, with its audit row and email.bounce_noted (the thread's delivery status, the
 * sender's task). A kind once written is never cleared nor written again (a later permanent bounce still wins: the database).
 */

const bounceNoted = mailDepthEvents[3]

export function deliveryStatusProcessor(next: InboundProcessor): InboundProcessor {
  return {
    async process(receipt, tools) {
      await next.process(receipt, tools)
      const notification = parseSesNotification(receipt.body)
      if (!notification || notification.kind !== 'event' || notification.event !== 'Bounce' || !notification.bounce || !notification.sesMessageId) return
      const kind = bounceKindOf(notification.bounce.type)
      if (kind === 'PERMANENT') return
      const row = await tools.tx.emailOutbound.findFirst({
        where: { sesMessageId: notification.sesMessageId },
        select: { id: true, companyId: true, threadId: true, recordType: true, recordId: true, status: true, bounceKind: true },
      })
      if (!row || row.status !== 'SENT' || row.bounceKind !== null) return
      await tools.tx.emailOutbound.update({ where: { id: row.id }, data: { bounceKind: kind }, select: { id: true } })
      tools.audit({ action: 'email.softBounce', recordType: 'EmailOutbound', recordId: row.id, companyId: row.companyId, before: { bounceKind: null }, after: { bounceKind: kind, status: row.status } })
      tools.emit(eventFor(bounceNoted, { subject: row.id, companyId: row.companyId, payload: { outboundId: row.id, threadId: row.threadId, recordType: row.recordType, recordId: row.recordId, bounceKind: kind } }))
    },
  }
}
