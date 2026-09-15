import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ listings: vi.fn(), columns: vi.fn() }))
const product = { id: 'p', sku: 'P', parentId: null, isParent: false, productType: 'OUTERWEAR',
  categoryAttributes: { material: 'Master leather' }, variantAttributes: {}, localizedContent: {},
  bulletPoints: ['Master bullet'], variationAxes: [] }
vi.mock('../../db.js', () => ({ default: {
  $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({ $executeRaw: async () => 0 }),
  product: { findFirst: async () => ({ id: 'p', parentId: null }), findMany: async () => [product] },
  channelListing: { findMany: mocks.listings }, productListingAlias: { findMany: async () => [] },
  fieldLinkGroup: { findMany: async () => [] }, cellFormula: { findMany: async () => [] },
  // LX.F R-LX-13 — the LX reach read (`studio-sheet.service.ts:1058`).
  marketplace: { findUnique: async () => ({ schemaMapping: null }), findMany: async () => [{ channel: 'AMAZON', code: 'IT', languages: ['it'], language: 'it' }] },
} }))
vi.mock('./studio-columns.js', () => ({ getStudioColumns: mocks.columns }))
vi.mock('./product-category-context.js', () => ({ productCategoryContext: async () => ({
  categories: ['OUTERWEAR'], defaults: { p: { channelCategoryId: 'OUTERWEAR' } }, connectionId: 'account',
}) }))

import { getStudioSheet } from './studio-sheet.service.js'

beforeEach(() => {
  mocks.listings.mockResolvedValue([{ id: 'listing', productId: 'p', aliasId: null, channel: 'AMAZON', marketplace: 'IT', translations: [], overrideData: { material: null },
    platformAttributes: { subtitle: null }, followMasterBulletPoints: false, bulletPointsOverride: [] }])
  const common = { group: 'content', kind: 'text', scope: 'global', storage: 'categoryAttributes',
    requiredBy: [], editable: true, defaultVisible: true }
  mocks.columns.mockResolvedValue({
    // LX.F R-LX-13 — LX's `contentListing` refuses a coordinate without its market languages.
  coordinates: [{ channel: 'AMAZON', marketplace: 'IT', label: 'Amazon · IT', inMarket: true, languages: ['it'] }],
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
  it('keeps empty overrides pinned in the JSON and platform stores', async () => {
    const sheet = await read()
    for (const key of ['material', 'subtitle']) {
      expect(sheet.rows[0].values[key], key).toMatchObject({ value: null, source: 'channelExplicit', layer: 'channel', pinned: true, follows: false })
    }
  })
  /**
   * LX.F R-LX-13. `bulletPoints_1` left this arm deliberately, with its numbers.
   *
   * An EMPTY legacy `bulletPointsOverride` array is not an authored clear — there
   * is no presence marker on those columns — so the one content resolver answers
   * from Master. Measured on the local Docker catalogue (`Product.version` 59 =
   * local, not Neon): **0 of 1013** listings carry `bulletPointsOverride = '{}'`
   * with `followMasterBulletPoints = false`, and the same for an empty
   * `titleOverride`/`title`/`descriptionOverride` pin — against a positive control
   * of **512** listings whose `bulletPointsOverride` is non-empty. So this shape
   * exists in no writer's output; an operator's clear is recorded as an authored
   * KEY on the translation row (`content-write.ts:59`), which is the arm below.
   */
  it('shows Master for an empty legacy bullet array, and PINNED EMPTY for an authored clear', async () => {
    expect((await read()).rows[0].values.bulletPoints_1).toMatchObject({ value: 'Master bullet', pinned: false })
    mocks.listings.mockResolvedValue([{ id: 'listing', productId: 'p', aliasId: null, channel: 'AMAZON', marketplace: 'IT',
      overrideData: { material: null }, platformAttributes: { subtitle: null }, followMasterBulletPoints: false, bulletPointsOverride: [],
      // The authored clear: the key is PRESENT on the pin row with an empty value.
      translations: [{ language: 'it', channelListingId: 'listing', attributes: { bulletPoints: [] }, source: 'manual', reviewedAt: new Date() }] }])
    expect((await read()).rows[0].values.bulletPoints_1).toMatchObject({ value: null, pinned: true, follows: false })
  })
  it('restoring inheritance uses Master and ignores the previous bullet snapshot', async () => {
    mocks.listings.mockResolvedValue([{ id: 'listing', productId: 'p', aliasId: null, channel: 'AMAZON', marketplace: 'IT', translations: [], overrideData: {},
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
