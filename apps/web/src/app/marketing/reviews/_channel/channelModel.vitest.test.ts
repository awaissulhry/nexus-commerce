import { describe, expect, it } from 'vitest'
import type { InboxRow } from '../inbox/inboxDatasource'
import {
  ALL_PRODUCTS, NO_RATING_WORDS, amazonSubtitle, amazonTiles, dsrRows, ebaySubtitle, ebayTiles, feedbackManagerHref, feedbackTypeOf,
  filterFeedback, lockedLinks, marketTabs, parseChannelPeriod, periodDaysWords, periodOptions, periodSearch, replyHeld, replyNote,
  requestRows, sectionData, sectionError, sellerCentralHref, sellerHubHref, summaryNote, topicColumns, topicProductOptions, topicView,
  typeChartRows, typeChartWords, typeOptions, watchView, type AmazonTiles, type AmazonTopics, type EbayReadState, type EbaySummary,
  type EbayTiles,
} from './channelModel'

// 2026-10-26 — Reviews › channel pages (PR F, build spec §3.5; rulings 3, 5, 6).
const IT = { channel: 'AMAZON' as const, marketplace: 'IT' }
const EBAY_ALL = { channel: 'EBAY' as const, marketplace: '' }
const EBAY_DE = { channel: 'EBAY' as const, marketplace: 'DE' }
const NOW = new Date('2026-10-26T12:00:00Z')

const row = (over: Partial<InboxRow> = {}): InboxRow => ({
  id: 'r1', postedAt: '2026-10-24T09:00:00Z', channel: 'EBAY', market: 'IT', kind: 'seller', rating: 5, snippet: 'Ottimo venditore',
  english: 'Great seller', language: 'it', buyer: 'buyer-one', product: { id: 'p1', name: 'Touring jacket', sku: 'TJ-M', variant: 'M' },
  order: { id: 'o1', label: '12-34567-89013' }, mood: null, themes: [], status: 'NEW', assignee: null, dueAt: null, overdue: false,
  imported: false, responses: { sent: 0, draft: 0 }, ...over,
})

describe('the period in the address', () => {
  it('each page offers its own periods; the default leaves the address', () => {
    expect(periodOptions('AMAZON').map((o) => o.label)).toEqual(['7 days', '30 days', '90 days'])
    expect(periodOptions('EBAY').map((o) => o.label)).toEqual(['30 days', '90 days', '12 months'])
    expect(parseChannelPeriod('AMAZON', '?period=7d')).toBe('7d')
    expect(parseChannelPeriod('AMAZON', '?period=12m')).toBe('30d')
    expect(parseChannelPeriod('EBAY', '')).toBe('12m')
    expect(parseChannelPeriod('EBAY', 'period=90d')).toBe('90d')
    expect(periodSearch('EBAY', '12m')).toBe('')
    expect(periodSearch('AMAZON', '90d')).toBe('?period=90d')
  })
})

describe('sections', () => {
  it('a failed section is its error, never zeros', () => {
    expect(sectionData({ ok: false, error: 'The topics could not be read.' })).toBeNull()
    expect(sectionError({ ok: false, error: 'The topics could not be read.' })).toBe('The topics could not be read.')
    expect(sectionData({ ok: true, data: 3 })).toBe(3)
    expect(sectionError(null)).toBeNull()
  })
})

describe('links carry the lock', () => {
  it('the Inbox, Requests and Insights open filtered to the channel and market', () => {
    const links = lockedLinks(IT, '30d')
    expect(links.inbox({ status: 'NEW,IN_PROGRESS' })).toBe('/marketing/reviews/inbox?period=30d&status=NEW%2CIN_PROGRESS&channel=AMAZON&market=IT')
    expect(links.requests({ status: 'SENT' })).toBe('/marketing/reviews/requests?status=SENT&channel=AMAZON&market=IT')
    expect(links.insights('themes')).toBe('/marketing/reviews/insights/themes?channel=AMAZON&market=IT')
    expect(lockedLinks(EBAY_ALL, '12m').inbox({ kind: 'seller' })).toBe('/marketing/reviews/inbox?kind=seller&period=12m&channel=EBAY')
  })

  it("the channel's own sites: Seller Central and Feedback Manager per market, eBay Seller Hub", () => {
    expect(sellerCentralHref('IT')).toBe('https://sellercentral.amazon.it')
    expect(sellerCentralHref('UK')).toBe('https://sellercentral.amazon.co.uk')
    expect(sellerCentralHref(null)).toBe('https://sellercentral-europe.amazon.com')
    expect(feedbackManagerHref('DE')).toBe('https://sellercentral.amazon.de/feedback-manager/index.html')
    expect(sellerHubHref('DE')).toBe('https://www.ebay.de/sh/ovw')
    expect(sellerHubHref(null)).toBe('https://www.ebay.it/sh/ovw')
  })
})

const AMAZON_TILES: AmazonTiles = {
  importedRating: 4.2, importedInPeriod: 486, importedTotal: 900, lastImportAt: '2026-10-24T08:00:00Z', topicsToFix: 3,
  topicsWeekOf: '2026-10-20T00:00:00Z', needReply: 3, oldestWaitDays: 1, requestsSent: 372, reviewRate: 8.9,
}

describe('Amazon', () => {
  it('six tiles: stars only from imports, 1–3 star feedback is "Coming later", links filtered to Amazon Italy', () => {
    const tiles = amazonTiles(AMAZON_TILES, IT, '30d')
    expect(tiles.map((t) => [t.label, t.value, t.hint])).toEqual([
      ['Rating · imported', '4.2', '486 reviews, file of 24 Oct'],
      ['Topics to fix', '3', 'Amazon topics, week of 20 Oct'],
      ['1–3 star feedback', 'Coming later', 'Amazon seller feedback · sample below'],
      ['Needs a reply', '3', 'oldest waits 1 day'],
      ['Requests sent', '372', 'last 30 days'],
      ['Review rate', '8.9%', 'estimate, from imported reviews'],
    ])
    expect(tiles.find((t) => t.key === 'seller')).toMatchObject({ later: true })
    expect(tiles.find((t) => t.key === 'seller')?.href).toBeUndefined()
    expect(tiles.find((t) => t.key === 'reply')?.href).toBe('/marketing/reviews/inbox?period=30d&status=NEW%2CIN_PROGRESS&channel=AMAZON&market=IT')
  })

  it('no import: no rating, and says where a rating comes from — never an Amazon number', () => {
    const tiles = amazonTiles({ ...AMAZON_TILES, importedRating: null, importedInPeriod: 0, importedTotal: 0, lastImportAt: null, topicsToFix: null, reviewRate: null }, IT, '30d')
    expect(tiles[0]).toMatchObject({ value: '—', hint: NO_RATING_WORDS })
    expect(tiles[1]).toMatchObject({ value: '—', hint: 'No Amazon topics here' })
    expect(tiles[5]).toMatchObject({ value: '—', hint: 'needs imported reviews to match' })
    expect(amazonTiles({ ...AMAZON_TILES, importedRating: null, importedInPeriod: 0 }, IT, '7d')[0].hint).toBe('No imported review in the last 7 days')
  })

  it('the header says where the stars and topics come from', () => {
    const topics = { state: 'ok', productCount: 12, weekOf: '2026-10-20T00:00:00Z' } as AmazonTopics
    expect(amazonSubtitle(AMAZON_TILES, topics)).toBe('12 products with Amazon topics · topics weekly, week of 20 Oct · stars from reviews imported 24 Oct · seller feedback coming later')
    expect(amazonSubtitle(null, { ...topics, state: 'not_on_market', weekOf: null, productCount: 0 })).toBe('no Amazon topics on this market · seller feedback coming later')
  })

  it('requests by Amazon’s answer, then the review rate as an estimate', () => {
    const rows = requestRows({ sent: 372, tooEarly: 11, alreadyAsked: 6, notAllowed: 2, failed: 1, skipped: 4, waiting: 9, reviewRate: null })
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ['Sent — Amazon accepted', '372'], ['Too early — tried again daily', '11'], ['Already asked', '6'], ['Not allowed', '2'],
      ['Failed', '1'], ['Skipped', '4'], ['Waiting', '9'], ['Review rate', '—'],
    ])
    expect(rows.at(-1)?.note).toMatch(/Amazon gives no review count/)
  })

  const topic = (label: string, mentions: number, impact: number | null, share: number | null = 18) => ({
    key: `amazon:${label.toLowerCase()}`, label, mentions, impact, share, quote: `“about ${label}”`, market: 'IT', trend: null,
  })
  const TOPICS: AmazonTopics = {
    state: 'ok', words: null, where: '…', weekOf: null, productCount: 2,
    like: [topic('Waterproof', 214, 0.2)], dislike: [topic('Runs small', 88, -0.3, 7), topic('Zip', 41, null, null)],
    products: [{ key: 'p1', name: 'Gloves', like: [], dislike: [topic('Seams', 9, -0.1)] }],
  }

  it('a topic: mentions, share, star effect with its sign; the 6-month trend comes later', () => {
    expect(topicView(TOPICS.dislike[0])).toMatchObject({ mentions: '88 mentions', share: '7% of reviews', impact: '−0.3 stars', impactTone: 'down', trend: '6-month trend: coming later' })
    expect(topicView(TOPICS.like[0])).toMatchObject({ impact: '+0.2 stars', impactTone: 'up' })
    expect(topicView(TOPICS.dislike[1])).toMatchObject({ impact: '—', share: '', impactTone: 'flat' })
  })

  it('the product picker: all products, then each; a product shows its own topics', () => {
    expect(topicProductOptions(TOPICS)).toEqual([{ value: ALL_PRODUCTS, label: 'All 2 products' }, { value: 'p1', label: 'Gloves' }])
    expect(topicColumns(TOPICS, ALL_PRODUCTS).dislike.map((t) => t.label)).toEqual(['Runs small', 'Zip'])
    expect(topicColumns(TOPICS, 'p1')).toMatchObject({ like: [], dislike: [{ label: 'Seams' }] })
    expect(topicColumns(TOPICS, 'gone').like.map((t) => t.label)).toEqual(['Waterproof'])
  })

  it('a product to watch: imported stars, or "No rating data from Amazon — import reviews"', () => {
    expect(watchView({ productId: 'p', name: 'Over-pants', sku: 'OP', ratingNow: 3.9, ratingBefore: 4.2, change: -0.3, imported: 46, topTopic: 'Runs small', topShare: 34, topMentions: 16 }))
      .toMatchObject({ hasRating: true, ratingText: '3.9', change: '−0.3', changeTone: 'down', topic: 'Runs small', topicSub: '34% of reviews · 16 mentions' })
    expect(watchView({ productId: 'q', name: 'Base layer', sku: null, ratingNow: null, ratingBefore: null, change: null, imported: 0, topTopic: null, topShare: null, topMentions: null }))
      .toMatchObject({ hasRating: false, ratingText: NO_RATING_WORDS, change: '—', topic: 'No topics yet', topicSub: 'Amazon needs more reviews' })
  })
})

const SUMMARY: EbaySummary = {
  state: 'read', words: null, readAt: '2026-10-26T10:42:00Z', accountWide: true, accounts: 1, score: 2431,
  periods: [{ days: 30, positive: 18, neutral: 1, negative: 0 }, { days: 180, positive: 90, neutral: 4, negative: 2 }, { days: 365, positive: 171, neutral: 7, negative: 3 }],
  dsr: [{ key: 'ItemAsDescribed', label: 'Item as described', rating: 4.9, count: 176 }, { key: 'Communication', label: 'Communication', rating: null, count: 0 }],
  dsrPeriod: 'FiftyTwoWeeks',
}
const EBAY_TILES: EbayTiles = { positive: 171, neutral: 7, negative: 3, score: 2431, positivePct: 98.3, positiveFrom: 'ebay', needReply: 5, oldestWaitDays: 2 }
const DE_BEHIND: EbayReadState = { channel: 'EBAY', market: 'DE', label: 'eBay Germany', ok: false, reason: 'Sign-in expired', since: null, reconnectHref: '/settings/channels/ebay' }

describe('eBay', () => {
  it("six tiles: eBay's score and % positive, neutral and negative open the Inbox, buyers to rate comes later", () => {
    const tiles = ebayTiles(EBAY_TILES, SUMMARY, EBAY_DE, '12m')
    expect(tiles.map((t) => [t.label, t.value, t.hint])).toEqual([
      ['Feedback score', '2,431', 'whole eBay account'],
      ['Positive', '98.3%', 'last 12 months, eBay’s counts'],
      ['Neutral', '7', 'last 12 months'],
      ['Negative', '3', 'last 12 months'],
      ['Needs a reply', '5', 'oldest waits 2 days'],
      ['Buyers to rate', 'Coming later', 'Leave feedback for buyers · sample below'],
    ])
    expect(tiles[3].href).toBe('/marketing/reviews/inbox?kind=seller&period=12m&channel=EBAY&market=DE&stars=1%2C2')
    const unread = ebayTiles({ ...EBAY_TILES, score: null, positivePct: 50, positiveFrom: 'nexus' }, null, EBAY_ALL, '30d')
    expect(unread[0]).toMatchObject({ value: '—', hint: 'eBay was not read' })
    expect(unread[1].hint).toBe('last 30 days, feedback Nexus read')
  })

  it('the header names the markets that are not read', () => {
    expect(ebaySubtitle(EBAY_ALL, [DE_BEHIND], null)).toBe('Seller feedback on every eBay market · eBay Germany not read')
    expect(ebaySubtitle(EBAY_DE, [], { ...SUMMARY, readAt: '2026-10-24T10:00:00Z' })).toBe('Seller feedback on eBay Germany · read every 30 min · eBay’s summary read 24 Oct')
  })

  it("eBay's summary in words: the whole account's numbers on a market page; the four ratings with counts", () => {
    expect(summaryNote(SUMMARY, EBAY_DE)).toMatch(/^eBay counts feedback per account: these are the whole account’s numbers, not Germany’s alone\. eBay is asked at most once an hour/)
    expect(summaryNote({ ...SUMMARY, accountWide: false, readAt: null }, EBAY_ALL)).toBeNull()
    expect(dsrRows(SUMMARY)).toEqual([
      { key: 'ItemAsDescribed', label: 'Item as described', rating: 4.9, value: '4.9', count: '176 ratings' },
      { key: 'Communication', label: 'Communication', rating: null, value: '—', count: 'No ratings' },
    ])
  })

  it('feedback by type per eBay period, with the share of positive', () => {
    const rows = typeChartRows(SUMMARY)
    expect(rows.map((r) => [r.when, r.positive, r.negative, r.pct])).toEqual([['Last 30 days', 18, 0, 100], ['Last 6 months', 90, 2, 97.8], ['Last 12 months', 171, 3, 98.3]])
    expect(typeChartWords(rows)).toMatch(/^Last 30 days: 18 positive, 1 neutral, 0 negative \(100\.0% positive\);/)
    expect(typeChartWords([])).toBe('eBay gave no feedback counts.')
    expect(periodDaysWords(45)).toBe('Last 45 days')
  })

  it('the list: type and search (text, English, buyer, product, order)', () => {
    const rows = [row(), row({ id: 'r2', rating: 1, snippet: 'Guanti scuciti', english: 'Gloves came apart', buyer: 'buyer-two' }), row({ id: 'r3', rating: 3, product: null, order: null })]
    expect(filterFeedback(rows, 'negative', '').map((r) => r.id)).toEqual(['r2'])
    expect(filterFeedback(rows, 'all', 'came APART').map((r) => r.id)).toEqual(['r2'])
    expect(filterFeedback(rows, 'all', '89013').map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(typeOptions(rows).map((o) => o.label)).toEqual(['All 3', 'Positive 1', 'Neutral 1', 'Negative 1'])
    expect([5, 4, 3, 2, 1, null].map(feedbackTypeOf)).toEqual(['positive', 'positive', 'neutral', 'negative', 'negative', null])
  })

  it('a reply is held while the market is not read, once one went out (eBay: one per feedback), and for a file', () => {
    expect(replyHeld(row(), [], NOW)).toBeNull()
    expect(replyHeld(row({ market: 'DE' }), [DE_BEHIND], NOW)).toBe('eBay Germany must be reconnected before a reply can be sent.')
    expect(replyHeld(row({ responses: { sent: 1, draft: 0 } }), [], NOW)).toBe('This feedback already has a reply. eBay allows one reply per feedback.')
    expect(replyHeld(row({ imported: true }), [], NOW)).toBe('This feedback came from a file: reply on eBay itself.')
    expect(replyNote(row({ status: 'RESPONDED' }))).toBe('Replied')
    expect(replyNote(row({ responses: { sent: 0, draft: 1 } }))).toBe('Draft saved')
    expect(replyNote(row({ overdue: true }))).toBe('Overdue')
    expect(replyNote(row({ status: 'RESOLVED' }))).toBe('No reply needed')
  })

  it('market tabs: all markets, then each market as a link; a market not read says so', () => {
    const tabs = marketTabs(EBAY_ALL, [{ code: 'IT', label: 'Italy' }, { code: 'DE', label: 'Germany' }], [DE_BEHIND])
    expect(tabs).toEqual([
      { id: 'all', label: 'All markets', href: '/marketing/reviews/ebay', behind: false },
      { id: 'IT', label: 'Italy', href: '/marketing/reviews/ebay/it', behind: false },
      { id: 'DE', label: 'Germany', href: '/marketing/reviews/ebay/de', behind: true },
    ])
    // A market page whose market has no reviews yet still has its own tab.
    expect(marketTabs({ channel: 'AMAZON', marketplace: 'SE' }, [{ code: 'IT', label: 'Italy' }], null).map((t) => t.id)).toEqual(['all', 'IT', 'SE'])
  })
})
