/**
 * Reviews Overview — the pure rules behind GET /api/reviews/area/overview and /needs-you: periods and their previous
 * period, chart buckets, weighted averages, deltas, star spread, eBay's % positive, review rate, star impact, the
 * products-to-watch ranking, themes from reviews and Amazon topics, and the Needs-you order. No database.
 */
import { describe, expect, it } from 'vitest'
import {
  averageRating, bucketKey, bucketKeys, buyerShort, channelMarketLabel, delta, parseOverviewPeriod, periodBounds, periodOf,
  positiveShare, quoteOf, rankWatch, ratingIn, ratingKindOf, sparkValues, sparkWindows, starCounts, starImpact,
  trendBucket, trendPoints, weightedAverage,
} from './overviewMath.js'
import { amazonThemes, overviewTrend, reviewThemes, scopeCode, topThemes } from './review-overview.service.js'
import {
  alertItem, closesWords, parseLimit, parseOnly, rankNeedsYou, replyItem, replyItems, requestItems, waitWords,
} from './review-needs-you.service.js'
import { etsyClosingWhere } from './review-visibility.js'

const NOW = new Date('2026-10-26T12:00:00Z')
const DAY = 86_400_000
const ago = (days: number) => new Date(NOW.getTime() - days * DAY)

describe('period', () => {
  it('reads a known period and falls back to 30 days', () => {
    expect(parseOverviewPeriod('7d')).toBe('7d')
    expect(parseOverviewPeriod(' 12M ')).toBe('12m')
    expect(parseOverviewPeriod('week')).toBe('30d')
    expect(parseOverviewPeriod(undefined)).toBe('30d')
  })

  it('compares against a previous period of the same length', () => {
    const b = periodBounds('30d', NOW)
    expect(b.to.toISOString()).toBe(NOW.toISOString())
    expect(b.from!.toISOString()).toBe(ago(30).toISOString())
    expect(b.prevFrom!.toISOString()).toBe(ago(60).toISOString())
    expect(b.prevTo!.toISOString()).toBe(ago(30).toISOString())
    expect(periodOf(ago(1), b)).toBe('now')
    expect(periodOf(ago(45), b)).toBe('prev')
    expect(periodOf(ago(61), b)).toBeNull()
  })

  it('12 months goes back calendar months; All time has no previous period', () => {
    const y = periodBounds('12m', NOW)
    expect(y.from!.toISOString().slice(0, 10)).toBe('2025-10-26')
    expect(y.prevFrom!.toISOString().slice(0, 10)).toBe('2024-10-26')
    const all = periodBounds('all', NOW)
    expect(all.from).toBeNull()
    expect(all.prevFrom).toBeNull()
    expect(periodOf(new Date('2001-01-01'), all)).toBe('now')
  })
})

describe('chart buckets', () => {
  it('days for 7 and 30 days, weeks for 90, months for 12 months', () => {
    expect(trendBucket('7d')).toBe('day')
    expect(trendBucket('30d')).toBe('day')
    expect(trendBucket('90d')).toBe('week')
    expect(trendBucket('12m')).toBe('month')
    expect(bucketKey(new Date('2026-10-29T10:00:00Z'), 'week')).toBe('2026-10-26') // a Thursday → its Monday
    expect(bucketKey(new Date('2026-10-26T00:00:00Z'), 'week')).toBe('2026-10-26')
    expect(bucketKey(new Date('2026-10-29T10:00:00Z'), 'month')).toBe('2026-10')
  })

  it('every day of the period is a point, a day without reviews counts 0 and has no average', () => {
    const keys = bucketKeys(ago(6), NOW, 'day')
    expect(keys).toHaveLength(7)
    const points = trendPoints([{ postedAt: ago(1), rating: 5 }, { postedAt: ago(1), rating: 3 }, { postedAt: ago(1), rating: null }], keys, 'day')
    const yesterday = points.find(p => p.day === ago(1).toISOString().slice(0, 10))!
    expect(yesterday).toEqual({ day: ago(1).toISOString().slice(0, 10), reviews: 3, avg: 4 })
    expect(points.filter(p => p.reviews === 0).every(p => p.avg === null)).toBe(true)
  })

  it('the bars count every review (eBay feedback too); the line is product-review stars only', () => {
    const keys = bucketKeys(ago(6), NOW, 'day')
    const row = (channel: string, rating: number, ingestSource: string) => ({ id: `${channel}${rating}`, channel, marketplace: 'IT', rating, postedAt: ago(1), productId: null, ingestSource, kind: null, sentiment: null })
    const points = overviewTrend([row('EBAY', 5, 'EBAY_API'), row('EBAY', 1, 'EBAY_API'), row('SHOPIFY', 4, 'JUDGEME_API')], keys, 'day')
    expect(points.find(p => p.day === ago(1).toISOString().slice(0, 10))).toEqual({ day: ago(1).toISOString().slice(0, 10), reviews: 3, avg: 4 })
    // eBay feedback only: the bars still show it, with no star line (never "No reviews" beside the feedback).
    const ebayOnly = overviewTrend([row('EBAY', 5, 'EBAY_API')], keys, 'day')
    expect(ebayOnly.reduce((n, p) => n + p.reviews, 0)).toBe(1)
    expect(ebayOnly.every(p => p.avg === null)).toBe(true)
  })
})

describe('averages and changes', () => {
  it('weights each value and skips missing values and zero weights', () => {
    expect(weightedAverage([{ value: 4, weight: 3 }, { value: 2, weight: 1 }])).toBe(3.5)
    expect(weightedAverage([{ value: null, weight: 5 }, { value: 4, weight: 0 }])).toBeNull()
    expect(averageRating([5, 4, null, 3])).toBe(4)
    expect(averageRating([])).toBeNull()
  })

  it('a change needs both periods; it is never invented from nothing', () => {
    expect(delta(4.5, 4.3)).toBe(0.2)
    expect(delta(4.3, 4.4)).toBe(-0.1)
    expect(delta(4.3, null)).toBeNull()
    expect(delta(null, 4)).toBeNull()
  })

  it('star spread is 5 stars first, rounded to whole stars', () => {
    expect(starCounts([5, 5, 4.4, 4.6, 1, null, 0.2])).toEqual([3, 1, 0, 0, 2])
  })

  it('eBay reads as % positive of positive + negative (neutral left out)', () => {
    expect(positiveShare([5, 5, 5, 1, 3])).toBe(75)
    expect(positiveShare([3, 3])).toBeNull()
    expect(ratingKindOf('EBAY')).toBe('positive')
    expect(ratingKindOf('AMAZON')).toBe('stars')
    expect(ratingIn('positive', [5, 1])).toBe(50)
    expect(ratingIn('stars', [5, 4])).toBe(4.5)
  })

  it('star impact is the theme average against the overall average', () => {
    expect(starImpact(3.2, 4.4)).toBe(-1.2)
    expect(starImpact(null, 4.4)).toBeNull()
  })
})

describe('products to watch', () => {
  const row = (key: string, before: number, now: number, kind: 'stars' | 'positive' = 'stars', countNow = 5, countBefore = 5) =>
    ({ key, ratingBefore: before, ratingNow: now, kind, countNow, countBefore })

  it('ranks the biggest drop first and leaves out rises, small drops and thin samples', () => {
    const ranked = rankWatch([
      row('a', 4.4, 4.1),
      row('b', 4.6, 3.9),
      row('c', 4.0, 4.5),
      row('d', 4.8, 3.0, 'stars', 2, 9), // too few now
      row('e', 4.4, 4.2), // −0.2: below the one "rating dropped" rule (0.3 stars, audit C8)
    ])
    expect(ranked.map(r => r.key)).toEqual(['b', 'a'])
    expect(ranked[0].change).toBe(-0.7)
  })

  it('puts % positive drops on the star scale only to rank them; a drop counts from 6 points (= 0.3 stars)', () => {
    // −7 points ≈ −0.35 stars ranks before −0.3 stars; −4 points is not a drop.
    const ranked = rankWatch([row('ebay', 99, 92, 'positive'), row('amazon', 4.5, 4.2), row('small', 99, 95, 'positive')])
    expect(ranked.map(r => r.key)).toEqual(['ebay', 'amazon'])
    expect(ranked[0].change).toBe(-7)
  })

  it('a sparkline with fewer than three readings is too few to trend', () => {
    const windows = sparkWindows(NOW)
    expect(windows).toHaveLength(6)
    const thin = sparkValues('stars', [{ postedAt: ago(1), rating: 4 }, { postedAt: ago(8), rating: 5 }], windows)
    expect(thin.tooFew).toBe(true)
    expect(thin.values.filter(v => v != null)).toEqual([5, 4])
    const full = sparkValues('stars', [1, 8, 15, 22].map(d => ({ postedAt: ago(d), rating: 4 })), windows)
    expect(full.tooFew).toBe(false)
  })
})

describe('words', () => {
  it('names channels with their market, buyers by first name and initial, quotes short', () => {
    expect(channelMarketLabel('EBAY', 'it')).toBe('eBay Italy')
    expect(channelMarketLabel('SHOPIFY', null)).toBe('Shopify')
    expect(buyerShort('First Middle Last')).toBe('First L.')
    expect(buyerShort('  ')).toBeNull()
    expect(quoteOf('a'.repeat(200), 20)).toHaveLength(22)
    expect(scopeCode('ebay')).toBe('EBAY')
    expect(scopeCode('ALL')).toBeNull()
    expect(scopeCode('x; drop')).toBeNull()
  })
})

describe('themes', () => {
  const review = (id: string, label: string, categories: string[], rating: number, phrase = 'runs small', channel = 'SHOPIFY') => ({
    id, channel, marketplace: 'IT', rating, postedAt: ago(Number(id)), productId: 'p', ingestSource: 'SHOPIFY_APP', kind: null,
    sentiment: { label, categories, topPhrases: [phrase] },
  })

  it('counts a theme against the positive (or negative) reviews, with its newest quote and star impact', () => {
    const rows = [
      review('1', 'NEGATIVE', ['FIT_SIZING'], 1, 'too small'),
      review('2', 'NEGATIVE', ['FIT_SIZING', 'OTHER'], 2, 'order a size up'),
      review('3', 'NEGATIVE', ['SHIPPING'], 2),
      review('4', 'POSITIVE', ['COMFORT'], 5),
    ]
    const fix = reviewThemes(rows, 'NEGATIVE')
    const fit = fix.find(t => t.key === 'FIT_SIZING')!
    expect(fit).toMatchObject({ label: 'Fit & sizing', share: 67, mentions: 2, source: 'review', quote: '“too small”', quoteFrom: 'Shopify review · IT' })
    expect(fit.impact).toBe(-1)
    expect(fix.some(t => t.key === 'OTHER')).toBe(false)
  })

  it('eBay feedback is % positive, never stars: its themes carry no star impact (the one rating, audit C3)', () => {
    const rows = [review('1', 'NEGATIVE', ['FIT_SIZING'], 1, 'too small', 'EBAY'), review('4', 'POSITIVE', ['COMFORT'], 5, 'great', 'EBAY')]
    const fit = reviewThemes(rows, 'NEGATIVE').find(t => t.key === 'FIT_SIZING')!
    expect(fit).toMatchObject({ quoteFrom: 'eBay feedback · IT', impact: null })
  })

  it("merges Amazon topics over products; the share is Amazon's own, weighted by mentions", () => {
    const topics = amazonThemes([
      { marketplace: 'DE', positiveTopics: [], negativeTopics: [{ topic: 'Fit', mentionCount: 30, ratingImpact: -0.42, share: 30, snippets: ['Runs small'] }] },
      { marketplace: 'IT', positiveTopics: [], negativeTopics: [{ topic: 'fit', mentionCount: 10, ratingImpact: -0.2, share: 20, snippets: [] }] },
    ], 'NEGATIVE')
    expect(topics).toHaveLength(1)
    // (30 × 30 + 20 × 10) / 40 = 27.5
    expect(topics[0]).toMatchObject({ key: 'amazon:fit', label: 'Fit', mentions: 40, share: 27.5, source: 'amazon_topic', quote: '“Runs small”', quoteFrom: 'Amazon topic · DE', impact: -0.4 })
    // No share from Amazon → none shown.
    expect(amazonThemes([{ marketplace: 'DE', positiveTopics: [{ topic: 'Warm', mentionCount: 5 }], negativeTopics: [] }], 'POSITIVE')[0].share).toBeNull()
  })

  it('keeps the four themes mentioned most', () => {
    const t = (key: string, mentions: number) => ({ key, label: key, share: null, shareOf: 'positive' as const, mentions, source: 'review' as const, quote: null, quoteFrom: null, english: null, impact: null, market: null })
    expect(topThemes([t('a', 1), t('b', 9), t('c', 5), t('d', 7), t('e', 3)]).map(x => x.key)).toEqual(['b', 'd', 'c', 'e'])
  })
})

describe('needs you', () => {
  it('reads only, limit and order: danger first, then newest', () => {
    expect(parseOnly('reply')).toBe('reply')
    expect(parseOnly('everything')).toBeNull()
    expect(parseLimit('5')).toBe(5)
    expect(parseLimit('900')).toBe(50)
    expect(parseLimit('x')).toBe(8)
    const ranked = rankNeedsYou([
      { id: 'w-new', tone: 'warning' as const, at: ago(0).toISOString() },
      { id: 'd-old', tone: 'danger' as const, at: ago(5).toISOString() },
      { id: 'd-new', tone: 'danger' as const, at: ago(1).toISOString() },
    ])
    expect(ranked.map(i => i.id)).toEqual(['d-new', 'd-old', 'w-new'])
  })

  it('a negative eBay feedback asks for a reply, in words', () => {
    const item = replyItem({
      id: 'r1', channel: 'EBAY', marketplace: 'IT', rating: 1, body: 'Stitching came apart after a month.', authorName: 'Test Buyer',
      postedAt: ago(3), product: { name: 'Racing gloves — S', sku: 'G-S' }, sentiment: { label: 'NEGATIVE' },
    }, NOW)
    expect(item).toMatchObject({ kind: 'review', tone: 'danger', label: 'Reply needed', title: 'Negative feedback, no reply for 3 days' })
    expect(item.detail).toBe('Racing gloves — S · eBay Italy · Test B. · “Stitching came apart after a month.”')
    expect(item.action).toEqual({ label: 'Reply', page: 'review', params: { id: 'r1', channel: 'EBAY', market: 'IT' } })
  })

  it('an alert says the theme, how much it rose and the share before and now', () => {
    const item = alertItem({
      id: 's1', marketplace: 'DE', category: 'FIT_SIZING', rate7dNumerator: 9, rate7dDenominator: 50, rate28dNumerator: 14,
      rate28dDenominator: 200, spikeMultiplier: 2.57, detectedAt: ago(0.2), product: { name: 'Touring jacket', sku: null },
    })
    expect(item.title).toBe('Fit & sizing complaints up 2.6×')
    expect(item.detail).toBe('Touring jacket · Germany · 18% of reviews in the last 7 days, was 7%')
  })

  // Lane N4 (2026-10-27): Etsy's one reply, on Etsy.com, within 100 days of the buyer's last edit.
  const etsy = (id: string, editedDaysAgo: number, over: Record<string, unknown> = {}) => ({
    id, channel: 'ETSY', marketplace: null, rating: 3, body: 'Strap feels thin.', authorName: 'Test Buyer', postedAt: ago(editedDaysAgo + 5),
    channelEditedAt: ago(editedDaysAgo), kind: 'PRODUCT', product: { name: 'Test strap', sku: 'T-1' }, sentiment: null, ...over,
  })

  it('an Etsy review whose reply window closes soon says when, from the buyer’s last edit, and leads', () => {
    const item = replyItem(etsy('e1', 96), NOW)
    expect(item).toMatchObject({ kind: 'review', label: 'Reply needed', tone: 'danger', title: 'Etsy reply window closes in 4 days' })
    expect(item.detail).toBe('3-star review · Test strap · Etsy · Test B. · “Strap feels thin.” · reply on Etsy.com by 30 Oct')
    expect(item.dueAt).toBe(new Date(ago(96).getTime() + 100 * DAY).toISOString())
    // Reply opens the review in Nexus (write, copy, mark as responded); it is still the one Reply action.
    expect(item.action).toEqual({ label: 'Reply', page: 'review', params: { id: 'e1', channel: 'ETSY' } })
    // The 100 days count from the last edit, not from the posting: a review posted 200 days ago, edited 92 days ago.
    expect(replyItem(etsy('e2', 92, { postedAt: ago(200) }), NOW).title).toBe('Etsy reply window closes in 8 days')
    // A review never edited counts from when it was posted.
    expect(replyItem(etsy('e3', 0, { postedAt: ago(99.5), channelEditedAt: null }), NOW).title).toBe('Etsy reply window closes within a day')
  })

  it('an Etsy review with time left keeps its own title; the deadline is detail, never a second item', () => {
    const item = replyItem(etsy('e4', 20, { rating: 2 }), NOW)
    expect(item).toMatchObject({ tone: 'danger', title: '2-star review, no reply for 25 days' })
    expect(item.detail.endsWith('reply on Etsy.com · 80 days left')).toBe(true)
    expect(item.dueAt).toBeUndefined()
    expect(replyItem(etsy('e5', 30), NOW)).toMatchObject({ tone: 'warning' })
    // Other channels carry no window.
    expect(replyItem({ ...etsy('x', 96), channel: 'SHOPIFY' }, NOW)).toMatchObject({ title: '3-star review, no reply for 101 days' })
    expect(closesWords(1)).toBe('closes within a day')
    expect(closesWords(10)).toBe('closes in 10 days')
  })

  it('reply items: windows about to close first (soonest first), then negative, then the rest — each once', () => {
    const items = replyItems({
      closing: [etsy('soon-9', 91), etsy('soon-2', 98)],
      urgent: [etsy('soon-2', 98), { ...etsy('neg', 1, { rating: 1 }), channel: 'EBAY', kind: null }],
      other: [etsy('later', 10)],
    }, NOW, 8)
    expect(items.map(i => i.id)).toEqual(['soon-2', 'soon-9', 'neg', 'later'])
    expect(replyItems({ closing: [etsy('soon-9', 91)], urgent: [], other: [etsy('later', 10)] }, NOW, 1).map(i => i.id)).toEqual(['soon-9'])
  })

  it('the mixed list: a window about to close leads its tone, soonest first', () => {
    const ranked = rankNeedsYou([
      { id: 'd-new', tone: 'danger' as const, at: ago(0).toISOString() },
      { id: 'etsy-5', tone: 'danger' as const, at: ago(100).toISOString(), dueAt: ago(-5).toISOString() },
      { id: 'etsy-1', tone: 'danger' as const, at: ago(110).toISOString(), dueAt: ago(-1).toISOString() },
      { id: 'w', tone: 'warning' as const, at: ago(0).toISOString() },
    ])
    expect(ranked.map(i => i.id)).toEqual(['etsy-1', 'etsy-5', 'd-new', 'w'])
  })

  it('the closing Etsy rows: inside the last 10 days of the window, from the last edit, else the posting', () => {
    const cut = new Date(NOW.getTime() - 90 * DAY)
    expect(etsyClosingWhere(NOW)).toEqual({
      AND: [
        { channel: 'ETSY' },
        { OR: [{ channelEditedAt: { lte: cut } }, { AND: [{ channelEditedAt: null }, { postedAt: { lte: cut } }] }] },
      ],
    })
  })

  it('failed and retrying requests are one item each, and none when there are none', () => {
    const items = requestItems([{ channel: 'EBAY', count: 4, latest: ago(1) }, { channel: 'AMAZON', count: 2, latest: ago(2) }], { count: 3, latest: ago(0) }, NOW)
    expect(items.map(i => i.title)).toEqual(['6 review requests failed in the last 7 days', '3 requests waiting to try again'])
    expect(items[0].detail.startsWith('eBay 4 · Amazon 2')).toBe(true)
    expect(requestItems([], { count: 0, latest: null }, NOW)).toEqual([])
    expect(waitWords(ago(0.25), NOW)).toBe('6 h')
  })
})
