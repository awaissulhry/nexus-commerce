/**
 * 6e — the most one click can cost once a placement adjustment and the bidding strategy multiply the bid (review G.3),
 * and the placement raise that takes it past a ceiling (Owner decision D4: a raise past it is refused, a lowering never).
 */
import { describe, expect, it } from 'vitest'
import {
  effectiveCpcRefusal, effectiveMaxCpc, maxStrategyUplift, placementFactor, placementRaiseOverCeiling, raisesAnyPlacement,
  raisesBids, strategyUplift,
} from './ads-effective-cpc.js'

const TOP = 'PLACEMENT_TOP', REST = 'PLACEMENT_REST_OF_SEARCH', PP = 'PLACEMENT_PRODUCT_PAGE', BIZ = 'SITE_AMAZON_BUSINESS'
const at = (top: number, rest = 0, pp = 0) => [{ placement: TOP, percentage: top }, { placement: REST, percentage: rest }, { placement: PP, percentage: pp }]

describe('the formula', () => {
  it('a placement adjustment multiplies the bid by (1 + pct/100): +300% is ×4', () => {
    expect(placementFactor(300, TOP, 'LEGACY_FOR_SALES')).toBe(4)
    expect(placementFactor(0, REST, 'MANUAL')).toBe(1)
  })

  it('up and down adds up to +100% at Top of search and +50% everywhere else; down only and fixed add nothing', () => {
    expect(strategyUplift('AUTO_FOR_SALES', TOP)).toBe(1)
    for (const p of [REST, PP, BIZ, 'SOMETHING_NEW']) expect(strategyUplift('AUTO_FOR_SALES', p)).toBe(0.5)
    for (const s of ['LEGACY_FOR_SALES', 'MANUAL', null, undefined, 'RULE_BASED']) expect(strategyUplift(s, TOP)).toBe(0)
    // the Ads API patch form names it too (updatePlacementBidding's `biddingStrategy`)
    expect(raisesBids('autoForSales')).toBe(true)
    expect(raisesBids('legacyForSales')).toBe(false)
    expect(maxStrategyUplift('AUTO_FOR_SALES')).toBe(1)
    expect(maxStrategyUplift('LEGACY_FOR_SALES')).toBe(0)
  })

  it('900% with up and down is 20× the bid at Top of search — the review\'s number', () => {
    expect(placementFactor(900, TOP, 'AUTO_FOR_SALES')).toBe(20)
    expect(effectiveMaxCpc(50, at(900), 'AUTO_FOR_SALES')).toEqual({ cents: 1000, placement: TOP, pct: 900 })
  })

  it('a placement with no adjustment still counts: up and down raises Top of search at 0%', () => {
    // Rest +10% under up and down is ×1.65; Top at 0% is ×2.00 and is the most a click can cost.
    expect(effectiveMaxCpc(100, [{ placement: REST, percentage: 10 }], 'AUTO_FOR_SALES')).toEqual({ cents: 200, placement: TOP, pct: 0 })
    expect(effectiveMaxCpc(100, [], 'LEGACY_FOR_SALES').cents).toBe(100)
  })
})

describe('placementRaiseOverCeiling — Owner decision D4', () => {
  const base = { highestBidCents: 50, ceilingCents: 150, strategy: 'LEGACY_FOR_SALES' }

  it('a raise past the ceiling is a breach, with what the click would cost and what still fits', () => {
    expect(placementRaiseOverCeiling({ ...base, prior: at(0), next: at(300) })).toEqual({
      placement: TOP, fromPct: 0, toPct: 300, highestBidCents: 50, uplift: 0, effectiveCents: 200, ceilingCents: 150, fitsPct: 200,
    })
  })

  it('a raise to exactly the ceiling, or under it, passes', () => {
    expect(placementRaiseOverCeiling({ ...base, prior: at(0), next: at(200) })).toBeNull() // 50 × 3 = 150
    expect(placementRaiseOverCeiling({ ...base, prior: at(0), next: at(100) })).toBeNull()
  })

  it('a lowering always passes, even when the placement stays above the ceiling', () => {
    expect(placementRaiseOverCeiling({ ...base, prior: at(500), next: at(400) })).toBeNull() // 50 × 5 = 250 > 150, but lower
    expect(placementRaiseOverCeiling({ ...base, prior: at(500, 100), next: at(0, 0) })).toBeNull()
    expect(raisesAnyPlacement({ prior: at(500), next: at(400), strategy: 'AUTO_FOR_SALES' })).toBe(false)
  })

  it('a raise on a placement already above the ceiling is a breach', () => {
    expect(placementRaiseOverCeiling({ ...base, prior: at(400), next: at(425) })?.effectiveCents).toBe(263)
  })

  it('no ceiling, or no bid known, passes — no new default (D4)', () => {
    expect(placementRaiseOverCeiling({ ...base, ceilingCents: null, prior: at(0), next: at(900) })).toBeNull()
    expect(placementRaiseOverCeiling({ ...base, highestBidCents: null, prior: at(0), next: at(900) })).toBeNull()
    expect(placementRaiseOverCeiling({ ...base, highestBidCents: 0, prior: at(0), next: at(900) })).toBeNull()
  })

  it('up and down counts on the placement it applies to: +100% at Top, +50% elsewhere', () => {
    const auto = { ...base, strategy: 'AUTO_FOR_SALES' }
    // Top 50% → 50 × 1.5 × 2 = 150: at the ceiling. Top 60% → 160: past it.
    expect(placementRaiseOverCeiling({ ...auto, prior: at(0), next: at(50) })).toBeNull()
    expect(placementRaiseOverCeiling({ ...auto, prior: at(0), next: at(60) })).toMatchObject({ placement: TOP, effectiveCents: 160, uplift: 1, fitsPct: 50 })
    // Rest 100% → 50 × 2 × 1.5 = 150: at the ceiling.
    expect(placementRaiseOverCeiling({ ...auto, prior: at(0), next: at(0, 100) })).toBeNull()
    expect(placementRaiseOverCeiling({ ...auto, prior: at(0), next: at(0, 110) })).toMatchObject({ placement: REST, effectiveCents: 158 })
  })

  it('a write that raises one placement past the ceiling and lowers another is a breach on the raised one', () => {
    expect(placementRaiseOverCeiling({ ...base, prior: at(100, 200), next: at(300, 0) })).toMatchObject({ placement: TOP, fromPct: 100, toPct: 300 })
  })

  it('a placement the write does not name keeps its value — it is not lowered to 0, nor counted as raised', () => {
    expect(placementRaiseOverCeiling({ ...base, prior: at(400, 0, 0), next: [{ placement: REST, percentage: 50 }] })).toBeNull()
  })

  it('switching the strategy to up and down is a raise on every placement', () => {
    const r = placementRaiseOverCeiling({ ...base, prior: at(100), next: at(100), nextStrategy: 'autoForSales' })
    expect(r).toMatchObject({ placement: TOP, fromPct: 100, toPct: 100, effectiveCents: 200, uplift: 1 })
    // and switching away from it never is
    expect(raisesAnyPlacement({ prior: at(100), next: at(100), strategy: 'AUTO_FOR_SALES', nextStrategy: 'legacyForSales' })).toBe(false)
  })

  it('a fraction of a cent past the ceiling is past it, and what fits is the highest whole % at or under it', () => {
    // 35 × 2.85 = 99.75: under a 100 ceiling. 35 × 2.86 = 100.1: past it, shown rounded up.
    const b = { ...base, highestBidCents: 35, ceilingCents: 100 }
    expect(placementRaiseOverCeiling({ ...b, prior: at(0), next: at(185) })).toBeNull()
    expect(placementRaiseOverCeiling({ ...b, prior: at(0), next: at(186) })).toMatchObject({ effectiveCents: 101, fitsPct: 185 })
  })

  it('what the rank engine\'s cap allows is never past the ceiling (cpcCapPct floors to the same arithmetic)', () => {
    for (const bid of [3, 17, 35, 40, 45, 50, 80, 232]) {
      for (const ceiling of [50, 99, 100, 150, 190]) {
        const capPct = Math.floor(100 * (ceiling / (bid * 2) - 1)) // rank-controller cpcCapPct with up-and-down headroom ×2
        if (capPct < 0) continue
        for (const p of [TOP, REST, PP]) {
          expect(placementRaiseOverCeiling({ highestBidCents: bid, ceilingCents: ceiling, strategy: 'AUTO_FOR_SALES', prior: [], next: [{ placement: p, percentage: capPct }] }), `${bid}¢ ${ceiling}¢ ${p} ${capPct}%`).toBeNull()
        }
      }
    }
  })

  it('a bid that alone passes the ceiling fits no raise', () => {
    expect(placementRaiseOverCeiling({ ...base, highestBidCents: 200, prior: at(0), next: at(10) })?.fitsPct).toBe(-1)
  })
})

describe('effectiveCpcRefusal — one plain sentence', () => {
  it('says what one click could cost, how, the ceiling and where it comes from, and what still fits', () => {
    const breach = placementRaiseOverCeiling({ highestBidCents: 80, ceilingCents: 200, strategy: 'AUTO_FOR_SALES', prior: at(0), next: at(100) })!
    expect(effectiveCpcRefusal(breach, 'the campaign\'s own maximum bid')).toBe(
      'Raising Top of search from 0% to 100% would let one click cost up to €3.20 (highest bid €0.80 ×2.00 for the placement ×2.00 for "dynamic bids – up and down"), '
      + 'above the €2.00 ceiling from the campaign\'s own maximum bid, so nothing was sent to Amazon. At most 25% fits under that ceiling there. Lowering a placement is always allowed.',
    )
  })

  it('names a strategy switch, and a ceiling no adjustment fits under', () => {
    const sw = placementRaiseOverCeiling({ highestBidCents: 100, ceilingCents: 150, strategy: 'MANUAL', nextStrategy: 'autoForSales', prior: at(0), next: at(0) })!
    expect(effectiveCpcRefusal(sw, 'x')).toMatch(/^Switching to "dynamic bids – up and down" with Top of search at 0% would let one click cost up to €2\.00/)
    // 80¢ under up and down is €1.60 at Top of search with no adjustment: a €1.50 ceiling fits nothing there.
    const over = placementRaiseOverCeiling({ highestBidCents: 80, ceilingCents: 150, strategy: 'AUTO_FOR_SALES', prior: at(0), next: at(10) })!
    expect(over.fitsPct).toBe(-1)
    expect(effectiveCpcRefusal(over, 'x')).toMatch(/Even at 0% one click there can cost more than that ceiling, so no placement raise fits: lower the bids first\./)
  })
})
