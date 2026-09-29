/**
 * MX.1 — a new variant's listings, copied from a sibling ("Add child → copy from"), moved out of catalog.routes.ts.
 *
 * Copies content / attributes / pricing (per copy group) and strips every variation-specific SP-API field (color,
 * size, ASIN, offers, …) and the sibling's own channel ids and checkpoints (Shopify variant, eBay offers), so the new
 * variant starts with shared content but its own identifiers.
 *
 * Step 7 — every copy is an inert Nexus draft decided by the one draft rule: a copy of a primary listing comes from
 * `ensureDraftListings` on the sibling's coordinate (a sibling saved without an account resolves to the channel's
 * primary account), a copy of an alias listing from `draftListingFields`, which `ensureDraftListings` never creates.
 * The copied content is written AFTER the draft exists. A coordinate the draft rule refuses (a market no longer
 * active, an account no longer connected) is skipped and reported: the variant is still created.
 *
 * Runs on the caller's transaction client.
 */
import type { Prisma } from '@prisma/client'
import { DraftListingError, draftListingFields, ensureDraftListings } from './draft-listing.service.js'
import { validateAliasWriteTargets } from './listing-alias.service.js'
import { AmbiguousConnectionError } from '../connection-resolver.service.js'
import { isManagedShopifyAttribute } from '../shopify/linked-state-guard.js'
import { PUBLISH_KEY } from '../shopify/content-workspace.service.js'

export type CopyGroup = 'content' | 'attributes' | 'pricing'

export interface SkippedListingCopy {
  channel: string
  marketplace: string
  reason: string
}

const AXIS_ATTRS = new Set([
  'color', 'color_name', 'colour_name',
  'apparel_size', 'size', 'size_name', 'variation_size_base_size',
  'parentage_level', 'child_parent_sku_relationship',
  'purchasable_offer', 'fulfillment_availability', 'skip_offer',
])

/**
 * Keys that name the SIBLING's own channel object or its publish state. Copied, they would make the new variant claim
 * the sibling's Shopify variant (price and stock pushes would target it), its eBay offers, or its checkpoints. The new
 * variant starts without them; the channel's own sync writes its ids.
 */
const LISTING_IDENTITY_KEYS = new Set([
  'shopifyProductId', 'variantId', 'inventoryItemId', 'inventoryLocationId', 'nexusFamilyId', // Shopify native mapping (content-sync)
  '__offerIds', '__lastPublishedAxes', // eBay Inventory offers and the axes last published
  PUBLISH_KEY,
])
const isListingIdentityKey = (key: string) => LISTING_IDENTITY_KEYS.has(key) || isManagedShopifyAttribute(key)

/** Copy the sibling's listings onto `productId` as drafts. Returns the coordinates that were skipped. */
export async function copySiblingListings(tx: Prisma.TransactionClient, input: { sourceProductId: string; productId: string; groups: Set<string> }): Promise<SkippedListingCopy[]> {
  const { sourceProductId, productId, groups } = input
  const siblings = await tx.channelListing.findMany({ where: { productId: sourceProductId } })
  await validateAliasWriteTargets(siblings.filter(sib => sib.aliasKey).map(sib => ({ productId: sourceProductId, channel: sib.channel, marketplace: sib.marketplace, connectionId: sib.channelConnectionId, aliasKey: sib.aliasKey })), tx)
  const skipped: SkippedListingCopy[] = []
  // One at a time: they share the caller's transaction.
  for (const sib of siblings) {
    let draftId: string
    try {
      if (sib.aliasKey) {
        const [row] = await tx.channelListing.createManyAndReturn({
          data: [draftListingFields({ productId, channel: sib.channel, market: sib.marketplace, accountId: sib.channelConnectionId as string, aliasKey: sib.aliasKey })],
          select: { id: true },
        })
        draftId = row.id
      } else {
        const [row] = await ensureDraftListings(tx, { channel: sib.channel, market: sib.marketplace, accountId: sib.channelConnectionId, productIds: [productId] })
        draftId = row.id
      }
    } catch (error) {
      // A sibling saved without an account, on a channel with several accounts and no primary, names none either.
      if (!(error instanceof DraftListingError || error instanceof AmbiguousConnectionError)) throw error
      skipped.push({ channel: sib.channel, marketplace: sib.marketplace, reason: error.message })
      continue
    }
    const stored = sib.platformAttributes && typeof sib.platformAttributes === 'object' && !Array.isArray(sib.platformAttributes) ? sib.platformAttributes as Record<string, any> : {}
    const platAttrs = Object.fromEntries(Object.entries(stored).filter(([key]) => !isListingIdentityKey(key)))
    const sibAttrs = (platAttrs.attributes ?? {}) as Record<string, any>
    const cleanedAttrs: Record<string, any> = {}
    if (groups.has('attributes')) {
      for (const [k, v] of Object.entries(sibAttrs)) {
        if (!AXIS_ATTRS.has(k)) cleanedAttrs[k] = v
      }
    }
    await tx.channelListing.update({
      where: { id: draftId },
      data: {
        ...(groups.has('content') ? {
          title: sib.title,
          description: sib.description,
          bulletPointsOverride: sib.bulletPointsOverride,
        } : {}),
        ...(groups.has('pricing') ? {
          price: sib.price,
          pricingRule: sib.pricingRule,
          priceAdjustmentPercent: sib.priceAdjustmentPercent,
        } : {}),
        platformAttributes: { ...platAttrs, attributes: cleanedAttrs } as any,
        variationTheme: sib.variationTheme,
        stockBuffer: sib.stockBuffer,
        version: { increment: 1 },
      },
    })
  }
  return skipped
}
