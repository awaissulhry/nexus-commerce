import { describe, expect, it } from 'vitest'
import {
  ageWords, behindWords, bucketLabel, changeView, channelViewRows, deltaView, ETSY_SAMPLE_ROW, headerSubtitle, lastWords,
  needsActionHeld, needsActionHref, needsFooter, needsSubtitle, ratingText, sectionData, sectionError, signed, starsLinkWords,
  themeCountWords, themeHref, TOO_FEW_WORDS, trendSummary, visibleSetup, watchView, zeroStarsReason,
  type NeedsYouItem, type OverviewChannelRow, type OverviewTheme, type OverviewTiles, type Section,
} from './overviewModel'

const NOW = Date.parse('2026-10-26T12:00:00Z')
const HOUR = 3_600_000

const row = (over: Partial<OverviewChannelRow>): OverviewChannelRow => ({
  channel: 'AMAZON', market: 'IT', label: 'Amazon Italy', ratingKind: 'stars', rating: 4.2, reviews: 46, change: 0.1, sent: 372, rate: 8.9,
  lastReviewAt: new Date(NOW - 50 * HOUR).toISOString(), state: 'ok', reason: null, since: null, reconnectHref: null,
  what: 'Topics · stars from imported reviews', lastNote: 'file import · topics 20 Oct', ...over,
})

describe('a failed section is an error, never zeros', () => {
  it('keeps the words and gives no data', () => {
    const failed: Section<OverviewTiles> = { ok: false, error: 'The numbers at the top could not be read. Try again in a moment.' }
    expect(sectionError(failed)).toBe('The numbers at the top could not be read. Try again in a moment.')
    expect(sectionData(failed)).toBeNull()
    const read: Section<number[]> = { ok: true, data: [] }
    expect(sectionError(read)).toBeNull()
    expect(sectionData(read)).toEqual([])
    expect(sectionData(null)).toBeNull()
  })
})

describe('changes in words', () => {
  it('a tile says the change against the period before, up is good, no change is neutral (neither green nor red)', () => {
    expect(deltaView(0.1, 'stars', '30d')).toEqual({ value: '+0.1 vs month before', tone: 'positive' })
    expect(deltaView(-0.3, 'stars', '7d')).toEqual({ value: '−0.3 vs week before', tone: 'negative' })
    expect(deltaView(14, 'count', '90d')).toEqual({ value: '+14 vs quarter before', tone: 'positive' })
    expect(deltaView(-1200, 'count', '12m')).toEqual({ value: '−1,200 vs year before', tone: 'negative' })
    expect(deltaView(0.6, 'points', '30d')).toEqual({ value: '+0.6 pts vs month before', tone: 'positive' })
    expect(deltaView(0, 'count', '30d')).toEqual({ value: 'same as the month before', tone: 'neutral' })
    expect(deltaView(0.04, 'stars', '7d')).toEqual({ value: 'same as the week before', tone: 'neutral' })
    expect(deltaView(null, 'stars', '30d')).toBeNull()
    expect(signed(-0.04)).toBe('0.0')
  })

  it('eBay reads as % positive with changes in points; stars with one decimal', () => {
    expect(ratingText('positive', 99.1)).toBe('99.1%')
    expect(ratingText('stars', 4.25)).toBe('4.3')
    expect(ratingText('stars', null)).toBe('—')
    expect(changeView(-0.8, 'positive')).toEqual({ text: '−0.8 pts', tone: 'down' })
    expect(changeView(0.2, 'stars')).toEqual({ text: '+0.2', tone: 'up' })
    expect(changeView(0, 'positive')).toEqual({ text: '0.0', tone: 'flat' })
    expect(changeView(null, 'stars')).toEqual({ text: '—', tone: 'flat' })
  })
})

describe('channel table', () => {
  it('Amazon without imported reviews says so, eBay shows % positive, e-mail requests say so', () => {
    const rows = channelViewRows([
      row({}),
      row({ market: 'ES', label: 'Amazon Spain', rating: null, reviews: 0, change: null, rate: null }),
      row({ channel: 'EBAY', market: 'IT', ratingKind: 'positive', rating: 99.1, sent: 64 }),
    ], NOW)
    expect(rows[0]).toMatchObject({ label: 'Amazon Italy', noAmazonData: false, reviews: '46', sent: '372', sentNote: null, rate: '8.9%', last: '24 Oct' })
    expect(rows[1]).toMatchObject({ noAmazonData: true, reviews: '—', rate: '—' })
    expect(rows[2]).toMatchObject({ ratingKind: 'positive', sentNote: 'by email' })
    expect(rows[0].href).toBe('/marketing/reviews/inbox?channel=AMAZON&market=IT')
  })

  it('Etsy is a labelled placeholder with sample numbers and a dash for requests (Etsy asks buyers itself)', () => {
    const rows = channelViewRows([row({})], NOW)
    const etsy = rows[rows.length - 1]
    expect(etsy).toBe(ETSY_SAMPLE_ROW)
    expect(etsy).toMatchObject({ sample: true, state: 'later', sent: '—', sentNote: 'Etsy asks buyers itself', last: 'Coming later', lastNote: 'sample numbers', href: null })
    expect(channelViewRows([row({})], NOW, false)).toHaveLength(1)
  })

  it('a channel that stopped shows Not updating and why, never a stale date; the card names it', () => {
    const rows = channelViewRows([
      row({ channel: 'EBAY', market: 'DE', label: 'eBay Germany', ratingKind: 'positive', state: 'not_updating', reason: 'Sign-in expired', reconnectHref: '/settings/channels/ebay' }),
    ], NOW, false)
    expect(rows[0]).toMatchObject({ label: 'eBay Germany', last: 'Not updating', lastNote: null, reason: 'Sign-in expired', reconnectHref: '/settings/channels/ebay' })
    expect(behindWords(rows)).toBe('eBay Germany behind')
    expect(behindWords([...rows, { ...rows[0], id: 'x' }])).toBe('2 channels behind')
    expect(behindWords(channelViewRows([row({})], NOW))).toBeNull()
  })

  it('says when the last review came', () => {
    expect(lastWords(new Date(NOW - 3 * HOUR).toISOString(), NOW)).toBe('3 h ago')
    expect(lastWords(new Date(NOW - 0.2 * HOUR).toISOString(), NOW)).toBe('Less than an hour ago')
    expect(lastWords(null, NOW)).toBe('None yet')
  })
})

describe('products to watch', () => {
  const watch = { productId: 'p1', name: 'Touring jacket — M', sku: 'TJ-M', channel: 'EBAY', market: 'IT', where: 'eBay Italy', kind: 'positive' as const, ratingNow: 95, ratingBefore: 99, change: -4, reviews: 22, topTheme: 'Quality', spark: [99, null, 97], tooFew: true }

  it('too few readings say so instead of a line', () => {
    const v = watchView(watch)
    expect(v).toMatchObject({ now: '95.0%', before: 'was 99.0%', change: '−4.0 pts', reviews: '22 feedback in this period', tooFew: true, href: '/marketing/reviews/products/p1' })
    expect(TOO_FEW_WORDS).toBe('Too few to trend')
    expect(watchView({ ...watch, kind: 'stars', ratingNow: 3.9, ratingBefore: 4.4, change: -0.5, tooFew: false }).sparkLabel).toBe('Average rating, 6 weeks')
  })
})

describe('needs you', () => {
  const item = (over: Partial<NeedsYouItem>): NeedsYouItem => ({
    kind: 'review', id: 'r1', label: 'Reply needed', tone: 'danger', title: 'Negative feedback, no reply for 3 days', detail: '', at: new Date(NOW - 72 * HOUR).toISOString(),
    action: { label: 'Reply', page: 'review', params: { id: 'r1', channel: 'EBAY', market: 'IT' } }, ...over,
  })

  it('counts what it shows', () => {
    expect(needsFooter(5, 8, null)).toBe('Showing 5 of 8')
    expect(needsFooter(3, 12, 'reply')).toBe('Showing 3 of 12 reviews that need a reply')
    expect(needsFooter(4, 4, 'alerts')).toBe('Showing all 4')
    expect(needsSubtitle(5, 8, null)).toBe('8 things, most urgent first')
    expect(needsSubtitle(3, 3, 'reply')).toBe('3 shown, most urgent first')
    expect(needsSubtitle(0, 0, null)).toBe('Nothing waits for you')
    // A filter tile on with none of its kind: other kinds may still wait, so it does not say "nothing waits".
    expect(needsSubtitle(0, 0, 'alerts')).toBe('Nothing of this kind waits for you')
    expect(ageWords(item({}).at, NOW)).toBe('3 days')
    expect(ageWords(new Date(NOW - 5 * HOUR).toISOString(), NOW)).toBe('5 h')
  })

  it('each action opens a page that exists today (through the one link module)', () => {
    expect(needsActionHref(item({}).action)).toBe('/marketing/reviews/inbox?channel=EBAY&market=IT')
    expect(needsActionHref({ label: 'See alert', page: 'alerts', params: { market: 'DE' } })).toBe('/marketing/reviews/spikes?market=DE')
    expect(needsActionHref({ label: 'See requests', page: 'requests', params: { status: 'FAILED' } })).toBe('/marketing/reviews/requests')
  })

  it('a reply is held without Manage reviews, with the reason; opening a page is not', () => {
    expect(needsActionHeld(item({}), false)).toBe("You need 'Manage reviews' to reply to reviews.")
    expect(needsActionHeld(item({}), true)).toBeNull()
    expect(needsActionHeld(item({ kind: 'alert' }), false)).toBeNull()
  })
})

describe('themes, stars and the header', () => {
  const theme: OverviewTheme = { key: 'FIT_SIZING', label: 'Fit & sizing', share: 41, shareOf: 'negative', mentions: 88, source: 'review', quote: '“Runs small”', quoteFrom: 'eBay feedback · IT', english: null, impact: -0.6, market: null }

  it('names the share, what it is a share of, and the star impact', () => {
    expect(themeCountWords(theme)).toBe('41% of negative reviews · 88 mentions · −0.6 stars')
    expect(themeCountWords({ ...theme, share: null, mentions: 1, impact: null })).toBe('1 mention')
    expect(themeCountWords({ ...theme, shareOf: 'amazon', source: 'amazon_topic', share: 12, impact: 0.05 })).toBe('12% of Amazon reviews · 88 mentions')
    expect(themeHref(theme, '30d')).toBe('/marketing/reviews/inbox?period=30d&theme=FIT_SIZING')
    expect(themeHref({ ...theme, source: 'amazon_topic', market: 'DE' }, '30d')).toBe('/marketing/reviews/heatmap?channel=AMAZON&market=DE')
  })

  it('a rating bar offers its reviews, or says why it cannot', () => {
    expect(starsLinkWords(1, 6)).toBe('Open 6 one-star reviews in the Inbox')
    expect(starsLinkWords(4, 1)).toBe('Open 1 four-star review in the Inbox')
    expect(zeroStarsReason(3, '30d')).toBe('No three-star reviews in the last 30 days, so there is nothing to open.')
  })

  it('the header counts the period on the channels shown', () => {
    const tiles = { newReviews: 128 } as OverviewTiles
    expect(headerSubtitle('30d', tiles, [row({}), row({ channel: 'EBAY' }), row({ channel: 'SHOPIFY', market: null })])).toBe('128 reviews in the last 30 days on Amazon, eBay and Shopify')
    expect(headerSubtitle('7d', null, null)).toBe('Last 7 days')
  })

  it('the chart in words, and its bucket labels', () => {
    expect(trendSummary([{ day: '2026-10-25', reviews: 3, avg: 4.5 }, { day: '2026-10-26', reviews: 1, avg: null }, { day: '2026-10-24', reviews: 2, avg: 4.2 }], 'day', '7d'))
      .toBe('Reviews per day and average rating, last 7 days: 6 reviews in all; average rating between 4.2 and 4.5, latest 4.2.')
    expect(trendSummary([{ day: '2026-10', reviews: 0, avg: null }], 'month', '12m')).toBe('Reviews per month and average rating, last 12 months: 0 reviews in all; no star ratings.')
    expect(bucketLabel('2026-10-20', 'week')).toBe('20 Oct')
    expect(bucketLabel('2026-10', 'month')).toBe('Oct 2026')
  })

  it('a hidden setup problem stays hidden until it changes', () => {
    const p = { id: 'amazon-topics-role', title: 't', words: 'w', actionLabel: 'Fix in Settings', href: '/settings/channels/amazon', fingerprint: 'amazon-topics-role:IT:2026-10-20' }
    expect(visibleSetup([p], new Set([p.fingerprint]))).toEqual([])
    expect(visibleSetup([{ ...p, fingerprint: 'amazon-topics-role:IT:never' }], new Set([p.fingerprint]))).toHaveLength(1)
  })
})
