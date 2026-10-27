/**
 * Reviews Inbox — the pure filters → `where`, and the bulk bar's plan (which ticked rows change, and the words for
 * the ones skipped). No database.
 */
import { describe, expect, it } from 'vitest'
import {
  BULK_NOT_FOUND,
  INBOX_MAX_PAGE_SIZE,
  inboxOrderBy,
  inboxStatusWhere,
  inboxWhere,
  parseInboxPeriod,
  parseInboxQuery,
  planInboxBulk,
  validateInboxBulk,
  variantWords,
  type InboxBulkRow,
} from './review-inbox-query.js'
import { visibleReviewWhere } from './review-visibility.js'

const NOW = new Date('2026-10-26T12:00:00Z')
const HOUR = 60 * 60 * 1000
const VISIBLE = visibleReviewWhere()

/** The filters inside the visible-rows wrapper (asserts the wrapper is there). */
function filters(where: ReturnType<typeof inboxWhere>): unknown[] {
  const and = (where as { AND: unknown[] }).AND
  expect(and[0]).toEqual(VISIBLE)
  return (and[1] as { AND: unknown[] }).AND
}

describe('parseInboxQuery — the address, parsed once', () => {
  it('defaults: all kinds, every status, all time, newest first, page 1 of 50', () => {
    expect(parseInboxQuery({})).toEqual({
      kind: 'all', statuses: [], channels: [], markets: [], stars: [], moods: [], themes: [], owners: [], families: [], withPhotos: false,
      periodDays: null, q: null, sort: { field: 'postedAt', dir: 'desc' }, page: 1, pageSize: 50,
    })
  })

  it('"Has photos" (PR G): photos=1 keeps only reviews with the buyer’s photos; anything else is off', () => {
    expect(parseInboxQuery({ photos: '1' }).withPhotos).toBe(true)
    expect(parseInboxQuery({ photos: 'true' }).withPhotos).toBe(true)
    expect(parseInboxQuery({ photos: '0' }).withPhotos).toBe(false)
    expect(parseInboxQuery({ photos: 'maybe' }).withPhotos).toBe(false)
    const where = JSON.stringify(inboxWhere(parseInboxQuery({ photos: '1' }), new Date('2026-10-27T00:00:00Z')))
    expect(where).toContain('"media":{"some":{}}')
    expect(JSON.stringify(inboxWhere(parseInboxQuery({}), new Date('2026-10-27T00:00:00Z')))).not.toContain('media')
  })

  it('lists, upper-cased where codes; unknown values are dropped, never guessed', () => {
    const q = parseInboxQuery({
      kind: 'seller', status: 'new,overdue,WAITING', channel: 'ebay,amazon', market: 'de', stars: '1,2,9,x', mood: 'negative,angry',
      theme: 'fit_sizing', owner: 'none,owner-a', family: 'fam1', period: '30d', q: '  runs small ', sort: 'rating:asc', page: '3', pageSize: '1000',
    })
    expect(q).toMatchObject({
      kind: 'seller', statuses: ['NEW', 'OVERDUE'], channels: ['EBAY', 'AMAZON'], markets: ['DE'], stars: [1, 2],
      moods: ['NEGATIVE'], themes: ['FIT_SIZING'], owners: ['none', 'owner-a'], families: ['fam1'], periodDays: 30,
      q: 'runs small', sort: { field: 'rating', dir: 'asc' }, page: 3, pageSize: INBOX_MAX_PAGE_SIZE,
    })
    expect(parseInboxQuery({ kind: 'everything' }).kind).toBe('all')
  })

  it('period: 7, 7d, 90d → days; all or nonsense → all time', () => {
    expect(parseInboxPeriod('7')).toBe(7)
    expect(parseInboxPeriod('90d')).toBe(90)
    expect(parseInboxPeriod('all')).toBeNull()
    expect(parseInboxPeriod('soon')).toBeNull()
    expect(parseInboxPeriod(undefined)).toBeNull()
  })
})

describe('inboxWhere — fixture rows never show', () => {
  it('no filter: exactly the visible-rows rule (FIXTURE excluded, rows without a source kept)', () => {
    expect(inboxWhere(parseInboxQuery({}), NOW)).toEqual(VISIBLE)
    expect(VISIBLE).toEqual({ OR: [{ ingestSource: null }, { ingestSource: { not: 'FIXTURE' } }] })
  })

  it('every filter sits inside the visible-rows rule', () => {
    const f = filters(inboxWhere(parseInboxQuery({ channel: 'EBAY', market: 'DE', stars: '1,2' }), NOW))
    expect(f).toEqual([{ channel: { in: ['EBAY'] } }, { marketplace: { in: ['DE'] } }, { rating: { in: [1, 2] } }])
  })
})

describe('inboxWhere — kind', () => {
  it('seller feedback = eBay rows; product reviews = every other channel', () => {
    expect(filters(inboxWhere(parseInboxQuery({ kind: 'seller' }), NOW))).toEqual([{ channel: 'EBAY' }])
    expect(filters(inboxWhere(parseInboxQuery({ kind: 'product' }), NOW))).toEqual([{ channel: { not: 'EBAY' } }])
    expect(inboxWhere(parseInboxQuery({ kind: 'all' }), NOW)).toEqual(VISIBLE)
  })

  it('the tab counts leave the kind out and keep every other filter', () => {
    const q = parseInboxQuery({ kind: 'seller', stars: '1' })
    expect(filters(inboxWhere(q, NOW, { kind: true }))).toEqual([{ rating: { in: [1] } }])
  })
})

describe('inboxWhere — status tiles and OVERDUE', () => {
  it('New includes rows never triaged', () => {
    expect(inboxStatusWhere('NEW', NOW)).toEqual({ OR: [{ triageStatus: null }, { triageStatus: 'NEW' }] })
    expect(inboxStatusWhere('RESOLVED', NOW)).toEqual({ triageStatus: 'RESOLVED' })
  })

  it('Overdue = open (none, New, In progress) and posted more than 48 hours ago', () => {
    expect(inboxStatusWhere('OVERDUE', NOW)).toEqual({
      AND: [
        { OR: [{ triageStatus: null }, { triageStatus: { in: ['NEW', 'IN_PROGRESS'] } }] },
        { postedAt: { lt: new Date(NOW.getTime() - 48 * HOUR) } },
      ],
    })
  })

  it('several tiles: any of them; the tile counts leave the status out', () => {
    const q = parseInboxQuery({ status: 'RESPONDED,OVERDUE', channel: 'AMAZON' })
    expect(filters(inboxWhere(q, NOW))[0]).toEqual({ OR: [inboxStatusWhere('RESPONDED', NOW), inboxStatusWhere('OVERDUE', NOW)] })
    expect(filters(inboxWhere(q, NOW, { status: true }))).toEqual([{ channel: { in: ['AMAZON'] } }])
  })
})

describe('inboxWhere — the other filters', () => {
  it('mood and theme read the sentiment row together', () => {
    expect(filters(inboxWhere(parseInboxQuery({ mood: 'NEGATIVE', theme: 'FIT_SIZING,QUALITY' }), NOW))).toEqual([
      { sentiment: { is: { label: { in: ['NEGATIVE'] }, categories: { hasSome: ['FIT_SIZING', 'QUALITY'] } } } },
    ])
  })

  it('owner: a name, or "none" for nobody', () => {
    expect(filters(inboxWhere(parseInboxQuery({ owner: 'none' }), NOW))).toEqual([{ assignee: null }])
    expect(filters(inboxWhere(parseInboxQuery({ owner: 'owner-a,none' }), NOW))).toEqual([{ OR: [{ assignee: { in: ['owner-a'] } }, { assignee: null }] }])
  })

  it('product family: the product, or the parent of a variation', () => {
    expect(filters(inboxWhere(parseInboxQuery({ family: 'f1' }), NOW))).toEqual([
      { product: { is: { OR: [{ familyId: { in: ['f1'] } }, { parent: { is: { familyId: { in: ['f1'] } } } }] } } },
    ])
  })

  it('period and search', () => {
    const f = filters(inboxWhere(parseInboxQuery({ period: '7', q: 'zip' }), NOW))
    expect(f[0]).toEqual({ postedAt: { gte: new Date(NOW.getTime() - 7 * 24 * HOUR) } })
    const contains = { contains: 'zip', mode: 'insensitive' }
    expect(f[1]).toEqual({ OR: [{ title: contains }, { body: contains }, { bodyEnglish: contains }, { authorName: contains }, { sku: contains }] })
  })

  it('sort: newest first by default; stars put rows without stars last; ties by id', () => {
    expect(inboxOrderBy(parseInboxQuery({}))).toEqual([{ postedAt: 'desc' }, { id: 'desc' }])
    expect(inboxOrderBy(parseInboxQuery({ sort: 'rating:asc' }))).toEqual([{ rating: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }])
  })

  it('variant words from a variation\'s attributes', () => {
    expect(variantWords({ Size: 'XL', Color: 'Black' })).toBe('XL · Black')
    expect(variantWords(null)).toBeNull()
    expect(variantWords({})).toBeNull()
  })
})

describe('bulk bar — validation words', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`)
  it('refusals, in words', () => {
    expect(validateInboxBulk({ ids: [], action: 'assign' })).toMatchObject({ ok: false, error: 'no_ids', words: 'Tick at least one review.' })
    expect(validateInboxBulk({ ids: ids(201), action: 'assign' })).toMatchObject({ ok: false, error: 'too_many', words: 'Pick at most 200 reviews at once.' })
    expect(validateInboxBulk({ ids: ['a'], action: 'delete' })).toMatchObject({ ok: false, error: 'invalid_action' })
    expect(validateInboxBulk({ ids: ['a'], action: 'tag', value: '  ' })).toMatchObject({ ok: false, words: 'Type a tag first.' })
    expect(validateInboxBulk({ ids: ['a'], action: 'status', value: 'DONE' })).toMatchObject({ ok: false, error: 'invalid_status' })
    expect(validateInboxBulk({ ids: ids(51), action: 'draft' })).toMatchObject({ ok: false, error: 'too_many_drafts', words: 'Draft with AI takes at most 50 reviews at once.' })
  })
  it('accepted: ids de-duplicated, status upper-cased, an empty owner clears the owner', () => {
    expect(validateInboxBulk({ ids: ['a', 'a', 'b'], action: 'status', value: 'resolved' })).toEqual({ ok: true, request: { ids: ['a', 'b'], action: 'status', value: 'RESOLVED' } })
    expect(validateInboxBulk({ ids: ['a'], action: 'assign', value: '' })).toEqual({ ok: true, request: { ids: ['a'], action: 'assign', value: null } })
    expect(validateInboxBulk({ ids: ids(50), action: 'draft' })).toMatchObject({ ok: true })
  })
})

describe('bulk bar — which ticked rows change, and the held words for the others', () => {
  const row = (id: string, over: Partial<InboxBulkRow> = {}): InboxBulkRow => ({
    id, channel: 'AMAZON', marketplace: 'DE', postedAt: new Date(NOW.getTime() - 24 * HOUR), ingestSource: 'IMPORT_CSV',
    assignee: null, triageStatus: null, triageTags: [], sentReplies: 0, draftReplies: 0, ...over,
  })

  it('assign: skips rows already assigned to that person; a row not found is named', () => {
    const plan = planInboxBulk({ ids: ['a', 'b', 'gone'], action: 'assign', value: 'owner-a' }, [row('a', { assignee: 'owner-a' }), row('b')], NOW)
    expect(plan.apply.map((r) => r.id)).toEqual(['b'])
    expect(plan.skipped).toEqual([{ id: 'a', reason: 'Already assigned to owner-a.' }, { id: 'gone', reason: BULK_NOT_FOUND }])
  })

  it('tag and status: already so → skipped with words (a row never triaged is New)', () => {
    expect(planInboxBulk({ ids: ['a'], action: 'tag', value: 'size chart' }, [row('a', { triageTags: ['size chart'] })], NOW).skipped)
      .toEqual([{ id: 'a', reason: 'Already tagged “size chart”.' }])
    expect(planInboxBulk({ ids: ['a', 'b'], action: 'status', value: 'NEW' }, [row('a'), row('b', { triageStatus: 'RESOLVED' })], NOW))
      .toMatchObject({ apply: [{ id: 'b' }], skipped: [{ id: 'a', reason: 'Already New.' }] })
  })

  it('draft: held where the channel allows no more replies, or a draft or reply exists', () => {
    const rows = [
      row('ebay-replied', { channel: 'EBAY', ingestSource: 'EBAY_API', sentReplies: 1 }),
      row('etsy-late', { channel: 'ETSY', postedAt: new Date(NOW.getTime() - 120 * 24 * HOUR) }),
      row('has-draft', { draftReplies: 1 }),
      row('shopify-sent', { channel: 'SHOPIFY', sentReplies: 1 }),
      row('fresh'),
    ]
    const plan = planInboxBulk({ ids: rows.map((r) => r.id), action: 'draft', value: null }, rows, NOW)
    expect(plan.apply.map((r) => r.id)).toEqual(['fresh'])
    expect(plan.skipped).toEqual([
      { id: 'ebay-replied', reason: 'This feedback already has a reply. eBay allows one reply per feedback.' },
      { id: 'etsy-late', reason: expect.stringMatching(/^The reply window on Etsy closed on /) },
      { id: 'has-draft', reason: 'A reply draft is already saved.' },
      { id: 'shopify-sent', reason: 'A reply was already sent.' },
    ])
  })

  it('nothing applies → every row is skipped with its reason (the web holds the action and names why)', () => {
    const plan = planInboxBulk({ ids: ['a'], action: 'assign', value: null }, [row('a')], NOW)
    expect(plan).toEqual({ apply: [], skipped: [{ id: 'a', reason: 'Nobody is assigned already.' }] })
  })
})
