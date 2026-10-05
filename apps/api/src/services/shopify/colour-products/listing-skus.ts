/**
 * S5 (per-channel SKU) — a colour's sizes under the SKU Shopify knows each one by. The colour plan is built from the
 * family (`loadColourPlan`: each size under its product SKU); here each size takes the SKU of ITS listing on this store
 * (account, market, extra listing): the SKU Shopify holds for a listing on Shopify, the SKU Publish would send for a
 * still-draft (`reportedSkuOf`). A size with no listing there, or whose listing has no SKU of its own, keeps its product
 * SKU — exactly as before. Find searches Shopify by these SKUs, Confirm matches and writes them, Sync matches the sizes
 * and creates the missing ones under them.
 *
 * A listing with no single SKU on record (two different ones) keeps its product SKU in the plan and is reported in
 * `problems` (one plain sentence each): the callers that call or write Shopify refuse before any call.
 */
import type { ColourPlan } from '@nexus/shared/shopify-colour-products'
import prisma from '../../../db.js'
import { CHANNEL_SKU_LISTING_SELECT } from '../../listings/channel-sku.js'
import { reportedSkuOf } from '../../listings/reported-sku.js'

export interface ColourDestinationKey { accountId: string; marketplace: string; aliasKey?: string | null }

export async function withListingSkus(destination: ColourDestinationKey, plan: ColourPlan): Promise<{ plan: ColourPlan; problems: string[] }> {
  const ids = [...new Set(plan.products.flatMap(product => product.variants.map(variant => variant.productId)))]
  if (!ids.length) return { plan, problems: [] }
  const listings = await prisma.channelListing.findMany({
    where: { productId: { in: ids }, channel: 'SHOPIFY', marketplace: destination.marketplace, channelConnectionId: destination.accountId, aliasKey: destination.aliasKey ?? '' },
    select: CHANNEL_SKU_LISTING_SELECT,
  })
  const byProduct = new Map(listings.map(listing => [listing.productId, listing]))
  const problems: string[] = []
  let changed = false
  const products = plan.products.map(product => ({ ...product, variants: product.variants.map(variant => {
    const listing = byProduct.get(variant.productId)
    if (!listing) return variant
    const answer = reportedSkuOf(listing, variant.sku)
    if (answer.sku === null) { problems.push(answer.conflict.sentence); return variant }
    if (answer.sku === variant.sku) return variant
    changed = true
    return { ...variant, sku: answer.sku }
  }) }))
  return { plan: changed ? { ...plan, products } : plan, problems }
}

/** The refusal for a plan with `problems`: nothing was asked of Shopify. */
export const listingSkuRefusal = (problems: readonly string[]) => `${[...new Set(problems)].join(' ')} Nothing was changed in Shopify.`
