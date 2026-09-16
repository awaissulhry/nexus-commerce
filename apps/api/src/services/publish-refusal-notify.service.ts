/**
 * BP.S3 — tell someone when a publish into a shared seller account was refused.
 *
 * The claim check (`reserveSharedCoordinates`) is ENFORCED: a coordinate another
 * business holds never becomes a job. But several of its callers are background paths
 * — `content-auto-publish.service.ts` catches every error and logs it as "non-fatal" —
 * so without this an operator whose listing was refused saw nothing at all. Safe, and
 * silent, which is not the same as correct.
 *
 * Two lessons from the one other notifier in this codebase shape this file:
 *
 * 🔴 RECIPIENTS ARE THIS BUSINESS'S PEOPLE, never every user.
 *    `ads-automation-notify.service.ts` fans out to `userProfile.findMany()` — every
 *    login on the system. `UserProfile` is a global model, so under business profiles
 *    that would deliver one business's refusal, which NAMES another business, to people
 *    who belong to neither. Recipients here are the actor, if there is one, plus the
 *    active owners of the business in context.
 *
 * 🔴 DEDUPED, or it floods. That notifier measured 41,466 notifications a day before
 *    its caps. A refused coordinate is the same fact on every edit until someone acts
 *    on it, and auto-publish runs on every edit. One unread notice per coordinate per
 *    person; once it has been read, a recurrence is new information and notifies again.
 *
 * Best-effort: a failure here is logged and never turns a refused publish into a
 * failed request.
 */
import prisma from '../db.js'
import { requireWorkspace } from '../lib/workspace-context.js'
import { logger } from '../utils/logger.js'
import { channelLabel } from '@nexus/shared/channel-label'

export const PUBLISH_REFUSED_TYPE = 'publish-refused-shared-account'

export interface RefusedCoordinate {
  channelListingId: string
  sellerSku: string | null
  marketplace: string
  reason: string
  heldByWorkspaceName?: string
}

export interface RefusalNotifyResult {
  created: number
  /** Notices skipped because an identical one is still unread. */
  deduped: number
}

export async function notifyPublishRefused(refused: RefusedCoordinate[]): Promise<RefusalNotifyResult> {
  if (refused.length === 0) return { created: 0, deduped: 0 }
  try {
    const { workspaceId, actorUserId } = requireWorkspace()
    const recipients = await recipientsFor(workspaceId, actorUserId)
    if (recipients.length === 0) return { created: 0, deduped: 0 }

    const listings = await prisma.channelListing.findMany({
      where: { id: { in: [...new Set(refused.map(r => r.channelListingId))] } },
      select: { id: true, productId: true, channel: true, product: { select: { name: true } } },
    })
    const byId = new Map(listings.map(l => [l.id, l]))

    let created = 0
    let deduped = 0
    for (const coordinate of refused) {
      const listing = byId.get(coordinate.channelListingId)
      // One notice per coordinate: the entity is the LISTING, and the dedupe key is the
      // listing plus the recipient, so a second refusal of the same listing is folded
      // into the unread notice rather than stacked on top of it.
      for (const userId of recipients) {
        const unread = await prisma.notification.findFirst({
          where: { userId, type: PUBLISH_REFUSED_TYPE, entityType: 'ChannelListing', entityId: coordinate.channelListingId, readAt: null },
          select: { id: true },
        })
        if (unread) { deduped++; continue }
        await prisma.notification.create({
          data: {
            userId,
            type: PUBLISH_REFUSED_TYPE,
            severity: 'warn',
            title: titleFor(listing?.product?.name, coordinate.sellerSku),
            body: bodyFor(coordinate, listing?.channel),
            entityType: 'ChannelListing',
            entityId: coordinate.channelListingId,
            // The product editor is where the operator can act: change the seller SKU, or
            // see which listing this is. A bare path — the bell's router adds the
            // business prefix, so the link cannot point into another business.
            href: listing ? `/products/${encodeURIComponent(listing.productId)}/edit` : null,
            meta: {
              sellerSku: coordinate.sellerSku,
              marketplace: coordinate.marketplace,
              heldByWorkspaceName: coordinate.heldByWorkspaceName ?? null,
            },
          },
        })
        created++
      }
    }
    return { created, deduped }
  } catch (error) {
    logger.warn('[publish-refusal-notify] failed', { error: String(error).slice(0, 160) })
    return { created: 0, deduped: 0 }
  }
}

/** The actor, if a person caused this, and the business's active owners. De-duplicated. */
async function recipientsFor(workspaceId: string, actorUserId: string | null): Promise<string[]> {
  const owners = await prisma.workspaceMembership.findMany({
    where: {
      workspaceId, status: 'active', user: { status: 'active' },
      roles: { some: { role: { key: 'OWNER' } } },
    },
    select: { userId: true },
  })
  return [...new Set([...(actorUserId ? [actorUserId] : []), ...owners.map(o => o.userId)])]
}

function titleFor(productName: string | null | undefined, sellerSku: string | null): string {
  const what = productName ?? sellerSku ?? 'A listing'
  return `${what} was not published`
}

/**
 * Written for the person who has to act. States what happened, why, and the two ways
 * out — and never implies the refusal was an error, because it was the system working.
 */
function bodyFor(coordinate: RefusedCoordinate, channel: string | undefined): string {
  const account = accountPhrase(channel, coordinate.marketplace)
  if (!coordinate.sellerSku) {
    return `It has more than one seller SKU, so its place on ${account} cannot be reserved. Give it a single seller SKU and it will publish.`
  }
  if (coordinate.heldByWorkspaceName) {
    return `${coordinate.heldByWorkspaceName} already publishes ${coordinate.sellerSku} on ${account}. Use a different seller SKU, or ask ${coordinate.heldByWorkspaceName} to stop publishing it there.`
  }
  return coordinate.reason
}

/**
 * "the shared eBay IT account", or "the shared account" when the channel is unknown.
 *
 * `channelLabel` is the one operator-facing channel name (packages/shared): the raw
 * column read "the shared EBAY IT account" in the first measured notice. A marketplace
 * of DEFAULT or GLOBAL is a storage convention, not something an operator calls a
 * market, so it is left out. Built as ONE phrase so a missing part cannot leave a
 * doubled or dangling word — an earlier draft produced "the shared the shared account".
 */
export function accountPhrase(channel: string | null | undefined, marketplace: string | null | undefined): string {
  const market = marketplace && marketplace !== 'DEFAULT' && marketplace !== 'GLOBAL' ? ` ${marketplace}` : ''
  return channel ? `the shared ${channelLabel(channel)}${market} account` : 'the shared account'
}
