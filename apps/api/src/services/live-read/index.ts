/**
 * Read live (Owner, 2026-09-26): what one channel × market × account × listing alias holds right now, in one shape.
 * Read only; never stored as Nexus data. One read per destination per 30 s — a second request inside that window gets
 * the same read with its time (`cached: true`), and concurrent requests share one read. The raw provider documents stay
 * on the server: `readLiveListing` returns them for the publish review, `publicLiveRead` strips them for the web.
 * Channel logins are KMS-sealed, so live reads work only in the deployed API.
 */
import type { LiveRead, LiveReadChannel } from '@nexus/shared/live-read'
import prisma from '../../db.js'
import { resolveWorkspaceDestination } from '../pim/workspace-destination.js'
import { configuredAmazonMarketplaceId } from '../categories/marketplace-ids.js'
import { languageTag, marketLanguages } from '../pim/market-languages.js'
import { AmazonSpApiClient } from '../../clients/amazon-sp-api.client.js'
import { getAmazonRegion, getAmazonSellerId } from '../../lib/amazon-sp-client.js'
import { ebayInventoryReads } from '../pim/studio-publication-ebay-inventory.js'
import { readEbayInventoryListing } from './ebay-inventory.js'
import { readEbayTradingListing } from './ebay-trading.js'
import { readAmazonListing, type AmazonListingRead } from './amazon.js'
import type { ServerLiveRead } from './types.js'
import { reportedSkuOf } from '../listings/reported-sku.js'
import type { ChannelSkuAnswer } from '../listings/channel-sku.pure.js'

export interface LiveReadScope { channel: string; marketplace: string; accountId: string; aliasKey?: string }
const WINDOW_MS = 30_000
const recent = new Map<string, { at: number; read: ServerLiveRead<unknown> }>()
const inFlight = new Map<string, Promise<ServerLiveRead<unknown>>>()
const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {}

/** Nothing to read yet (not listed, or a channel whose reader comes later): honest, never an empty "no change". */
function notReadable(destination: LiveRead['destination'], reason: string): ServerLiveRead<null> {
  return { readAt: new Date().toISOString(), source: destination.channel === 'AMAZON' ? 'amazon-listings-item' : destination.channel === 'SHOPIFY' ? 'shopify-product' : destination.channel === 'ETSY' ? 'etsy-listing' : 'ebay-trading-item',
    destination, revision: null, content: {}, variations: null, errors: [{ scope: 'item', reason }], raw: null }
}

async function readNow(productId: string, scope: LiveReadScope): Promise<ServerLiveRead<unknown>> {
  const d = await resolveWorkspaceDestination({ productId, channel: scope.channel, marketplace: scope.marketplace, accountId: scope.accountId, aliasKey: scope.aliasKey })
  const products = await prisma.product.findMany({ where: { deletedAt: null, OR: [{ id: d.familyId }, { parentId: d.familyId }] }, select: { id: true, sku: true, parentId: true } })
  const listings = await prisma.channelListing.findMany({ where: { productId: { in: products.map(p => p.id) }, channel: scope.channel, marketplace: scope.marketplace,
    channelConnectionId: d.accountId, aliasKey: d.aliasKey ?? '' }, include: { offers: true, alias: { select: { sku: true, productId: true } } } })
  const parent = products.find(p => p.id === d.familyId)!
  const children = products.filter(p => p.parentId === d.familyId && listings.some(l => l.productId === p.id))
  const destination = { productId: d.familyId, channel: scope.channel as LiveReadChannel, marketplace: scope.marketplace, accountId: d.accountId, aliasKey: d.aliasKey ?? '' }
  // S7 — the SKU the channel knows each product's listing here by: its own SKU (the Amazon rule reads the one active
  // offer, then the stored identity, as Publish does), else the product SKU. No single SKU: not read, said plainly.
  const skuAnswers = new Map<string, ChannelSkuAnswer>(products.map(p => {
    const listing = listings.find(l => l.productId === p.id)
    return [p.id, listing ? reportedSkuOf({ ...listing, channel: scope.channel }, p.sku) : { sku: p.sku, source: 'product' }]
  }))
  const unclear = [parent, ...children].map(p => skuAnswers.get(p.id)?.conflict).find(Boolean)
  const skuOf = (p: { id: string; sku: string }) => skuAnswers.get(p.id)?.sku ?? p.sku
  if (scope.channel === 'EBAY') {
    const itemId = listings.find(l => l.productId === parent.id)?.externalListingId ?? listings.find(l => l.externalListingId)?.externalListingId
    if (!itemId) return notReadable(destination, 'This listing is not on eBay yet.')
    if (unclear) return notReadable(destination, unclear.sentence)
    const reads = ebayInventoryReads(d.accountId, scope.marketplace, itemId)
    const expectedSkus = children.map(skuOf)
    const inventory = listings.some(l => Object.keys(object(object(l.platformAttributes).__offerIds)).length > 0)
    // The Inventory read finds the group by the family's parent SKU — the main listing's group, never an alias's.
    if (inventory && d.aliasKey) return notReadable(destination, 'This alias uses the eBay Inventory API. Nexus reads Inventory listings by the family\'s SKUs, which belong to the main listing, so it cannot read this alias.')
    return inventory
      ? readEbayInventoryListing({ ...destination, expectedSkus, itemId, parentSku: parent.sku }, reads)
      : readEbayTradingListing({ ...destination, expectedSkus, itemId }, { getItem: reads.getItem })
  }
  if (scope.channel === 'AMAZON') {
    if (unclear) return notReadable(destination, unclear.sentence)
    const marketplaceId = await configuredAmazonMarketplaceId(scope.marketplace)
    if (!marketplaceId) return notReadable(destination, `No Amazon marketplace is configured for ${scope.marketplace}.`)
    const [language] = await marketLanguages('AMAZON', scope.marketplace)
    const sellerId = await getAmazonSellerId(d.accountId)
    const client = new AmazonSpApiClient({ id: d.accountId, region: await getAmazonRegion(d.accountId) })
    // The seller SKU: the listing's own (S7, `reportedSkuOf` above), else the product SKU.
    return readAmazonListing({ ...destination, expectedSkus: children.map(skuOf), parentSku: skuOf(parent), marketplaceId,
      languageTag: language ? languageTag(language, scope.marketplace) : '' }, {
      async listing(sku): Promise<AmazonListingRead> {
        const r = await client.getListingsItem({ sellerId, sku, marketplaceId, includedData: ['summaries', 'attributes', 'offers', 'fulfillmentAvailability'] })
        if (!r.success) return { status: 'error', reason: r.error ?? 'Amazon could not read this listing.' }
        // The client returns this exact no-body shape only for HTTP 404: a measured absence, not a failed read.
        if (r.asin === null && r.status === null && r.rawResponse === undefined && r.error === undefined) return { status: 'absent' }
        return { status: 'found', raw: object(r.rawResponse) }
      },
      async schemaProperties(productType) {
        const row = await prisma.categorySchema.findFirst({ where: { channel: 'AMAZON', marketplace: scope.marketplace, productType, isActive: true }, orderBy: { fetchedAt: 'desc' }, select: { schemaDefinition: true } })
        const properties = object(object(row?.schemaDefinition).properties)
        return Object.keys(properties).length ? properties : null
      },
    })
  }
  return notReadable(destination, scope.channel === 'SHOPIFY' ? 'Reading live from Shopify comes with the Shopify publish step (P4.2).'
    : scope.channel === 'ETSY' ? 'Reading live from Etsy comes with the Etsy publish step (P5.1).' : `Reading live from ${scope.channel} is not available.`)
}

/** Server side (publish review): the read with its raw provider documents. */
export async function readLiveListing(productId: string, scope: LiveReadScope, now = Date.now): Promise<ServerLiveRead<unknown> & { cached: boolean }> {
  const key = JSON.stringify([productId, scope.channel, scope.marketplace, scope.accountId, scope.aliasKey ?? ''])
  const last = recent.get(key)
  if (last && now() - last.at < WINDOW_MS) return { ...last.read, cached: true }
  let pending = inFlight.get(key)
  if (!pending) {
    pending = readNow(productId, scope).then(read => { recent.set(key, { at: now(), read }); return read }).finally(() => inFlight.delete(key))
    inFlight.set(key, pending)
  }
  return { ...await pending, cached: false }
}

/** For the web: the same read without the raw provider documents. */
export function publicLiveRead(read: ServerLiveRead<unknown> & { cached: boolean }): LiveRead & { cached: boolean } {
  const { raw: _raw, ...rest } = read
  return rest
}

/** Tests only. */
export function resetLiveReadWindow() { recent.clear(); inFlight.clear() }
