import { describe, expect, it } from 'vitest'
import { rankedBacklog, rankProblems, whyWords, type BacklogOrder } from './rank'

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
