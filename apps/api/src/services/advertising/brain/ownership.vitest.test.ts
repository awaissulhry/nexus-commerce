/**
 * ONE BRAIN AB-1 — the campaign → product resolver (brain/ownership.ts).
 *
 *   single      every ad of one product → that product's brain owns the campaign
 *   variations  ads of two variations roll up to their parent: one owner
 *   ties        an ad with no productId ties by its SKU, else its ASIN (any case); a parentless row whose ASIN a
 *               variation carries (FBA beside FBM) belongs to that variation's family
 *   shared      ads of two families; or one family plus an ad Nexus cannot tie (fail closed); or an ASIN two families
 *               carry (named as ambiguous)
 *   none        no ad, or only ads Nexus cannot tie
 *   batched     the loader asks a fixed number of queries whatever the number of campaigns (no N+1)
 *
 * Values are made up (public repo).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  campaign: { findMany: vi.fn() },
  adProductAd: { findMany: vi.fn() },
  product: { findMany: vi.fn(), findFirst: vi.fn() },
}))
vi.mock('../../../db.js', () => ({ default: db }))

const { buildCatalog, ownerOf, resolveCampaignOwnership, tieAd, tieCampaigns } = await import('./ownership.js')

const products = [
  { id: 'p-parent', parentId: null, amazonAsin: 'B0PARENT01', sku: 'JACKET' },
  { id: 'p-s', parentId: 'p-parent', amazonAsin: 'B0JACKETS1', sku: 'JACKET-S' },
  { id: 'p-m', parentId: 'p-parent', amazonAsin: 'B0JACKETM1', sku: 'JACKET-M' },
  { id: 'p-m-fba', parentId: null, amazonAsin: 'B0JACKETM1', sku: 'JACKET-M-FBA' },
  { id: 'q-parent', parentId: null, amazonAsin: null, sku: 'GLOVE' },
  { id: 'q-l', parentId: 'q-parent', amazonAsin: 'B0GLOVEL01', sku: 'GLOVE-L' },
  { id: 'r-solo', parentId: null, amazonAsin: 'B0BOOTS001', sku: 'BOOTS' },
]
const catalog = buildCatalog(products)
const ad = (campaignId: string, productId: string | null, asin: string | null = null, sku: string | null = null) => ({ campaignId, productId, asin, sku })

describe('ownerOf', () => {
  it('one family and every ad tied → product; several, or one with an untied ad → shared; none → none', () => {
    expect(ownerOf(['p-parent'], 0)).toEqual({ kind: 'product', productId: 'p-parent' })
    expect(ownerOf(['q-parent', 'p-parent'], 0)).toEqual({ kind: 'shared', productIds: ['p-parent', 'q-parent'] })
    expect(ownerOf(['p-parent'], 1)).toEqual({ kind: 'shared', productIds: ['p-parent'] })
    expect(ownerOf([], 0)).toEqual({ kind: 'none' })
    expect(ownerOf([], 3)).toEqual({ kind: 'none' })
  })
})

describe('tieAd', () => {
  it('a variation rolls up to its parent; a parentless product is its own family', () => {
    expect(tieAd({ productId: 'p-s', asin: null, sku: null }, catalog).families).toEqual(['p-parent'])
    expect(tieAd({ productId: 'r-solo', asin: null, sku: null }, catalog).families).toEqual(['r-solo'])
    expect(tieAd({ productId: 'p-parent', asin: null, sku: null }, catalog).families).toEqual(['p-parent'])
  })

  it('with no productId it ties by SKU, else by ASIN in any case', () => {
    expect(tieAd({ productId: null, asin: null, sku: 'JACKET-S' }, catalog).families).toEqual(['p-parent'])
    expect(tieAd({ productId: null, asin: 'b0gloveL01', sku: 'NOT-A-SKU' }, catalog).families).toEqual(['q-parent'])
    // A productId Nexus no longer has (a deleted product) falls back to the SKU.
    expect(tieAd({ productId: 'gone', asin: null, sku: 'BOOTS' }, catalog).families).toEqual(['r-solo'])
  })

  it('a parentless row whose ASIN a variation carries (FBA beside FBM) belongs to that family', () => {
    expect(tieAd({ productId: 'p-m-fba', asin: null, sku: null }, catalog).families).toEqual(['p-parent'])
    expect(tieAd({ productId: null, asin: null, sku: 'JACKET-M-FBA' }, catalog).families).toEqual(['p-parent'])
    // By ASIN alone both rows answer, and both are the one family: not ambiguous.
    expect(tieAd({ productId: null, asin: 'B0JACKETM1', sku: null }, catalog)).toEqual({ families: ['p-parent'], ambiguousKey: null })
  })

  it('an ASIN live products of two families carry ties to both and is named', () => {
    const twoFamilies = buildCatalog([...products, { id: 'q-dup', parentId: 'q-parent', amazonAsin: 'B0JACKETS1', sku: 'GLOVE-DUP' }])
    expect(tieAd({ productId: null, asin: 'B0JACKETS1', sku: null }, twoFamilies)).toEqual({ families: ['p-parent', 'q-parent'], ambiguousKey: 'B0JACKETS1' })
  })

  it('an ad with nothing Nexus knows ties to no product', () => {
    expect(tieAd({ productId: null, asin: 'B0NOWHERE1', sku: 'NOWHERE' }, catalog).families).toEqual([])
    expect(tieAd({ productId: null, asin: null, sku: null }, catalog).families).toEqual([])
  })
})

describe('tieCampaigns', () => {
  it('single, variations, shared, untied and none', () => {
    const out = tieCampaigns(['c-single', 'c-vars', 'c-shared', 'c-untied', 'c-none', 'c-empty'], [
      ad('c-single', 'r-solo'),
      ad('c-vars', 'p-s'), ad('c-vars', null, 'b0jacketm1'), ad('c-vars', null, null, 'JACKET-M-FBA'),
      ad('c-shared', 'p-s'), ad('c-shared', 'q-l'),
      ad('c-untied', 'p-m'), ad('c-untied', null, 'B0NOWHERE1'),
      ad('c-none', null, 'B0NOWHERE1'), ad('c-none', null, null, 'NOWHERE'),
      ad('c-elsewhere', 'p-s'),
    ], catalog)
    expect(out.get('c-single')).toEqual({ productIds: ['r-solo'], unresolved: [], ambiguous: [], owner: { kind: 'product', productId: 'r-solo' } })
    expect(out.get('c-vars')?.owner).toEqual({ kind: 'product', productId: 'p-parent' })
    expect(out.get('c-shared')?.owner).toEqual({ kind: 'shared', productIds: ['p-parent', 'q-parent'] })
    expect(out.get('c-untied')).toEqual({ productIds: ['p-parent'], unresolved: ['B0NOWHERE1'], ambiguous: [], owner: { kind: 'shared', productIds: ['p-parent'] } })
    expect(out.get('c-none')).toEqual({ productIds: [], unresolved: ['B0NOWHERE1', 'NOWHERE'], ambiguous: [], owner: { kind: 'none' } })
    expect(out.get('c-empty')?.owner).toEqual({ kind: 'none' })
    expect(out.has('c-elsewhere')).toBe(false)
  })
})

describe('resolveCampaignOwnership (batched)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('asks four queries for 60 campaigns, and reads only serving ads of serving ad groups', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `c-${i}`)
    db.campaign.findMany.mockResolvedValue(ids.map((id) => ({ id, name: `Campaign ${id}`, marketplace: 'A1PA6795UKMFR9', adProduct: 'SPONSORED_PRODUCTS', status: 'ENABLED' })))
    db.adProductAd.findMany.mockResolvedValue(ids.flatMap((id, i) => [
      { productId: i % 2 ? 'p-s' : null, asin: i % 2 ? null : 'b0jacketm1', sku: null, adGroup: { campaignId: id } },
      ...(i % 10 === 0 ? [{ productId: 'q-l', asin: null, sku: null, adGroup: { campaignId: id } }] : []),
    ]))
    db.product.findMany
      .mockResolvedValueOnce(products.filter((p) => ['p-s', 'q-l', 'p-m', 'p-m-fba'].includes(p.id)))
      .mockResolvedValueOnce([{ parentId: 'p-parent', amazonAsin: 'B0JACKETM1' }])
    const out = await resolveCampaignOwnership(ids)
    expect(db.campaign.findMany).toHaveBeenCalledTimes(1)
    expect(db.adProductAd.findMany).toHaveBeenCalledTimes(1)
    expect(db.product.findMany).toHaveBeenCalledTimes(2)
    expect(db.adProductAd.findMany.mock.calls[0][0].where).toMatchObject({ status: { not: 'ARCHIVED' }, adGroup: { status: { not: 'ARCHIVED' } } })
    expect(db.product.findMany.mock.calls[0][0].where).toMatchObject({ deletedAt: null })
    expect(out.size).toBe(60)
    expect(out.get('c-1')).toMatchObject({ market: 'DE', owner: { kind: 'product', productId: 'p-parent' } })
    expect(out.get('c-2')).toMatchObject({ owner: { kind: 'product', productId: 'p-parent' } })
    expect(out.get('c-10')).toMatchObject({ owner: { kind: 'shared', productIds: ['p-parent', 'q-parent'] } })
  })

  it('asks nothing for no campaign, and stops after the campaigns when none is in this business', async () => {
    expect((await resolveCampaignOwnership([])).size).toBe(0)
    expect(db.campaign.findMany).not.toHaveBeenCalled()
    db.campaign.findMany.mockResolvedValue([])
    expect((await resolveCampaignOwnership(['c-other'])).size).toBe(0)
    expect(db.adProductAd.findMany).not.toHaveBeenCalled()
  })
})
