import type { Prisma } from '@prisma/client'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import { raiseChannelAlertInTx } from '../channel-alerts.service.js'
import { recordConnectionEventInTx } from '../events.service.js'
import type { EbayInboundReceipt } from './ebay-claims.js'

/** Persist the unresolved outcome with its receipt; do not turn it into account revocation. */
export async function raiseEbayFailureNotificationInTx(tx: Prisma.TransactionClient, receipt: Readonly<EbayInboundReceipt>) {
  if (receipt.workspaceId !== workspaceIdForQuery()) throw new Error('The unresolved event belongs to another business profile.')
  const account = receipt.connectionId ? await tx.channelConnection.findFirst({
    where: { id: receipt.connectionId, workspaceId: receipt.workspaceId, channelType: 'EBAY' }, select: { id: true },
  }) : null
  const notifications = await raiseChannelAlertInTx(tx, {
    kind: 'channel-notification-unresolved', severity: 'warn',
    title: 'An eBay notification needs attention',
    body: 'This event could not be completed safely. Automatic attempts have stopped. Review it in Ingress before replaying it.',
    entityType: 'WebhookEvent', entityId: receipt.id, href: '/settings/channels?tab=ingress',
    meta: { receiptId: receipt.id },
  }, { occurrenceId: `receipt:${receipt.id}`, actorUserId: null })
  await recordConnectionEventInTx(tx, {
    connectionId: account?.id ?? null, channelKey: 'EBAY', type: 'inbound_failed', actor: { kind: 'system' },
    detail: { receiptId: receipt.id, disposition: 'dlq', recipients: notifications.recipients,
      notificationOutcome: notifications.recipients === 0 ? 'no_active_owners' : notifications.created === 0 ? 'already_delivered' : 'delivered' },
  })
}
