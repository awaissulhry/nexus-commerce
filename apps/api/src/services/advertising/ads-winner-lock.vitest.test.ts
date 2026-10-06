/**
 * PB-6a — the winners-stay lock (ads-winner-lock.ts), pure: which positive a negative would block in its own ad group
 * (L1), and where a term already lives (L2). Plus the one read: archived positives and archived campaigns are no home.
 * Values are made up (public repo).
 */
import { describe, expect, it, vi } from 'vitest'

const findMany = vi.fn()
vi.mock('../../db.js', () => ({ default: { adTarget: { findMany: (...a: unknown[]) => findMany(...a) } } }))

const { blockedPositive, homeOf, negativeKey, positivesIn, standingNegativesIn } = await import('./ads-winner-lock.js')
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
