/**
 * ONE BRAIN AB-14 — the bid brain's run as a step of the product cycle (bid-brain/shadow.ts), pure parts: the raises the
 * cycle's earlier steps hold join the brain's own spend guard on a campaign (never replace it), and a run's write decisions
 * counted by direction — stored or not — with the raises per campaign the report's clash check reads.
 * The scope itself (the cycle decides a product's own campaigns, the full run leaves them; a held raise in the decision's
 * why) runs on a real PostgreSQL in brain/cycle-postgres.vitest.test.ts. Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { mergeRaiseCaps, movesOf } from './shadow.js'
import type { Decision } from './decide.js'

describe('AB-14 — the bid brain inside the product cycle', () => {
  it('the cycle\'s holds join the spend guard: one campaign\'s two reasons joined, the others kept as they are', () => {
    const guard = new Map([['c1', 'this hour\'s spend heads above 1.5 × its average'], ['c3', 'the last hour spent above its average']])
    const caps = new Map([['c1', 'the product cycle\'s stops and state step: it pauses Jacket exact (asked)'], ['c2', 'the product cycle\'s money step: the money brake holds every raise']])
    expect(mergeRaiseCaps(guard, caps)).toEqual(new Map([
      ['c1', 'this hour\'s spend heads above 1.5 × its average; the product cycle\'s stops and state step: it pauses Jacket exact (asked)'],
      ['c3', 'the last hour spent above its average'],
      ['c2', 'the product cycle\'s money step: the money brake holds every raise'],
    ]))
    expect(mergeRaiseCaps(undefined, caps)).toEqual(caps)
    expect(guard.size).toBe(2) // the run's own map is not changed
  })

  it('a run\'s write decisions by direction, holds and unchanged bids left out; the raises per campaign', () => {
    const d = (targetId: string, action: string, currentCents: number, bidCents: number) => ({ targetId, action, currentCents, bidCents }) as unknown as Decision
    const campaignOf = (targetId: string) => (targetId.startsWith('a') ? 'c1' : 'c2')
    expect(movesOf([d('a1', 'write', 40, 44), d('a2', 'write', 40, 36), d('b1', 'write', 20, 25), d('b2', 'hold', 20, 30), d('b3', 'write', 20, 20)], campaignOf))
      .toEqual({ raise: 2, lower: 1, raisedBy: { c1: 1, c2: 1 } })
    expect(movesOf([], campaignOf)).toEqual({ raise: 0, lower: 0, raisedBy: {} })
  })
})
