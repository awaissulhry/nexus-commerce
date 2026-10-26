/**
 * Negative Targeting page, step 4 — the reach check of a negative, pure and from the market's facts: exact
 * blocks its term, phrase every term holding its words whole and in order, a product its ASIN; a term blocked there
 * already is not counted; the sums are the rows' own; the terms that sold are named (at most 10, most orders first); a
 * total counts each term in each place once and never adds money across currencies; a step names the negative it adds.
 * Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { blockedBy, MAX_SOLD, reachBlocks, reachIn, reachOf, reachTotal, stepNegative, type ReachTerm } from './reach.js'
import type { WasteFacts } from './read.js'

const term = (key: string, n: Partial<ReachTerm> = {}): ReachTerm => ({
  adGroupId: 'g1', key, text: key, impressions: 40, clicks: 4, spendCents: 200, orders: 0, salesCents: 0, blocked: false, ...n,
})

describe('reachBlocks — the rule every read of the page blocks by', () => {
  it('exact: that term only; phrase: its words whole and in order; a product: its ASIN only', () => {
    expect(reachBlocks({ text: 'Made  Up Gloves', match: 'EXACT' }, 'made up gloves')).toBe(true)
    expect(reachBlocks({ text: 'made up gloves', match: 'EXACT' }, 'made up gloves cheap')).toBe(false)
    expect(reachBlocks({ text: 'made up', match: 'PHRASE' }, 'cheap made up gloves')).toBe(true)
    expect(reachBlocks({ text: 'made up', match: 'PHRASE' }, 'up made gloves')).toBe(false)
    expect(reachBlocks({ text: 'made up', match: 'PHRASE' }, 'made upper gloves')).toBe(false)
    expect(reachBlocks({ text: 'B0MADEUP01', match: 'ASIN' }, 'b0madeup01')).toBe(true)
    expect(reachBlocks({ text: 'gloves', match: 'ASIN' }, 'gloves')).toBe(false)
  })
})

describe('blockedBy · reachOf — what one negative would block', () => {
  const terms = [
    term('made up gloves', { spendCents: 400, clicks: 6, orders: 2, salesCents: 5000 }),
    term('made up gloves cheap', { spendCents: 300, clicks: 5 }),
    term('cheap made up gloves', { spendCents: 200, clicks: 3, orders: 1, salesCents: 2500 }),
    term('gloves made up', { spendCents: 900 }),
    // Blocked there already (a standing negative): this one changes nothing for it.
    term('made up gloves blue', { spendCents: 700, blocked: true }),
    // Nothing in the window.
    term('made up gloves red', { impressions: 0, clicks: 0, spendCents: 0 }),
  ]

  it('a phrase: every term holding the words, not one blocked already, not one silent in the window', () => {
    const blocked = blockedBy(terms, { text: 'made up gloves', match: 'PHRASE' })
    expect(blocked.map((t) => t.key)).toEqual(['made up gloves', 'made up gloves cheap', 'cheap made up gloves'])
    expect(reachOf(blocked, 60, 'EUR')).toEqual({
      windowDays: 60, currency: 'EUR', terms: 3, spendCents: 900, clicks: 14, orders: 3, salesCents: 7500,
      sold: [{ text: 'made up gloves', orders: 2 }, { text: 'cheap made up gloves', orders: 1 }],
    })
  })

  it('an exact: that term; nothing sold, nothing named', () => {
    const r = reachOf(blockedBy(terms, { text: 'made up gloves cheap', match: 'EXACT' }), 30, 'EUR')
    expect(r).toMatchObject({ terms: 1, spendCents: 300, orders: 0, sold: [] })
  })

  it('names at most 10 terms that sold, the most orders first', () => {
    const many = Array.from({ length: 14 }, (_, i) => term(`made up ${String(i).padStart(2, '0')}`, { orders: i + 1 }))
    const r = reachOf(blockedBy(many, { text: 'made up', match: 'PHRASE' }), 60, 'EUR')
    expect(r.terms).toBe(14)
    expect(r.sold).toHaveLength(MAX_SOLD)
    expect(r.sold[0]).toEqual({ text: 'made up 13', orders: 14 })
  })
})

describe('reachTotal — several negatives together', () => {
  it('each term in each place once (an exact and a phrase over one term block it once); null with none', () => {
    const shared = term('made up gloves', { spendCents: 400, clicks: 6, orders: 1, salesCents: 2000 })
    const exact = { reach: reachOf([shared], 60, 'EUR'), blocked: [shared] }
    const other = term('made up gloves cheap', { spendCents: 300, clicks: 5 })
    const phrase = { reach: reachOf([shared, other], 60, 'EUR'), blocked: [shared, other] }
    // The same words in another ad group are another term.
    const there = term('made up gloves', { adGroupId: 'g2', spendCents: 100, clicks: 1 })
    const elsewhere = { reach: reachOf([there], 60, 'EUR'), blocked: [there] }
    expect(reachTotal([exact, phrase, null, elsewhere])).toEqual({
      windowDays: 60, currency: 'EUR', terms: 3, spendCents: 800, clicks: 12, orders: 1, salesCents: 2000,
      currencies: [{ currency: 'EUR', spendCents: 800, salesCents: 2000 }],
    })
    expect(reachTotal([null, null])).toBeNull()
  })

  it('never adds money across currencies; a window per market says so (null)', () => {
    const eur = term('made up gloves', { spendCents: 400 })
    const gbp = term('made up gloves', { adGroupId: 'g-uk', spendCents: 300 })
    const total = reachTotal([{ reach: reachOf([eur], 60, 'EUR'), blocked: [eur] }, { reach: reachOf([gbp], 30, 'GBP'), blocked: [gbp] }])
    expect(total).toMatchObject({ windowDays: null, currency: null, spendCents: null, salesCents: null, terms: 2 })
    expect(total!.currencies).toEqual([{ currency: 'EUR', spendCents: 400, salesCents: 0 }, { currency: 'GBP', spendCents: 300, salesCents: 0 }])
  })
})

describe('stepNegative — the negative a preview step adds', () => {
  const place = { campaign: { id: 'c1' }, adGroup: { id: 'g1' } }
  it('exact, phrase, product; in its ad group or the whole campaign; none for other steps', () => {
    expect(stepNegative({ action: 'NEGATE_EXACT', text: 'made up gloves', level: 'AD_GROUP', place })).toEqual({ campaignId: 'c1', adGroupId: 'g1', level: 'AD_GROUP', text: 'made up gloves', match: 'EXACT' })
    expect(stepNegative({ action: 'NEGATE_PHRASE', text: 'made up', level: 'CAMPAIGN', place: { campaign: { id: 'c1' }, adGroup: null } })).toEqual({ campaignId: 'c1', adGroupId: null, level: 'CAMPAIGN', text: 'made up', match: 'PHRASE' })
    expect(stepNegative({ action: 'NEGATE_ASIN', text: 'B0MADEUP01', level: 'AD_GROUP', place })).toMatchObject({ match: 'ASIN', level: 'AD_GROUP' })
    expect(stepNegative({ action: 'PAUSE', text: 'made up', level: null, place })).toBeNull()
    expect(stepNegative({ action: 'NEGATE_EXACT', text: null, level: 'AD_GROUP', place })).toBeNull()
    expect(stepNegative({ action: 'NEGATE_EXACT', text: 'made up', level: null, place: { campaign: null, adGroup: null } })).toBeNull()
  })
})

describe('reachIn — from the market\'s facts, the rows\' own sums over the page\'s window', () => {
  const sums = (spendCents: number, orders = 0) => ({ impressions: 50, clicks: 5, spendCents, orders, salesCents: orders * 3000 })
  const place = (adGroupId: string, key: string, spend60: number, orders60 = 0) => ({
    adGroupId, campaignId: 'c1', key, text: key, matchType: 'BROAD', clicks93: 5, clicksDefault: 5, servedDefault: 55,
    win: { 30: sums(spend60 / 2), 60: sums(spend60, orders60), 90: sums(spend60 * 2, orders60) }, d90: { clicks: 5, orders: orders60, spendCents: spend60 * 2 }, spark: [], vias: new Map(),
  })
  const p1 = place('g1', 'made up gloves', 400, 1)
  const p2 = place('g1', 'made up gloves cheap', 300)
  const p3 = place('g2', 'made up gloves cheap', 500)
  const p4 = place('g2', 'made up gloves blue', 600)
  const neg = { id: 'n1', adGroupId: 'g2', kind: 'KEYWORD', expressionType: 'NEGATIVE_EXACT', expressionValue: 'made up gloves blue', status: 'ENABLED', isNegative: true, negativeLevel: 'AD_GROUP', externalTargetId: 'x', createdAt: new Date(), retiredAt: null }
  const f = {
    now: new Date('2026-10-25T10:00:00Z'), markets: ['IT'], marketNegateBar: new Map([['IT', null]]),
    campaigns: new Map([['c1', { id: 'c1', name: 'Made up', market: 'IT', status: 'ENABLED', portfolioId: null, externalCampaignId: 'X1', dailyBudgetCurrency: 'EUR', live: true }]]),
    adGroups: new Map([['g1', { id: 'g1', name: 'one', campaignId: 'c1', externalAdGroupId: 'XG1', status: 'ENABLED', live: true, productIds: [], firstDay: 1 }], ['g2', { id: 'g2', name: 'two', campaignId: 'c1', externalAdGroupId: 'XG2', status: 'ENABLED', live: true, productIds: [], firstDay: 1 }]]),
    placesByGroup: new Map([['g1', [p1, p2]], ['g2', [p3, p4]]]),
    placesByCampaign: new Map([['c1', [p1, p2, p3, p4]]]),
    negByGroup: new Map([['g2', [neg]]]), negByCampaign: new Map(),
    ownership: new Map(), products: new Map(), portfolioNames: new Map(), currencyOf: new Map([['c1', 'EUR']]),
  } as unknown as WasteFacts

  it('an ad group negative reads its ad group; a campaign negative every ad group of it; a term blocked already is left out', () => {
    expect(reachIn(f, { campaignId: 'c1', adGroupId: 'g1', level: 'AD_GROUP', text: 'made up gloves', match: 'PHRASE' })!.reach)
      .toEqual({ windowDays: 60, currency: 'EUR', terms: 2, spendCents: 700, clicks: 10, orders: 1, salesCents: 3000, sold: [{ text: 'made up gloves', orders: 1 }] })
    expect(reachIn(f, { campaignId: 'c1', adGroupId: null, level: 'CAMPAIGN', text: 'made up gloves', match: 'PHRASE' })!.reach).toMatchObject({ terms: 3, spendCents: 1200 })
  })

  it('a place the page does not read (another campaign, an ad group of another campaign) has no reach', () => {
    expect(reachIn(f, { campaignId: 'c9', adGroupId: 'g1', level: 'AD_GROUP', text: 'made up', match: 'PHRASE' })).toBeNull()
    expect(reachIn(f, { campaignId: 'c1', adGroupId: 'g9', level: 'AD_GROUP', text: 'made up', match: 'PHRASE' })).toBeNull()
  })
})
