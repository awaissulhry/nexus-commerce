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
  // Etsy sends a shop ID. Its externalAccountId is a user ID in a different
  // namespace: equal numeric strings do not identify the same resource.
  if (channel === 'ETSY' && !externalAccountId) throw new WorkspaceError('ingress_account_ambiguous', 'The Etsy notification names no shop.', 503)
  const identity = externalAccountId
    ? channel === 'ETSY'
      ? { inboundAliases: { has: externalAccountId } }
      : { OR: [{ externalAccountId }, { inboundAliases: { has: externalAccountId } }, ...(channel === 'AMAZON_ADS' ? [{ destinationIds: { has: externalAccountId } }] : [])] }
    : {}
  const candidates = await prisma.channelAccountRoute.findMany({ where: { channelType: channel, workspace: { status: 'active' }, ...identity }, take: 2 })
  if (candidates.length !== 1) throw new WorkspaceError('ingress_account_ambiguous', 'The verified notification does not identify one connected seller.', 503)
  return candidates[0]
}

/**
 * Meta ads step 30 — every active route of a channel whose notification names no account Nexus can trust before its
 * signature is checked (META: the body says which ad account or Page, but only the app secret of a connected business
 * proves Meta sent it, and each business keeps its own secret). The caller checks the signature with each candidate's
 * own secret, inside that candidate's business, and routes on the body only after one matched. No secret is read here.
 */
export async function activeChannelRoutes(channel: string) {
  const PAGE = 200
  const out: Array<{ workspaceId: string; connectionId: string; externalAccountId: string | null }> = []
  // Every route, page by page (a business is never left out because many are connected).
  for (let after: string | null = null; ;) {
    const page: typeof out = await prisma.channelAccountRoute.findMany({
      where: { channelType: channel, workspace: { status: 'active' }, ...(after ? { connectionId: { gt: after } } : {}) },
      select: { workspaceId: true, connectionId: true, externalAccountId: true },
      orderBy: { connectionId: 'asc' },
      take: PAGE,
    })
    out.push(...page)
    if (page.length < PAGE) return out
    after = page[page.length - 1].connectionId
  }
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
