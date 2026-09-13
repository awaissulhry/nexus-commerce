import { beforeEach, describe, expect, it, vi } from 'vitest'
const s = vi.hoisted(() => ({ controls: [] as any[], read: vi.fn(), next: vi.fn(), transport: vi.fn(), review: vi.fn() }))
vi.mock('./listing-push-controls.js', () => ({ readPushControls: s.read }))
vi.mock('../db.js', () => ({ default: { product: { findUnique: s.next, findMany: s.next }, sharedListingMembership: { findMany: s.next } } }))
vi.mock('./ebay-trading-api.service.js', () => ({ callTradingApi: s.transport, siteIdForMarket: () => '101', escapeXml: (v: string) => v, addFixedPriceItem: s.transport }))
vi.mock('./ebay-presentation-consumer.service.js', () => ({ assertLegacyPresentationPublishAllowed: s.review }))
vi.mock('./pim/publish-review-gate.js', () => ({ assertListingContentReviewed: s.review }))
vi.mock('./ebay-description-theme.service.js', () => ({ renderListingDescriptionSafe: s.next }))
vi.mock('./ebay-variation-push.service.js', () => ({ axisSynonymKey: (v: string) => v.toLowerCase() }))
vi.mock('./ebay-auth.service.js', () => ({ ebayAuthService: { getAccessToken: s.next } }))
vi.mock('./connection-resolver.service.js', () => ({ tryResolveConnection: s.next }))
vi.mock('./marketplaces/amazon.service.js', () => ({ AmazonService: class { updateVariantPrice = s.transport } }))
vi.mock('./marketplaces/shopify.service.js', () => ({ ShopifyService: class { updateVariantPrice = s.transport; updateVariantInventory = s.transport } }))
vi.mock('./marketplaces/woocommerce.service.js', () => ({ WooCommerceService: class {} }))
vi.mock('./marketplaces/etsy.service.js', () => ({ EtsyService: class {} }))
import { convertListingAxesToItalian } from './ebay-axes-convert.service.js'
import { reconcileMembershipsFromEbay } from './ebay-membership-reconcile.service.js'
import { addVariationsToListing } from './ebay-variation-add.service.js'
import { applyVariationOrderToListing } from './ebay-variation-order-apply.service.js'
import { relabelListingToPoolSkus, adoptSkulessVariations } from './ebay-variation-relabel.service.js'
import { createSharedListing } from './ebay-shared-listing-push.service.js'
import { publishEbaySharedListingImages } from './images/ebay-shared-image-publish.service.js'
import { ebayProvider } from '../providers/ebay.provider.js'
import { MarketplaceService } from './marketplaces/marketplace.service.js'
import { EbayService } from './marketplaces/ebay.service.js'
const ctx = { oauthToken: 'fixture' }
const market = new MarketplaceService()
const ebay = new EbayService()
const cases: Array<[string, () => Promise<unknown>, 'read' | 'send' | 'review']> = [
 ['axis rename', () => convertListingAxesToItalian('123', 'IT', ctx), 'send'],
 ['membership repair', () => reconcileMembershipsFromEbay('123', 'IT', ctx), 'send'],
 ['add variations', () => addVariationsToListing('123', 'IT', [], ctx), 'send'],
 ['variation order', () => applyVariationOrderToListing('123', 'IT', [], {}, ctx), 'send'],
 ['relabel', () => relabelListingToPoolSkus('123', 'IT', ctx), 'read'],
 ['adopt SKU-less', () => adoptSkulessVariations('123', 'IT', ctx), 'send'],
 ['shared create', () => createSharedListing({sku:'SKU'}, [], {...ctx, market:'IT'} as any), 'review'],
 ['shared images', () => publishEbaySharedListingImages('product', 'IT'), 'read'],
 ['provider images', () => ebayProvider.reviseItemImages({ itemId:'123', galleryUrls:['https://fixture.invalid/a.jpg'] }), 'send'],
 ['Shopify legacy price', () => market.updatePrice([{ channel:'SHOPIFY', channelVariantId:'123', price:2 }]), 'send'],
 ['Shopify legacy stock', () => market.updateInventory([{ channel:'SHOPIFY', channelVariantId:'123', inventory:2 }]), 'send'],
 ['eBay legacy stock', () => ebay.updateInventory('SKU', 2), 'read'],
 ['eBay legacy price', () => ebay.updatePrice('SKU', 2), 'read'],
 ['eBay legacy variant price', () => ebay.updateVariantPrice('SKU', 2), 'read'],
]
const locks = [{ syncPaused:true }, { offerClosedAt:new Date('2026-09-13') }, ...['HELD','WITHDRAWN','ENDED','DISCONTINUED','RELEASED'].map(presenceIntent => ({presenceIntent}))]
async function outcome(run: () => Promise<unknown>) { try { return JSON.stringify(await run()) ?? '' } catch(e) { return e instanceof Error ? e.message : String(e) } }
beforeEach(() => {
 vi.clearAllMocks(); s.controls = [{}]; s.read.mockImplementation(async () => s.controls)
 s.next.mockRejectedValue(new Error('NEXT_READ')); s.transport.mockRejectedValue(new Error('NEXT_TRANSPORT')); s.review.mockRejectedValue(new Error('NEXT_REVIEW'))
 vi.stubGlobal('fetch', s.transport)
 vi.spyOn(ebay as any, 'getAccessToken').mockImplementation(s.next)
 vi.spyOn(ebayProvider as any, 'callTradingApi').mockImplementation(s.transport)
})
describe.each(cases)('%s push boundary', (_name, run, next) => {
 it.each(locks)('refuses %j before remote work', async lock => {
  s.controls = [lock]; expect(await outcome(run)).toContain('PUSH_')
  expect(s.read).toHaveBeenCalledOnce(); expect(s.transport).not.toHaveBeenCalled(); expect(s.next).not.toHaveBeenCalled(); expect(s.review).not.toHaveBeenCalled()
 })
 it('unlocked control reaches the existing next boundary', async () => {
  const result = await outcome(run); expect(result).not.toContain('PUSH_'); expect(s.read).toHaveBeenCalledOnce()
  expect(next === 'read' ? s.next : next === 'review' ? s.review : s.transport).toHaveBeenCalled()
 })
})
it('explicit order dry-run retains its remote-read preview without a push-control read', async () => {
 await applyVariationOrderToListing('123','IT',[],{},ctx,{dryRun:true})
 expect(s.read).not.toHaveBeenCalled(); expect(s.transport).toHaveBeenCalledWith('GetItem',expect.any(String),expect.any(Object))
})
it('Etsy refusal remains local and does not enter a write lookup', async () => {
 const result = await market.updatePrice([{channel:'ETSY',channelVariantId:'123',price:2}])
 expect(result[0].success).toBe(false); expect(s.read).not.toHaveBeenCalled(); expect(s.transport).not.toHaveBeenCalled()
})
