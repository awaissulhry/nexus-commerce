import { describe, expect, it } from 'vitest'
import { INCOMING_TILES } from '../incoming/rules'
import { INQUIRY_STATUSES, type InquiryStatus } from '../inquiries/rules'
import { REQUEST_STATUSES } from '../portal-ordering/rules'
import { QUOTE_STATUSES, type QuoteStatus } from '../quotes/quotes'
import { beforeOrderCounts, beforeOrderCountsAnswer, beforeOrderCountsQuery, BEFORE_ORDER_PARTIES_MAX } from './contracts'
import {
  BEFORE_ORDER_GROUPS,
  beforeOrderGroupsOf,
  byUrgency,
  CLOSED_GROUPS,
  ENDS_SOON_DAYS,
  GROUP_WAITS_ON,
  groupOfPortalOrder,
  groupOfQuote,
  groupOfRequest,
  INCOMING_TILE_OF,
  incomingUrgencyKey,
  LIVE_GROUPS,
  OPEN_QUOTES,
  openQuotesOf,
  PORTAL_GROUP_STATUSES,
  PORTAL_GROUPS,
  portalGroupCounts,
  QUOTE_GROUP_STATUSES,
  QUOTE_GROUP_TERMS,
  QUOTE_GROUPS,
  QUOTE_TERM_GROUPS,
  quoteGroupCounts,
  quoteUrgencyKey,
  REQUEST_GROUP_STATUSES,
  REQUEST_GROUPS,
  requestGroupCounts,
  waitsOnUsOf,
  type IncomingUrgencyFacts,
  type QuoteUrgencyFacts,
} from './groups'

/** B-CQ-001 (customer page › Quotes & incoming, 13-backend §2): everything before an order, in one rule — pure. */
describe('B-CQ-001 the before-order groups', () => {
  it('every status of every kind falls in exactly one group; the nine groups cover every state and are life-ordered', () => {
    expect([...LIVE_GROUPS, ...CLOSED_GROUPS]).toEqual([...BEFORE_ORDER_GROUPS])
    const seen = new Set<string>()
    for (const status of QUOTE_STATUSES) for (const made of [false, true]) seen.add(groupOfQuote(status, made))
    for (const status of INQUIRY_STATUSES) seen.add(groupOfRequest(status))
    for (const status of REQUEST_STATUSES) for (const became of ['ORDER', 'QUOTE', null] as const) seen.add(groupOfPortalOrder(status, status === 'ACCEPTED' ? became : null))
    expect([...seen].sort()).toEqual([...BEFORE_ORDER_GROUPS].sort())
    // Each kind stays inside its own groups.
    for (const status of QUOTE_STATUSES) for (const made of [false, true]) expect(QUOTE_GROUPS).toContain(groupOfQuote(status, made))
    for (const status of INQUIRY_STATUSES) expect(REQUEST_GROUPS).toContain(groupOfRequest(status))
    for (const status of REQUEST_STATUSES) expect(PORTAL_GROUPS).toContain(groupOfPortalOrder(status, 'ORDER'))
    // Who each group waits on; the closed ones on nobody.
    for (const group of CLOSED_GROUPS) expect(GROUP_WAITS_ON[group], group).toBeNull()
    expect(GROUP_WAITS_ON).toMatchObject({ WRITING: 'CUSTOMER', TO_ANSWER: 'US', APPROVAL: 'APPROVER', WAITING_CUSTOMER: 'CUSTOMER', ORDER_WAITS: 'US' })
  })

  it('the rule, state by state (research §2)', () => {
    const quote = (status: QuoteStatus, made = false) => groupOfQuote(status, made)
    expect([quote('DRAFT'), quote('APPROVED'), quote('PENDING_APPROVAL'), quote('SENT')]).toEqual(['PREPARING', 'PREPARING', 'APPROVAL', 'WAITING_CUSTOMER'])
    expect([quote('ACCEPTED', false), quote('ACCEPTED', true)]).toEqual(['ORDER_WAITS', 'WON'])
    expect([quote('DECLINED'), quote('EXPIRED'), quote('CANCELLED')]).toEqual(['LOST', 'LOST', 'LOST'])
    const request = (status: InquiryStatus) => groupOfRequest(status)
    expect(['NEW', 'ASSIGNED', 'NEED_INFO', 'ORDERED', 'QUOTED'].map((status) => request(status as InquiryStatus))).toEqual(['TO_ANSWER', 'TO_ANSWER', 'WAITING_CUSTOMER', 'WON', 'MOVED'])
    // Every decline (also "Not an order") and the customer's own withdrawal are LOST: the chip says why (C6).
    expect(['DECLINED', 'LOST', 'WITHDRAWN'].map((status) => request(status as InquiryStatus))).toEqual(['LOST', 'LOST', 'LOST'])
    expect(groupOfPortalOrder('DRAFT', null)).toBe('WRITING')
    expect(groupOfPortalOrder('SENT', null)).toBe('TO_ANSWER')
    expect(groupOfPortalOrder('ACCEPTED', 'ORDER')).toBe('WON')
    expect(groupOfPortalOrder('ACCEPTED', 'QUOTE')).toBe('MOVED')
    expect([groupOfPortalOrder('REFUSED', null), groupOfPortalOrder('WITHDRAWN', null)]).toEqual(['LOST', 'LOST'])
  })

  it('each kind’s status sets are the inverse of its groupOf (the server builds its wheres from them)', () => {
    for (const group of QUOTE_GROUPS) for (const status of QUOTE_GROUP_STATUSES[group]) expect([false, true].some((made) => groupOfQuote(status, made) === group), `${group} ${status}`).toBe(true)
    for (const status of QUOTE_STATUSES) for (const made of [false, true]) expect(QUOTE_GROUP_STATUSES[groupOfQuote(status, made)], `${status} ${made}`).toContain(status)
    for (const group of REQUEST_GROUPS) for (const status of REQUEST_GROUP_STATUSES[group]) expect(groupOfRequest(status)).toBe(group)
    for (const status of INQUIRY_STATUSES) expect(REQUEST_GROUP_STATUSES[groupOfRequest(status)]).toContain(status)
    for (const group of PORTAL_GROUPS) for (const status of PORTAL_GROUP_STATUSES[group]) expect((['ORDER', 'QUOTE', null] as const).some((became) => groupOfPortalOrder(status, became) === group), `${group} ${status}`).toBe(true)
    for (const status of REQUEST_STATUSES) expect(PORTAL_GROUP_STATUSES[groupOfPortalOrder(status, 'QUOTE')]).toContain(status)
    // The statuses of a kind's groups are disjoint but for the one split by a fact (ACCEPTED: an order or not).
    const quoteStatuses = QUOTE_GROUPS.flatMap((group) => QUOTE_GROUP_STATUSES[group]).filter((status) => status !== 'ACCEPTED')
    expect(new Set(quoteStatuses).size).toBe(quoteStatuses.length)
    expect([...new Set(QUOTE_GROUPS.flatMap((group) => QUOTE_GROUP_STATUSES[group]))].sort()).toEqual([...QUOTE_STATUSES].sort())
    expect([...new Set(REQUEST_GROUPS.flatMap((group) => REQUEST_GROUP_STATUSES[group]))].sort()).toEqual([...INQUIRY_STATUSES].sort())
    expect([...new Set(PORTAL_GROUPS.flatMap((group) => PORTAL_GROUP_STATUSES[group]))].sort()).toEqual([...REQUEST_STATUSES].sort())
  })

  it('OPEN_QUOTES = PREPARING ∪ APPROVAL ∪ the quotes of WAITING_CUSTOMER; LIVE = groups 3–6; every term names quote groups only', () => {
    const open = QUOTE_TERM_GROUPS.OPEN_QUOTES.flatMap((group) => QUOTE_GROUP_STATUSES[group])
    expect([...open].sort()).toEqual([...OPEN_QUOTES].sort())
    expect(QUOTE_TERM_GROUPS.LIVE).toEqual(['PREPARING', 'APPROVAL', 'WAITING_CUSTOMER', 'ORDER_WAITS'])
    expect(LIVE_GROUPS.slice(2)).toEqual([...QUOTE_TERM_GROUPS.LIVE])
    for (const term of QUOTE_GROUP_TERMS) for (const group of QUOTE_TERM_GROUPS[term]) expect(QUOTE_GROUPS).toContain(group)
    // A door group no quote is in is no term (the web folds the Quotes section instead).
    for (const group of ['WRITING', 'TO_ANSWER', 'MOVED']) expect(QUOTE_GROUP_TERMS as readonly string[]).not.toContain(group)
    // Each before-order door on Incoming is one of its tiles (the two new ones included, appended at the end).
    for (const tile of Object.values(INCOMING_TILE_OF)) expect(INCOMING_TILES as readonly string[]).toContain(tile)
    expect(INCOMING_TILE_OF).toEqual({ TO_ANSWER: 'TO_ANSWER', WAITING_CUSTOMER: 'WAITING_CUSTOMER', WON: 'ORDERED', MOVED: 'QUOTED', LOST: 'ENDED' })
    expect(ENDS_SOON_DAYS).toBe(7)
  })

  it('the counts: each kind per group, the groups null only when every kind they hold is gated out, open quotes and waits on us', () => {
    const quotes = quoteGroupCounts({ DRAFT: 2, APPROVED: 1, PENDING_APPROVAL: 1, SENT: 3, ACCEPTED: 4, DECLINED: 1, EXPIRED: 1, CANCELLED: 1 }, 3)
    expect(quotes).toEqual({ PREPARING: 3, APPROVAL: 1, WAITING_CUSTOMER: 3, ORDER_WAITS: 1, WON: 3, LOST: 3 })
    const requests = requestGroupCounts({ NEW: 1, ASSIGNED: 1, NEED_INFO: 2, ORDERED: 1, QUOTED: 1, DECLINED: 2, LOST: 1, WITHDRAWN: 1 })
    expect(requests).toEqual({ TO_ANSWER: 2, WAITING_CUSTOMER: 2, WON: 1, MOVED: 1, LOST: 4 })
    const portal = portalGroupCounts({ DRAFT: 5, SENT: 1, ACCEPTED: 2, REFUSED: 1, WITHDRAWN: 1 }, 1)
    // A draft is never counted among the sent ones.
    expect(portal).toEqual({ TO_ANSWER: 1, WON: 1, MOVED: 1, LOST: 2 })
    const everyone = beforeOrderGroupsOf({ quotes, requests, portalOrders: portal, drafts: 5 })
    expect(everyone).toEqual({ WRITING: 5, TO_ANSWER: 3, PREPARING: 3, APPROVAL: 1, WAITING_CUSTOMER: 5, ORDER_WAITS: 1, WON: 5, MOVED: 2, LOST: 9 })
    expect(openQuotesOf(quotes)).toBe(7)
    expect(waitsOnUsOf(everyone)).toBe(4)
    // Finance-like (quotes and drafts, no requests right): TO_ANSWER and MOVED left out, the rest the quotes' alone.
    const finance = beforeOrderGroupsOf({ quotes, requests: null, portalOrders: null, drafts: 5 })
    expect(finance).toMatchObject({ WRITING: 5, TO_ANSWER: null, MOVED: null, WAITING_CUSTOMER: 3, WON: 3, LOST: 3 })
    expect(waitsOnUsOf(finance)).toBe(1)
    // Production-manager-like (requests only): the quote groups left out, never a guessed 0.
    const production = beforeOrderGroupsOf({ quotes: null, requests, portalOrders: null, drafts: null })
    expect(production).toMatchObject({ WRITING: null, PREPARING: null, APPROVAL: null, ORDER_WAITS: null, TO_ANSWER: 2, WAITING_CUSTOMER: 2 })
    expect(openQuotesOf(null)).toBeNull()
    expect(waitsOnUsOf(production)).toBe(2)
    const nothing = beforeOrderGroupsOf({ quotes: null, requests: null, portalOrders: null, drafts: null })
    for (const group of BEFORE_ORDER_GROUPS) expect(nothing[group], group).toBeNull()
    expect(waitsOnUsOf(nothing)).toBeNull()
    // 0 is kept as 0 (the reader may read the kind; no row in reach).
    expect(beforeOrderGroupsOf({ quotes: quoteGroupCounts({}, 0), requests: null, portalOrders: null, drafts: 0 })).toMatchObject({ WRITING: 0, PREPARING: 0, WON: 0, TO_ANSWER: null })
  })

  it('the contracts: the query names the customer; the answer holds counts only (no amount, no person)', () => {
    expect(beforeOrderCountsQuery.safeParse({}).success).toBe(false)
    expect(beforeOrderCountsQuery.safeParse({ partyId: 'not-an-id' }).success).toBe(false)
    expect(beforeOrderCountsQuery.safeParse({ partyId: '018f7a2b-1c3d-7e4f-8a9b-0c1d2e3f4a5b', extra: 1 }).success).toBe(false)
    const parsed = beforeOrderCountsQuery.safeParse({})
    expect(parsed.success ? null : parsed.error.issues[0]?.message).toBe('Name the customer.')
    expect(BEFORE_ORDER_PARTIES_MAX).toBe(50)
    const groups = beforeOrderGroupsOf({ quotes: null, requests: null, portalOrders: null, drafts: null })
    const counts = { groups, openQuotes: null, waitsOnUs: null, byKind: { quotes: null, requests: null, portalOrders: null, drafts: null } }
    expect(beforeOrderCounts.parse(counts)).toEqual(counts)
    const answer = beforeOrderCountsAnswer.parse({ ...counts, partyId: '018f7a2b-1c3d-7e4f-8a9b-0c1d2e3f4a5b', sampleRounds: 2, asOf: '2026-11-23T09:00:00.000Z' })
    expect(Object.keys(answer).sort()).toEqual(['asOf', 'byKind', 'groups', 'openQuotes', 'partyId', 'sampleRounds', 'waitsOnUs'])
    expect(Object.keys(answer.groups)).toEqual([...BEFORE_ORDER_GROUPS])
    expect(beforeOrderCounts.safeParse({ ...counts, openQuotes: -1 }).success).toBe(false)
  })
})

describe('B-CQ-011 / B-CQ-022 most urgent first', () => {
  const today = '2026-11-23'
  const quote = (id: string, more: Partial<QuoteUrgencyFacts>): QuoteUrgencyFacts => ({ id, status: 'DRAFT', orderMade: false, approval: null, validUntil: null, sentAt: null, closedAt: null, updatedAt: '2026-11-01T09:00:00.000Z', ...more })
  const order = (rows: QuoteUrgencyFacts[]) => [...rows].sort(byUrgency((row: QuoteUrgencyFacts) => quoteUrgencyKey(row, today))).map((row) => row.id)

  it('each tier above the next: order waits · approval · our move · ends soon · sent · closed', () => {
    const rows = [
      quote('closed', { status: 'DECLINED', updatedAt: '2026-11-20T09:00:00.000Z' }),
      quote('sent-old', { status: 'SENT', sentAt: '2026-11-03T09:00:00.000Z', validUntil: '2026-12-31' }),
      quote('ends-soon', { status: 'SENT', sentAt: '2026-11-20T09:00:00.000Z', validUntil: '2026-11-26' }),
      quote('draft', { status: 'DRAFT' }),
      quote('rejected', { status: 'DRAFT', approval: { status: 'REJECTED', createdAt: '2026-11-02T09:00:00.000Z' }, updatedAt: '2026-11-10T09:00:00.000Z' }),
      quote('approved', { status: 'APPROVED', updatedAt: '2026-11-15T09:00:00.000Z' }),
      quote('approval', { status: 'PENDING_APPROVAL', approval: { status: 'PENDING', createdAt: '2026-11-05T09:00:00.000Z' } }),
      quote('waits', { status: 'ACCEPTED', orderMade: false, closedAt: '2026-11-18T09:00:00.000Z' }),
      quote('won', { status: 'ACCEPTED', orderMade: true, updatedAt: '2026-11-21T09:00:00.000Z' }),
    ]
    expect(order(rows)).toEqual(['waits', 'approval', 'approved', 'rejected', 'draft', 'ends-soon', 'sent-old', 'won', 'closed'])
  })

  it('inside a tier the oldest wait first; a SENT ending in 3 days above one sent 20 days ago; a past last day in tier 4; ties by id', () => {
    expect(order([quote('b', { status: 'SENT', sentAt: '2026-11-03T09:00:00.000Z', validUntil: '2027-01-31' }), quote('a', { status: 'SENT', sentAt: '2026-11-20T09:00:00.000Z', validUntil: '2026-11-26' })])).toEqual(['a', 'b'])
    // Already past and not yet expired by the morning job: still "ends soon", and first of them.
    expect(order([quote('soon', { status: 'SENT', validUntil: '2026-11-25' }), quote('past', { status: 'SENT', validUntil: '2026-11-21' }), quote('far', { status: 'SENT', sentAt: '2026-10-01T09:00:00.000Z', validUntil: '2026-12-31' })])).toEqual(['past', 'soon', 'far'])
    expect(quoteUrgencyKey(quote('edge', { status: 'SENT', validUntil: '2026-11-30' }), today)[0]).toBe(4)
    expect(quoteUrgencyKey(quote('edge', { status: 'SENT', validUntil: '2026-12-01' }), today)[0]).toBe(5)
    expect(order([quote('w2', { status: 'ACCEPTED', closedAt: '2026-11-19T09:00:00.000Z' }), quote('w1', { status: 'ACCEPTED', closedAt: '2026-11-10T09:00:00.000Z' })])).toEqual(['w1', 'w2'])
    // Closed: the newest change first.
    expect(order([quote('old', { status: 'EXPIRED', updatedAt: '2026-10-01T09:00:00.000Z' }), quote('new', { status: 'CANCELLED', updatedAt: '2026-11-01T09:00:00.000Z' })])).toEqual(['new', 'old'])
    expect(order([quote('y', {}), quote('x', {})])).toEqual(['x', 'y'])
  })

  it('Incoming: overdue on us above on us above waiting for the customer above closed; inside, the longest wait, the earliest wanted day', () => {
    const row = (id: string, more: Partial<IncomingUrgencyFacts>): IncomingUrgencyFacts => ({ id, open: true, waitsOnUs: true, overdue: false, workingMinutes: 60, wantedDate: null, receivedAt: '2026-11-20T09:00:00.000Z', ...more })
    const rank = (rows: IncomingUrgencyFacts[]) => [...rows].sort(byUrgency(incomingUrgencyKey)).map((entry) => entry.id)
    expect(rank([row('closed', { open: false, waitsOnUs: false, workingMinutes: null }), row('need-info', { waitsOnUs: false, workingMinutes: null }), row('ours', {}), row('late', { overdue: true, workingMinutes: 900 })])).toEqual(['late', 'ours', 'need-info', 'closed'])
    expect(rank([row('short', { workingMinutes: 30 }), row('long', { workingMinutes: 300 })])).toEqual(['long', 'short'])
    expect(rank([row('none', {}), row('later', { wantedDate: '2026-12-20' }), row('sooner', { wantedDate: '2026-12-01' })])).toEqual(['sooner', 'later', 'none'])
    expect(rank([row('c2', { open: false, receivedAt: '2026-11-01T09:00:00.000Z' }), row('c1', { open: false, receivedAt: '2026-11-10T09:00:00.000Z' })])).toEqual(['c1', 'c2'])
  })
})
