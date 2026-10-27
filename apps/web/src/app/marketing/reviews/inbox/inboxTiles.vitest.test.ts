import { describe, expect, it } from 'vitest'
import type { InboxRow } from './inboxDatasource'
import { EMPTY_INBOX_QUERY } from './inboxQuery'
import {
  TILE_ORDER, agoWords, dueWords, hasTranslation, headerSubtitle, inboxChips, kindWords, livePill, photoWords, productWords,
  readStateBanners, tabItems, tileHint, tileLabel, tileValue,
} from './inboxTiles'

const NOW = Date.parse('2026-10-26T12:00:00Z')
const H = 3_600_000

const row = (over: Partial<InboxRow> = {}): InboxRow => ({
  id: 'r1', postedAt: '2026-10-26T07:00:00Z', channel: 'EBAY', market: 'DE', kind: 'seller', rating: 3, snippet: 'Fällt klein aus',
  english: 'Runs small', language: 'de', buyer: 'buyer-one', product: { id: 'p', name: 'Over-trousers', sku: 'OT', variant: 'XL' },
  order: { id: 'o', label: '12-1' }, mood: 'NEUTRAL', themes: ['FIT_SIZING'], status: 'NEW', assignee: null,
  dueAt: '2026-10-28T07:00:00Z', overdue: false, imported: false, responses: { sent: 0, draft: 0 }, photos: 0, aiTopics: [], ...over,
})

describe('Inbox tabs and tiles', () => {
  it('tabs carry the API counts; unknown is not zero', () => {
    expect(tabItems(null).map((t) => [t.label, t.count])).toEqual([['All', null], ['Product reviews', null], ['Seller feedback', null]])
    expect(tabItems({ all: 1284, product: 968, seller: 316 })[2]).toEqual({ id: 'seller', label: 'Seller feedback', count: 316 })
  })

  it('six status tiles in order, with a dash until the API answered', () => {
    expect(TILE_ORDER.map(tileLabel)).toEqual(['New', 'In progress', 'Responded', 'Resolved', 'Ignored', 'Overdue'])
    expect(tileValue(null, 'NEW')).toBe('—')
    expect(tileValue({ NEW: 9, IN_PROGRESS: 3, RESPONDED: 1642, RESOLVED: 0, IGNORED: 2, OVERDUE: 4 }, 'RESPONDED')).toBe('1,642')
    expect(tileHint('OVERDUE')).toBe('needs a reply for more than 48 h')
  })

  it('one removable chip per filter on, each removing only itself', () => {
    const q = { ...EMPTY_INBOX_QUERY, statuses: ['OVERDUE' as const], channels: ['EBAY'], stars: [1], owners: ['none'], families: ['f1'], q: 'zip' }
    const chips = inboxChips(q, { owners: [], themes: [], families: [{ id: 'f1', label: 'Trousers' }] })
    expect(chips.map((c) => c.label)).toEqual([
      'Received in the last 30 days', 'Overdue', 'Channel: eBay', '1 star', 'Owner: Nobody', 'Family: Trousers', 'Search: “zip”',
    ])
    expect(chips[0].next.period).toBe('all')
    expect(chips[1].next.statuses).toEqual([])
    expect(chips[2].next).toMatchObject({ channels: [], stars: [1] })
    expect(chips[1].removeLabel).toBe('Show every status, not only Overdue')
    expect(inboxChips({ ...EMPTY_INBOX_QUERY, period: 'all' })).toEqual([])
  })
})

describe('Inbox read state', () => {
  it('names a market that is not read, since when and where to fix it; ok markets say nothing', () => {
    const banners = readStateBanners([
      { channel: 'EBAY', market: 'DE', ok: false, since: '2026-10-23T09:00:00Z', reason: 'Sign-in expired', reconnectHref: '/settings/channels/ebay' },
      { channel: 'AMAZON', market: 'IT', ok: true, since: null, reason: null, reconnectHref: null },
    ], 'UTC')
    expect(banners).toEqual([{
      key: 'Sign-in expired|/settings/channels/ebay',
      title: 'eBay Germany has not been read since 23 Oct.',
      body: 'Sign-in expired. New reviews from eBay Germany are missing here until Nexus reads it again.',
      action: { label: 'Reconnect eBay Germany', href: '/settings/channels/ebay' },
    }])
  })

  it('markets with the same reason share one banner; no fix → no button; never a setting name', () => {
    const banners = readStateBanners([
      { channel: 'EBAY', market: 'DE', ok: false, since: null, reason: 'Nexus does not read eBay feedback in this setup yet', reconnectHref: null },
      { channel: 'EBAY', market: 'IT', ok: false, since: null, reason: 'Nexus does not read eBay feedback in this setup yet', reconnectHref: null },
    ])
    expect(banners).toHaveLength(1)
    expect(banners[0].title).toBe('eBay Germany and eBay Italy are not being read.')
    expect(banners[0].action).toBeNull()
    expect(JSON.stringify(banners)).not.toMatch(/NEXUS_|_MODE|_API\b/)
  })

  it('the live pill: not updating, updating, a market behind, up to date', () => {
    expect(livePill({ error: true, updating: false, readState: null })).toEqual({ tone: 'danger', words: 'Not updating' })
    expect(livePill({ error: false, updating: true, readState: null }).words).toBe('Updating…')
    expect(livePill({ error: false, updating: false, readState: [{ channel: 'EBAY', market: 'DE', ok: false, since: null, reason: 'x', reconnectHref: null }] }))
      .toEqual({ tone: 'warning', words: 'eBay Germany behind' })
    expect(livePill({ error: false, updating: false, readState: [] }).words).toBe('Up to date')
  })

  it('the header line', () => {
    expect(headerSubtitle(1284, '30d', 'ready')).toBe('1,284 reviews · last 30 days')
    expect(headerSubtitle(1, 'all', 'ready')).toBe('1 review · all time')
    expect(headerSubtitle(null, '7d', 'loading')).toBe('Loading…')
    expect(headerSubtitle(null, '7d', 'error')).toBe('Could not load · last 7 days')
  })
})

describe('Inbox row words', () => {
  it('received, kind, product and translation', () => {
    expect(agoWords('2026-10-26T07:00:00Z', NOW)).toBe('5 h ago')
    expect(agoWords('2026-10-26T11:59:30Z', NOW)).toBe('just now')
    expect(agoWords('2026-10-24T07:00:00Z', NOW)).toBe('2 days ago')
    expect(kindWords({ kind: 'product', imported: true })).toBe('Product review · imported')
    expect(productWords(row())).toBe('Over-trousers — XL')
    expect(productWords(row({ product: null }))).toBeNull()
    expect(hasTranslation(row())).toBe(true)
    expect(hasTranslation(row({ language: 'en' }))).toBe(false)
  })

  it('due words follow the API: overdue, soon, a day, replied, closed', () => {
    expect(dueWords(row({ overdue: true, dueAt: new Date(NOW - 7 * H).toISOString() }), NOW)).toEqual({ text: 'Overdue 7 h', kind: 'late' })
    expect(dueWords(row({ overdue: true, dueAt: new Date(NOW - 50 * H).toISOString() }), NOW)).toEqual({ text: 'Overdue 2 days', kind: 'late' })
    expect(dueWords(row({ dueAt: new Date(NOW + 18 * H).toISOString() }), NOW)).toEqual({ text: 'Due in 18 h', kind: 'soon' })
    expect(dueWords(row(), NOW, 'UTC')).toEqual({ text: 'Due 28 Oct', kind: 'ok' })
    expect(dueWords(row({ responses: { sent: 1, draft: 0 } }), NOW)).toEqual({ text: 'Replied', kind: 'done' })
    expect(dueWords(row({ status: 'RESOLVED', dueAt: null }), NOW)).toEqual({ text: 'No reply needed', kind: 'done' })
  })

  it('photos (PR G): the count in words, and "Has photos" as a removable chip', () => {
    expect(photoWords(row())).toBeNull()
    expect(photoWords(row({ photos: 1 }))).toBe('1 photo')
    expect(photoWords(row({ photos: 3 }))).toBe('3 photos')
    expect(photoWords({})).toBeNull()
    const chips = inboxChips({ ...EMPTY_INBOX_QUERY, period: 'all', photos: true })
    expect(chips).toEqual([{ key: 'photos', label: 'Has photos', removeLabel: 'Show reviews with or without photos', next: { ...EMPTY_INBOX_QUERY, period: 'all', photos: false, page: 1 } }])
  })
})
