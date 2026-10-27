/**
 * Reviews area — the visible-rows, kind and needs-a-reply rules. Pure `where` builders: the test reads the objects
 * Prisma would receive and checks them against rows the way PostgreSQL would answer them (NULL never equals a value).
 */
import { describe, expect, it } from 'vitest'
import {
  canTakeReply,
  countsInRating,
  FIXTURE_SOURCE,
  needsReplyWhere,
  overdueWhere,
  reviewKindOf,
  reviewKindWhere,
  reviewNeedsReply,
  reviewOverdue,
  visibleReviewWhere,
} from './review-visibility.js'

type Row = { channel: string; ingestSource: string | null; triageStatus: string | null; rating?: number | null; kind?: string | null; postedAt?: Date; channelEditedAt?: Date | null }

/** A tiny evaluator for the shapes these builders produce (AND / OR / equals / not / in / null), SQL style. */
function matches(where: any, row: Record<string, unknown>): boolean {
  if (!where || typeof where !== 'object') return true
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as any[]).every(c => matches(c, row))
    if (key === 'OR') return (cond as any[]).some(c => matches(c, row))
    // SQL's NOT (…): a NULL inside stays unknown, so only a clear "true" inside excludes the row (good enough for these shapes).
    if (key === 'NOT') return !(Array.isArray(cond) ? cond.some(c => matches(c, row)) : matches(cond, row))
    const value = row[key] ?? null
    if (cond === null) return value === null
    if (typeof cond !== 'object' || cond instanceof Date) return value === cond
    const c = cond as Record<string, unknown>
    if ('not' in c) return value !== null && value !== c.not
    if ('in' in c) return value !== null && (c.in as unknown[]).includes(value)
    if ('equals' in c) return value === c.equals
    if ('startsWith' in c) return value !== null && String(value).toUpperCase().startsWith(String(c.startsWith).toUpperCase())
    if ('lt' in c) return value !== null && (value as Date).getTime() < (c.lt as Date).getTime()
    throw new Error(`unexpected condition on ${key}`)
  })
}

const row = (patch: Partial<Row>): Row => ({ channel: 'AMAZON', ingestSource: 'AMAZON_VOC', triageStatus: null, ...patch })

describe('visibleReviewWhere', () => {
  it('hides fixture rows and keeps rows with no source', () => {
    const where = visibleReviewWhere()
    expect(matches(where, row({ ingestSource: FIXTURE_SOURCE }))).toBe(false)
    expect(matches(where, row({ ingestSource: null }))).toBe(true)
    for (const source of ['IMPORT_CSV', 'AMAZON_VOC', 'EBAY_API', 'SHOPIFY_WEBHOOK', 'MANUAL']) {
      expect(matches(where, row({ ingestSource: source }))).toBe(true)
    }
  })

  it('narrows with an extra condition without widening past the fixture rule', () => {
    const where = visibleReviewWhere({ OR: [{ rating: 1 }, { rating: 2 }] })
    expect(where).toHaveProperty('AND')
    expect(matches(where, { ...row({}), rating: 1 })).toBe(true)
    expect(matches(where, { ...row({}), rating: 5 })).toBe(false)
    expect(matches(where, { ...row({ ingestSource: FIXTURE_SOURCE }), rating: 1 })).toBe(false)
  })
})

describe('review kind', () => {
  it('reads the kind column first', () => {
    expect(reviewKindOf('AMAZON', 'SELLER')).toBe('seller')
    expect(reviewKindOf('EBAY', 'PRODUCT')).toBe('product')
    expect(reviewKindOf('amazon', 'seller')).toBe('seller')
  })

  it('falls back to the old channel rule when the column is empty: eBay is seller feedback, every other channel a product review', () => {
    expect(reviewKindOf('EBAY', null)).toBe('seller')
    expect(reviewKindOf('ebay')).toBe('seller')
    for (const channel of ['AMAZON', 'SHOPIFY', 'ETSY', '', null, undefined]) expect(reviewKindOf(channel, null)).toBe('product')
  })

  it('selects the same rows as reviewKindOf, with and without the column', () => {
    for (const channel of ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY']) {
      for (const kind of [null, 'SELLER', 'PRODUCT']) {
        const r = { ...row({ channel }), kind }
        expect(matches(reviewKindWhere('seller'), r)).toBe(reviewKindOf(channel, kind) === 'seller')
        expect(matches(reviewKindWhere('product'), r)).toBe(reviewKindOf(channel, kind) === 'product')
      }
    }
  })

  it('never averages Amazon seller feedback (only 1–3 stars), and averages everything else as before', () => {
    expect(countsInRating({ channel: 'AMAZON', kind: 'SELLER' })).toBe(false)
    expect(countsInRating({ channel: 'AMAZON', kind: null })).toBe(true)
    expect(countsInRating({ channel: 'AMAZON', kind: 'PRODUCT' })).toBe(true)
    expect(countsInRating({ channel: 'EBAY', kind: null })).toBe(true)
    expect(countsInRating({ channel: 'EBAY', kind: 'SELLER' })).toBe(true)
  })
})

describe('needs a reply — ONE rule (Owner 2026-10-27, audit B3/C1)', () => {
  const NOW = new Date('2026-10-27T12:00:00Z')
  const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000)
  const ebay = (patch: Partial<Row> = {}): Row => row({ channel: 'EBAY', ingestSource: 'EBAY_API', kind: null, postedAt: days(1), ...patch })
  const agree = (r: Row) => expect(matches(needsReplyWhere(NOW), r)).toBe(reviewNeedsReply(r, NOW))

  it('counts open rows only: no status yet, New or In progress', () => {
    const where = needsReplyWhere(NOW)
    expect(matches(where, ebay({ triageStatus: null }))).toBe(true)
    expect(matches(where, ebay({ triageStatus: 'NEW' }))).toBe(true)
    expect(matches(where, ebay({ triageStatus: 'IN_PROGRESS' }))).toBe(true)
    for (const status of ['RESPONDED', 'RESOLVED', 'IGNORED']) expect(matches(where, ebay({ triageStatus: status }))).toBe(false)
  })

  it('never counts a fixture row', () => {
    expect(matches(needsReplyWhere(NOW), ebay({ ingestSource: FIXTURE_SOURCE, triageStatus: 'NEW' }))).toBe(false)
    expect(matches(needsReplyWhere(NOW), ebay({ ingestSource: FIXTURE_SOURCE, triageStatus: null }))).toBe(false)
  })

  it('never counts an Amazon product review (Amazon lets nobody reply) — Amazon seller feedback does', () => {
    expect(matches(needsReplyWhere(NOW), row({ channel: 'AMAZON', kind: null, ingestSource: 'AMAZON_VOC' }))).toBe(false)
    expect(matches(needsReplyWhere(NOW), row({ channel: 'AMAZON', kind: 'PRODUCT', ingestSource: 'AMAZON_VOC' }))).toBe(false)
    expect(matches(needsReplyWhere(NOW), row({ channel: 'AMAZON', kind: 'SELLER', ingestSource: 'AMAZON_SELLER_FEEDBACK' }))).toBe(true)
    expect(canTakeReply({ channel: 'AMAZON', kind: null })).toBe(false)
    expect(canTakeReply({ channel: 'AMAZON', kind: 'SELLER' })).toBe(true)
  })

  it('never counts an imported row (history read in, not work)', () => {
    expect(matches(needsReplyWhere(NOW), ebay({ ingestSource: 'IMPORT_CSV' }))).toBe(false)
    expect(matches(needsReplyWhere(NOW), row({ channel: 'SHOPIFY', ingestSource: 'import_csv' }))).toBe(false)
    expect(matches(needsReplyWhere(NOW), ebay({ ingestSource: null }))).toBe(true)
  })

  it('an Etsy review past its 100-day reply window no longer needs one', () => {
    expect(matches(needsReplyWhere(NOW), row({ channel: 'ETSY', ingestSource: 'ETSY_API', postedAt: days(30) }))).toBe(true)
    expect(matches(needsReplyWhere(NOW), row({ channel: 'ETSY', ingestSource: 'ETSY_API', postedAt: days(101) }))).toBe(false)
  })

  it('Etsy\'s 100 days count from the buyer\'s last edit (#796), as the reply rules count them; Shopify reviews count', () => {
    const edited = row({ channel: 'ETSY', ingestSource: 'ETSY_API', postedAt: days(150), channelEditedAt: days(10) })
    expect(matches(needsReplyWhere(NOW), edited)).toBe(true)
    expect(reviewNeedsReply(edited, NOW)).toBe(true)
    const editedLongAgo = row({ channel: 'ETSY', ingestSource: 'ETSY_API', postedAt: days(150), channelEditedAt: days(120) })
    expect(matches(needsReplyWhere(NOW), editedLongAgo)).toBe(false)
    expect(reviewNeedsReply(editedLongAgo, NOW)).toBe(false)
    // A review read through Judge.me (answered from Nexus) needs a reply like any other open, answerable review.
    expect(matches(needsReplyWhere(NOW), row({ channel: 'SHOPIFY', ingestSource: 'JUDGEME_API', postedAt: days(3) }))).toBe(true)
    expect(reviewOverdue({ channel: 'SHOPIFY', kind: 'PRODUCT', ingestSource: 'JUDGEME_API', triageStatus: null, postedAt: days(3) }, NOW)).toBe(true)
  })

  it('the pure rule for one row says what the where says', () => {
    for (const channel of ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY']) {
      for (const kind of [null, 'SELLER', 'PRODUCT']) {
        for (const ingestSource of [null, 'IMPORT_CSV', 'EBAY_API', FIXTURE_SOURCE]) {
          for (const triageStatus of [null, 'NEW', 'RESOLVED']) {
            for (const postedAt of [days(1), days(120)]) {
              for (const channelEditedAt of [null, days(2), days(110)]) agree({ channel, kind, ingestSource, triageStatus, postedAt, channelEditedAt })
            }
          }
        }
      }
    }
  })

  it('overdue = the same rows, waiting more than 48 hours', () => {
    expect(matches(overdueWhere(NOW), ebay({ postedAt: days(3) }))).toBe(true)
    expect(matches(overdueWhere(NOW), ebay({ postedAt: days(1) }))).toBe(false)
    expect(matches(overdueWhere(NOW), row({ channel: 'AMAZON', kind: null, postedAt: days(3) }))).toBe(false)
    expect(matches(overdueWhere(NOW), ebay({ ingestSource: 'IMPORT_CSV', postedAt: days(3) }))).toBe(false)
    expect(reviewOverdue({ ...ebay(), postedAt: days(3) }, NOW)).toBe(true)
    expect(reviewOverdue({ channel: 'AMAZON', kind: 'PRODUCT', ingestSource: 'AMAZON_VOC', triageStatus: null, postedAt: days(3) }, NOW)).toBe(false)
  })
})
