/**
 * New listings (ND1 A, Owner 2026-10-04) — THE `purchasable_offer` Nexus builds for an Amazon listing when it holds no
 * offer of it to put back: a listing created Inactive (no offer was ever sent in this market), or an older close that
 * kept no usable snapshot. Resume (Status → Active, then Publish) replays this through SCT.6's reopen
 * (`reopenMarketOffers`, amazon-market-offer.service.ts) exactly as it replays a saved offer.
 *
 * From Nexus's own data, with the rules a new listing's offer follows (`newListingOfferRoots`,
 * pim/studio-publication-amazon.ts): the send price now (`listingSendPriceNow`: a pin's own price, a follower's rule price
 * from the current master — in the market's own currency, never converted), inside the product's floor and ceiling
 * (`priceRefusalFor`) and Amazon's minimum and maximum, with the offer settings Nexus holds (a sale with both dates, the
 * minimum and maximum price). Builds only; nothing is sent here, and no quantity is ever part of it.
 */
import prisma from '../../db.js'
import { listingSendPriceNow } from '../pim/follower-price.js'
import { marketCurrency } from '../pim/market-currency.js'
import { priceRefusalFor } from '../price-bounds.service.js'
import { amazonMarketplaceIdOf, loadAmazonOfferFacts } from './offer-facts.js'
import { amazonPurchasableOffer, amazonSellerBoundsRefusal } from './offer-attributes.js'

export type NexusOfferAnswer = { offer: Array<Record<string, unknown>>; price: number; currency: string } | { refusal: string }

/** This listing's Amazon offer from Nexus's data, or why it cannot be built (plain English). */
export async function nexusPurchasableOffer(listingId: string): Promise<NexusOfferAnswer> {
  const row = await prisma.channelListing.findUnique({ where: { id: listingId }, select: {
    id: true, channel: true, marketplace: true, productId: true, price: true, priceOverride: true, followMasterPrice: true, pricingRule: true,
    priceAdjustmentPercent: true, product: { select: { sku: true, basePrice: true } },
  } })
  if (!row || row.channel !== 'AMAZON') return { refusal: 'This Amazon listing was not found.' }
  const marketplaceId = amazonMarketplaceIdOf(row.marketplace)
  if (!marketplaceId) return { refusal: `Amazon has no marketplace ${row.marketplace}.` }
  const send = await listingSendPriceNow(row as never, row.product?.basePrice, `Amazon ${row.marketplace}`)
  if (send.price == null) return { refusal: send.reason }
  let currency: string
  try { currency = await marketCurrency('AMAZON', row.marketplace) } catch (error) { return { refusal: error instanceof Error ? error.message : String(error) } }
  const sku = row.product?.sku ?? null
  const bounds = await priceRefusalFor({ price: send.price, productId: row.productId, channel: 'Amazon', sku, market: { channel: 'AMAZON', marketplace: row.marketplace } })
  if (bounds) return { refusal: bounds }
  const facts = (await loadAmazonOfferFacts(prisma as never, [row.id], 'job')).get(row.id)
  if (!facts) return { refusal: 'Nexus could not read this listing\'s offer settings.' }
  const sale = facts.values.sale?.start && facts.values.sale.end ? facts.values.sale.price : null
  const seller = amazonSellerBoundsRefusal({ price: send.price, salePrice: sale, min: facts.values.minimum_seller_allowed_price, max: facts.values.maximum_seller_allowed_price, sku: sku ?? undefined })
  if (seller) return { refusal: seller }
  const offer = amazonPurchasableOffer({ marketplaceId, currency, facts, sendPrice: send.price })
  if (!offer) return { refusal: 'This listing has no price to offer. Set its price first.' }
  return { offer: offer as Array<Record<string, unknown>>, price: send.price, currency }
}
