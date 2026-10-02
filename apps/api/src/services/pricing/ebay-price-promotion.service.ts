/**
 * MCP full control 08 S13 — an eBay markdown or volume promotion drafted for Claude's set-ebay-price-promotion, with the
 * rules the eBay promotion pages apply (POST /api/listings/ebay/markdowns, POST /api/ebay/volume-promotions): a markdown
 * is per eBay listing, priced against the listing's current price in its market's currency; a volume promotion is a
 * ladder of 2-4 quantity tiers (validateVolumeTiers) over SKUs of one eBay market.
 *
 * Sending is the existing publishers' (pushMarkdownToEbay, pushVolumePromotion): dry run unless
 * NEXUS_EBAY_MARKDOWN_LIVE / NEXUS_EBAY_VOLUME_LIVE is '1', through the eBay marketing dispatcher (the channel gateway).
 * That dispatcher posts with the business's PRIMARY eBay account only, so a listing on another eBay account is refused
 * here rather than sent to the wrong store.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { marketCurrency } from '../pim/market-currency.js'
import { AmbiguousConnectionError, primaryConnectionIds } from '../connection-resolver.service.js'
import { validateVolumeTiers, type VolumeTier } from '../ebay-volume-pricing.service.js'

export const markdownLive = () => process.env.NEXUS_EBAY_MARKDOWN_LIVE === '1'
export const volumeLive = () => process.env.NEXUS_EBAY_VOLUME_LIVE === '1'

export class EbayPromotionRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EbayPromotionRefusal'
  }
}

/**
 * The eBay account promotions are sent with (the primary), or a refusal when there are several and none is primary.
 * Null: no eBay account is connected (a dry run still works; a live send fails and says so).
 */
export async function promotionAccount(): Promise<string | null> {
  try {
    return (await primaryConnectionIds(['EBAY'])).get('EBAY') ?? null
  } catch (error) {
    if (error instanceof AmbiguousConnectionError) throw new EbayPromotionRefusal('This business has several eBay accounts and none is primary: an eBay promotion is sent with the primary account. Choose one in Nexus.')
    throw error
  }
}

/** Why a listing on this account cannot get a promotion here, or null. */
export function accountRefusal(sku: string, listingAccount: string | null, primary: string | null): string | null {
  if (listingAccount && primary && listingAccount !== primary) return `${sku} is listed on another eBay account: a promotion is sent with the primary eBay account only (set it in Nexus)`
  return null
}

/** A DRAFT markdown on one eBay listing (the rules of POST /api/listings/ebay/markdowns). */
export async function draftMarkdown(input: {
  channelListingId: string
  discountType: 'PERCENTAGE' | 'FIXED_PRICE'
  discountValue: number
  startDate: Date
  endDate: Date | null
}) {
  const listing = await prisma.channelListing.findUnique({ where: { id: input.channelListingId }, select: { id: true, channel: true, price: true, marketplace: true } })
  if (!listing) throw new EbayPromotionRefusal('Listing not found')
  if (listing.channel !== 'EBAY') throw new EbayPromotionRefusal('Listing is not on eBay — markdowns are eBay-specific.')
  if (listing.price == null) throw new EbayPromotionRefusal('Listing has no price set — set a price before scheduling a markdown.')
  const originalPrice = Number(listing.price)
  const markdownPrice = input.discountType === 'PERCENTAGE' ? Math.max(0, originalPrice * (1 - input.discountValue / 100)) : Math.max(0, input.discountValue)
  const currency = await marketCurrency(listing.channel, listing.marketplace)
  return prisma.ebayMarkdown.create({
    data: {
      channelListingId: listing.id,
      discountType: input.discountType,
      discountValue: input.discountValue,
      originalPrice,
      markdownPrice,
      currency,
      status: 'DRAFT',
      startDate: input.startDate,
      endDate: input.endDate,
    },
  })
}

/** A DRAFT volume promotion over SKUs of one eBay market (the rules of POST /api/ebay/volume-promotions). */
export async function draftVolumePromotion(input: { name: string; marketplace: string; tiers: VolumeTier[]; skus: string[]; startDate: Date | null; endDate: Date | null }) {
  const validation = validateVolumeTiers(input.tiers)
  if (!validation.ok) throw new EbayPromotionRefusal(`invalid tiers: ${validation.errors.join('; ')}`)
  return prisma.ebayVolumePromotion.create({
    data: {
      name: input.name,
      marketplace: input.marketplace,
      tiers: input.tiers as unknown as Prisma.InputJsonValue,
      skus: input.skus as unknown as Prisma.InputJsonValue,
      status: 'DRAFT',
      startDate: input.startDate,
      endDate: input.endDate,
    },
  })
}
