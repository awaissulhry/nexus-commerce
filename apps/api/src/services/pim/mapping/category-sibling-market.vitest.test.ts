/**
 * P2 (the Owner's D2 = A, 2026-09-27) — the Amazon product type of a market where the product has no listing comes FIRST
 * from its own Amazon listings in the other markets of the same region (`MARKET_CATALOGUE.region`), then the category
 * mapping, then `Product.productType`. A listing in THIS market still beats all of it.
 *
 * Measured before: GALE-JACKET was COAT in its four listed markets and OUTERWEAR in the seven others, so one jacket
 * showed two Amazon rule sets. On an in-process PostgreSQL (PGlite) with the REAL sibling query, so the region, account
 * and JSON filters are the ones production runs. Every id below is invented.
 *
 * Run: DATABASE_URL=postgresql://nexus@127.0.0.1:1/nexus_unit_test npx vitest run src/services/pim/mapping/category-sibling-market.vitest.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})

import prisma from '../../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { categorySourceLabel, resolveCategoriesForProducts, type MappingRow } from './category-mapping.service.js'
import { productCategoryContext } from '../product-category-context.js'

// Production runs with business profiles on: every database call runs inside a business, as real callers do.
const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}
let accountA = ''
let accountB = ''

async function product(key: string, productType: string, parent?: string) {
  ids[key] = (await prisma.product.create({ data: { sku: `P2-${key}`, name: key, basePrice: 10, productType, ...(parent ? { parentId: ids[parent] } : {}) } })).id
}
async function listing(key: string, marketplace: string, productType: unknown, channelConnectionId: string | null = null, channel = 'AMAZON') {
  await prisma.channelListing.create({ data: { productId: ids[key], channel, marketplace, channelMarket: `${channel}_${marketplace}`,
    region: marketplace === 'US' ? 'NA' : 'EU', channelConnectionId, platformAttributes: productType === undefined ? {} : { productType } as never } })
}
const resolve = (keys: string[], marketplace: string, extra: { channel?: string; channelConnectionId?: string | null; mappingSnapshot?: MappingRow[] } = {}) =>
  scoped(() => resolveCategoriesForProducts({ productIds: keys.map(k => ids[k]), channel: extra.channel ?? 'AMAZON', marketplace, ...extra }))

afterAll(async () => { await state.db?.close() })

beforeAll(async () => {
  await scoped(async () => {
    const account = (label: string) => prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: label, isActive: true,
      externalAccountId: `SELLER-${label}`, authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })
    accountA = (await account('a')).id
    accountB = (await account('b')).id

    // A GALE-like family: the parent and one variant listed as COAT in IT and DE; a second variant listed nowhere.
    await product('gale', 'OUTERWEAR')
    await product('galeM', 'OUTERWEAR', 'gale')
    await product('galeL', 'OUTERWEAR', 'gale')
    await listing('gale', 'IT', 'COAT')
    await listing('galeM', 'IT', 'COAT')
    await listing('galeM', 'DE', ' coat ') // stored spelling is normalised, as `categoryForListing` does for this market
    // Listings disagree across markets.
    await product('split', 'OUTERWEAR')
    await listing('split', 'IT', 'COAT')
    await listing('split', 'DE', 'OUTERWEAR')
    // A listing in THIS market (BE) and a different type in a sibling market.
    await product('pinned', 'OUTERWEAR')
    await listing('pinned', 'BE', 'PANTS')
    await listing('pinned', 'DE', 'COAT')
    // Listed only in another Amazon region (the catalogue puts US in NA).
    await product('usOnly', 'OUTERWEAR')
    await listing('usOnly', 'US', 'COAT')
    // Listed in DE under account B only.
    await product('acct', 'OUTERWEAR')
    await listing('acct', 'DE', 'COAT', accountB)
    // Listings that carry no usable type: blank, a number, no key at all, and an eBay listing's category.
    await product('blank', 'OUTERWEAR')
    await listing('blank', 'IT', '  ')
    await listing('blank', 'DE', 123)
    await listing('blank', 'FR', undefined)
    await listing('blank', 'ES', 'COAT', null, 'EBAY')
  })
}, 60_000)

describe('the Amazon product type from a sibling market', () => {
  it('a GALE-like jacket resolves COAT in an unlisted EU market, naming the markets it came from', async () => {
    const result = await resolve(['galeM'], 'BE')
    expect(result[ids.galeM]).toMatchObject({ channelCategoryId: 'COAT', source: 'listingOtherMarket', fromMarkets: ['DE', 'IT'] })
    expect(result[ids.galeM].otherMarketConflicts).toBeUndefined()
    expect(categorySourceLabel(result[ids.galeM])).toBe("From this product's Amazon listings in DE, IT")
  })

  it('a variant with no listing of its own takes its parent’s', async () => {
    const result = await resolve(['galeL', 'gale'], 'PL')
    expect(result[ids.galeL]).toMatchObject({ channelCategoryId: 'COAT', source: 'listingOtherMarket', fromMarkets: ['IT'] })
    expect(result[ids.gale]).toMatchObject({ channelCategoryId: 'COAT', source: 'listingOtherMarket', fromMarkets: ['IT'] })
    expect(categorySourceLabel(result[ids.galeL])).toBe("From this product's Amazon listing in IT")
  })

  it('the resolving market itself is never its own sibling: DE reads IT only', async () => {
    expect((await resolve(['galeM'], 'DE'))[ids.galeM]).toMatchObject({ source: 'listingOtherMarket', fromMarkets: ['IT'] })
  })

  it('disagreeing markets decide nothing: the product type stands, and the disagreement is recorded', async () => {
    const result = (await resolve(['split'], 'BE'))[ids.split]
    expect(result).toMatchObject({ channelCategoryId: 'OUTERWEAR', source: 'productType', otherMarketConflicts: ['DE → OUTERWEAR', 'IT → COAT'] })
    // Not the blocking `conflicts` field: the category still resolved.
    expect(result.conflicts).toBeUndefined()
    expect(categorySourceLabel(result)).toBe("The product's own product type (no mapping for this market). Its Amazon listings in other markets disagree: DE → OUTERWEAR, IT → COAT")
  })

  it('disagreeing markets fall through to the category mapping when there is one', async () => {
    const snapshot: MappingRow[] = await scoped(async () => {
      const category = await prisma.category.create({ data: { slug: 'p2-jackets', name: { en: { name: 'Jackets' } } } })
      await prisma.productCategory.create({ data: { productId: ids.split, categoryId: category.id, isPrimary: true } })
      return [{ categoryId: category.id, marketplace: 'BE', channelCategoryId: 'MAPPED_TYPE', channelCategoryPath: null, browseNodeId: null, reviewedAt: null }]
    })
    const result = (await resolve(['split'], 'BE', { mappingSnapshot: snapshot }))[ids.split]
    expect(result).toMatchObject({ channelCategoryId: 'MAPPED_TYPE', source: 'categoryExact', categoryName: 'Jackets', otherMarketConflicts: ['DE → OUTERWEAR', 'IT → COAT'] })
    // …while agreeing sibling listings outrank that same mapping.
    await scoped(() => prisma.productCategory.create({ data: { productId: ids.galeM, categoryId: snapshot[0].categoryId, isPrimary: true } }))
    expect((await resolve(['galeM'], 'BE', { mappingSnapshot: snapshot }))[ids.galeM]).toMatchObject({ channelCategoryId: 'COAT', source: 'listingOtherMarket' })
  })

  it('a listing in THIS market still wins, row by row', async () => {
    const context = await scoped(() => productCategoryContext([ids.pinned], 'AMAZON', 'BE', null))
    // The product-level default reads the sibling market…
    expect(context.defaults[ids.pinned]).toMatchObject({ channelCategoryId: 'COAT', source: 'listingOtherMarket', fromMarkets: ['DE'] })
    // …and the BE listing's own type decides the row and the columns.
    expect(context.byRow.get(`${ids.pinned}:`)).toMatchObject({ channelCategoryId: 'PANTS', source: 'listing' })
    expect(context.categories).toEqual(['PANTS'])
  })

  it('another region’s listing is not used', async () => {
    expect((await resolve(['usOnly'], 'BE'))[ids.usOnly]).toEqual(expect.objectContaining({ channelCategoryId: 'OUTERWEAR', source: 'productType' }))
    expect((await resolve(['usOnly'], 'BE'))[ids.usOnly].otherMarketConflicts).toBeUndefined()
    // US has no sibling in the catalogue, and a market the catalogue does not know has no region at all.
    expect((await resolve(['galeM'], 'US'))[ids.galeM]).toMatchObject({ channelCategoryId: 'OUTERWEAR', source: 'productType' })
    expect((await resolve(['galeM'], 'XX'))[ids.galeM]).toMatchObject({ channelCategoryId: 'OUTERWEAR', source: 'productType' })
  })

  it('reads only the account the caller reads its own listings with', async () => {
    expect((await resolve(['acct'], 'BE', { channelConnectionId: accountB }))[ids.acct]).toMatchObject({ channelCategoryId: 'COAT', source: 'listingOtherMarket' })
    expect((await resolve(['acct'], 'BE', { channelConnectionId: accountA }))[ids.acct]).toMatchObject({ channelCategoryId: 'OUTERWEAR', source: 'productType' })
    expect((await resolve(['acct'], 'BE', { channelConnectionId: null }))[ids.acct]).toMatchObject({ source: 'productType' })
    // Omitted: every account's listings count.
    expect((await resolve(['acct'], 'BE'))[ids.acct]).toMatchObject({ channelCategoryId: 'COAT', source: 'listingOtherMarket' })
  })

  it('a blank, non-text or missing listing type, or another channel’s listing, is no evidence', async () => {
    expect((await resolve(['blank'], 'BE'))[ids.blank]).toMatchObject({ channelCategoryId: 'OUTERWEAR', source: 'productType' })
  })

  it('non-Amazon channels are unchanged', async () => {
    for (const channel of ['EBAY', 'SHOPIFY']) {
      const result = (await resolve(['galeM', 'blank'], 'IT', { channel }))
      expect(result[ids.galeM]).toMatchObject({ channelCategoryId: null, source: 'none' })
      expect(result[ids.blank]).toMatchObject({ channelCategoryId: null, source: 'none' })
      expect(result[ids.galeM].fromMarkets).toBeUndefined()
    }
  })
})
