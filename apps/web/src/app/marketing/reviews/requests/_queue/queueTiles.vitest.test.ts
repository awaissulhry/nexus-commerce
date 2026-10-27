import { describe, expect, it } from 'vitest'
import type { QueueFacets, QueueTiles } from './queueDatasource'
import { EMPTY_QUEUE_QUERY } from './queueQuery'
import { countWords, failuresLines, filterChips, pointsDelta, queueTileViews, rateText } from './queueTiles'

const TILES: QueueTiles = { scheduled: 132, dueNow: 18, retrying: 37, sent: 1126, failed: 6, skipped: 142, reviewRate: 0.074, rateDelta: 0.006 }
const FACETS: QueueFacets = {
  rules: [{ id: 'r1', name: 'Amazon — all markets', isActive: true }],
  productTypes: ['Jacket'],
  reasons: [{ key: 'amazon_too_early', words: 'Amazon: too early — tries again tomorrow' }],
}

describe('queue tiles', () => {
  it('shows six status filters and the review rate as an estimate', () => {
    const views = queueTileViews(TILES, 'FAILED')
    expect(views.map((v) => `${v.label}=${v.value}`)).toEqual([
      'Scheduled=132', 'Due now=18', 'Retrying=37', 'Sent=1,126', 'Failed=6', 'Skipped=142', 'Review rate=7.4%',
    ])
    expect(views.filter((v) => v.active).map((v) => v.key)).toEqual(['FAILED'])
    const rate = views[6]
    expect(rate.status).toBeNull()
    expect(rate.hint).toBe('last 30 days, estimate')
    expect(views[3].hint).toBe('last 30 days')
    const year = queueTileViews(TILES, null, '12m')
    expect(year[3].hint).toBe('last 12 months')
    expect(year[6].hint).toBe('last 12 months, estimate')
    expect(rate.delta).toEqual({ value: '+0.6', positive: true })
  })

  it('says “—” and no change before anything was sent', () => {
    const rate = queueTileViews({ ...TILES, reviewRate: null, rateDelta: null }, null)[6]
    expect(rate.value).toBe('—')
    expect(rate.delta).toBeUndefined()
    expect(rate.hint).toBe('nothing sent in this period')
  })

  it('says “Not measurable” when requests went out but no review can follow them — never 0.0% (live audit A02)', () => {
    const rate = queueTileViews({ ...TILES, reviewRate: null, rateDelta: null, rateWords: 'Not measurable: Amazon gives no review count — import this market’s reviews to estimate it.' }, null)[6]
    expect(rate.value).toBe('Not measurable')
    expect(rate.hint).toMatch(/^Not measurable: Amazon gives no review count/)
  })

  it('writes rates and point changes', () => {
    expect(rateText(0.0891)).toBe('8.9%')
    expect(rateText(null)).toBe('—')
    expect(pointsDelta(-0.012)).toEqual({ value: '−1.2', positive: false })
    expect(pointsDelta(0.0001)).toBeNull()
  })

  it('names each filter that is on as a removable chip, in words', () => {
    const q = { ...EMPTY_QUEUE_QUERY, status: 'SUPPRESSED' as const, channel: 'EBAY', market: 'DE', rule: 'r1', reason: 'amazon_too_early', q: 'gloves' }
    expect(filterChips(q, FACETS).map((c) => c.words)).toEqual([
      'Status: Blocked',
      'Channel: eBay',
      'Market: Germany',
      'Rule: Amazon — all markets',
      'Reason: Amazon: too early — tries again tomorrow',
      'Search: “gloves”',
    ])
    expect(filterChips({ ...EMPTY_QUEUE_QUERY, rule: 'gone' }, null)[0].words).toBe('Rule: a rule')
  })

  it('counts the requests and splits the failures sentence', () => {
    expect(countWords(1461, false)).toBe('1,461 requests · last 30 days and upcoming')
    expect(countWords(1, true)).toBe('1 request match')
    expect(failuresLines('6 requests failed in the last 7 days: 4 emails bounced · 2 other')).toEqual({ title: '6 requests failed in the last 7 days', detail: '4 emails bounced · 2 other' })
    expect(failuresLines('No request failed in the last 7 days')).toEqual({ title: 'No request failed in the last 7 days', detail: null })
  })
})
