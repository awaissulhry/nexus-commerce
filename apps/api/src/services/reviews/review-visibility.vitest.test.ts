/**
 * Reviews area — the visible-rows, kind and needs-a-reply rules. Pure `where` builders: the test reads the objects
 * Prisma would receive and checks them against rows the way PostgreSQL would answer them (NULL never equals a value).
 */
import { describe, expect, it } from 'vitest'
import {
  automaticFeedbackWhere,
  canTakeReply,
  isAutomaticFeedback,
  isPositiveReview,
  noReplyReason,
  notAutomaticWhere,
  countsInRating,
  FIXTURE_SOURCE,
  missedReplyWhere,
  needsReplyWhere,
  overdueWhere,
  reviewKindOf,
  reviewKindWhere,
  reviewNeedsReply,
  reviewOverdue,
  visibleReviewWhere,
} from './review-visibility.js'

type Row = {
  channel: string; ingestSource: string | null; triageStatus: string | null; rating?: number | null; kind?: string | null
  postedAt?: Date; channelEditedAt?: Date | null; body?: string; sentiment?: { label: string } | null
}

/**
 * A tiny evaluator for the shapes these builders produce, with SQL's three values: a comparison with NULL is unknown
 * (null), NOT unknown stays unknown, and a row counts only when the whole where is TRUE — so a `NOT (…)` over a NULL
 * column drops the row here exactly as PostgreSQL drops it.
 */
function ev(where: any, row: Record<string, unknown>): boolean | null {
  if (!where || typeof where !== 'object') return true
  const parts = Object.entries(where).map(([key, cond]): boolean | null => {
    if (key === 'AND') return and((cond as any[]).map(c => ev(c, row)))
    if (key === 'OR') return or((cond as any[]).map(c => ev(c, row)))
    if (key === 'NOT') {
      const inner = Array.isArray(cond) ? or(cond.map(c => ev(c, row))) : ev(cond, row)
      return inner == null ? null : !inner
    }
    const value = row[key] ?? null
    if (key === 'sentiment') {
      const is = (cond as { is: unknown }).is
      if (is === null) return value === null
      return value === null ? false : ev(is, value as Record<string, unknown>)
    }
    if (cond === null) return value === null
    if (typeof cond !== 'object' || cond instanceof Date) return value === null ? null : value === cond
    const c = cond as Record<string, unknown>
    const insensitive = c.mode === 'insensitive'
    const norm = (v: unknown) => (insensitive && typeof v === 'string' ? v.toLowerCase() : v)
    if (value === null) return null
    if ('not' in c) return norm(value) !== norm(c.not)
    if ('in' in c) return (c.in as unknown[]).includes(value)
    if ('equals' in c) return norm(value) === norm(c.equals)
    if ('startsWith' in c) return String(value).toUpperCase().startsWith(String(c.startsWith).toUpperCase())
    if ('lt' in c) return typeof value === 'number' ? value < (c.lt as number) : (value as Date).getTime() < (c.lt as Date).getTime()
    if ('gte' in c) return typeof value === 'number' ? value >= (c.gte as number) : (value as Date).getTime() >= (c.gte as Date).getTime()
    throw new Error(`unexpected condition on ${key}`)
  })
  return and(parts)
}
function and(values: Array<boolean | null>): boolean | null {
  if (values.some(v => v === false)) return false
  return values.some(v => v === null) ? null : true
}
function or(values: Array<boolean | null>): boolean | null {
  if (values.some(v => v === true)) return true
  return values.some(v => v === null) ? null : false
}
const matches = (where: any, row: Record<string, unknown>): boolean => ev(where, row) === true

const row = (patch: Partial<Row>): Row => ({ channel: 'AMAZON', ingestSource: 'AMAZON_VOC', triageStatus: null, rating: null, body: 'Text', sentiment: null, channelEditedAt: null, kind: null, ...patch })
/** The pure rule's view of a row (the mood is the sentiment's label). */
const facts = (r: Row) => ({ ...r, mood: r.sentiment?.label ?? null })

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
  const agree = (r: Row) => expect(matches(needsReplyWhere(NOW), r)).toBe(reviewNeedsReply(facts(r), NOW))

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
              for (const channelEditedAt of [null, days(2), days(110)]) agree(row({ channel, kind, ingestSource, triageStatus, postedAt, channelEditedAt }))
            }
          }
        }
      }
    }
  })

  it('positive reviews and feedback never need a reply: 4–5 stars, eBay positive; with no stars a POSITIVE mood (Owner 2026-10-27)', () => {
    const where = needsReplyWhere(NOW)
    expect(matches(where, ebay({ rating: 5, body: 'Venditore serio' }))).toBe(false)
    expect(matches(where, ebay({ rating: 3, body: 'Buono ma non eccellente' }))).toBe(true)
    expect(matches(where, ebay({ rating: 1, body: 'Taglia sbagliata' }))).toBe(true)
    expect(matches(where, row({ channel: 'SHOPIFY', ingestSource: 'JUDGEME_API', rating: 4 }))).toBe(false)
    expect(matches(where, row({ channel: 'SHOPIFY', ingestSource: 'JUDGEME_API', rating: null, sentiment: { label: 'POSITIVE' } }))).toBe(false)
    expect(matches(where, row({ channel: 'SHOPIFY', ingestSource: 'JUDGEME_API', rating: null, sentiment: { label: 'NEGATIVE' } }))).toBe(true)
    // No stars and no mood read yet: it waits (never hidden for a missing reading).
    expect(matches(where, row({ channel: 'SHOPIFY', ingestSource: 'JUDGEME_API', rating: null, sentiment: null }))).toBe(true)
    // The stars decide when there are any: a 2-star review the AI read as happy still waits.
    expect(matches(where, row({ channel: 'SHOPIFY', ingestSource: 'JUDGEME_API', rating: 2, sentiment: { label: 'POSITIVE' } }))).toBe(true)
    expect(isPositiveReview({ rating: 2, mood: 'POSITIVE' })).toBe(false)
    expect(isPositiveReview({ rating: null, mood: 'positive' })).toBe(true)
  })

  it("eBay's automatic feedback never needs a reply, in any letter case or with a full stop; a buyer's own words do", () => {
    const where = needsReplyWhere(NOW)
    for (const body of ['Order delivered on time with no issues', 'order delivered on time with no issues.', ' Order delivered on time with no issues ']) {
      expect(isAutomaticFeedback({ channel: 'EBAY', body })).toBe(true)
      // Stored neutral or with no rating, it still is eBay's text, not the buyer's.
      expect(matches(where, ebay({ rating: null, body: body.trim() }))).toBe(false)
    }
    expect(isAutomaticFeedback({ channel: 'SHOPIFY', body: 'Order delivered on time with no issues' })).toBe(false)
    expect(isAutomaticFeedback({ channel: 'EBAY', body: 'Order delivered on time with no issues but the zip broke' })).toBe(false)
    expect(matches(automaticFeedbackWhere(), ebay({ body: 'ORDER DELIVERED ON TIME WITH NO ISSUES' }))).toBe(true)
    expect(matches(notAutomaticWhere(), ebay({ body: 'ORDER DELIVERED ON TIME WITH NO ISSUES' }))).toBe(false)
    expect(matches(notAutomaticWhere(), row({ channel: 'SHOPIFY', body: 'Order delivered on time with no issues' }))).toBe(true)
  })

  it('says why a row needs no reply, the same rule the where counts', () => {
    expect(noReplyReason(facts(ebay({ rating: 1 })), NOW)).toBeNull()
    expect(noReplyReason(facts(ebay({ rating: 5 })), NOW)).toBe('positive')
    expect(noReplyReason(facts(ebay({ rating: 5, body: 'Order delivered on time with no issues' })), NOW)).toBe('automatic')
    expect(noReplyReason(facts(ebay({ ingestSource: 'IMPORT_CSV' })), NOW)).toBe('imported')
    expect(noReplyReason(facts(row({ channel: 'AMAZON', kind: 'PRODUCT' })), NOW)).toBe('no_reply')
    expect(noReplyReason(facts(row({ channel: 'ETSY', ingestSource: 'ETSY_API', postedAt: days(101) })), NOW)).toBe('window_closed')
    expect(noReplyReason(facts(ebay({ triageStatus: 'RESOLVED' })), NOW)).toBe('closed')
  })

  it('missed (the Etsy page\'s "Window closed"): the same rule with Etsy\'s window run out — never a positive, imported or answered one', () => {
    const where = missedReplyWhere(NOW)
    const etsy = (patch: Partial<Row>) => row({ channel: 'ETSY', ingestSource: 'ETSY_API', rating: 2, ...patch })
    expect(matches(where, etsy({ postedAt: days(130), channelEditedAt: days(120) }))).toBe(true)
    expect(matches(where, etsy({ postedAt: days(101), channelEditedAt: null }))).toBe(true)
    // Edited within 100 days: still open (needs a reply, not missed).
    expect(matches(where, etsy({ postedAt: days(130), channelEditedAt: days(95) }))).toBe(false)
    expect(matches(where, etsy({ postedAt: days(101), rating: 5 }))).toBe(false)
    expect(matches(where, etsy({ postedAt: days(101), triageStatus: 'RESPONDED' }))).toBe(false)
    expect(matches(where, etsy({ postedAt: days(101), ingestSource: 'IMPORT_CSV' }))).toBe(false)
    expect(matches(where, etsy({ postedAt: days(101), ingestSource: FIXTURE_SOURCE }))).toBe(false)
    expect(matches(where, ebay({ postedAt: days(400), rating: 1 }))).toBe(false)
    // The pure rule's reason agrees: the window closed, and it would otherwise need a reply.
    for (const channel of ['EBAY', 'SHOPIFY', 'ETSY']) {
      for (const rating of [null, 1, 3, 5]) {
        for (const triageStatus of [null, 'IN_PROGRESS', 'RESPONDED']) {
          for (const postedAt of [days(5), days(101)]) {
            for (const channelEditedAt of [null, days(50), days(105)]) {
              const r = row({ channel, ingestSource: 'API', rating, triageStatus, postedAt, channelEditedAt })
              const f = facts(r)
              expect(matches(where, r)).toBe(noReplyReason(f, NOW) === 'window_closed' && !isPositiveReview(f) && !isAutomaticFeedback(f))
            }
          }
        }
      }
    }
  })

  it('a NULL column never drops a row that needs a reply (the where is written NULL-safe)', () => {
    // An Etsy review with no edit date inside its window, a row with no kind, no rating and no mood: all still count.
    expect(matches(needsReplyWhere(NOW), row({ channel: 'ETSY', ingestSource: 'ETSY_API', postedAt: days(5), channelEditedAt: null }))).toBe(true)
    expect(matches(needsReplyWhere(NOW), row({ channel: 'SHOPIFY', ingestSource: null, kind: null, rating: null, sentiment: null, postedAt: days(1) }))).toBe(true)
  })

  it('the pure rule agrees with the where for ratings, moods and texts too', () => {
    for (const channel of ['EBAY', 'SHOPIFY', 'AMAZON']) {
      for (const rating of [null, 1, 3, 4, 5]) {
        for (const sentiment of [null, { label: 'POSITIVE' }, { label: 'NEGATIVE' }]) {
          for (const body of ['Order delivered on time with no issues', 'Taglia sbagliata']) agree(row({ channel, kind: channel === 'AMAZON' ? 'SELLER' : null, ingestSource: 'EBAY_API', rating, sentiment, body, postedAt: days(3) }))
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
