/**
 * ADS AUTONOMY W1-6b — the pure decisions behind category and product monthly caps (Owner decision D5 = A).
 *
 *   scope spend   a product's spend counts on EVERY cap it falls under (its own row, its parent's, its categories'),
 *                 never on the market's here; a product without spend adds nothing
 *   reached       a cap is reached at its spend or above; a cap of 0 is reached at once
 *   ad groups     an ad group holding ANY product under a reached cap is floored (the safer rule); it is given back
 *                 only when no reached cap covers it any more AND the floor is the deciding engine's own; a floor
 *                 another engine or a person set is never lifted, and an ad group already floored is not floored twice
 * Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { adGroupFloorDecisions, scopeCaps, spendByScope, type ScopeCap } from './spend.js'
import type { CapInForce } from './resolve.js'

const cap = (strategyId: string, level: 'market' | 'category' | 'product', cents: number, label = strategyId): CapInForce => ({
  source: { level, strategyId, scopeId: `scope-${strategyId}`, label, version: 1 },
  monthlySpendCapCents: cents,
})
const MARKET = cap('s-market', 'market', 1_000_000)
const HELMETS = cap('s-helmets', 'category', 5_000, 'Test helmets (IT)')
const PARENT = cap('s-parent', 'product', 3_000, 'TEST-PARENT (IT)')
const GLOVES = cap('s-gloves', 'product', 0, 'TEST-GLOVES (IT)')

describe('spendByScope — each product\'s spend on every category and product cap it falls under', () => {
  it('two variations of one parent in one category: both count on the parent\'s cap and on the category\'s', () => {
    const byScope = spendByScope([
      { productId: 'v1', caps: [PARENT, HELMETS, MARKET] },
      { productId: 'v2', caps: [PARENT, HELMETS, MARKET] },
      { productId: 'other', caps: [HELMETS, MARKET] },
      { productId: 'idle', caps: [GLOVES, MARKET] },
    ], new Map([['v1', 1_200], ['v2', 1_900], ['other', 700]]))
    expect(Object.fromEntries(byScope)).toEqual({ 's-parent': 3_100, 's-helmets': 3_800, 's-gloves': 0 })
    expect(byScope.has('s-market')).toBe(false) // the market's cap is the budget engine's own campaign stop
  })

  it('scopeCaps: reached at the cap or above; a cap of 0 is reached at once; the market cap is not a scope cap', () => {
    const caps = scopeCaps([MARKET, HELMETS, PARENT, GLOVES], new Map([['s-parent', 3_000], ['s-helmets', 4_999]]))
    expect(caps.map((c) => [c.strategyId, c.level, c.spendCents, c.reached])).toEqual([
      ['s-helmets', 'category', 4_999, false], ['s-parent', 'product', 3_000, true], ['s-gloves', 'product', 0, true],
    ])
  })
})

describe('adGroupFloorDecisions — which ad groups to floor, which to give back', () => {
  const reached = new Map<string, ScopeCap>(scopeCaps([PARENT, HELMETS], new Map([['s-parent', 3_100], ['s-helmets', 100]])).filter((c) => c.reached).map((c) => [c.strategyId, c]))
  const mine = (by: string | null) => (by ?? '').startsWith('automation:budget-')
  const decide = (groups: Parameters<typeof adGroupFloorDecisions>[0]) => adGroupFloorDecisions(groups, reached, mine)

  it('an ad group holding ANY product under a reached cap is floored; one whose products are all under it is too', () => {
    const [mixed, only, other] = decide([
      { id: 'g-mixed', caps: [PARENT, HELMETS, MARKET], ownFloor: null }, // the capped variation shares it with another product
      { id: 'g-only', caps: [PARENT, MARKET], ownFloor: null },
      { id: 'g-other', caps: [HELMETS, MARKET], ownFloor: null }, // its category is under its cap: nothing reached
    ])
    expect(mixed).toMatchObject({ suppress: true, restore: false, reachedBy: [{ strategyId: 's-parent', spendCents: 3_100, capCents: 3_000 }] })
    expect(only).toMatchObject({ suppress: true, restore: false })
    expect(other).toEqual({ id: 'g-other', suppress: false, restore: false, reachedBy: [] })
  })

  it('a reached cap holds the ad group\'s own floor, whoever set it; it is not floored twice', () => {
    expect(decide([{ id: 'g', caps: [PARENT], ownFloor: { by: 'automation:budget-manager-cron' } }])[0]).toMatchObject({ suppress: false, restore: false })
  })

  it('given back only when no reached cap covers it AND the floor is this engine\'s own', () => {
    const [own, person, unknown] = decide([
      { id: 'g-own', caps: [HELMETS, MARKET], ownFloor: { by: 'automation:budget-manager-cron' } }, // the 1st, or the cap was raised
      { id: 'g-person', caps: [MARKET], ownFloor: { by: 'user:someone' } },
      { id: 'g-unknown', caps: [], ownFloor: { by: null } },
    ])
    expect(own).toMatchObject({ suppress: false, restore: true })
    expect(person).toMatchObject({ suppress: false, restore: false })
    expect(unknown).toMatchObject({ suppress: false, restore: false })
  })

  it('the market\'s own cap never floors an ad group here (it floors the campaigns)', () => {
    const marketOnly = new Map<string, ScopeCap>([['s-market', { strategyId: 's-market', level: 'category', scopeId: '*', label: 'x', version: 1, capCents: 1, spendCents: 2, reached: true }]])
    expect(adGroupFloorDecisions([{ id: 'g', caps: [MARKET], ownFloor: null }], marketOnly, mine)[0]).toMatchObject({ suppress: false, reachedBy: [] })
  })
})
