/**
 * 5a — the one negation policy (review 7.1, 7.9 phrase half, G.10 text limits).
 *
 * The matcher is pure; the wire half reads the protected terms, the campaign behind an Amazon campaign id and the
 * text Nexus holds for a negative id, which are stubbed here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const protectionFindMany = vi.fn(async (_args?: unknown) => [] as unknown[])
const campaignFindFirst = vi.fn(async (_args?: unknown) => null as unknown)
const targetFindFirst = vi.fn(async (_args?: unknown) => null as unknown)
vi.mock('../../db.js', () => ({
  default: {
    adKeywordProtection: { get findMany() { return protectionFindMany } },
    campaign: { get findFirst() { return campaignFindFirst } },
    adTarget: { get findFirst() { return targetFindFirst } },
  },
}))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

const {
  NegativeRefusedError, assertNegativeWriteAllowed, isAsin, loadProtectedTerms, negativeKeywordTextProblem,
  negativeWireRefusal, protectedNegativeRefusal, protectedTermHit, protectedTermRefusal,
} = await import('./ads-negation-policy.js')

const XAVIA = { term: 'xavia', matchType: 'CONTAINS', isPrefix: false, reason: 'brand' }
const XAVIA_GALE = { term: 'xavia gale', matchType: 'CONTAINS', isPrefix: false, reason: null }

beforeEach(() => {
  protectionFindMany.mockReset(); protectionFindMany.mockResolvedValue([])
  campaignFindFirst.mockReset(); campaignFindFirst.mockResolvedValue(null)
  targetFindFirst.mockReset(); targetFindFirst.mockResolvedValue(null)
})

describe('protectedTermHit — one matcher for EXACT / PREFIX / CONTAINS', () => {
  it('EXACT is the whole term, case and spacing aside', () => {
    expect(protectedTermHit('  XAVIA   Gale ', 'NEGATIVE_EXACT', [{ term: 'xavia gale', matchType: 'EXACT' }])).not.toBeNull()
    expect(protectedTermHit('xavia gale giacca', 'NEGATIVE_EXACT', [{ term: 'xavia gale', matchType: 'EXACT' }])).toBeNull()
  })
  it('PREFIX is the start; a null matchType falls back to isPrefix', () => {
    expect(protectedTermHit('xavia gale', null, [{ term: 'xavia', isPrefix: true, matchType: null }])).not.toBeNull()
    expect(protectedTermHit('gale xavia', null, [{ term: 'xavia', isPrefix: true, matchType: null }])).toBeNull()
    expect(protectedTermHit('xavia gale', null, [{ term: 'xavia', isPrefix: false, matchType: null }])).toBeNull()
  })
  it('CONTAINS is anywhere in the text', () => {
    expect(protectedTermHit('giacca moto xavia', 'NEGATIVE_EXACT', [XAVIA])).toMatchObject({ via: 'text', protection: XAVIA })
    expect(protectedTermHit('motorradjacke herren', 'NEGATIVE_EXACT', [XAVIA])).toBeNull()
  })
})

describe('protectedTermHit — a phrase negative is refused when a protected term contains it as a run of words', () => {
  it('🔴 phrase "gale" would block "xavia gale": refused; the same text as EXACT is not', () => {
    expect(protectedTermHit('gale', 'NEGATIVE_PHRASE', [XAVIA_GALE])).toMatchObject({ via: 'phrase', protection: XAVIA_GALE })
    expect(protectedTermHit('gale', 'PHRASE', [XAVIA_GALE])).not.toBeNull()
    expect(protectedTermHit('gale', 'NEGATIVE_EXACT', [XAVIA_GALE])).toBeNull()
  })
  it('whole words only, in order', () => {
    expect(protectedTermHit('gal', 'NEGATIVE_PHRASE', [XAVIA_GALE])).toBeNull()
    expect(protectedTermHit('gale xavia', 'NEGATIVE_PHRASE', [XAVIA_GALE])).toBeNull()
    expect(protectedTermHit('giacca giacca', 'NEGATIVE_PHRASE', [{ term: 'giacca moto giacca', matchType: 'EXACT' }])).toBeNull()
    expect(protectedTermHit('moto  GIACCA', 'NEGATIVE_PHRASE', [{ term: 'giacca moto giacca', matchType: 'EXACT' }])).not.toBeNull()
  })
})

describe('protectedTermRefusal — a plain sentence naming the protected term', () => {
  it('text and phrase', () => {
    expect(protectedTermRefusal('Giacca Xavia', { protection: XAVIA, via: 'text' }))
      .toBe('"giacca xavia" cannot be negated: it matches the protected term "xavia" (brand).')
    expect(protectedTermRefusal('gale', { protection: XAVIA_GALE, via: 'phrase' }))
      .toBe('"gale" cannot be a phrase negative: it would also block searches for the protected term "xavia gale".')
  })
})

describe('negativeKeywordTextProblem — Amazon accepts 80 characters; 10 words exact, 4 words phrase', () => {
  it('within the limits: null', () => {
    expect(negativeKeywordTextProblem('giacca moto donna estiva', 'NEGATIVE_PHRASE')).toBeNull()
    expect(negativeKeywordTextProblem('a b c d e f g h i j', 'NEGATIVE_EXACT')).toBeNull()
    expect(negativeKeywordTextProblem('x'.repeat(80), 'NEGATIVE_EXACT')).toBeNull()
  })
  it('over them: a sentence with the count and the limit', () => {
    expect(negativeKeywordTextProblem('giacca moto donna estiva rete', 'NEGATIVE_PHRASE')).toBe('"giacca moto donna estiva rete" has 5 words; Amazon accepts at most 4 in a negative phrase keyword.')
    expect(negativeKeywordTextProblem('a b c d e f g h i j k', 'NEGATIVE_EXACT')).toMatch(/has 11 words; Amazon accepts at most 10 in a negative exact keyword/)
    expect(negativeKeywordTextProblem('x'.repeat(81), 'NEGATIVE_EXACT')).toMatch(/has 81 characters; Amazon accepts at most 80/)
    expect(negativeKeywordTextProblem('   ', 'NEGATIVE_EXACT')).toBe('A negative keyword needs some text.')
  })
})

describe('isAsin', () => {
  it('B0 + 8 letters or digits, any case', () => {
    expect(isAsin('B07XJ8C8F5')).toBe(true)
    expect(isAsin(' b07xj8c8f5 ')).toBe(true)
    expect(isAsin('giacca moto')).toBe(false)
    expect(isAsin('B07XJ8C8F')).toBe(false)
  })
})

describe('loadProtectedTerms — a scope the caller does not know binds every row', () => {
  const whereOf = () => (protectionFindMany.mock.calls[0]![0] as { where: unknown }).where
  it('market and campaign known: global rows or that market, global rows or that campaign', async () => {
    await loadProtectedTerms({ marketplace: 'IT', campaignId: 'c-1' })
    expect(whereOf()).toEqual({
      mode: 'WHITELIST',
      AND: [{ OR: [{ marketplace: null }, { marketplace: 'IT' }] }, { OR: [{ campaignId: null }, { campaignId: 'c-1' }] }],
    })
  })
  it('neither known: every WHITELIST row', async () => {
    await loadProtectedTerms({ marketplace: null, campaignId: null })
    expect(whereOf()).toEqual({ mode: 'WHITELIST' })
  })
  it('protectedNegativeRefusal answers from the rows it loads', async () => {
    protectionFindMany.mockResolvedValue([XAVIA])
    expect(await protectedNegativeRefusal({ text: 'giubbotto xavia', matchType: 'NEGATIVE_EXACT', marketplace: 'IT' }))
      .toEqual({ reason: '"giubbotto xavia" cannot be negated: it matches the protected term "xavia" (brand).', protectedTerm: 'xavia' })
    expect(await protectedNegativeRefusal({ text: 'giubbotto', matchType: 'NEGATIVE_EXACT', marketplace: 'IT' })).toBeNull()
  })
})

describe('negativeWireRefusal — what liveCall refuses to send', () => {
  const kw = (keywordText: string, matchType = 'NEGATIVE_EXACT') => ({ campaignId: 'EXT-1', adGroupId: 'EXT-G', keywordText, matchType, state: 'ENABLED' })

  it('POST /sp/negativeKeywords and /sp/campaignNegativeKeywords: a protected term is refused, scoped by the campaign Nexus holds', async () => {
    protectionFindMany.mockResolvedValue([XAVIA])
    campaignFindFirst.mockResolvedValue({ id: 'c-1', marketplace: 'IT' })
    expect(await negativeWireRefusal({ method: 'POST', path: '/sp/negativeKeywords', body: { negativeKeywords: [kw('giacca xavia')] } }))
      .toMatch(/protected term "xavia"/)
    expect(await negativeWireRefusal({ method: 'POST', path: '/sp/campaignNegativeKeywords', body: { campaignNegativeKeywords: [kw('xavia', 'NEGATIVE_PHRASE')] } }))
      .toMatch(/protected term "xavia"/)
    expect(campaignFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { externalCampaignId: 'EXT-1' } }))
    const where = (protectionFindMany.mock.calls[0]![0] as { where: { AND: unknown } }).where
    expect(where.AND).toEqual([{ OR: [{ marketplace: null }, { marketplace: 'IT' }] }, { OR: [{ campaignId: null }, { campaignId: 'c-1' }] }])
  })

  it('POST: a phrase that a protected term contains is refused; an unprotected term passes', async () => {
    protectionFindMany.mockResolvedValue([XAVIA_GALE])
    expect(await negativeWireRefusal({ method: 'POST', path: '/sp/negativeKeywords', body: { negativeKeywords: [kw('gale', 'NEGATIVE_PHRASE')] } }))
      .toMatch(/^"gale" cannot be a phrase negative/)
    expect(await negativeWireRefusal({ method: 'POST', path: '/sp/negativeKeywords', body: { negativeKeywords: [kw('gale', 'NEGATIVE_EXACT')] } })).toBeNull()
  })

  it('POST: Amazon text limits refuse before anything is sent', async () => {
    expect(await negativeWireRefusal({ method: 'POST', path: '/sp/negativeKeywords', body: { negativeKeywords: [kw('a b c d e', 'NEGATIVE_PHRASE')] } }))
      .toMatch(/at most 4 in a negative phrase keyword/)
  })

  it('POST /sp/negativeTargets: the clause value is checked against the protected terms', async () => {
    protectionFindMany.mockResolvedValue([{ term: 'B07XJ8C8F5', matchType: 'EXACT', reason: 'own product' }])
    const body = (asin: string) => ({ negativeTargetingClauses: [{ campaignId: 'EXT-1', adGroupId: 'EXT-G', expression: [{ type: 'asinSameAs', value: asin }], state: 'ENABLED' }] })
    expect(await negativeWireRefusal({ method: 'POST', path: '/sp/negativeTargets', body: body('B07XJ8C8F5') })).toMatch(/protected term "b07xj8c8f5" \(own product\)/)
    expect(await negativeWireRefusal({ method: 'POST', path: '/sp/negativeTargets', body: body('B000000001') })).toBeNull()
  })

  it('PUT state ENABLED: judged on the text Nexus holds for that id; an id Nexus does not hold is refused', async () => {
    protectionFindMany.mockResolvedValue([XAVIA])
    targetFindFirst.mockResolvedValue({ expressionValue: 'xavia giacca', expressionType: 'NEGATIVE_EXACT', adGroup: { campaign: { id: 'c-1', marketplace: 'IT' } } })
    const enable = { negativeKeywords: [{ keywordId: 'neg-1', state: 'ENABLED' }] }
    expect(await negativeWireRefusal({ method: 'PUT', path: '/sp/negativeKeywords', body: enable })).toMatch(/^Not re-enabled: "xavia giacca" cannot be negated/)
    expect(targetFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { externalTargetId: 'neg-1', isNegative: true } }))

    targetFindFirst.mockResolvedValue(null)
    expect(await negativeWireRefusal({ method: 'PUT', path: '/sp/negativeKeywords', body: enable })).toMatch(/^Negative neg-1 was not re-enabled: Nexus holds no copy of it/)

    targetFindFirst.mockResolvedValue({ expressionValue: 'giacca pelle', expressionType: 'NEGATIVE_EXACT', adGroup: { campaign: { id: 'c-1', marketplace: 'IT' } } })
    expect(await negativeWireRefusal({ method: 'PUT', path: '/sp/negativeKeywords', body: enable })).toBeNull()
  })

  it('a pause, an archive (/delete), a list, a positive keyword and any other call are not judged and read nothing', async () => {
    protectionFindMany.mockResolvedValue([XAVIA])
    expect(await negativeWireRefusal({ method: 'PUT', path: '/sp/negativeKeywords', body: { negativeKeywords: [{ keywordId: 'neg-1', state: 'PAUSED' }] } })).toBeNull()
    expect(await negativeWireRefusal({ method: 'POST', path: '/sp/negativeKeywords/delete', body: { negativeKeywordIdFilter: { include: ['neg-1'] } } })).toBeNull()
    expect(await negativeWireRefusal({ method: 'POST', path: '/sp/negativeKeywords/list', body: {} })).toBeNull()
    expect(await negativeWireRefusal({ method: 'POST', path: '/sp/keywords', body: { keywords: [{ keywordText: 'xavia', matchType: 'EXACT' }] } })).toBeNull()
    expect(protectionFindMany).not.toHaveBeenCalled()
    expect(targetFindFirst).not.toHaveBeenCalled()
  })

  it('assertNegativeWriteAllowed throws NegativeRefusedError with the sentence', async () => {
    protectionFindMany.mockResolvedValue([XAVIA])
    const err = await assertNegativeWriteAllowed({ method: 'POST', path: '/sp/negativeKeywords', body: { negativeKeywords: [kw('xavia')] } }).catch((e) => e)
    expect(err).toBeInstanceOf(NegativeRefusedError)
    expect(err.message).toBe('"xavia" cannot be negated: it matches the protected term "xavia" (brand).')
  })
})
