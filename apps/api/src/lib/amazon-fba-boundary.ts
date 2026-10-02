import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { isFbaCoordinate } from './amazon-fulfillment.js'
import { AMAZON_LISTING_SKU_KEYS } from '../services/channel-mapping/defaults.js'

/**
 * The FBA boundary for a whole JSON_LISTINGS_FEED (Studio Publish). A merchant quantity sent for an FBA SKU switches
 * its offer to FBM (the June 2026 incident class). `guardFbaQtyFlip` covers only the Listings PATCH path and
 * `findFbaQtyViolations` only the old flat-file submit; this runs on the feed before anything is uploaded.
 */

const ROOT = 'fulfillment_availability'
const FBA_LOCATION_CODE = 'AMAZON-EU-FBA'

export interface FeedMessageLike { sku: string; attributes?: Record<string, unknown>; patches?: Array<{ op?: string; path?: string; value?: unknown }> }
type Entry = Record<string, unknown>

const entriesOf = (value: unknown): Entry[] =>
  (Array.isArray(value) ? value : [value]).filter((v): v is Entry => !!v && typeof v === 'object' && !Array.isArray(v))
// DEFAULT, MFN or no code is the merchant's channel; RAFN, VCS and every other AMAZON_* code is Amazon's.
const isMerchantQuantity = (entry: Entry) =>
  entry.quantity != null && !String(entry.fulfillment_channel_code ?? '').trim().toUpperCase().startsWith('AMAZON')
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim()
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}

/** The merchant-quantity entries of one feed message: its attributes (any operation) and every patch that writes the
 * root (replace, merge — any op but delete). */
export function merchantQuantityEntries(message: FeedMessageLike): Array<{ sku: string; entries: Entry[] }> {
  const values = [object(message.attributes)[ROOT], ...(Array.isArray(message.patches) ? message.patches : [])
    .filter(p => p?.path === `/attributes/${ROOT}` && String(p.op ?? '').toLowerCase() !== 'delete').map(p => p.value)]
  const entries = values.flatMap(entriesOf).filter(isMerchantQuantity)
  return entries.length ? [{ sku: message.sku, entries }] : []
}

/** The SKUs among `skus` that are FBA by any evidence: the product flag, FBA stock, an active FBA offer, or any Amazon
 * listing of the product on this account (any market) that `isFbaCoordinate` reads as FBA. Fail-closed: a lookup
 * error, or a SKU no product claims, counts as FBA. */
export async function fbaSkusAmong(skus: string[], accountId: string): Promise<Set<string>> {
  // A blank SKU can be claimed by no product, so it is refused below.
  const wanted = [...new Set(skus.map(sku => String(sku ?? '')))]
  if (!wanted.length) return new Set()
  try {
    // Unattributed older rows count too: they may be this account's, and more evidence can only refuse.
    const onAccount = { channel: 'AMAZON', OR: [{ channelConnectionId: accountId }, { channelConnectionId: null }] }
    // A seller SKU is the listing's own identity (offer, mirror keys — as Publish reads it) or the product SKU.
    const identity = [{ offers: { some: { sku: { in: wanted } } } }, ...wanted.flatMap(sku => [
      ...AMAZON_LISTING_SKU_KEYS.platformAttributes.map(key => ({ platformAttributes: { path: [key], equals: sku } })),
      ...AMAZON_LISTING_SKU_KEYS.flatFileSnapshot.map(key => ({ flatFileSnapshot: { path: [key], equals: sku } })),
    ])]
    const products = await prisma.product.findMany({
      where: { OR: [{ sku: { in: wanted } }, { channelListings: { some: { AND: [onAccount, { OR: identity }] } } }] },
      select: { id: true, sku: true, fulfillmentMethod: true, channelListings: { where: onAccount, select: { fulfillmentMethod: true,
        platformAttributes: true, flatFileSnapshot: true, offers: { select: { sku: true, fulfillmentMethod: true, isActive: true } } } } },
    })
    const stock = products.length ? await prisma.stockLevel.findMany({
      where: { productId: { in: products.map(p => p.id) }, quantity: { gt: 0 }, location: { code: FBA_LOCATION_CODE } },
      select: { productId: true, quantity: true },
    }) : []
    const fbaStock = new Map<string, number>()
    for (const row of stock) fbaStock.set(row.productId, (fbaStock.get(row.productId) ?? 0) + row.quantity)
    const verdicts = products.map(p => {
      const claims = new Set([p.sku, ...p.channelListings.flatMap(l => [...l.offers.map(o => o.sku),
        ...AMAZON_LISTING_SKU_KEYS.platformAttributes.map(k => object(l.platformAttributes)[k]),
        ...AMAZON_LISTING_SKU_KEYS.flatFileSnapshot.map(k => object(l.flatFileSnapshot)[k])])].filter(text))
      const evidence = { fbaStockQty: fbaStock.get(p.id) ?? 0,
        hasActiveFbaOffer: p.channelListings.some(l => l.offers.some(o => o.isActive && o.fulfillmentMethod === 'FBA')) }
      return { claims, fba: [null, ...p.channelListings].some(l => isFbaCoordinate(l, p, evidence)) }
    })
    return new Set(wanted.filter(sku => {
      const owners = verdicts.filter(v => v.claims.has(sku))
      return !owners.length || owners.some(v => v.fba)
    }))
  } catch (error) {
    logger.warn('FBA boundary: evidence lookup failed — failing closed (refusing)', { skus: wanted, error: error instanceof Error ? error.message : String(error) })
    return new Set(wanted)
  }
}

/** Refuse the whole feed when any message carries a merchant quantity for an FBA SKU. `notSent`: nothing left Nexus. */
export async function assertNoMerchantQuantityForFba(feed: { messages: FeedMessageLike[] }, accountId: string): Promise<void> {
  const skus = [...new Set(feed.messages.flatMap(merchantQuantityEntries).map(hit => String(hit.sku ?? '')))]
  if (!skus.length) return
  const fba = await fbaSkusAmong(skus, accountId)
  const refused = skus.filter(sku => fba.has(sku))
  if (!refused.length) return
  logger.error('FBA boundary: refused a feed with a merchant quantity for FBA SKUs (it would switch them to FBM)', { critical: true, skus: refused, accountId })
  // The caller prefixes "Nothing was submitted." (studio-publication.service.ts), so the sentence names only the SKUs.
  const many = refused.length > 1
  throw Object.assign(new Error(`${refused.join(', ')} ${many ? 'are' : 'is'} fulfilled by Amazon (FBA) — a merchant quantity would switch ${many ? 'them' : 'it'} to FBM.`), { notSent: true })
}
