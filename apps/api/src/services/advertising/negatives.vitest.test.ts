/**
 * NEG.1 — the four decisions that go wrong silently.
 *
 * These are pure functions for one reason: each of them has already been got wrong somewhere in
 * this codebase, and none of the failures announced itself.
 *
 *   · the match type has SIX spellings for THREE concepts, and the column is being rewritten live
 *     (~65 rows/min on 2026-08-12) — a filter on one spelling returns a different row set every
 *     few minutes;
 *   · "blocking now" is an intersection of three conditions that the study reported as one;
 *   · attribution has FOUR values and the tempting collapse to two invents a third fact;
 *   · a campaign id from another market, silently overriding the market picker, is how a shared
 *     link shows the recipient something else.
 */
import { describe, it, expect } from 'vitest'
import {
  normaliseMatchType,
  isBlockingNow,
  attributionOf,
  resolveNegScope,
  normaliseNegTerm,
  type NegScopeGraph,
} from './negatives.service.js'

describe('normaliseMatchType — six spellings, three concepts, read-time only', () => {
  it('collapses every spelling measured on prod', () => {
    // The exact six, from `_neg1-baseline.mts`. Two of them did not exist in the study's snapshot
    // one day earlier, which is the whole argument for doing this at read time.
    expect(normaliseMatchType('EXACT').type).toBe('EXACT')
    expect(normaliseMatchType('_EXACT').type).toBe('EXACT')
    expect(normaliseMatchType('NEGATIVE_EXACT').type).toBe('EXACT')
    expect(normaliseMatchType('PHRASE').type).toBe('PHRASE')
    expect(normaliseMatchType('_PHRASE').type).toBe('PHRASE')
    expect(normaliseMatchType('NEGATIVE_PHRASE').type).toBe('PHRASE')
    expect(normaliseMatchType('PRODUCT_EXACT').type).toBe('ASIN')
  })

  it('keeps the raw spelling so a churning column stays visible', () => {
    // Laundering `_EXACT` into `EXACT` and forgetting it is how a live rewrite of the column went
    // unnoticed between two studies a day apart.
    expect(normaliseMatchType('_EXACT').raw).toBe('_EXACT')
    expect(normaliseMatchType('NEGATIVE_EXACT').raw).toBe('NEGATIVE_EXACT')
  })

  it('a PRODUCT row is an ASIN whatever its expressionType says', () => {
    expect(normaliseMatchType('ASIN', 'PRODUCT').type).toBe('ASIN')
    expect(normaliseMatchType('SOMETHING_ELSE', 'PRODUCT').type).toBe('ASIN')
  })

  it('🔴 an unrecognised spelling is OTHER, never forced into EXACT', () => {
    // A seventh spelling appearing is a fact about the ingest. Bucketing it silently is exactly
    // what let the underscore forms grow from 62 to four figures unremarked.
    expect(normaliseMatchType('BROAD').type).toBe('OTHER')
    expect(normaliseMatchType('BROAD').raw).toBe('BROAD')
    expect(normaliseMatchType('').type).toBe('OTHER')
    expect(normaliseMatchType(null).type).toBe('OTHER')
    expect(normaliseMatchType(undefined).type).toBe('OTHER')
  })

  it('handles case and stray whitespace', () => {
    expect(normaliseMatchType(' exact ').type).toBe('EXACT')
    expect(normaliseMatchType('__phrase').type).toBe('PHRASE')
  })
})

describe('isBlockingNow — an intersection, not a status', () => {
  const row = (o: Partial<{ status: string; externalTargetId: string | null; campaignStatus: string | null }> = {}) =>
    ({ status: 'ENABLED', externalTargetId: 'k1', campaignStatus: 'ENABLED', ...o })

  it('all three conditions, or it is not blocking', () => {
    expect(isBlockingNow(row())).toBe(true)
    expect(isBlockingNow(row({ status: 'ARCHIVED' }))).toBe(false)
    expect(isBlockingNow(row({ campaignStatus: 'PAUSED' }))).toBe(false)
    expect(isBlockingNow(row({ campaignStatus: 'ARCHIVED' }))).toBe(false)
  })

  it('🔴 a negative Amazon never confirmed blocks nothing, whatever our row says', () => {
    // 42 rows say no. All 22 campaign-scope negatives in the account are among them: the write gate
    // denied at `connection` and the local mirror was written anyway (fixed in NEG.0).
    expect(isBlockingNow(row({ externalTargetId: null }))).toBe(false)
  })

  it('a null campaign status is not ENABLED', () => {
    expect(isBlockingNow(row({ campaignStatus: null }))).toBe(false)
  })
})

describe('attributionOf — four values, never blank', () => {
  it('no log row at all is "unattributed" — 1,225 of 2,059', () => {
    expect(attributionOf(null).kind).toBe('unattributed')
    expect(attributionOf(undefined).kind).toBe('unattributed')
  })

  it('🔴 a log row with a null actor is a DIFFERENT fact — 198 rows', () => {
    // "We have no record" and "we have a record with no actor" are different things, and a
    // retirement path has to tell them apart. Collapsing both to "unknown" invents a third.
    expect(attributionOf({ userId: null }).kind).toBe('actor-not-recorded')
    expect(attributionOf({ userId: '' }).kind).toBe('actor-not-recorded')
  })

  it('an engine is named as an engine', () => {
    const a = attributionOf({ userId: 'automation:auto-harvest' })
    expect(a.kind).toBe('engine')
    expect(a.label).toBe('automation:auto-harvest')
  })

  it('a user keeps their identity, without the prefix', () => {
    expect(attributionOf({ userId: 'user:anonymous' })).toMatchObject({ kind: 'user', label: 'anonymous' })
    expect(attributionOf({ userId: 'htest' })).toMatchObject({ kind: 'user', label: 'htest' })
  })
})

describe('resolveNegScope — five grains, most specific wins', () => {
  const graph: NegScopeGraph = {
    campaigns: [
      { id: 'c-it-1', name: 'IT one', marketplace: 'IT', portfolioId: 'p1' },
      { id: 'c-it-2', name: 'IT two', marketplace: 'IT', portfolioId: null },
      { id: 'c-de-1', name: 'DE one', marketplace: 'DE', portfolioId: 'p1' },
    ],
    ads: [
      { productId: 'child-a', campaignId: 'c-it-1' },
      { productId: 'child-b', campaignId: 'c-it-2' },
      { productId: 'child-a', campaignId: 'c-de-1' },
    ],
    products: [
      { id: 'child-a', parentId: 'line-1' },
      { id: 'child-b', parentId: 'line-2' },
      { id: 'line-1', parentId: null },
      { id: 'line-2', parentId: null },
    ],
    adGroups: [
      { id: 'ag-1', name: 'AG one', campaignId: 'c-it-1' },
      { id: 'ag-2', name: 'AG two', campaignId: 'c-it-2' },
      { id: 'ag-de', name: 'AG de', campaignId: 'c-de-1' },
    ],
  }

  it('market binds when nothing narrower is given', () => {
    const r = resolveNegScope(graph, { market: 'IT' })
    expect(r.boundBy).toBe('market')
    expect(r.campaignIds).toEqual(['c-it-1', 'c-it-2'])
    expect(r.adGroupIds).toBeNull()
  })

  it('the ad group is the fifth grain and the most specific', () => {
    // 2,037 of 2,059 negatives are ad-group-scoped. Nothing coarser can address one.
    const r = resolveNegScope(graph, { market: 'IT', campaign: 'c-it-1', portfolio: 'p1', adGroup: 'ag-2' })
    expect(r.boundBy).toBe('adGroup')
    expect(r.adGroupIds).toEqual(['ag-2'])
    expect(r.campaignIds).toEqual(['c-it-2'])
  })

  it('campaign beats portfolio and line', () => {
    const r = resolveNegScope(graph, { market: 'IT', line: 'line-1', portfolio: 'p1', campaign: 'c-it-2' })
    expect(r.boundBy).toBe('campaign')
    expect(r.campaignIds).toEqual(['c-it-2'])
  })

  it('portfolio beats line', () => {
    const r = resolveNegScope(graph, { market: 'IT', line: 'line-2', portfolio: 'p1' })
    expect(r.boundBy).toBe('portfolio')
    expect(r.campaignIds).toEqual(['c-it-1'])
  })

  it('a line resolves through Product.parentId, inside the market only', () => {
    const r = resolveNegScope(graph, { market: 'IT', line: 'line-1' })
    expect(r.boundBy).toBe('line')
    expect(r.campaignIds).toEqual(['c-it-1']) // NOT c-de-1, which also advertises child-a
  })

  it('🔴 a campaign from another market resolves to NOTHING, not to an override', () => {
    // The market picker and the campaign picker cannot disagree and both be honoured. Silently
    // preferring one is how a pasted link renders a different view for whoever opens it.
    const r = resolveNegScope(graph, { market: 'IT', campaign: 'c-de-1' })
    expect(r.boundBy).toBe('campaign')
    expect(r.campaignIds).toEqual([])
  })

  it('🔴 an ad group from another market resolves to nothing too', () => {
    const r = resolveNegScope(graph, { market: 'IT', adGroup: 'ag-de' })
    expect(r.campaignIds).toEqual([])
    expect(r.adGroupIds).toEqual([])
  })

  it('always reports what the portfolio grain cannot reach', () => {
    // 64% of the account's negatives sit in campaigns with no portfolioId. A portfolio view that
    // does not say so looks complete.
    const r = resolveNegScope(graph, { market: 'IT', portfolio: 'p1' })
    expect(r.campaignsInMarket).toBe(2)
    expect(r.campaignsWithoutPortfolio).toBe(1)
  })

  it('an unknown line or portfolio resolves to an empty scope, not to the whole market', () => {
    expect(resolveNegScope(graph, { market: 'IT', portfolio: 'nope' }).campaignIds).toEqual([])
    expect(resolveNegScope(graph, { market: 'IT', line: 'nope' }).campaignIds).toEqual([])
  })
})

describe('normaliseNegTerm — the one grouping key', () => {
  it('is the same function the NEG.0 protection compares with', () => {
    // If this page grouped terms differently from the way the gate protects them, the page would
    // show a term the gate does not recognise, under the same word.
    expect(normaliseNegTerm('Giacca  Moto ')).toBe('giacca moto')
    expect(normaliseNegTerm('AIRMESH pant')).toBe('airmesh pant')
  })
})
