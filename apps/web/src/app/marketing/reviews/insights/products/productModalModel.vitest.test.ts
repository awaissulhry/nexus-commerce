import { describe, expect, it } from 'vitest'
import { parseInboxQuery } from '../../inbox/inboxQuery'
import {
  MANAGE_FIX,
  allReviewsHref,
  feedbackWords,
  headerPills,
  languageName,
  marketRows,
  navIds,
  needsImport,
  parseProductTab,
  productSubtitle,
  productTabs,
  productTitle,
  returnsFacts,
  reviewByline,
  studioHref,
  suggestHeld,
  suggestResultWords,
  themeImpact,
  themeInboxHref,
  whenWords,
  type ProductDetail,
} from './productModalModel'

const detail = (over: Partial<ProductDetail> = {}): ProductDetail => ({
  product: { id: 'p-1', name: 'Touring jacket', sku: 'TJ-BLK', variant: null, family: null, isFamily: true, variants: 4 },
  scope: { channel: null, market: null, period: '30d' },
  summary: { rating: 4.04, ratingWords: 'stars from reviews', change: -0.3, reviews: 188, reviewsAllTime: 420, soldOn: ['Amazon Italy', 'eBay Italy'] },
  openAlerts: [{ id: 'a-1', theme: 'Fit & sizing', market: 'DE', status: 'OPEN' }],
  markets: [
    { channel: 'AMAZON', market: 'IT', label: 'Amazon Italy', kind: 'stars', rating: 4.12, count: 40, change: -0.2, words: 'stars from imported reviews' },
    { channel: 'AMAZON', market: 'ES', label: 'Amazon Spain', kind: 'stars', rating: null, count: 0, change: null, words: 'No rating data from Amazon — import reviews' },
    { channel: 'EBAY', market: 'IT', label: 'eBay Italy', kind: 'positive', rating: 96.4, count: 30, change: 1.5, words: 'seller feedback, % positive' },
  ],
  spread: [98, 40, 20, 12, 18],
  themes: [{ key: 'FIT_SIZING', label: 'Fit & sizing', mentions: 40, share: 21, starImpact: -0.84, starImpactFrom: 'reviews', quote: null }],
  fit: {
    family: { id: 'p-1', name: 'Touring jacket' }, sizes: [], variants: [], reviews: 9, returns: 3, unclearReturns: 0, noSize: 0,
    advice: 'Too few fit mentions per size to tell buyers anything yet.', words: 'From 9 reviews …', minimum: 5,
  },
  latest: [],
  returns: { windowDays: 30, rate: { rate: 16, returns: 34, orders: 212 }, family: { rate: 14.2, returns: 40, orders: 280 }, withReview: 11, topReason: { reason: 'Too small', share: 41 }, reasons: [{ reason: 'Too small', count: 14, share: 41 }, { reason: 'Too large', count: 6, share: 18 }] },
  topicsAt: null,
  generatedAt: '2026-10-26T10:00:00Z',
  ...over,
})

describe('the pop-up header and tabs', () => {
  it('names the product, its family, its SKU and where it sells', () => {
    expect(productTitle({ name: 'Touring jacket', variant: 'M · Black' })).toBe('Touring jacket — M · Black')
    expect(productSubtitle(detail())).toBe('4 sizes and colours · SKU TJ-BLK · 188 reviews and feedback in the period · sold on Amazon Italy, eBay Italy')
    expect(productSubtitle(detail({ product: { id: 'v', name: 'Touring jacket', sku: 'TJ-BLK-M', variant: 'M', family: { id: 'p-1', name: 'Touring jacket' }, isFamily: false, variants: 0 } }))).toBe('Touring jacket family · SKU TJ-BLK-M · 188 reviews and feedback in the period · sold on Amazon Italy, eBay Italy')
  })

  it('shows the average, the drop and the open alerts as pills', () => {
    expect(headerPills(detail(), 'last 30 days')).toEqual([
      { text: '4.0 average', tone: 'neutral' },
      { text: 'Down 0.3 in 30 days', tone: 'danger' },
      { text: '1 open alert', tone: 'warning' },
    ])
    expect(headerPills(detail({ summary: { ...detail().summary, rating: null, ratingWords: 'too few to rate', change: null }, openAlerts: [] }), 'last 7 days')).toEqual([{ text: 'too few to rate', tone: 'neutral' }])
  })

  it('counts each tab; Sizes counts the fit mentions placed on a size', () => {
    expect(productTabs(detail()).map((t) => [t.id, t.count ?? t.badge ?? null])).toEqual([['summary', null], ['reviews', 188], ['themes', 1], ['returns', 20], ['sizes', 12]])
    expect(productTabs(detail({ fit: null })).find((t) => t.id === 'sizes')?.count).toBeNull()
    expect(parseProductTab('returns')).toBe('returns')
    expect(parseProductTab('nope')).toBe('summary')
  })
})

describe('rating per channel and market', () => {
  it('says stars, eBay’s % positive, and Amazon with no rating data — never an invented Amazon star', () => {
    const rows = marketRows(detail())
    expect(rows.map((r) => [r.where, r.kind, r.value, r.change])).toEqual([
      ['Amazon Italy', 'stars', '4.1', '−0.2'],
      ['Amazon Spain', 'none', '—', '—'],
      ['eBay Italy', 'positive', '96%', '+1.5 pts'],
    ])
    expect(rows[1].note).toBe('No rating data from Amazon — import reviews')
    expect(needsImport(rows[1])).toBe(true)
    expect(needsImport(rows[0])).toBe(false)
  })
})

describe('themes, reviews and returns', () => {
  it('words a theme’s star impact', () => {
    expect(themeImpact({ starImpact: -0.84, starImpactFrom: 'reviews' })).toEqual({ text: '−0.8 ★', tone: 'danger', words: '0.84 stars below this product’s average' })
    expect(themeImpact({ starImpact: null, starImpactFrom: null }).text).toBe('—')
  })

  it('opens this product’s reviews in the Inbox by its SKU', () => {
    const scope = { channel: 'AMAZON', market: 'DE', period: '90d' as const }
    const href = themeInboxHref(detail(), 'FIT_SIZING', scope)
    expect(href).toBe('/marketing/reviews/inbox?period=90d&channel=AMAZON&market=DE&theme=FIT_SIZING&q=TJ-BLK')
    expect(parseInboxQuery(href.slice(href.indexOf('?'))).query.q).toBe('TJ-BLK')
    expect(allReviewsHref(detail(), { channel: null, market: null, period: '30d' })).toBe('/marketing/reviews/inbox?period=30d&q=TJ-BLK')
  })

  it('says who wrote a review, where, and when', () => {
    expect(reviewByline({ id: 'r', channel: 'AMAZON', market: 'DE', where: 'Amazon Germany', imported: true, kind: 'stars', rating: 2, text: 'x', english: null, language: 'de', buyer: 'Buyer K.', postedAt: '', themes: [] })).toBe('Buyer K. · Amazon Germany · imported from a file')
    expect(languageName('de')).toBe('German')
    expect(languageName('pt')).toBe('PT')
    const now = new Date('2026-10-26T12:00:00Z')
    expect(whenWords('2026-10-26T08:00:00Z', now)).toBe('today')
    expect(whenWords('2026-10-25T08:00:00Z', now)).toBe('yesterday')
    expect(whenWords('2026-10-20T08:00:00Z', now)).toBe('6 days ago')
    expect(whenWords('2026-09-01T08:00:00Z', now)).toBe('1 Sept')
    expect(feedbackWords(1)).toEqual({ text: 'Negative feedback', tone: 'danger' })
  })

  it('states the return numbers with their basis', () => {
    expect(returnsFacts(detail())).toEqual([
      { label: 'Return rate', value: '16%', hint: 'family 14.2% · 34 of 212 orders · last 30 days' },
      { label: 'Returns with a review', value: '11', hint: 'the same order also has a review' },
      { label: 'Top reason', value: 'Too small', hint: '41% of returns' },
    ])
  })
})

describe('Prev / Next and Suggest a fix', () => {
  it('walks each family, then its sizes and colours', () => {
    expect(navIds([{ productId: 'a', variants: [{ productId: 'a1' }, { productId: 'a2' }] }, { productId: 'b', variants: [] }])).toEqual(['a', 'a1', 'a2', 'b'])
  })

  it('holds Suggest a fix without the permission or anything to work from', () => {
    expect(suggestHeld(false, detail())).toBe(MANAGE_FIX)
    expect(suggestHeld(true, null)).toBe('Wait until the product has loaded.')
    expect(suggestHeld(true, detail({ summary: { ...detail().summary, reviews: 0 }, themes: [] }))).toMatch(/No reviews or Amazon topics/)
    expect(suggestHeld(true, detail())).toBeNull()
    expect(suggestResultWords(2)).toBe('2 fixes suggested — opening Fixes. Nothing changes on a channel before a person approves.')
    expect(suggestResultWords(0, 'No complaints about this product in the last 30 days: nothing to fix.')).toBe('No complaints about this product in the last 30 days: nothing to fix.')
    expect(studioHref('p 1')).toBe('/products/p%201/edit/studio')
  })
})
