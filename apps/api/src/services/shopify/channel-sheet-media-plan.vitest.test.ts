/**
 * A media-plan family whose store shows each colour as its own Shopify product (GALE): each colour product the plan
 * manages gets the plan's gallery through the reviewed sheet gallery sync, on the row that holds its product fields. A colour
 * the plan does not manage is never touched, and an older sheet gallery draft is refused (the Media page is the one editor).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writeMediaCollection } from '@nexus/shared/product-media'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import type { ShopifyProductLayout } from '@nexus/shared/media-plan-channels'

const s = vi.hoisted(() => ({ products: [] as ShopifyProductLayout[], layoutCalls: 0 }))
vi.mock('../images/media-plan-switch.js', () => ({ isOnMediaPlan: async () => true, mediaPlanRevision: async () => null, mediaPlanProducts: async () => new Set() }))
vi.mock('../images/media-plan.service.js', () => ({ mediaLayoutFor: async () => { s.layoutCalls++; return { layout: { media: [], variantImages: {}, checks: [], products: s.products } } } }))
vi.mock('../../db.js', () => ({ default: {} }))
import { readSheetGallerySources, planGalleryFamily, SHEET_MEDIA_SYNC } from './channel-sheet-media.js'

const BLACK = 'gid://shopify/Product/7001', YELLOW = 'gid://shopify/Product/7002'
const destination = { familyId: 'gale', productId: 'gale', accountId: 'store-a', aliasKey: '', marketplace: 'GLOBAL' } as any
const schema = { locales: [{ locale: 'it', primary: true }], native: { scopes: ['write_files', 'write_products'] } } as ShopifyStoreSchema
let listings: any[], files: any[], colourProducts: number, assets: any[]
const tx = {
  product: { findMany: async () => [{ id: 'gale', parentId: null, name: 'GALE-JACKET', sku: 'GALE-JACKET', localizedContent: {} },
    { id: 'b-m', parentId: 'gale', name: 'Black M', sku: 'GALE-BLACK-M', localizedContent: {} }, { id: 'b-l', parentId: 'gale', name: 'Black L', sku: 'GALE-BLACK-L', localizedContent: {} },
    { id: 'y-m', parentId: 'gale', name: 'Yellow M', sku: 'GALE-YELLOW-M', localizedContent: {} }] },
  channelListing: { findMany: async () => listings },
  productImage: { findMany: async (args: any) => args.where?.sourceAssetId ? files.filter(f => args.where.id.in.includes(f.id) && f.sourceAssetId) : files },
  digitalAsset: { findMany: async (args: any) => assets.filter(a => args.where.id.in.includes(a.id)) },
  shopifyColourProduct: { count: async () => colourProducts },
} as any
const product = (over: Partial<ShopifyProductLayout>): ShopifyProductLayout => ({ productId: BLACK, valueKey: 'color:black', label: 'Black', managed: true, media: ['p2', 'p1'], checks: [], ...over })

beforeEach(() => {
  listings = [
    { id: 'l-root', productId: 'gale', externalListingId: null, platformAttributes: {} },
    { id: 'l-b-m', productId: 'b-m', externalListingId: '7001', platformAttributes: {} },
    { id: 'l-b-l', productId: 'b-l', externalListingId: '7001', platformAttributes: {} },
    { id: 'l-y-m', productId: 'y-m', externalListingId: '7002', platformAttributes: {} },
  ]
  files = [{ id: 'p1', productId: 'gale', url: 'https://cdn.shopify.com/s/files/black-front.webp', alt: null, mediaType: 'IMAGE', sourceAssetId: 'dam-1' },
    { id: 'p2', productId: 'gale', url: 'https://res.cloudinary.com/x/image/upload/p2.jpg', alt: 'Front', mediaType: 'IMAGE', sourceAssetId: null }]
  assets = [{ id: 'dam-1', storageProvider: 'shopify', storageId: 'gid://shopify/MediaImage/1', metadata: { shopifyAccountId: 'store-a' } }]
  colourProducts = 2; s.layoutCalls = 0
  s.products = [product({}), product({ productId: YELLOW, valueKey: 'color:yellow', label: 'Yellow', managed: false, media: [] })]
})

describe('colour products of a media-plan family', () => {
  it('sends each managed colour product its plan gallery, on the row holding its fields; an unmanaged colour is untouched', async () => {
    const { galleries } = await readSheetGallerySources(tx, destination, schema)
    expect(galleries).toHaveLength(1)
    // The owner row: the first of the colour's rows in SKU order (GALE-BLACK-L before GALE-BLACK-M).
    expect(galleries[0]).toMatchObject({ listingId: 'l-b-l', nexusProductId: 'b-l', productId: BLACK, ownerLabel: 'GALE-JACKET · Black', locale: 'it', value: [],
      assets: [{ id: 'p2', url: 'https://res.cloudinary.com/x/image/upload/p2.jpg', type: 'IMAGE', alt: 'Front', translations: {} }, { id: 'p1', type: 'IMAGE', alt: '', translations: {} }],
      storeFiles: { p1: 'gid://shopify/MediaImage/1' } })
    expect(await planGalleryFamily(tx, destination)).toBe(true)
  })
  it('a synced gallery is not sent again until the plan changes it', async () => {
    const first = await readSheetGallerySources(tx, destination, schema)
    listings[2].platformAttributes[SHEET_MEDIA_SYNC] = { signature: first.galleries[0].signature }
    const again = await readSheetGallerySources(tx, destination, schema)
    expect(again.galleries).toHaveLength(0)
    expect(again.revision).toBe(first.revision)
    s.products[0] = product({ media: ['p1', 'p2'] })
    expect((await readSheetGallerySources(tx, destination, schema)).galleries.map(g => g.assets.map(a => a.id))).toEqual([['p1', 'p2']])
  })
  it('refuses an older sheet gallery draft, a blocking plan problem, or a product no row holds', async () => {
    s.products = [product({ checks: [{ severity: 'error', code: 'over-limit', message: 'Too many.' }] })]
    await expect(readSheetGallerySources(tx, destination, schema)).rejects.toThrow('Black: Too many.')
    s.products = [product({ productId: 'gid://shopify/Product/404' })]
    await expect(readSheetGallerySources(tx, destination, schema)).rejects.toThrow('no Nexus row holds')
    listings[1].platformAttributes._productMediaLocales = writeMediaCollection({}, 'it', { version: 1, items: [{ assetId: 'p1' }] })
    await expect(readSheetGallerySources(tx, destination, schema)).rejects.toThrow('managed on the Media page')
  })
  it('a plan family without colour products on this store reads nothing', async () => {
    colourProducts = 0
    expect((await readSheetGallerySources(tx, destination, schema)).galleries).toEqual([])
    expect(s.layoutCalls).toBe(0)
    expect(await planGalleryFamily(tx, destination)).toBe(false)
  })
})
