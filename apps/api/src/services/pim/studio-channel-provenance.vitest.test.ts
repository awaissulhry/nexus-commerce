import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ listings: vi.fn(), columns: vi.fn() }))
const product = { id: 'p', sku: 'P', parentId: null, isParent: false, productType: 'OUTERWEAR',
  categoryAttributes: { material: 'Master leather' }, variantAttributes: {}, localizedContent: {},
  bulletPoints: ['Master bullet'], variationAxes: [] }
vi.mock('../../db.js', () => ({ default: {
  product: { findFirst: async () => ({ id: 'p', parentId: null }), findMany: async () => [product] },
  channelListing: { findMany: mocks.listings }, productListingAlias: { findMany: async () => [] },
  fieldLinkGroup: { findMany: async () => [] }, cellFormula: { findMany: async () => [] },
} }))
vi.mock('./studio-columns.js', () => ({ getStudioColumns: mocks.columns }))
vi.mock('./product-category-context.js', () => ({ productCategoryContext: async () => ({
  categories: ['OUTERWEAR'], defaults: { p: { channelCategoryId: 'OUTERWEAR' } }, connectionId: 'account',
}) }))

import { getStudioSheet } from './studio-sheet.service.js'

beforeEach(() => {
  mocks.listings.mockResolvedValue([{ id: 'listing', productId: 'p', aliasId: null, overrideData: { material: null },
    platformAttributes: { subtitle: null }, followMasterBulletPoints: false, bulletPointsOverride: [] }])
  const common = { group: 'content', kind: 'text', scope: 'global', storage: 'categoryAttributes',
    requiredBy: [], editable: true, defaultVisible: true }
  mocks.columns.mockResolvedValue({
    coordinates: [{ channel: 'AMAZON', marketplace: 'IT', label: 'Amazon · IT', inMarket: true }],
    locale: 'it', columns: [
      { ...common, key: 'material', label: 'Material', writeField: 'attr_material',
        channels: { 'Amazon · IT': { key: 'material', attribute: 'material', path: [] } } },
      { ...common, key: 'subtitle', label: 'Subtitle', writeField: 'attr_subtitle',
        channels: { 'Amazon · IT': { key: 'subtitle', attribute: 'subtitle', path: [], store: { kind: 'platformAttributes', path: ['subtitle'] } } } },
      { ...common, key: 'bulletPoints_1', label: 'Bullet 1', writeField: 'amazon_bulletPoints[1]', slot: { of: 'bulletPoints', index: 1 },
        channels: { 'Amazon · IT': { key: 'bullet_point', attribute: 'bullet_point', path: [],
          store: { kind: 'listingColumn', column: 'bulletPointsOverride', followFlag: 'followMasterBulletPoints' } } } },
    ],
  })
})

describe('stored channel provenance without mapping enrichment', () => {
  const read = () => getStudioSheet({ productId: 'p', scope: 'channel', channel: 'AMAZON', market: 'IT', locale: 'it', includeMapping: false })
  it('keeps empty overrides pinned across JSON, platform and slotted listing stores', async () => {
    const sheet = await read()
    for (const key of ['material', 'subtitle', 'bulletPoints_1']) {
      expect(sheet.rows[0].values[key], key).toMatchObject({ value: null, source: 'channelExplicit', layer: 'channel', pinned: true, follows: false })
    }
  })
  it('restoring inheritance uses Master and ignores the previous bullet snapshot', async () => {
    mocks.listings.mockResolvedValue([{ id: 'listing', productId: 'p', aliasId: null, overrideData: {},
      platformAttributes: {}, followMasterBulletPoints: true, bulletPointsOverride: ['Old channel bullet'] }])
    const sheet = await read()
    expect(sheet.rows[0].values.material).toMatchObject({ value: 'Master leather', pinned: false, follows: true })
    expect(sheet.rows[0].values.bulletPoints_1).toMatchObject({ value: 'Master bullet', pinned: false, follows: true })
  })
})

describe('unavailable channel requirements', () => {
  it('cannot report 100% readiness from the two fallback identity columns', async () => {
    const set = await mocks.columns()
    mocks.columns.mockResolvedValue({ ...set, schemaMissing: ['OUTERWEAR'] })
    const sheet = await getStudioSheet({ productId: 'p', scope: 'channel', channel: 'AMAZON', market: 'IT', locale: 'it', includeMapping: false })
    expect(sheet.rows[0].readiness).toMatchObject({ state: 'errors', issues: expect.arrayContaining([
      expect.objectContaining({ severity: 'error', message: expect.stringContaining('Readiness cannot be verified') }),
    ]) })
    expect(sheet.aliases[0].readiness).toMatchObject({ percent: null, state: 'errors' })
  })
})
