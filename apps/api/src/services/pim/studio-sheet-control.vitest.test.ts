/**
 * P1 (fix/product-sheet-editing) — the full-control facts the studio sheet serves: where a value comes from, and
 * which rows may hold it. Constructed families, the harness of `studio-sheet-axis.vitest.test.ts`: these are
 * DERIVATIONS of this service (given these rows and columns, which layer and which lock), not claims about storage.
 *
 * Run: npx vitest run src/services/pim/studio-sheet-control.vitest.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.hoisted(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected outbound channel call') })) })

const productFindFirst = vi.fn()
const productFindMany = vi.fn()
const channelListingFindMany = vi.fn()
const aliasFindMany = vi.fn()
const getStudioColumns = vi.fn()
const marketplaceFindMany = vi.fn()

vi.mock('../../db.js', () => ({
  default: {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({ $executeRaw: async () => 0 }),
    product: { findFirst: (...a: unknown[]) => productFindFirst(...a), findMany: (...a: unknown[]) => productFindMany(...a) },
    channelListing: { findMany: (...a: unknown[]) => channelListingFindMany(...a) },
    productMediaPlan: { findMany: async () => [] },
    productListingAlias: { findMany: (...a: unknown[]) => aliasFindMany(...a) },
    fieldLinkGroup: { findMany: async () => [] },
    cellFormula: { findMany: async () => [] },
    marketplace: { findUnique: async () => ({ schemaMapping: null }), findMany: (...a: unknown[]) => marketplaceFindMany(...a) },
  },
}))
vi.mock('./studio-columns.js', () => ({ getStudioColumns: (...a: unknown[]) => getStudioColumns(...a) }))
vi.mock('./product-category-context.js', () => ({ productCategoryContext: async () => ({ connectionId: 'account', categories: ['177104'], defaults: {} }) }))
vi.mock('./mapping/index.js', () => ({ resolveChannelValues: async () => ({ byProduct: {}, categoryByProduct: {}, missingProductIds: [], meta: {} }) }))

import { getStudioSheet } from './studio-sheet.service.js'

const PARENT = 'regal'
const EBAY_IT = { channel: 'EBAY', marketplace: 'IT', label: 'eBay · IT', inMarket: true, languages: ['it'] }
const title = { key: 'name', writeField: 'ebay_title', label: 'Title', group: 'Content', kind: 'longtext', storage: 'localizedContent',
  scope: 'global', requiredBy: [], editable: true, defaultVisible: true,
  channels: { 'eBay · IT': { key: 'title', attribute: 'title', path: [], store: { kind: 'listingColumn', column: 'title', followFlag: 'followMasterTitle' } } } }
const listing = (productId: string, over: Record<string, unknown> = {}) => ({
  id: `listing-${productId}`, productId, channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'account', aliasKey: '', aliasId: null,
  listingStatus: 'ACTIVE', isPublished: true, offerActive: true, version: 4, translations: [], platformAttributes: {}, overrideData: {},
  followMasterTitle: true, title: null, ...over,
})

beforeEach(() => {
  for (const m of [productFindFirst, productFindMany, channelListingFindMany, aliasFindMany, getStudioColumns, marketplaceFindMany]) m.mockReset()
  productFindFirst.mockResolvedValue({ id: PARENT, parentId: null })
  productFindMany.mockResolvedValue([
    { id: PARENT, sku: 'REGAL', isParent: true, parentId: null, productType: 'OUTERWEAR', name: 'Master title',
      variationAxes: ['Colore'], variantAttributes: {}, categoryAttributes: {}, translations: [] },
    { id: 'child', sku: 'REGAL-L', isParent: false, parentId: PARENT, productType: 'OUTERWEAR', name: 'Master title',
      variationAxes: [], variantAttributes: { Color: 'Nero' }, categoryAttributes: {}, translations: [] },
  ])
  marketplaceFindMany.mockResolvedValue([{ channel: 'EBAY', code: 'IT', languages: ['it'], language: 'it' }])
  aliasFindMany.mockResolvedValue([])
  getStudioColumns.mockResolvedValue({ columns: [title], coordinates: [EBAY_IT] })
})

describe('an old listing text is the listing’s own value (report 2 I-3)', () => {
  it('serves it on the listing layer, not Master, with the resolver’s follow intent unchanged', async () => {
    channelListingFindMany.mockResolvedValue([listing('child', { title: 'Old eBay title' }), listing(PARENT)])
    const sheet = await getStudioSheet({ productId: PARENT, scope: 'channel', channel: 'EBAY', market: 'IT', locale: 'it' })
    const cell = sheet.rows.find(row => row.id === 'child')!.values.name
    expect(cell).toMatchObject({ value: 'Old eBay title', source: 'channelSnapshot', layer: 'channel', follows: true, pinned: false })
    // Master's own text on the other row is still Master's.
    expect(sheet.rows.find(row => row.id === PARENT)!.values.name).toMatchObject({ value: 'Master title', layer: 'master' })
  })

  it('names the alias layer on a named listing alias', async () => {
    aliasFindMany.mockResolvedValue([{ id: 'outlet', label: 'Outlet', position: 1, status: 'ACTIVE' }])
    channelListingFindMany.mockResolvedValue([listing('child', { title: 'Old outlet title', aliasKey: 'outlet', aliasId: 'outlet' })])
    const sheet = await getStudioSheet({ productId: PARENT, scope: 'channel', channel: 'EBAY', market: 'IT', locale: 'it' })
    expect(sheet.rows.find(row => row.id === 'child' && row.aliasId === 'outlet')!.values.name).toMatchObject({ source: 'channelSnapshot', layer: 'alias' })
  })
})
