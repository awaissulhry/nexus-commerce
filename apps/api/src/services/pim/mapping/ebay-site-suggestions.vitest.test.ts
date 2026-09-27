import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * "Fill other eBay sites" — the suggestions. The database, the workspace's mapping read and eBay are stubbed: no
 * network, no database. The trees below follow production (2026-09-27): 177104 is motorcycle jackets in IT, FR and
 * ES; DE has no 177104 and uses 177117; FR 177117 is motocross.
 */
const { db, listCategoryMappings } = vi.hoisted(() => ({
  db: {
    marketplace: { findMany: vi.fn() },
    category: { findUnique: vi.fn() },
    marketplaceTaxonomy: { findFirst: vi.fn() },
    marketplaceTaxonomyNode: { findMany: vi.fn() },
    productCategory: { findFirst: vi.fn() },
    channelListing: { groupBy: vi.fn() },
  },
  listCategoryMappings: vi.fn(),
}))
vi.mock('../../../db.js', () => ({ default: db }))
vi.mock('../../ebay-category.service.js', () => ({ EbayCategoryService: class {} }))
vi.mock('../../taxonomy/repository.js', () => ({ taxonomyWhere: (channel: string, marketplace: string) => ({ channel, marketplace }) }))
vi.mock('./category-mapping.service.js', async importOriginal => ({ ...(await importOriginal<object>()), listCategoryMappings }))

import { confidentDefault, ebaySiteCoverage, ebaySiteSuggestions, pickSourceSite, rankCandidates, type TreeNode } from './ebay-site-suggestions.service.js'

const leaf = (path: string, assignable = true): TreeNode => ({ path, name: path.split(' › ').pop()!, assignable })

describe('rankCandidates', () => {
  const tree = new Map<string, TreeNode>([
    ['1', leaf('A › One')], ['2', leaf('A › Two')], ['3', leaf('A › Three')], ['4', leaf('A › Four')], ['9', leaf('A', false)],
  ])

  it('merges the reasons of one category into one candidate and ranks by how many reasons named it', () => {
    const ranked = rankCandidates([
      { categoryId: '1', reason: 'same_id' },
      { categoryId: '2', reason: 'ebay_suggestion' },
      { categoryId: '2', reason: 'same_name' },
      { categoryId: '2', reason: 'ebay_suggestion' },
    ], tree)
    expect(ranked).toEqual([
      { categoryId: '2', path: 'A › Two', reasons: ['same_name', 'ebay_suggestion'] },
      { categoryId: '1', path: 'A › One', reasons: ['same_id'] },
    ])
  })

  it('on equal counts, same_id beats ebay_suggestion, which beats same_name; then the order found', () => {
    const ranked = rankCandidates([
      { categoryId: '2', reason: 'same_name' },
      { categoryId: '4', reason: 'ebay_suggestion' },
      { categoryId: '3', reason: 'ebay_suggestion' },
      { categoryId: '1', reason: 'same_id' },
    ], tree)
    expect(ranked.map(c => c.categoryId)).toEqual(['1', '4', '3'])
  })

  it('starts a site with a category only when two sources agree (production 2026-09-27: DE got "E-Gitarren" from the name alone)', () => {
    expect(confidentDefault([{ categoryId: '33034', path: 'Gitarren › E-Gitarren', reasons: ['same_name'] }, { categoryId: '57988', path: 'Herrenmode › Jacken', reasons: ['ebay_suggestion'] }])).toBeNull()
    expect(confidentDefault([{ categoryId: '177104', path: 'Vêtements moto › Blousons', reasons: ['same_id', 'ebay_suggestion'] }])).toBe('177104')
    expect(confidentDefault([{ categoryId: '177104', path: 'Vêtements moto › Blousons', reasons: ['same_id'] }])).toBeNull()
    expect(confidentDefault([])).toBeNull()
  })

  it('ranks the same number above the name match on a tie (production: ES offered men\'s coats before moto jackets)', () => {
    const esTree = new Map<string, TreeNode>([['57988', leaf('Ropa de hombre › Abrigos, chaquetas y chalecos')], ['177104', leaf('Vestimenta motoristas › Chaquetas motoristas')]])
    const ranked = rankCandidates([
      { categoryId: '57988', reason: 'same_name' }, { categoryId: '57988', reason: 'ebay_suggestion' },
      { categoryId: '177104', reason: 'same_id' }, { categoryId: '177104', reason: 'ebay_suggestion' },
    ], esTree)
    expect(ranked.map(c => c.categoryId)).toEqual(['177104', '57988'])
    expect(confidentDefault(ranked)).toBe('177104')
  })

  it('keeps only assignable nodes of the target tree, at most three', () => {
    const ranked = rankCandidates([
      { categoryId: '9', reason: 'same_name' }, { categoryId: '404', reason: 'same_name' },
      { categoryId: '1', reason: 'ebay_suggestion' }, { categoryId: '2', reason: 'ebay_suggestion' },
      { categoryId: '3', reason: 'ebay_suggestion' }, { categoryId: '4', reason: 'ebay_suggestion' },
    ], tree)
    expect(ranked.map(c => c.categoryId)).toEqual(['1', '2', '3'])
  })
})

describe('pickSourceSite', () => {
  it('prefers IT, then the site with the most listings, then alphabetical', () => {
    expect(pickSourceSite(['DE', 'IT'], { DE: 9 })).toBe('IT')
    expect(pickSourceSite(['DE', 'FR'], { FR: 3, DE: 1 })).toBe('FR')
    expect(pickSourceSite(['FR', 'DE'])).toBe('DE')
    expect(pickSourceSite([])).toBeNull()
  })
})

// ── The service ─────────────────────────────────────────────────────────────────────────────────────────────────

const trees: Record<string, Record<string, TreeNode>> = {
  IT: { '177104': leaf('Abbigliamento per moto › Giacche e giubbotti') },
  FR: { '177104': leaf('Vêtements moto › Blousons'), '177117': leaf('Vêtements de cross › Blousons') },
  DE: { '177117': leaf('Motorradjacken'), '177000': leaf('Motorradbekleidung', false) },
  ES: { '177104': leaf('Vestimenta motoristas › Chaquetas motoristas') },
  UK: { '177117': leaf('Motorcycle Jackets') },
}
type Row = { categoryId: string; mapping: { id: string; marketplace: string; channelCategoryId: string; channelCategoryPath: string | null; reviewedAt: string | null } | null; inheritedFrom: object | null }
let mappings: Record<string, Row[]>

beforeEach(() => {
  vi.resetAllMocks()
  db.marketplace.findMany.mockResolvedValue(['DE', 'ES', 'FR', 'IT', 'UK'].map(code => ({ code })))
  db.category.findUnique.mockResolvedValue({ id: 'jackets', name: { en: { name: 'Jackets' } }, slug: 'jackets' })
  db.marketplaceTaxonomy.findFirst.mockImplementation(async ({ where }) => trees[where.marketplace] ? { activeSnapshotId: `snap-${where.marketplace}` } : null)
  db.marketplaceTaxonomyNode.findMany.mockImplementation(async ({ where }) => {
    const nodes = trees[String(where.snapshotId).replace('snap-', '')] ?? {}
    return where.externalId.in.filter((id: string) => nodes[id]).map((id: string) => ({ externalId: id, ...nodes[id] }))
  })
  db.productCategory.findFirst.mockResolvedValue({ product: { name: 'GALE Jacket', ebayTitle: null } })
  db.channelListing.groupBy.mockResolvedValue([])
  const itOnly: Row = { categoryId: 'jackets', mapping: { id: 'm-it', marketplace: 'IT', channelCategoryId: '177104', channelCategoryPath: 'stored path', reviewedAt: '2026-09-27T08:00:00.000Z' }, inheritedFrom: null }
  const none: Row = { categoryId: 'jackets', mapping: null, inheritedFrom: null }
  mappings = { IT: [itOnly], DE: [none], ES: [none], FR: [none], UK: [none] }
  listCategoryMappings.mockImplementation(async ({ marketplace }) => ({ rows: mappings[marketplace] ?? [] }))
})

const ebayWith = (bySite: Record<string, Record<string, string[]>>) => ({
  searchCategories: vi.fn(async (market: string, query: string) => (bySite[market]?.[query] ?? []).map(id => ({ productType: id, displayName: `eBay path ${id}`, bundled: false }))),
})

describe('ebaySiteSuggestions', () => {
  it('uses the IT assignment as the source and offers the same number only where that tree has it as a leaf', async () => {
    const ebay = ebayWith({})
    const result = await ebaySiteSuggestions('jackets', { ebay })
    expect(result.source).toEqual({ market: 'IT', channelCategoryId: '177104', path: 'Abbigliamento per moto › Giacche e giubbotti' })
    const site = (market: string) => result.sites.find(s => s.market === market)!
    // A same number alone is offered, never chosen for the operator.
    expect(site('FR')).toEqual({ market: 'FR', treeReady: true, defaultCategoryId: null, candidates: [{ categoryId: '177104', path: 'Vêtements moto › Blousons', reasons: ['same_id'] }] })
    expect(site('ES').defaultCategoryId).toBeNull()
    // DE has no 177104: no same-number candidate, and no default without another source.
    expect(site('DE')).toEqual({ market: 'DE', treeReady: true, defaultCategoryId: null, candidates: [] })
    expect(result.ebay).toEqual({ available: true, message: null })
  })

  it('asks eBay on each target site for the source leaf name, the category name and the first product title', async () => {
    const ebay = ebayWith({
      DE: { 'Giacche e giubbotti': ['177117'], Jackets: ['177117', '177000'], 'GALE Jacket': ['177117'] },
      FR: { 'Giacche e giubbotti': ['177104'], Jackets: ['177117'] },
    })
    const result = await ebaySiteSuggestions('jackets', { ebay })
    const de = result.sites.find(s => s.market === 'DE')!
    // 177000 is not a leaf in the DE tree, so it is never offered.
    expect(de.candidates).toEqual([{ categoryId: '177117', path: 'Motorradjacken', reasons: ['same_name', 'ebay_suggestion'] }])
    expect(de.defaultCategoryId).toBe('177117')
    const fr = result.sites.find(s => s.market === 'FR')!
    // Same number AND same name beats eBay's suggestion of the motocross leaf.
    expect(fr.candidates.map(c => [c.categoryId, c.reasons])).toEqual([['177104', ['same_id', 'same_name']], ['177117', ['ebay_suggestion']]])
    expect(fr.defaultCategoryId).toBe('177104')
    expect(ebay.searchCategories).toHaveBeenCalledWith('DE', 'Giacche e giubbotti', expect.objectContaining({ throwOnError: true, limit: 1 }))
    expect(ebay.searchCategories).toHaveBeenCalledWith('DE', 'Jackets', expect.objectContaining({ throwOnError: true }))
    expect(ebay.searchCategories).toHaveBeenCalledWith('DE', 'GALE Jacket', expect.objectContaining({ throwOnError: true }))
    expect(ebay.searchCategories).not.toHaveBeenCalledWith('IT', expect.anything(), expect.anything())
  })

  it('still answers when eBay cannot be reached: same-number candidates stay, and it says so', async () => {
    const ebay = { searchCategories: vi.fn().mockRejectedValue(new Error('auth: no eBay token')) }
    const result = await ebaySiteSuggestions('jackets', { ebay })
    expect(result.ebay.available).toBe(false)
    expect(result.ebay.message).toContain('eBay could not be reached')
    expect(result.sites.find(s => s.market === 'FR')!.candidates.map(c => c.categoryId)).toEqual(['177104'])
    expect(result.sites.find(s => s.market === 'FR')!.defaultCategoryId).toBeNull()
    expect(result.sites.find(s => s.market === 'DE')!.candidates).toEqual([])
  })

  it('skips every site that already has a category: its own, or inherited', async () => {
    mappings.DE = [{ categoryId: 'jackets', mapping: { id: 'm-de', marketplace: 'DE', channelCategoryId: '177117', channelCategoryPath: null, reviewedAt: null }, inheritedFrom: null }]
    mappings.UK = [{ categoryId: 'jackets', mapping: null, inheritedFrom: { categoryId: 'clothing' } }]
    const result = await ebaySiteSuggestions('jackets', { ebay: ebayWith({}) })
    expect(result.sites.map(s => s.market)).toEqual(['ES', 'FR'])
    expect(result.assignedSites).toEqual(['DE', 'IT', 'UK'])
    // IT still wins as the source although DE has one too.
    expect(result.source?.market).toBe('IT')
  })

  it('a site whose tree was never downloaded gets no candidates and says so', async () => {
    delete (trees as Record<string, unknown>).ES
    try {
      const result = await ebaySiteSuggestions('jackets', { ebay: ebayWith({}) })
      expect(result.sites.find(s => s.market === 'ES')).toEqual({ market: 'ES', treeReady: false, candidates: [], defaultCategoryId: null })
    } finally {
      trees.ES = { '177104': leaf('Vestimenta motoristas › Chaquetas motoristas') }
    }
  })

  it('refuses an unknown category', async () => {
    db.category.findUnique.mockResolvedValue(null)
    await expect(ebaySiteSuggestions('gone', { ebay: ebayWith({}) })).rejects.toThrow('Category no longer exists.')
    await expect(ebaySiteSuggestions('', { ebay: ebayWith({}) })).rejects.toThrow('Choose a category.')
  })
})

describe('ebaySiteCoverage', () => {
  it('lists a category only while it has its own assignment somewhere and none on another active site', async () => {
    mappings.IT.push({ categoryId: 'rainwear', mapping: { id: 'm-r', marketplace: 'IT', channelCategoryId: '177104', channelCategoryPath: null, reviewedAt: null }, inheritedFrom: null })
    for (const site of ['DE', 'ES', 'FR', 'UK']) mappings[site].push({ categoryId: 'rainwear', mapping: { id: `m-${site}`, marketplace: '*', channelCategoryId: '1', channelCategoryPath: null, reviewedAt: null }, inheritedFrom: null })
    const coverage = await ebaySiteCoverage()
    expect(coverage).toEqual({ sites: ['DE', 'ES', 'FR', 'IT', 'UK'], fillable: { jackets: { assigned: ['IT'], missing: ['DE', 'ES', 'FR', 'UK'] } } })
  })
})
