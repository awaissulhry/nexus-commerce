/**
 * Owner 2026-10-05 — Amazon keeps ONE photo set per product (its ASIN, every market): an Amazon listing alias (another
 * seller SKU of the same product page) shows the main listing's photos in Product media, read-only, with the reason the
 * web shows; its Amazon photo columns likewise. Off the photo plan only — the plan's Amazon layer is the account's already.
 * Fake ids and addresses only.
 *
 * Run (from apps/api): npx vitest run src/services/pim/studio-sheet-amazon-alias-photos.vitest.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AMAZON_ALIAS_PHOTOS } from '@nexus/shared/product-media'

const productFindMany = vi.fn()
const channelListingFindMany = vi.fn()
const aliasFindMany = vi.fn()
const getStudioColumns = vi.fn()
const plan = vi.hoisted(() => ({ row: null as null | ((...a: unknown[]) => unknown) }))

vi.mock('../../db.js', () => ({
  default: {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({ $executeRaw: async () => 0 }),
    product: { findFirst: async () => ({ id: 'p_solo', parentId: null }), findMany: (...a: unknown[]) => productFindMany(...a) },
    channelListing: { findMany: (...a: unknown[]) => channelListingFindMany(...a) },
    $queryRaw: async () => [],
    productMediaPlan: { findMany: async () => [] },
    productListingAlias: { findMany: (...a: unknown[]) => aliasFindMany(...a) },
    fieldLinkGroup: { findMany: async () => [] },
    cellFormula: { findMany: async () => [] },
    categorySchema: { findFirst: async () => null, findMany: async () => [] },
    channelSchema: { findMany: async () => [] },
    offer: { findMany: async () => [] },
    marketplace: { findUnique: async () => ({ schemaMapping: null }), findMany: async () => [
      { channel: 'AMAZON', code: 'IT', languages: ['it'], language: 'it' }, { channel: 'EBAY', code: 'IT', languages: ['it'], language: 'it' },
    ] },
  },
}))
vi.mock('./studio-stock.js', async (importOriginal) => ({ ...await importOriginal<typeof import('./studio-stock.js')>(), attachStudioStock: async () => ({ ms: 0 }) }))
vi.mock('./amazon-offer-cells.js', () => ({ loadAmazonOfferCells: async () => null }))
vi.mock('./studio-columns.js', () => ({ getStudioColumns: (...a: unknown[]) => getStudioColumns(...a) }))
vi.mock('./product-category-context.js', () => ({ productCategoryContext: async () => ({ connectionId: 'account', categories: ['COAT'], defaults: {} }) }))
vi.mock('./mapping/index.js', () => ({ resolveChannelValues: async () => ({ byProduct: {}, categoryByProduct: {}, missingProductIds: [], meta: {} }) }))
vi.mock('../images/media-plan.service.js', async (importOriginal) => ({ ...await importOriginal<object>(),
  sheetMediaPlan: async () => plan.row ? { row: plan.row } : null }))

import { getStudioSheet } from './studio-sheet.service.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

const read = (channel = 'AMAZON') => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] },
  () => getStudioSheet({ productId: 'p_solo', scope: 'channel', channel, market: 'IT', locale: 'it' }))

const url = (name: string) => `https://cdn.test/${name}.jpg`
const file = (id: string, sortOrder: number) => ({ id, url: url(id), type: 'ALT', sortOrder, createdAt: new Date(`2026-01-0${sortOrder + 1}T00:00:00Z`),
  isPrimary: false, mediaType: 'IMAGE', posterUrl: null, alt: '' })
const collection = (...ids: string[]) => ({ _productMedia: { version: 1, items: ids.map(assetId => ({ assetId })) } })
/** An Amazon photo column (the ASIN's) and an offer photo column (one seller SKU's), both stored on the listing. */
const photoColumn = (key: string, label: string) => ({ key, writeField: key, label, group: 'Images', kind: 'text', storage: 'listing', scope: 'global', requiredBy: [],
  editable: true, defaultVisible: true, channels: { 'Amazon · IT': { key, store: { kind: 'platformAttributes', path: [key] } }, 'eBay · IT': { key, store: { kind: 'platformAttributes', path: [key] } } } })

function setUp(input: { channel?: string; main: Record<string, unknown>; alias: Record<string, unknown>; mainAsin?: string; aliasAsin?: string }) {
  const channel = input.channel ?? 'AMAZON'
  productFindMany.mockResolvedValue([{ id: 'p_solo', sku: 'SOLO', isParent: false, parentId: null, productType: null, name: 'Giacca', description: null,
    variationAxes: [], variantAttributes: {}, categoryAttributes: {}, translations: [], localizedContent: { und: collection('img-shared') },
    images: [file('img-main', 0), file('img-alias', 1), file('img-shared', 2)] }])
  aliasFindMany.mockResolvedValue([{ id: 'alias-1', label: 'ALT1', position: 1, status: 'ACTIVE' }])
  channelListingFindMany.mockResolvedValue([
    { id: 'l-main', productId: 'p_solo', channel, marketplace: 'IT', channelConnectionId: 'account', platformAttributes: input.main, translations: [], aliasKey: '', aliasId: null, externalListingId: input.mainAsin ?? null },
    { id: 'l-alias', productId: 'p_solo', channel, marketplace: 'IT', channelConnectionId: 'account', platformAttributes: input.alias, translations: [], aliasKey: 'alias-1', aliasId: 'alias-1', externalListingId: input.aliasAsin ?? null },
  ])
  getStudioColumns.mockResolvedValue({ coordinates: [{ channel, marketplace: 'IT', label: channel === 'EBAY' ? 'eBay · IT' : 'Amazon · IT', inMarket: true, languages: ['it'] }],
    columns: [photoColumn('main_product_image_locator', 'Main image'), photoColumn('main_offer_image_locator', 'Offer image')] })
}

beforeEach(() => {
  plan.row = null
  for (const m of [productFindMany, channelListingFindMany, aliasFindMany, getStudioColumns]) m.mockReset()
})

describe('an Amazon alias shows the main listing\'s photos (Owner 2026-10-05)', () => {
  it('the alias row\'s Product media is the main listing\'s list, read-only with the reason — never its own saved list', async () => {
    setUp({ main: { _productMediaLocales: { it: collection('img-main') } }, alias: { _productMediaLocales: { it: collection('img-alias') } } })
    const rows = (await read()).rows
    const main = rows.find(r => r.aliasId === null)!, alias = rows.find(r => r.aliasId === 'alias-1')!
    expect(main.productMedia!.map(item => item.id)).toEqual(['img-main'])
    expect(main.productMediaFollows).toBeUndefined()
    expect(alias.productMedia).toEqual(main.productMedia)
    expect(alias.productMediaFollows).toBe('main-listing')
    expect(AMAZON_ALIAS_PHOTOS).toBe('Amazon shows one photo set per product. These are the Main listing\'s photos; change them on the Main listing.')
  })

  it('a main listing that follows the Shared photos: the alias shows the Shared photos too', async () => {
    setUp({ main: {}, alias: { _productMediaLocales: { it: collection('img-alias') } } })
    const alias = (await read()).rows.find(r => r.aliasId === 'alias-1')!
    expect(alias.productMedia!.map(item => item.id)).toEqual(['img-shared'])
    expect(alias.productMediaFollows).toBe('main-listing')
  })

  it('the alias\'s Amazon photo columns show the main listing\'s value, read-only; an offer photo stays the alias\'s own', async () => {
    setUp({ main: { main_product_image_locator: url('amazon-main'), main_offer_image_locator: url('offer-main') },
      alias: { main_product_image_locator: url('amazon-alias'), main_offer_image_locator: url('offer-alias') } })
    const rows = (await read()).rows
    const main = rows.find(r => r.aliasId === null)!, alias = rows.find(r => r.aliasId === 'alias-1')!
    expect(main.values.main_product_image_locator).toMatchObject({ value: url('amazon-main'), editable: true })
    expect(alias.values.main_product_image_locator).toMatchObject({ value: url('amazon-main'), editable: false, writable: false, writeBlockedReason: AMAZON_ALIAS_PHOTOS })
    expect(alias.values.main_offer_image_locator).toMatchObject({ value: url('offer-alias'), editable: true })
    expect(alias.values.main_offer_image_locator?.writeBlockedReason ?? null).toBeNull()
  })

  it('an alias on the Main listing\'s ASIN follows it; an alias on its own ASIN (another product page) keeps its own photos', async () => {
    setUp({ main: { _productMediaLocales: { it: collection('img-main') } }, alias: { _productMediaLocales: { it: collection('img-alias') }, main_product_image_locator: url('amazon-alias') },
      mainAsin: 'B0TESTMAIN', aliasAsin: 'B0TESTMAIN' })
    expect((await read()).rows.find(r => r.aliasId === 'alias-1')).toMatchObject({ productMediaFollows: 'main-listing', productMedia: [expect.objectContaining({ id: 'img-main' })] })
    setUp({ main: { _productMediaLocales: { it: collection('img-main') } }, alias: { _productMediaLocales: { it: collection('img-alias') }, main_product_image_locator: url('amazon-alias') },
      mainAsin: 'B0TESTMAIN', aliasAsin: 'B0TESTOTHER' })
    const own = (await read()).rows.find(r => r.aliasId === 'alias-1')!
    expect(own.productMedia!.map(item => item.id)).toEqual(['img-alias'])
    expect(own.productMediaFollows).toBeUndefined()
    expect(own.values.main_product_image_locator).toMatchObject({ value: url('amazon-alias'), editable: true })
  })

  it('NEGATIVE CONTROL: an eBay alias keeps its own photos (eBay listings hold their own)', async () => {
    setUp({ channel: 'EBAY', main: { _productMediaLocales: { it: collection('img-main') } }, alias: { _productMediaLocales: { it: collection('img-alias') } } })
    const alias = (await read('EBAY')).rows.find(r => r.aliasId === 'alias-1')!
    expect(alias.productMedia!.map(item => item.id)).toEqual(['img-alias'])
    expect(alias.productMediaFollows).toBeUndefined()
  })

  it('a photo plan family: the plan\'s Amazon layer (the account\'s) decides, as before — no read-only mark', async () => {
    plan.row = () => ({ set: { ref: 'common', label: 'Common', sharedBy: 1 }, items: [{ id: 'img-main', type: 'IMAGE', preview: url('img-main'), alt: '' }] })
    setUp({ main: {}, alias: { _productMediaLocales: { it: collection('img-alias') } } })
    const alias = (await read()).rows.find(r => r.aliasId === 'alias-1')!
    expect(alias.productMedia!.map(item => item.id)).toEqual(['img-main'])
    expect(alias.productMediaSet).toEqual({ ref: 'common', label: 'Common', sharedBy: 1 })
    expect(alias.productMediaFollows).toBeUndefined()
  })
})
