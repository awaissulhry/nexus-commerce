/**
 * PB-6a — the winners-stay lock (ads-winner-lock.ts), pure: which positive a negative would block in its own ad group
 * (L1), and where a term already lives (L2). Plus the one read: archived positives and archived campaigns are no home.
 * Values are made up (public repo).
 */
import { describe, expect, it, vi } from 'vitest'

const findMany = vi.fn()
const groups = { findMany: vi.fn(), findUnique: vi.fn() }
const productAds = vi.fn()
const products = vi.fn()
vi.mock('../../db.js', () => ({
  default: {
    adTarget: { findMany: (...a: unknown[]) => findMany(...a) },
    adGroup: { findMany: (...a: unknown[]) => groups.findMany(...a), findUnique: (...a: unknown[]) => groups.findUnique(...a) },
    adProductAd: { findMany: (...a: unknown[]) => productAds(...a) },
    product: { findMany: (...a: unknown[]) => products(...a) },
  },
}))

const { blockedPositive, familyAdGroups, homeOf, negativeKey, ownKeywordRefusal, positivesIn, productFamilyOf, standingNegativesIn } = await import('./ads-winner-lock.js')
type P = Parameters<typeof blockedPositive>[1][number]

const pos = (text: string, match: P['match'], over: Partial<P> = {}): P => ({ adTargetId: `t-${text}-${match}`, adGroupId: 'ag1', text, match, live: true, ...over })

describe('L1 — a negative never blocks a positive of its own ad group', () => {
  it('an exact negative blocks the positive EXACT keyword with the same text (case and spaces folded), nothing else', () => {
    const positives = [pos('Test Jacket  Blue', 'EXACT'), pos('test jacket', 'PHRASE'), pos('test jacket', 'BROAD')]
    expect(blockedPositive({ text: 'test jacket blue', match: 'EXACT' }, positives)?.match).toBe('EXACT')
    expect(blockedPositive({ text: 'test jacket', match: 'EXACT' }, positives)).toBeNull()
  })

  it('a phrase negative blocks any keyword holding its words next to each other, in order', () => {
    const broad = pos('warm test jacket blue', 'BROAD')
    expect(blockedPositive({ text: 'test jacket', match: 'PHRASE' }, [broad])).toBe(broad)
    expect(blockedPositive({ text: 'jacket test', match: 'PHRASE' }, [broad])).toBeNull() // out of order
    expect(blockedPositive({ text: 'warm jacket', match: 'PHRASE' }, [broad])).toBeNull() // not next to each other
    expect(blockedPositive({ text: 'test jacket', match: 'PHRASE' }, [pos('test jackets', 'EXACT')])).toBeNull() // whole words
    expect(blockedPositive({ text: 'test jacket', match: 'PHRASE' }, [pos('B0TEST0001', 'PRODUCT')])).toBeNull()
  })

  it('the brain\'s funnel only: a phrase of two words or more narrows a broad keyword; one word, or an exact or phrase keyword, is still blocked', () => {
    const broad = pos('warm test jacket blue', 'BROAD')
    const phrase = pos('test jacket blue', 'PHRASE')
    const narrowing = { broadNarrowing: true }
    expect(blockedPositive({ text: 'test jacket', match: 'PHRASE' }, [broad], narrowing)).toBeNull()
    expect(blockedPositive({ text: 'jacket', match: 'PHRASE' }, [broad], narrowing)).toBe(broad)
    expect(blockedPositive({ text: 'test jacket', match: 'PHRASE' }, [broad, phrase], narrowing)).toBe(phrase)
    expect(blockedPositive({ text: 'test jacket blue', match: 'EXACT' }, [pos('test jacket blue', 'EXACT')], narrowing)?.match).toBe('EXACT')
    // Without the option (every other writer, a person included): L1 as before.
    expect(blockedPositive({ text: 'test jacket', match: 'PHRASE' }, [broad])).toBe(broad)
  })

  it('a negative product target blocks the product target of the same ASIN only', () => {
    const asin = pos('B0TEST0001', 'PRODUCT')
    expect(blockedPositive({ text: 'b0test0001', match: 'PRODUCT' }, [asin])).toBe(asin)
    expect(blockedPositive({ text: 'B0TEST0002', match: 'PRODUCT' }, [asin])).toBeNull()
    expect(blockedPositive({ text: 'b0test0001', match: 'EXACT' }, [asin])).toBeNull()
  })
})

describe('L2 — a term\'s home', () => {
  it('is the positive EXACT keyword with its text; a live one is preferred', () => {
    const local = pos('test jacket', 'EXACT', { adGroupId: 'ag-a', live: false })
    const live = pos('Test Jacket', 'EXACT', { adGroupId: 'ag-b' })
    expect(homeOf('test  jacket', [pos('test jacket', 'PHRASE'), local, live])).toBe(live)
    expect(homeOf('test jacket', [local])).toBe(local)
    expect(homeOf('test jacket', [pos('test jacket', 'PHRASE')])).toBeNull()
    expect(homeOf('test jacket', [pos('test jacket', 'PHRASE')], 'PHRASE')?.match).toBe('PHRASE')
  })

  it('an ASIN\'s home is its product target, never a keyword', () => {
    const target = pos('B0TEST0001', 'PRODUCT')
    expect(homeOf('b0test0001', [pos('b0test0001', 'EXACT'), target])).toBe(target)
    expect(homeOf('b0test0001', [pos('b0test0001', 'EXACT')])).toBeNull()
  })
})

describe('the reads', () => {
  it('positives: kept per ad group, live only with an Amazon id; archived rows and campaigns are asked out', async () => {
    findMany.mockResolvedValueOnce([
      { id: 't1', adGroupId: 'ag1', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'test jacket', status: 'ENABLED', externalTargetId: 'x1' },
      { id: 't2', adGroupId: 'ag1', kind: 'KEYWORD', expressionType: 'PHRASE', expressionValue: 'test', status: 'PAUSED', externalTargetId: 'x2' },
      { id: 't3', adGroupId: 'ag2', kind: 'PRODUCT', expressionType: 'ASIN', expressionValue: 'B0TEST0001', status: 'ENABLED', externalTargetId: null },
    ])
    const out = await positivesIn(['ag1', 'ag2', 'ag1'])
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      adGroupId: { in: ['ag1', 'ag2'] }, isNegative: false, status: { not: 'ARCHIVED' }, adGroup: { campaign: { status: { not: 'ARCHIVED' } } },
    })
    expect(out.get('ag1')!.map((p) => [p.match, p.live])).toEqual([['EXACT', true], ['PHRASE', false]])
    expect(out.get('ag2')![0]).toMatchObject({ match: 'PRODUCT', live: false })
    expect(await positivesIn([])).toEqual(new Map())
  })

  it('standing negatives: found by ad group, match type and folded text', async () => {
    findMany.mockResolvedValueOnce([
      { adGroupId: 'ag1', kind: 'KEYWORD', expressionType: 'NEGATIVE_EXACT', expressionValue: 'Test Jacket' },
      { adGroupId: 'ag1', kind: 'PRODUCT', expressionType: 'ASIN', expressionValue: 'b0test0001' },
    ])
    const standing = await standingNegativesIn(['ag1'])
    expect(standing.has(negativeKey('ag1', 'EXACT', 'test jacket'))).toBe(true)
    expect(standing.has(negativeKey('ag1', 'PHRASE', 'test jacket'))).toBe(false)
    expect(standing.has(negativeKey('ag1', 'PRODUCT', 'B0TEST0001'))).toBe(true)
  })
})

describe('the write service\'s refusal (L1 for every writer)', () => {
  const row = (adGroupId: string, text: string, expressionType = 'EXACT') => ({ id: `t-${adGroupId}`, adGroupId, kind: 'KEYWORD', expressionType, expressionValue: text, status: 'ENABLED', externalTargetId: 'x' })
  it('names the keyword it would block and where, and says what to do instead; campaign scope looks in every ad group', async () => {
    findMany.mockResolvedValueOnce([row('ag1', 'test jacket')])
    groups.findUnique.mockResolvedValueOnce({ name: 'Exact group' })
    expect(await ownKeywordRefusal({ scope: 'AD_GROUP', adGroupId: 'ag1', campaignId: 'c1' }, 'Test Jacket', 'EXACT')).toEqual({
      deniedAt: 'own_keyword',
      reason: 'A negative exact "Test Jacket" was not added: it would block your own exact keyword "test jacket" in ad group "Exact group". Remove or lower that keyword instead.',
    })
    groups.findMany.mockResolvedValueOnce([{ id: 'ag1' }, { id: 'ag2' }])
    findMany.mockResolvedValueOnce([row('ag2', 'warm test jacket', 'BROAD')])
    groups.findUnique.mockResolvedValueOnce({ name: 'Broad group' })
    const campaign = await ownKeywordRefusal({ scope: 'CAMPAIGN', adGroupId: 'ag1', campaignId: 'c1' }, 'test jacket', 'PHRASE')
    expect(findMany.mock.calls.at(-1)![0].where.adGroupId).toEqual({ in: ['ag1', 'ag2'] })
    expect(campaign?.reason).toMatch(/broad keyword "warm test jacket" in ad group "Broad group"/)
    findMany.mockResolvedValueOnce([row('ag1', 'test jacket')])
    expect(await ownKeywordRefusal({ scope: 'AD_GROUP', adGroupId: 'ag1', campaignId: 'c1' }, 'test', 'EXACT')).toBeNull()
  })
})

describe('L2 scope — one product, its sibling variants, one market', () => {
  it('the family of the ad groups\' products: each product, its parent and the parent\'s other children, with their ASINs', async () => {
    productAds.mockResolvedValueOnce([{ productId: 'p-kid-1', asin: 'B0TESTKID1' }, { productId: null, asin: 'b0testlone' }])
    products
      .mockResolvedValueOnce([]) // no product holds the lone ASIN
      .mockResolvedValueOnce([{ id: 'p-kid-1', parentId: 'p-parent' }])
      .mockResolvedValueOnce([{ id: 'p-parent', amazonAsin: null }, { id: 'p-kid-1', amazonAsin: 'B0TESTKID1' }, { id: 'p-kid-2', amazonAsin: 'B0TESTKID2' }])
    const family = await productFamilyOf(['ag1'])
    expect(family.productIds.sort()).toEqual(['p-kid-1', 'p-kid-2', 'p-parent'])
    expect(family.asins.sort()).toEqual(['B0TESTKID1', 'B0TESTKID2', 'B0TESTLONE'])
    groups.findMany.mockResolvedValueOnce([{ id: 'ag-it', campaign: { marketplace: 'IT' } }, { id: 'ag-de', campaign: { marketplace: 'DE' } }])
    expect(await familyAdGroups(family, 'IT')).toEqual(['ag-it'])
    expect(groups.findMany.mock.calls.at(-1)![0].where).toMatchObject({ campaign: { status: { not: 'ARCHIVED' } }, productAds: { some: { status: { not: 'ARCHIVED' } } } })
    expect(await familyAdGroups({ productIds: [], asins: [] }, 'IT')).toEqual([])
  })
})

