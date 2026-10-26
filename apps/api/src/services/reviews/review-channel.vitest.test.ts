/**
 * Reviews › channel pages (Amazon, eBay) — the pure rules behind GET /api/reviews/area/channel: the address (channel,
 * market, period), where Amazon gives topics, requests by Amazon's answer, products to watch from imported stars only,
 * eBay feedback by type, which eBay accounts serve a page, eBay's summary in words, the market order, and the hourly
 * limit on eBay's summary read. No database, no network.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  amazonBucket, amazonRequestCounts, feedbackTypeCounts, mondayOf, orderMarkets, pageAccounts, parseChannel, parseChannelPeriod,
  parseMarket, rankAmazonWatch, topicsState, topicsWords,
} from './review-channel-math.js'
import { summaryFrom } from './review-channel.service.js'
import { readEbayFeedbackSummary, SUMMARY_TTL_MS } from './ebay-feedback-summary.service.js'

const NOW = new Date('2026-10-26T12:00:00Z')
const DAY = 86_400_000
const ago = (days: number) => new Date(NOW.getTime() - days * DAY)

describe('the address', () => {
  it('a page is Amazon or eBay; Shopify and Etsy pages come later', () => {
    expect(parseChannel('amazon')).toBe('AMAZON')
    expect(parseChannel(' EBAY ')).toBe('EBAY')
    expect(parseChannel('SHOPIFY')).toBeNull()
    expect(parseChannel(undefined)).toBeNull()
  })

  it('a market is two letters, upper case, and GB is the UK', () => {
    expect(parseMarket('it')).toBe('IT')
    expect(parseMarket('gb')).toBe('UK')
    expect(parseMarket('ita')).toBeNull()
    expect(parseMarket('1t')).toBeNull()
    expect(parseMarket(null)).toBeNull()
  })

  it('the period is 7 days, 30 days, 90 days or 12 months; anything else (All time too) is 30 days', () => {
    expect(parseChannelPeriod('7d')).toBe('7d')
    expect(parseChannelPeriod('12m')).toBe('12m')
    expect(parseChannelPeriod('all')).toBe('30d')
    expect(parseChannelPeriod('5y')).toBe('30d')
  })

  it('imported Amazon reviews are few: weekly for 30 and 90 days, daily for a week, monthly for a year', () => {
    expect(amazonBucket('7d')).toBe('day')
    expect(amazonBucket('30d')).toBe('week')
    expect(amazonBucket('90d')).toBe('week')
    expect(amazonBucket('12m')).toBe('month')
  })
})

describe('Amazon topics', () => {
  const ok = (days: number) => ({ accessStatus: 'OK', fetchedAt: ago(days) })
  const denied = (days: number) => ({ accessStatus: 'NEEDS_BRAND_ANALYTICS_ROLE', fetchedAt: ago(days) })

  it('only the UK, Germany, France, Italy and Spain: never Amazon.nl, whatever rows exist', () => {
    expect(topicsState('NL', [ok(1)]).state).toBe('not_on_market')
    expect(topicsState('US', [ok(1)]).state).toBe('not_on_market')
    expect(topicsWords('not_on_market', 'NL', null)).toBe('Amazon gives no review topics on Amazon.nl.')
    expect(topicsWords('not_on_market', 'SE', null)).toMatch(/UK, Germany, France, Italy and Spain only/)
  })

  it('the newest read refused for the missing role: says so, and keeps the week of the last read that worked', () => {
    const s = topicsState('IT', [ok(10), denied(2)])
    expect(s.state).toBe('role_missing')
    expect(s.lastOkAt).toEqual(ago(10))
    expect(topicsWords('role_missing', 'IT', s.lastOkAt)).toMatch(/Selling Partner Insights role.*last read that worked/)
    expect(topicsWords('role_missing', 'IT', null)).toMatch(/No topics show until the account owner adds the role/)
  })

  it('read: the week of the newest read (its Monday); nothing read yet says how topics arrive', () => {
    const s = topicsState('IT', [ok(3), denied(9)])
    expect(s.state).toBe('ok')
    expect(s.weekOf?.toISOString().slice(0, 10)).toBe('2026-10-19')
    expect(topicsWords('ok', 'IT', s.lastOkAt)).toBeNull()
    expect(topicsState(null, []).state).toBe('none')
    expect(topicsWords('none', null, null)).toMatch(/weekly, per product/)
    expect(mondayOf(new Date('2026-10-26T23:00:00Z')).toISOString().slice(0, 10)).toBe('2026-10-26')
  })

  it('no words name a setting or a code', () => {
    for (const state of ['ok', 'role_missing', 'not_on_market', 'none'] as const) {
      expect(topicsWords(state, 'IT', ago(3)) ?? '').not.toMatch(/NEXUS_|NEEDS_BRAND|[A-Z]{3,}_[A-Z]{3,}/)
    }
  })
})

describe('Amazon requests by Amazon’s answer', () => {
  it('each reason lands in one bucket; reasons of our own rules are "skipped"', () => {
    expect(amazonRequestCounts([
      'sent_amazon', 'sent_amazon', 'amazon_too_early', 'already_asked', 'amazon_refused', 'window_closed', 'amazon_no_answer',
      'first_try_waits', 'due_now', 'refunded', 'unhappy_check', 'skipped_by_hand',
    ])).toEqual({ sent: 2, tooEarly: 1, alreadyAsked: 1, notAllowed: 2, failed: 1, skipped: 3, waiting: 2 })
    expect(amazonRequestCounts([])).toEqual({ sent: 0, tooEarly: 0, alreadyAsked: 0, notAllowed: 0, failed: 0, skipped: 0, waiting: 0 })
  })
})

describe('Amazon products to watch (imported stars only)', () => {
  it('the biggest drop first; a change needs three imported ratings on each side; topics without imports come last', () => {
    const ranked = rankAmazonWatch([
      { productId: 'steady', now: [5, 5, 4], before: [5, 4, 5], hasTopics: true },
      { productId: 'drop', now: [3, 4, 4], before: [5, 5, 4], hasTopics: false },
      { productId: 'few', now: [2], before: [5, 5, 5], hasTopics: false },
      { productId: 'topics-only', now: [], before: [], hasTopics: true },
      { productId: 'nothing', now: [], before: [4, 4, 4], hasTopics: false },
    ])
    expect(ranked.map(r => r.productId)).toEqual(['drop', 'steady', 'few', 'topics-only'])
    expect(ranked[0]).toEqual({ productId: 'drop', ratingNow: 3.7, ratingBefore: 4.7, change: -1, imported: 3 })
    expect(ranked.find(r => r.productId === 'few')?.change).toBeNull()
    expect(ranked.find(r => r.productId === 'topics-only')).toEqual({ productId: 'topics-only', ratingNow: null, ratingBefore: null, change: null, imported: 0 })
  })

  it('keeps at most the limit', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ productId: `p${i}`, now: [4], before: [], hasTopics: false }))
    expect(rankAmazonWatch(rows, 8)).toHaveLength(8)
  })
})

describe('eBay', () => {
  it('stored feedback by type: 5 positive, 3 neutral, 1 negative; no rating is left out', () => {
    expect(feedbackTypeCounts([5, 5, 3, 1, null, 4, 2])).toEqual({ positive: 3, neutral: 1, negative: 2 })
  })

  it("a market page reads its own account, else the account that sells on every site (the whole account's numbers)", () => {
    const wide = { id: 'wide', market: null, isPrimary: true }
    const de = { id: 'de', market: 'DE', isPrimary: false }
    expect(pageAccounts([wide, de], 'DE')).toEqual({ accounts: [de], accountWide: false })
    expect(pageAccounts([wide, de], 'IT')).toEqual({ accounts: [wide], accountWide: true })
    expect(pageAccounts([wide, de], null)).toEqual({ accounts: [wide, de], accountWide: false })
    expect(pageAccounts([de], 'IT')).toEqual({ accounts: [], accountWide: false })
  })

  const summary = (score: number) => ({
    score,
    periods: [{ days: 365, positive: 10, neutral: 1, negative: 0 }],
    dsr: [],
    dsrPeriod: 'FiftyTwoWeeks' as const,
  })

  it("eBay's summary: read, partly read (named, with eBay's words), not read, nothing connected", () => {
    const read = summaryFrom([{ market: 'IT', read: { ok: true, summary: summary(100), readAt: '2026-10-26T11:00:00.000Z' } }], false)
    expect(read).toMatchObject({ state: 'read', words: null, score: 100, accounts: 1, readAt: '2026-10-26T11:00:00.000Z' })

    const partial = summaryFrom([
      { market: 'IT', read: { ok: true, summary: summary(100), readAt: '2026-10-26T11:00:00.000Z' } },
      { market: 'DE', read: { ok: false, words: 'eBay refused the read: Auth token is hard expired.', readAt: '2026-10-26T11:30:00.000Z' } },
    ], false)
    expect(partial.state).toBe('partial')
    expect(partial.score).toBe(100)
    expect(partial.words).toBe('One eBay account could not be read, so these numbers leave it out. eBay refused the read: Auth token is hard expired.')

    const none = summaryFrom([{ market: null, read: { ok: false, words: 'Nexus does not read eBay in this setup yet.', readAt: null } }], true)
    expect(none).toMatchObject({ state: 'not_read', words: 'Nexus does not read eBay in this setup yet.', score: null, accountWide: true })

    const nothing = summaryFrom([], false)
    expect(nothing.state).toBe('no_account')
    expect(nothing.words).toMatch(/Connect eBay in Settings › Channels/)
    for (const s of [read, partial, none, nothing]) expect(s.words ?? '').not.toMatch(/NEXUS_|[A-Z]{3,}_[A-Z]{3,}/)
  })

  it("eBay's summary is asked at most once an hour per account; two pages at once share one call", async () => {
    let clock = NOW.getTime()
    const cache = new Map()
    const inflight = new Map()
    const fetch = vi.fn(async () => ({ ok: true as const, summary: summary(5) }))
    const deps = { now: () => new Date(clock), cache, inflight, fetch }
    const [a, b] = await Promise.all([readEbayFeedbackSummary('acc-1', deps), readEbayFeedbackSummary('acc-1', deps)])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
    clock += SUMMARY_TTL_MS - 1000
    await readEbayFeedbackSummary('acc-1', deps)
    expect(fetch).toHaveBeenCalledTimes(1)
    await readEbayFeedbackSummary('acc-2', deps)
    expect(fetch).toHaveBeenCalledTimes(2)
    clock += 2000
    await readEbayFeedbackSummary('acc-1', deps)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it("a refusal from eBay is kept for the hour too; a read that never reached eBay is not (reconnecting shows at once)", async () => {
    const cache = new Map()
    const deps = { now: () => NOW, cache, inflight: new Map() }
    const refused = vi.fn(async () => ({ ok: false as const, called: true, words: 'eBay did not answer (it said 503).' }))
    await readEbayFeedbackSummary('acc-1', { ...deps, fetch: refused })
    await readEbayFeedbackSummary('acc-1', { ...deps, fetch: refused })
    expect(refused).toHaveBeenCalledTimes(1)
    const off = vi.fn(async () => ({ ok: false as const, called: false, words: 'Nexus does not read eBay in this setup yet.' }))
    const first = await readEbayFeedbackSummary('acc-2', { ...deps, fetch: off })
    await readEbayFeedbackSummary('acc-2', { ...deps, fetch: off })
    expect(off).toHaveBeenCalledTimes(2)
    expect(first).toEqual({ ok: false, words: 'Nexus does not read eBay in this setup yet.', readAt: null })
  })
})

describe('markets', () => {
  it('Italy, Germany, France, Spain, the UK … then the rest A–Z; GB is the UK; codes that are not markets drop out', () => {
    expect(orderMarkets(['US', 'de', 'GB', 'IT', 'DEFAULT', null, 'GLOBAL', 'AE', 'IT', 'fr'])).toEqual(['IT', 'DE', 'FR', 'UK', 'US', 'AE'])
  })
})
