import { describe, expect, it } from 'vitest'
import { blockedByOf, compareKeys, decodeCursor, encodeCursor, mergeWaiting, pageOf, passes, riskOf, riskRank, type RiskInput, type SortKey } from './risk'

/**
 * B-PR-34 — the work order list by risk, pure (./risk): the risk of one work order from what is stored (status, due date, planned
 * end, holds, the keeper's waiting-on, a person's raise), the order of the risk and due sorts, the merged waiting of several
 * orders, and the opaque cursor over (risk, due, id). Run with `cd apps/factory-api && npx vitest run
 * src/modules/production/work-orders/risk.vitest.test.ts`.
 */

const TODAY = '2026-11-18'
const input = (patch: Partial<RiskInput> = {}): RiskInput => ({ status: 'RELEASED', dueDate: '2026-11-30', plannedEnd: null, waiting: null, raised: null, ...patch })
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`

describe('the risk of one work order', () => {
  it('LATE past its due date while open (on hold too), with the days late', () => {
    expect(riskOf(input({ dueDate: '2026-11-14' }), TODAY)).toMatchObject({ state: 'LATE', daysLate: 4, blockedBy: null })
    expect(riskOf(input({ status: 'ON_HOLD', dueDate: '2026-11-17' }), TODAY)).toMatchObject({ state: 'LATE', daysLate: 1, blockedBy: 'HOLD' })
    // Due today is not late yet.
    expect(riskOf(input({ dueDate: TODAY }), TODAY)).toMatchObject({ state: 'ON_TRACK', daysLate: null })
  })

  it('AT_RISK when its working plan ends after its due date, or a person raised its order (the reason travels)', () => {
    expect(riskOf(input({ plannedEnd: '2026-12-02' }), TODAY)).toMatchObject({ state: 'AT_RISK', planAfterDue: true, plannedEnd: '2026-12-02', raised: null })
    expect(riskOf(input({ plannedEnd: '2026-11-30' }), TODAY)).toMatchObject({ state: 'ON_TRACK', planAfterDue: false })
    expect(riskOf(input({ raised: 'CAPACITY' }), TODAY)).toMatchObject({ state: 'AT_RISK', planAfterDue: false, raised: 'CAPACITY' })
    // No due date: the plan cannot be after it.
    expect(riskOf(input({ dueDate: null, plannedEnd: '2027-01-10' }), TODAY)).toMatchObject({ state: 'ON_TRACK', planAfterDue: false })
    // Late wins over at risk.
    expect(riskOf(input({ dueDate: '2026-11-10', plannedEnd: '2026-12-02', raised: 'QUALITY' }), TODAY)?.state).toBe('LATE')
  })

  it('BLOCKED on hold, or when its order waits on the customer or a supplier; a workshop or us is no block', () => {
    expect(riskOf(input({ status: 'ON_HOLD' }), TODAY)).toMatchObject({ state: 'BLOCKED', blockedBy: 'HOLD' })
    expect(riskOf(input({ waiting: { on: 'BRAND', since: null } }), TODAY)).toMatchObject({ state: 'BLOCKED', blockedBy: 'CUSTOMER' })
    expect(riskOf(input({ waiting: { on: 'SUPPLIER', since: null } }), TODAY)).toMatchObject({ state: 'BLOCKED', blockedBy: 'MATERIAL' })
    expect(riskOf(input({ waiting: { on: 'WORKSHOP', since: null } }), TODAY)).toMatchObject({ state: 'ON_TRACK', blockedBy: null })
    expect(riskOf(input({ waiting: { on: 'US', since: null } }), TODAY)).toMatchObject({ state: 'ON_TRACK', blockedBy: null })
    // At risk wins over blocked; the block is still said.
    expect(riskOf(input({ status: 'ON_HOLD', raised: 'MATERIAL_LATE' }), TODAY)).toMatchObject({ state: 'AT_RISK', blockedBy: 'HOLD' })
  })

  it('a finished work order has no risk and nothing blocks it', () => {
    for (const status of ['COMPLETED', 'CLOSED', 'CANCELLED'] as const) {
      expect(riskOf(input({ status, dueDate: '2026-11-01', waiting: { on: 'BRAND', since: null } }), TODAY)).toBeNull()
      expect(blockedByOf(status, { on: 'BRAND', since: null })).toBeNull()
    }
    expect(riskRank(null)).toBe(4)
    expect(riskRank(riskOf(input({ dueDate: '2026-11-01' }), TODAY))).toBe(0)
    expect(riskRank(riskOf(input(), TODAY))).toBe(3)
  })
})

describe('what several orders wait on', () => {
  it('the first owner in the order customer → supplier → workshop → us, since its earliest row', () => {
    const early = new Date('2026-11-02T08:00:00.000Z')
    const late = new Date('2026-11-09T08:00:00.000Z')
    expect(mergeWaiting([{ on: 'US', since: early }, { on: 'BRAND', since: late }, { on: 'BRAND', since: early }])).toEqual({ on: 'BRAND', since: early })
    expect(mergeWaiting([{ on: 'WORKSHOP', since: null }, { on: 'SUPPLIER', since: null }])).toEqual({ on: 'SUPPLIER', since: null })
    expect(mergeWaiting([])).toBeNull()
  })

  it('the computed filters', () => {
    const facts = { risk: riskOf(input({ status: 'ON_HOLD' }), TODAY), waiting: { on: 'US' as const, since: null } }
    expect(passes(facts, {})).toBe(true)
    expect(passes(facts, { waitingOn: 'US', risk: 'BLOCKED', blockedBy: 'HOLD' })).toBe(true)
    expect(passes(facts, { waitingOn: 'BRAND' })).toBe(false)
    expect(passes(facts, { risk: 'LATE' })).toBe(false)
    expect(passes(facts, { blockedBy: 'CUSTOMER' })).toBe(false)
    // A finished work order passes no computed filter.
    expect(passes({ risk: null, waiting: null }, { risk: 'ON_TRACK' })).toBe(false)
    expect(passes(undefined, { waitingOn: 'US' })).toBe(false)
  })
})

describe('the sorts and the cursor', () => {
  const rows: { key: SortKey }[] = [
    { key: { rank: 3, due: '2026-11-20', id: id(1) } },
    { key: { rank: 0, due: '2026-11-10', id: id(2) } },
    { key: { rank: 0, due: '2026-11-02', id: id(3) } },
    { key: { rank: 1, due: null, id: id(4) } },
    { key: { rank: 1, due: '2026-12-01', id: id(5) } },
    { key: { rank: 4, due: '2026-11-01', id: id(6) } },
    { key: { rank: 2, due: '2026-11-25', id: id(7) } },
    { key: { rank: 2, due: '2026-11-25', id: id(8) } },
  ]
  const order = (sort: 'risk' | 'due' | 'newest') => [...rows].sort((a, b) => compareKeys(sort, a.key, b.key)).map((row) => row.key.id)

  it('risk: late (most days first), at risk, blocked, on track, finished; each by due date (none last), then newest', () => {
    expect(order('risk')).toEqual([id(3), id(2), id(5), id(4), id(8), id(7), id(1), id(6)])
  })

  it('due: by due date (none last), then newest; newest: by id', () => {
    expect(order('due')).toEqual([id(6), id(3), id(2), id(1), id(8), id(7), id(5), id(4)])
    expect(order('newest')).toEqual([id(8), id(7), id(6), id(5), id(4), id(3), id(2), id(1)])
  })

  it('pages after the cursor, even when the last row read left the list meanwhile', () => {
    const first = pageOf(rows, 'risk', null, 3)
    expect(first.page.map((row) => row.key.id)).toEqual([id(3), id(2), id(5)])
    expect(first.next).toBe(`risk~1~2026-12-01~${id(5)}`)
    const after = decodeCursor('risk', first.next!)!
    const second = pageOf(rows.filter((row) => row.key.id !== id(5)), 'risk', after, 3)
    expect(second.page.map((row) => row.key.id)).toEqual([id(4), id(8), id(7)])
    const third = pageOf(rows, 'risk', decodeCursor('risk', second.next!), 3)
    expect(third.page.map((row) => row.key.id)).toEqual([id(1), id(6)])
    expect(third.next).toBeNull()
  })

  it('newest keeps the plain id cursor; a computed sort takes only its own token, else refused in words', () => {
    expect(encodeCursor('newest', { rank: 2, due: '2026-11-01', id: id(9) })).toBe(id(9))
    expect(decodeCursor('newest', id(9))).toEqual({ rank: 0, due: null, id: id(9) })
    expect(decodeCursor('due', `due~0~~${id(9)}`)).toEqual({ rank: 0, due: null, id: id(9) })
    expect(decodeCursor('risk', undefined)).toBeNull()
    expect(() => decodeCursor('newest', `risk~0~~${id(9)}`)).toThrow(/start from the first page/)
    expect(() => decodeCursor('risk', id(9))).toThrow(/start from the first page/)
    expect(() => decodeCursor('risk', `due~0~2026-11-01~${id(9)}`)).toThrow(/start from the first page/)
    expect(() => decodeCursor('due', 'due~0~2026-11-01~not-an-id-of-thirty-six-characters!!')).toThrow(/start from the first page/)
  })
})

// ── B-PR-22b ──
describe("B-PR-22b the risk sort's tie: the customer's urgency (06-tree §0.4 \"ties by brand priority\")", () => {
  it('same risk and due date: the customer-urgent work order first (by its place in its customer\'s list), then the newest; other sorts ignore it', () => {
    const rows: { key: SortKey }[] = [
      { key: { rank: 1, due: '2026-12-01', id: id(1) } },
      { key: { rank: 1, due: '2026-12-01', id: id(2), urgent: 2 } },
      { key: { rank: 1, due: '2026-12-01', id: id(3), urgent: 1 } },
      { key: { rank: 0, due: '2026-12-09', id: id(4) } },
      { key: { rank: 1, due: '2026-11-30', id: id(5) } },
    ]
    const order = (sort: 'risk' | 'due' | 'newest') => [...rows].sort((a, b) => compareKeys(sort, a.key, b.key)).map((row) => row.key.id)
    // A late one first; then at risk by due date; among the same due date the urgent ones (1st, 2nd), then the newest.
    expect(order('risk')).toEqual([id(4), id(5), id(3), id(2), id(1)])
    expect(order('due')).toEqual([id(5), id(3), id(2), id(1), id(4)])
  })

  it("the risk token carries the tie (u<place>) and pages after it; a due token never does", () => {
    const rows: { key: SortKey }[] = [
      { key: { rank: 1, due: '2026-12-01', id: id(1) } },
      { key: { rank: 1, due: '2026-12-01', id: id(2), urgent: 2 } },
      { key: { rank: 1, due: '2026-12-01', id: id(3), urgent: 1 } },
    ]
    const first = pageOf(rows, 'risk', null, 1)
    expect(first.next).toBe(`risk~1~2026-12-01~u1~${id(3)}`)
    expect(decodeCursor('risk', first.next!)).toEqual({ rank: 1, due: '2026-12-01', id: id(3), urgent: 1 })
    const second = pageOf(rows, 'risk', decodeCursor('risk', first.next!), 1)
    expect(second.page.map((row) => row.key.id)).toEqual([id(2)])
    expect(pageOf(rows, 'risk', decodeCursor('risk', second.next!), 5).page.map((row) => row.key.id)).toEqual([id(1)])
    expect(encodeCursor('due', { rank: 1, due: '2026-12-01', id: id(3), urgent: 1 })).toBe(`due~1~2026-12-01~${id(3)}`)
    expect(() => decodeCursor('due', `due~1~2026-12-01~u1~${id(3)}`)).toThrow(/start from the first page/)
  })
})
