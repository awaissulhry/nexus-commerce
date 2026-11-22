import { describe, expect, it } from 'vitest'
import { isOrderSort, ORDER_SORT_KEYS, ORDER_SORTS, urgentOrderOf, type UrgentSortRow } from './sort'

/**
 * B-CW-030 (customer Work tab plan §3; lead settles S5, S17) — "Most urgent first" as one order of a view's rows, pure (the PG
 * suite server-sort.pg.vitest.test.ts proves the read, the pages and the wall): our level, our number, the promise date, then the
 * customer's own Urgent places inside its own places; the orders that left last, newest first. Every id, number and code is made
 * up (Brand Alpha = ALPHA, Brand Beta = BETA).
 */

const row = (id: string, fields: Partial<UrgentSortRow> = {}): UrgentSortRow => ({ id, number: `T-${id}`, status: 'CONFIRMED', orderDate: '2026-11-01', promise: null, priority: 0, priorityLevel: 'NORMAL', customerCode: 'ALPHA', ...fields })
const NO_MARKS = new Map<string, number | null>()

// One level (Normal) shared by two customers, a High order of Beta, a Low order of Alpha, and three orders that left.
const WORLD: readonly UrgentSortRow[] = [
  row('a1', { promise: '2026-12-10' }),
  row('a2', { promise: '2026-12-20' }),
  row('a3', { promise: '2026-12-30' }),
  row('a4', { promise: '2027-01-09' }),
  row('b1', { promise: '2026-12-15', customerCode: 'BETA' }),
  row('b2', { promise: '2026-12-25', customerCode: 'BETA' }),
  row('h1', { promise: '2027-01-19', customerCode: 'BETA', priorityLevel: 'HIGH' }),
  row('l1', { promise: '2026-12-01', priorityLevel: 'LOW' }),
  row('n9', { promise: '2027-01-29', priority: 9 }),
  row('w1', { promise: '2026-12-05', customerCode: 'BETA', status: 'PENDING_APPROVAL' }),
  row('s1', { status: 'SHIPPED', orderDate: '2026-10-01' }),
  row('s2', { status: 'CANCELLED', orderDate: '2026-10-03', customerCode: 'BETA' }),
  row('s3', { status: 'CLOSED', orderDate: '2026-10-02' }),
]

describe('B-CW-030 the sort key `urgent`', () => {
  it('is one of the list\'s sorts, either way round', () => {
    expect(ORDER_SORT_KEYS).toContain('urgent')
    expect(ORDER_SORTS).toEqual(expect.arrayContaining(['urgent', '-urgent']))
    expect(isOrderSort('urgent')).toBe(true)
    expect(isOrderSort('-urgent')).toBe(true)
    expect(isOrderSort('urgency')).toBe(false)
  })
})

describe('B-CW-030 urgentOrderOf: most urgent first', () => {
  it('no mark counts (none, or the customer\'s switch off): our level, then our number, then the promise date; the orders that left last, newest first', () => {
    const order = urgentOrderOf(WORLD, NO_MARKS)
    // High before Normal before Low; inside Normal our number 9 first, then the earliest promise (an order waiting for a yes too).
    expect(order.open).toEqual(['h1', 'n9', 'w1', 'a1', 'b1', 'a2', 'b2', 'a3', 'a4', 'l1'])
    expect(order.left).toEqual(['s2', 's3', 's1'])
  })

  it('a customer\'s Urgent orders take the earliest places ITS OWN orders hold in that level, by their place in its own list; another customer\'s places never move', () => {
    const marks = new Map<string, number | null>([['a3', 1], ['a4', 2]])
    const plain = urgentOrderOf(WORLD, NO_MARKS).open
    const order = urgentOrderOf(WORLD, marks).open
    expect(order).toEqual(['h1', 'a3', 'w1', 'a4', 'b1', 'n9', 'b2', 'a1', 'a2', 'l1'])
    // Beta's orders stand exactly where they stood (Alpha's marks never put an order ahead of Beta's).
    for (const id of ['h1', 'w1', 'b1', 'b2']) expect(order.indexOf(id), id).toBe(plain.indexOf(id))
    // Alpha's Urgent orders in its own order (1, then 2), ahead of its Regular ones, which keep their own order.
    expect(order.filter((id) => ['a3', 'a4', 'n9', 'a1', 'a2'].includes(id))).toEqual(['a3', 'a4', 'n9', 'a1', 'a2'])
    // The other way round in the customer's own list: the places swap, nothing else moves.
    expect(urgentOrderOf(WORLD, new Map([['a3', 2], ['a4', 1]])).open).toEqual(['h1', 'a4', 'w1', 'a3', 'b1', 'n9', 'b2', 'a1', 'a2', 'l1'])
  })

  it('a mark never crosses our level: an Urgent order of a lower level stays below every order of a higher level', () => {
    const order = urgentOrderOf(WORLD, new Map([['l1', 1]])).open
    expect(order).toEqual(urgentOrderOf(WORLD, NO_MARKS).open)
    expect(order.at(-1)).toBe('l1')
    // Raised by us to High, it stands in that level by the rule (its promise is earlier than Beta's High order).
    const raised = WORLD.map((entry) => (entry.id === 'l1' ? { ...entry, priorityLevel: 'HIGH' as const } : entry))
    expect(urgentOrderOf(raised, NO_MARKS).open.slice(0, 2)).toEqual(['l1', 'h1'])
  })

  it('every order is in exactly one group: what production still has to do with is open, what left is last', () => {
    const order = urgentOrderOf(WORLD, new Map([['a3', 1]]))
    expect([...order.open, ...order.left].sort()).toEqual(WORLD.map((entry) => entry.id).sort())
    const statusOf = new Map(WORLD.map((entry) => [entry.id, entry.status]))
    expect(new Set(order.left.map((id) => statusOf.get(id)))).toEqual(new Set(['SHIPPED', 'CANCELLED', 'CLOSED']))
    const groupOf = (status: UrgentSortRow['status']): 'open' | 'left' => (urgentOrderOf([row('x', { status })], NO_MARKS).open.length === 1 ? 'open' : 'left')
    expect((['PENDING_APPROVAL', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'] as const).map(groupOf)).toEqual(['open', 'open', 'open', 'open', 'open'])
    expect((['SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED'] as const).map(groupOf)).toEqual(['left', 'left', 'left', 'left'])
    // A mark on an order that left orders nothing (the reader never names one: only kept orders count).
    expect(urgentOrderOf(WORLD, new Map([['s1', 1]])).left).toEqual(['s2', 's3', 's1'])
  })

  it('no promise comes after every promise; the same day: the customer, the order date, the number; nothing: an empty order', () => {
    const rows = [row('p0'), row('p1', { promise: '2026-12-01' }), row('p2', { promise: '2026-12-01', customerCode: 'BETA' }), row('p3', { promise: '2026-12-01', orderDate: '2026-10-01' })]
    expect(urgentOrderOf(rows, NO_MARKS).open).toEqual(['p3', 'p1', 'p2', 'p0'])
    expect(urgentOrderOf([], NO_MARKS)).toEqual({ open: [], left: [] })
  })
})
