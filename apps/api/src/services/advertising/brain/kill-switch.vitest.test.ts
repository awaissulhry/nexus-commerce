/**
 * ONE BRAIN AB-15 — the kill switch per lever (brain/kill-switch.ts) and the gate's part of it (ads-write-gate.ts), pure:
 *
 *   precedence  the most specific open kill names the stop (the product's, every product of its market, every product
 *               everywhere); a kill of another lever, product or market stops nothing here
 *   input       a lever of the brain; one product names its market; a kill says why
 *   the gate    only the brain's own actors are held: the bid brain on the levers it writes, the product brain's family on
 *               every lever; a person, auto-undo, the safety owners and other engines never; the refusal names the kill
 *
 * Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { killOf, killScopeWords, killsOfProduct, killTarget, killWords, type BrainKill } from './kill-switch.js'
import { brainKillDecision, brainKillLevers, BRAIN_STATE_ACTOR, PRODUCT_BRAIN_ACTOR } from '../ads-write-gate.js'
import { BRAIN_ACTOR } from '../bid-brain/live.js'
import { MONEY_BUDGETS_ACTOR } from './budget-ladder.js'

const k = (over: Partial<BrainKill>): BrainKill => ({ id: 'k1', lever: 'budgets', productId: 'p1', market: 'IT', by: 'user:owner', reason: 'test stop', at: '2026-10-08T10:00:00.000Z', ...over })

describe('AB-15 — which kill stops a lever (pure)', () => {
  it('the product\'s own kill, else every product of its market, else every product everywhere', () => {
    const own = k({ id: 'own' })
    const market = k({ id: 'market', productId: null })
    const everywhere = k({ id: 'all', productId: null, market: null })
    expect(killOf([everywhere, market, own], { lever: 'budgets', productId: 'p1', market: 'IT' })?.id).toBe('own')
    expect(killOf([everywhere, market], { lever: 'budgets', productId: 'p1', market: 'IT' })?.id).toBe('market')
    expect(killOf([everywhere], { lever: 'budgets', productId: 'p1', market: 'IT' })?.id).toBe('all')
    // A campaign no product's brain can be told: only a kill of every product.
    expect(killOf([own, market], { lever: 'budgets', productId: null, market: 'IT' })?.id).toBe('market')
  })

  it('another lever, product or market stops nothing here', () => {
    const kills = [k({ lever: 'negatives' }), k({ productId: 'p2' }), k({ market: 'DE' }), k({ productId: null, market: 'DE' })]
    expect(killOf(kills, { lever: 'budgets', productId: 'p1', market: 'IT' })).toBeNull()
    expect(killsOfProduct(kills, 'p1', 'IT')).toEqual({ negatives: kills[0] })
  })

  it('in words: who, when, where and why', () => {
    expect(killWords(k({}))).toBe('stopped by the Owner\'s kill switch (user:owner, 2026-10-08, product p1 in IT): "test stop"')
    expect(killScopeWords({ productId: null, market: 'IT' })).toBe('every product in IT')
    expect(killScopeWords({ productId: null, market: null })).toBe('every product in every market')
  })
})

describe('AB-15 — what a kill names (pure)', () => {
  it('a lever of the brain, a market code, one product with its market, and a reason for a kill', () => {
    expect(killTarget({ lever: 'budgets', productId: 'p1', market: 'it', reason: 'test stop' }, 'kill')).toEqual({ lever: 'budgets', productId: 'p1', market: 'IT', reason: 'test stop' })
    expect(killTarget({ lever: 'negatives', reason: 'every product, every market' }, 'kill')).toEqual({ lever: 'negatives', productId: null, market: null, reason: 'every product, every market' })
    expect(killTarget({ lever: 'nope', reason: 'x y z' }, 'kill')).toMatchObject({ refusal: expect.stringMatching(/not a lever of the brain/) })
    expect(killTarget({ lever: 'budgets', productId: 'p1', reason: 'test stop' }, 'kill')).toMatchObject({ refusal: expect.stringMatching(/names its market/) })
    expect(killTarget({ lever: 'budgets', market: 'Narnia', reason: 'test stop' }, 'kill')).toMatchObject({ refusal: expect.stringMatching(/not an Amazon market code/) })
    expect(killTarget({ lever: 'budgets', productId: 'p1', market: 'IT' }, 'kill')).toMatchObject({ refusal: expect.stringMatching(/says why/) })
    // Ending one needs no reason.
    expect(killTarget({ lever: 'budgets', productId: 'p1', market: 'IT' }, 'end')).toEqual({ lever: 'budgets', productId: 'p1', market: 'IT', reason: '' })
  })
})

describe('AB-15 — the gate holds only the brain\'s own actors', () => {
  it('the bid brain on its levers, the product brain\'s family on every lever; never a person or another writer', () => {
    expect(brainKillLevers(['bids', 'budgets', 'placements'], { actor: BRAIN_ACTOR })).toEqual(['bids', 'placements'])
    expect(brainKillLevers(['budgets'], { actor: MONEY_BUDGETS_ACTOR })).toEqual(['budgets'])
    expect(brainKillLevers(['state'], { actor: BRAIN_STATE_ACTOR })).toEqual(['state'])
    expect(brainKillLevers(['negatives'], { actor: `${PRODUCT_BRAIN_ACTOR}-negatives` })).toEqual(['negatives'])
    expect(brainKillLevers(['harvest'], { actor: `${PRODUCT_BRAIN_ACTOR}-harvest` })).toEqual(['harvest'])
    for (const actor of ['automation:auto-undo', 'automation:retail-guard', 'automation:budget-manager', 'automation:auto-bid', 'automation:rule-x', 'user:owner', '']) {
      expect(brainKillLevers(['bids', 'budgets', 'state'], { actor }), actor).toEqual([])
    }
    // A person (manual) is never held, whatever the actor string says.
    expect(brainKillLevers(['budgets'], { actor: MONEY_BUDGETS_ACTOR, manual: true })).toEqual([])
  })

  it('the refusal names the lever, the place, the kill and who may still write', () => {
    const d = brainKillDecision('budgets', k({}), 'campaign "Test" (c1)', MONEY_BUDGETS_ACTOR)
    expect(d).toMatchObject({ allowed: false, deniedAt: 'brain_killed' })
    expect(d.reason).toMatch(/^the daily budget of campaign "Test" \(c1\) is stopped by the Owner's kill switch \(user:owner, 2026-10-08, product p1 in IT\): "test stop": automation:ads-brain-budgets may not change it/)
    expect(d.reason).toMatch(/A person's edit, a request a person approved and the safety checks still pass; the brain's other levers are not affected/)
  })
})
