import { describe, expect, it } from 'vitest'
import { intakeBucketsOf, PROSPECTS_KEY, requestFiguresOf, requestFold, type RequestEntry } from './rules'

// B-TH-052 (threads plan L2-G10): the request-to-order figure, pure.

const entry = (partyId: string | null, receivedOn: string, status: string, facts: Partial<Pick<RequestEntry, 'quoted' | 'ordered' | 'declineReason'>> = {}): RequestEntry => ({
  partyId,
  receivedOn,
  status,
  declineReason: facts.declineReason ?? null,
  quoted: facts.quoted ?? false,
  ordered: facts.ordered ?? false,
})

const ENTRIES: RequestEntry[] = [
  entry('A', '2026-11-02', 'QUOTED', { quoted: true, ordered: true }),
  entry('A', '2026-11-10', 'QUOTED', { quoted: true }),
  entry('A', '2026-11-12', 'ORDERED', { ordered: true }),
  entry('B', '2026-11-18', 'DECLINED', { declineReason: 'PRICE' }),
  entry('B', '2026-11-20', 'NEW'),
  entry('B', '2026-11-21', 'DECLINED', { declineReason: 'NOT_AN_ORDER' }),
  entry(null, '2026-11-24', 'NEED_INFO'),
  entry(null, '2026-11-25', 'LOST'),
]

describe('the request-to-order figure (B-TH-052)', () => {
  it('counts received, open, quoted, ordered, declined, lost; "Not an order" apart and out of the rates', () => {
    expect(requestFiguresOf(ENTRIES)).toEqual({ received: 8, open: 2, quoted: 2, ordered: 2, declined: 1, lost: 1, withdrawn: 0, notAnOrder: 1, quotedPct: '28.6', orderedPct: '28.6' })
    expect(requestFiguresOf([])).toMatchObject({ received: 0, quotedPct: null, orderedPct: null })
    expect(requestFiguresOf([entry('A', '2026-11-02', 'DECLINED', { declineReason: 'NOT_AN_ORDER' })])).toMatchObject({ received: 1, notAnOrder: 1, declined: 0, quotedPct: null })
  })

  it('B-TH-095: a request its customer withdrew is a part of its own, in the rates’ whole; the parts add up to Received', () => {
    const withdrawn = [...ENTRIES, entry('B', '2026-11-26', 'WITHDRAWN')]
    const figures = requestFiguresOf(withdrawn)
    expect(figures).toMatchObject({ received: 9, withdrawn: 1, lost: 1, open: 2, quotedPct: '25.0', orderedPct: '25.0' })
    // Every request is in exactly one end part: open, quoted (or ordered straight), declined, lost, withdrawn, not an order.
    const straight = withdrawn.filter((one) => one.status === 'ORDERED').length
    expect(figures.open + figures.quoted + straight + figures.declined + figures.lost + figures.withdrawn + figures.notAnOrder).toBe(figures.received)
  })

  it('folds by week of arrival and by customer, the prospects in one group, the most requests first', () => {
    const buckets = intakeBucketsOf({ from: '2026-11-01', to: '2026-11-30' }, 'week')
    const fold = requestFold(ENTRIES, buckets)
    expect(fold.buckets.map((bucket) => [bucket.key, bucket.figures.received])).toEqual(buckets.map((bucket) => [bucket.key, ENTRIES.filter((one) => one.receivedOn >= bucket.from && one.receivedOn <= bucket.to).length]))
    expect(fold.buckets.reduce((sum, bucket) => sum + bucket.figures.received, 0)).toBe(8)
    expect(fold.groups.map((group) => [group.key, group.partyId, group.figures.received])).toEqual([
      ['A', 'A', 3],
      ['B', 'B', 3],
      [PROSPECTS_KEY, null, 2],
    ])
    const a = fold.groups[0]!
    expect(a.figures).toMatchObject({ quoted: 2, ordered: 2, quotedPct: '66.7', orderedPct: '66.7' })
    expect(a.buckets.map((bucket) => bucket.figures.received).reduce((x, y) => x + y, 0)).toBe(3)
    const months = requestFold(ENTRIES, intakeBucketsOf({ from: '2026-10-01', to: '2026-11-30' }, 'month'))
    expect(months.buckets.map((bucket) => [bucket.key, bucket.figures.received])).toEqual([
      ['2026-10', 0],
      ['2026-11', 8],
    ])
  })
})
