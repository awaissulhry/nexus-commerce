import prisma from '../db.js'
import { WorkspaceError, LEGACY_WORKSPACE_ID, withWorkspace } from './workspace-context.js'

/**
 * Call only after verifying the provider signature. The routing index contains no secrets.
 *
 * P2.1 — the identifier a channel puts on a notification is not always the one the
 * connection is keyed by. `inboundAliases` holds the other names the channel uses, so
 * Shopify's `X-Shopify-Shop-Domain` finds the same row as the shop GID would. It is
 * matched for every channel rather than a named one: an alias only exists because a
 * channel sends it, so there is nothing for an unrelated channel to collide with, and
 * the next receiver that needs one does not have to come back and edit this line.
 */
export async function verifiedChannelWorkspace(channel: string, externalAccountId?: string) {
  const candidates = await prisma.channelAccountRoute.findMany({ where: { channelType: channel, workspace: { status: 'active' }, ...(externalAccountId ? { OR: [{ externalAccountId }, { inboundAliases: { has: externalAccountId } }, ...(channel === 'AMAZON_ADS' ? [{ destinationIds: { has: externalAccountId } }] : [])] } : {}) }, take: 2 })
  if (candidates.length !== 1) throw new WorkspaceError('ingress_account_ambiguous', 'The verified notification does not identify one connected seller.', 503)
  return candidates[0]
}

/** Only the notification recipient is a routing key. Competitors in Offers are not. */
export function amazonNotificationSeller(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const envelope = raw as Record<string, any>
  const payload = envelope.Payload ?? envelope.payload ?? {}
  const roots = [payload, ...['OrderChangeNotification', 'OrderStatusChangeNotification', 'AnyOfferChangedNotification', 'AnyOfferChanged', 'AccountStatusChangedNotification', 'AccountStatusChanged', 'FBAInventoryAvailabilityChanges', 'FBAOutboundShipmentStatusNotification', 'FeedProcessingFinishedNotification', 'ListingsItemStatusChangeNotification'].map(key => payload[key])]
  const ids = new Set(roots.flatMap(root => root && typeof root === 'object' ? [root.SellerId ?? root.sellerId ?? root.SellerID].filter(id => typeof id === 'string' && id.length > 0) : []))
  return ids.size === 1 ? [...ids][0] as string : undefined
}
export function withIngressWorkspace<T>(workspaceId: string, work: () => T): T {
  return withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
}
export function legacyIngress<T>(work: () => T): T { return withIngressWorkspace(LEGACY_WORKSPACE_ID, work) }
