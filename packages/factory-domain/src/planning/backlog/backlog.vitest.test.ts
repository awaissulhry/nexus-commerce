import { describe, expect, it } from 'vitest'
import { brandSlots, rankedBacklog, rankProblems, RULE_WORDS, ruleCompare, urgencyCounts, whyWords, type BacklogOrder } from './rank'

const order = (number: string, over: Partial<BacklogOrder> = {}): BacklogOrder => ({
  id: `id-${number}`,
  number,
  rank: null,
  priorityLevel: 'NORMAL',
  priority: 0,
  promise: '2026-12-10',
  customerCode: 'C1',
  orderDate: '2026-11-01',
  ...over,
})

describe('the backlog ranked (PLN-177)', () => {
  it('by the rule: priority level, priority number, promise, customer, order date, number', () => {
    const orders = [
      order('SO-5', { promise: null }),
      order('SO-4', { customerCode: 'C2' }),
      order('SO-3', { promise: '2026-12-01' }),
      order('SO-2', { priority: 5 }),
      order('SO-1', { priorityLevel: 'LOW', promise: '2026-11-20' }),
      order('SO-0', { priorityLevel: 'URGENT', promise: '2026-12-30' }),
      order('SO-6', { orderDate: '2026-10-01' }),
    ]
    expect(rankedBacklog(orders).map((entry) => entry.number)).toEqual(['SO-0', 'SO-2', 'SO-3', 'SO-6', 'SO-4', 'SO-5', 'SO-1'])
  })

  it('ranked by hand first (ties by the rule), then the rest by the rule', () => {
    const orders = [order('SO-1', { priorityLevel: 'URGENT' }), order('SO-2', { rank: 2 }), order('SO-3', { rank: 1 }), order('SO-4', { rank: 2, promise: '2026-11-30' })]
    const ranked = rankedBacklog(orders)
    expect(ranked.map((entry) => [entry.number, entry.position, entry.rulePosition])).toEqual([
      ['SO-3', 1, 4],
      ['SO-4', 2, 2],
      ['SO-2', 3, 3],
      ['SO-1', 4, 1],
    ])
    expect(whyWords(ranked[0]!, (date) => date)).toBe('Ranked by hand: 1.')
    expect(whyWords(ranked[3]!, (date) => date)).toBe('By the rule: urgent priority, promised 2026-12-10, customer C1.')
  })

  it('refuses a ranking with a twice-named order or a rank out of 1 to 1 000 000', () => {
    expect(rankProblems([{ orderId: 'a', from: null, to: 1 }])).toEqual([])
    expect(rankProblems([{ orderId: 'a', from: null, to: 0 }, { orderId: 'a', from: 1, to: null }, { orderId: 'b', from: null, to: 1.5 }]).map((problem) => problem.path)).toEqual(['body/ranks/0/to', 'body/ranks/1/orderId', 'body/ranks/2/to'])
    expect(rankProblems([])[0]!.path).toBe('body/ranks')
  })
})

// ---- B-PR-41: the brand-slot pass (production plan §3 "Brand-slot rule"; review fixes R-40, R-46) -------------------------

describe("the backlog's brand-slot pass: a customer's urgency moves only its own places (B-PR-41)", () => {
  // Customer A (code CA) and customer B (code CB), interleaved by promise in the NORMAL level; one A order of the HIGH level;
  // one A order a planner ranked by hand.
  const backlog: BacklogOrder[] = [
    order('A-1', { customerCode: 'CA', promise: '2026-12-01' }),
    order('B-1', { customerCode: 'CB', promise: '2026-12-02' }),
    order('A-2', { customerCode: 'CA', promise: '2026-12-03' }),
    order('B-2', { customerCode: 'CB', promise: '2026-12-04' }),
    order('A-3', { customerCode: 'CA', promise: '2026-12-05' }),
    order('B-3', { customerCode: 'CB', promise: '2026-12-06' }),
    order('A-4', { customerCode: 'CA', promise: '2026-12-07' }),
    order('A-5', { customerCode: 'CA', promise: '2026-12-08' }),
    order('A-HIGH', { customerCode: 'CA', priorityLevel: 'HIGH', promise: '2026-12-20' }),
    order('A-HAND', { customerCode: 'CA', rank: 1, promise: '2026-12-30' }),
  ]
  const places = (orders: readonly BacklogOrder[]) => new Map(rankedBacklog(orders).map((entry) => [entry.number, entry.position]))
  const marked = (urgent: Readonly<Record<string, number>>, urgencyOn = true): BacklogOrder[] =>
    backlog.map((entry) => (entry.number in urgent ? { ...entry, customerUrgency: 'URGENT' as const, urgentRank: urgent[entry.number]!, urgencyOn } : { ...entry, urgencyOn }))

  it('without any mark the order is the rule\'s (hand rank first), as before', () => {
    expect(rankedBacklog(backlog).map((entry) => entry.number)).toEqual(['A-HAND', 'A-HIGH', 'A-1', 'B-1', 'A-2', 'B-2', 'A-3', 'B-3', 'A-4', 'A-5'])
    // The rule's words and compare are unchanged.
    expect(RULE_WORDS).toMatch(/^Ranked by hand first/)
    expect([...backlog].sort(ruleCompare).map((entry) => entry.number)[0]).toBe('A-HIGH')
  })

  it("wall (PW-18 pure): brand B's places are identical before and after brand A marks 3 urgent", () => {
    const before = places(backlog)
    const after = places(marked({ 'A-5': 1, 'A-4': 2, 'A-HIGH': 3 }))
    for (const number of ['B-1', 'B-2', 'B-3']) expect(after.get(number), number).toBe(before.get(number))
    // A's urgent orders took the earliest places A's own NORMAL orders held (A-1's and A-2's), in A's urgent order.
    expect(after.get('A-5')).toBe(before.get('A-1'))
    expect(after.get('A-4')).toBe(before.get('A-2'))
    // A's other NORMAL orders follow in the places left, as they stood.
    expect([after.get('A-1'), after.get('A-2'), after.get('A-3')]).toEqual([before.get('A-3'), before.get('A-4'), before.get('A-5')])
    // A's NORMAL places as a set never change.
    const normalOfA = (map: Map<string, number>) => ['A-1', 'A-2', 'A-3', 'A-4', 'A-5'].map((number) => map.get(number)!).sort((x, y) => x - y)
    expect(normalOfA(after)).toEqual(normalOfA(before))
  })

  it('an urgent order never takes a hand-ranked place nor leaves its office level; a hand-ranked urgent order keeps its place', () => {
    const before = places(backlog)
    const after = places(marked({ 'A-HAND': 1, 'A-HIGH': 2, 'A-5': 3 }))
    expect(after.get('A-HAND')).toBe(before.get('A-HAND'))
    expect(after.get('A-HIGH')).toBe(before.get('A-HIGH'))
    expect(after.get('A-5')).toBe(before.get('A-1'))
    expect(urgencyCounts({ ...backlog.at(-1)!, customerUrgency: 'URGENT', urgentRank: 1, urgencyOn: true })).toBe(false)
  })

  it("with the customer's switch off the marks change nothing (kept dormant, R-46)", () => {
    expect(rankedBacklog(marked({ 'A-5': 1, 'A-4': 2 }, false)).map((entry) => [entry.number, entry.position])).toEqual(rankedBacklog(backlog).map((entry) => [entry.number, entry.position]))
  })

  it("the place by the rule alone stays the rule's; the why names the customer's own places", () => {
    const ranked = rankedBacklog(marked({ 'A-5': 1 }))
    const a5 = ranked.find((entry) => entry.number === 'A-5')!
    expect(a5.rulePosition).toBe(rankedBacklog(backlog).find((entry) => entry.number === 'A-5')!.rulePosition)
    expect(whyWords(a5, (date) => date)).toBe('By the rule: normal priority, promised 2026-12-08, customer CA; customer urgency: own places (urgent 1).')
    expect(whyWords(ranked.find((entry) => entry.number === 'B-1')!, (date) => date)).toBe('By the rule: normal priority, promised 2026-12-02, customer CB.')
    // The pass alone, on an order list: B's entries are the same objects in the same places.
    const ordered = rankedBacklog(backlog)
    const passed = brandSlots(ordered.map((entry) => (entry.number === 'A-3' ? { ...entry, customerUrgency: 'URGENT' as const, urgentRank: 1, urgencyOn: true } : entry)))
    passed.forEach((entry, index) => {
      if (entry.customerCode === 'CB') expect(entry).toBe(ordered[index])
    })
  })
})
