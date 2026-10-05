import { describe, it, expect } from 'vitest'
import { buildBlendedAdjustments, deltaBidCents, mergeOntoAmazonPlacements } from './ads-placement-math.js'

// BL — the blended writer must let Top + Rest of Search + Product pages coexist in ONE
// placement profile, drop a lane the target no longer declares, preserve foreign
// placements, and clamp — so a blended window drives all three at once without churn.
const pmap = (arr: Array<{ placement: string; percentage: number }>) =>
  Object.fromEntries(arr.map((x) => [x.placement, x.percentage]))

describe('buildBlendedAdjustments (BL — multi-placement coexistence)', () => {
  it('drives all three placements simultaneously', () => {
    const out = buildBlendedAdjustments([], [
      { placement: 'PLACEMENT_TOP', percentage: 150 },
      { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 50 },
      { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 30 },
    ])
    expect(pmap(out)).toEqual({ PLACEMENT_TOP: 150, PLACEMENT_REST_OF_SEARCH: 50, PLACEMENT_PRODUCT_PAGE: 30 })
  })

  it('Top + Rest coexist (the headline fix — no more either/or)', () => {
    const out = buildBlendedAdjustments([{ placement: 'PLACEMENT_TOP', percentage: 100 }], [
      { placement: 'PLACEMENT_TOP', percentage: 200 },
      { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 80 },
    ])
    expect(pmap(out).PLACEMENT_TOP).toBe(200)
    expect(pmap(out).PLACEMENT_REST_OF_SEARCH).toBe(80)
  })

  it('drops a managed placement the target no longer declares (was boosted → 0)', () => {
    const out = buildBlendedAdjustments(
      [{ placement: 'PLACEMENT_TOP', percentage: 150 }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 30 }],
      [{ placement: 'PLACEMENT_TOP', percentage: 150 }, { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 50 }],
    )
    expect(pmap(out).PLACEMENT_PRODUCT_PAGE).toBe(0) // explicitly dropped
    expect(pmap(out).PLACEMENT_TOP).toBe(150)
    expect(pmap(out).PLACEMENT_REST_OF_SEARCH).toBe(50)
  })

  it('does not add a spurious 0 for an undeclared placement that was never set', () => {
    const out = buildBlendedAdjustments([], [{ placement: 'PLACEMENT_TOP', percentage: 120 }])
    expect(out.find((x) => x.placement === 'PLACEMENT_PRODUCT_PAGE')).toBeUndefined()
    expect(out.find((x) => x.placement === 'PLACEMENT_REST_OF_SEARCH')).toBeUndefined()
    expect(pmap(out)).toEqual({ PLACEMENT_TOP: 120 })
  })

  it('clamps each lane to 0–900', () => {
    const out = buildBlendedAdjustments([], [
      { placement: 'PLACEMENT_TOP', percentage: 1200 },
      { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: -50 },
    ])
    expect(pmap(out).PLACEMENT_TOP).toBe(900)
    expect(pmap(out).PLACEMENT_REST_OF_SEARCH).toBe(0)
  })

  it('preserves a foreign (non-managed) placement untouched', () => {
    const out = buildBlendedAdjustments(
      [{ placement: 'PLACEMENT_HOME', percentage: 40 }],
      [{ placement: 'PLACEMENT_TOP', percentage: 100 }],
    )
    expect(pmap(out).PLACEMENT_HOME).toBe(40)
    expect(pmap(out).PLACEMENT_TOP).toBe(100)
  })

  it('empty lanes drops every previously-boosted managed placement to 0', () => {
    const out = buildBlendedAdjustments(
      [{ placement: 'PLACEMENT_TOP', percentage: 100 }, { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 50 }],
      [],
    )
    expect(pmap(out).PLACEMENT_TOP).toBe(0)
    expect(pmap(out).PLACEMENT_REST_OF_SEARCH).toBe(0)
  })
})

// BL.7 — deltaBidCents must compute from the STABLE baseline (the caller always passes the
// remembered baseline, never the current bid) so repeated application can't compound; it
// clamps the delta to a sane range and floors at 2¢.
describe('deltaBidCents (BL.7 — base-bid delta, no compounding)', () => {
  it('scales the baseline by ±%', () => {
    expect(deltaBidCents(50, 20)).toBe(60)   // +20%
    expect(deltaBidCents(50, -40)).toBe(30)  // −40%
    expect(deltaBidCents(50, 0)).toBe(50)    // no-op
  })
  it('is idempotent from the baseline (no compounding) — same input → same output', () => {
    const once = deltaBidCents(50, 15)
    expect(deltaBidCents(50, 15)).toBe(once) // re-applying from baseline never drifts
    expect(once).toBe(57) // 50 * 1.15 = 57.4999… (float) → round → 57
  })
  it('floors at 2¢ and clamps the delta to [-95, +300]', () => {
    expect(deltaBidCents(50, -100)).toBe(3)   // clamped to -95% → round(2.5) = 3
    expect(deltaBidCents(4, -90)).toBe(2)     // round(0.4) = 0 → floored to 2
    expect(deltaBidCents(50, 9999)).toBe(deltaBidCents(50, 300)) // clamped to +300%
    expect(deltaBidCents(50, 300)).toBe(200)  // round(50 * 4)
  })
})

// G.4 — a placement write is merged onto Amazon's CURRENT array (read just before the PUT): a lane the
// write does not set keeps Amazon's value, so a console change since the last 20-minute sync survives.
describe('mergeOntoAmazonPlacements (G.4 — merge onto Amazon before the PUT)', () => {
  const TOP = 'PLACEMENT_TOP', REST = 'PLACEMENT_REST_OF_SEARCH', PP = 'PLACEMENT_PRODUCT_PAGE', AB = 'PLACEMENT_AMAZON_BUSINESS'
  const p = (placement: string, percentage: number) => ({ placement, percentage })

  it('keeps Amazon\'s value for a lane the request only carried from the local copy (the console edit survives)', () => {
    // local: Top 50, Product 0 · console raised Product to 40 · the write moves Top to 80 and carries Product 0
    const out = mergeOntoAmazonPlacements([p(TOP, 80), p(PP, 0)], [p(TOP, 50), p(PP, 0)], [p(TOP, 50), p(PP, 40)])
    expect(pmap(out.adjustments)).toEqual({ [TOP]: 80, [PP]: 40 })
    expect(out.drift).toEqual([{ placement: PP, local: 0, amazon: 40 }])
  })

  it('a lane the request sets to a new value wins over Amazon\'s', () => {
    const out = mergeOntoAmazonPlacements([p(TOP, 80), p(PP, 10)], [p(TOP, 50), p(PP, 25)], [p(TOP, 60), p(PP, 25)])
    expect(pmap(out.adjustments)).toEqual({ [TOP]: 80, [PP]: 10 })
    expect(out.drift).toEqual([{ placement: TOP, local: 50, amazon: 60 }])
  })

  it('keeps a lane Amazon has and the request never mentions (Amazon Business, a console-added lane)', () => {
    const out = mergeOntoAmazonPlacements([p(TOP, 80)], [p(TOP, 50)], [p(TOP, 50), p(AB, 30), p(REST, 15)])
    expect(pmap(out.adjustments)).toEqual({ [TOP]: 80, [AB]: 30, [REST]: 15 })
    expect(out.drift.map((d) => d.placement).sort()).toEqual([AB, REST].sort())
  })

  it('a lane the request leaves out while the local copy has it above 0 is removed (what the full-array PUT always meant)', () => {
    const out = mergeOntoAmazonPlacements([p(TOP, 80)], [p(TOP, 50), p(PP, 25)], [p(TOP, 50), p(PP, 25)])
    expect(pmap(out.adjustments)).toEqual({ [TOP]: 80, [PP]: 0 })
    expect(out.drift).toEqual([])
  })

  it('does not invent a "nothing → 0" entry for a lane that is 0 everywhere', () => {
    const out = mergeOntoAmazonPlacements([p(TOP, 80), p(REST, 0)], [p(TOP, 50)], [p(TOP, 50)])
    expect(out.adjustments).toEqual([p(TOP, 80)])
  })

  it('no drift and nothing carried: the request goes out as it came', () => {
    const local = [p(TOP, 50), p(REST, 0), p(PP, 25)]
    const out = mergeOntoAmazonPlacements([p(TOP, 150), p(REST, 0), p(PP, 25)], local, local)
    expect(pmap(out.adjustments)).toEqual({ [TOP]: 150, [REST]: 0, [PP]: 25 })
    expect(out.drift).toEqual([])
  })

  it('resend counts every requested lane as set (the failed-write re-push), and still keeps lanes it does not name', () => {
    // local holds the undelivered Top 80; Amazon still has Top 50 and a console-added Product 40
    const out = mergeOntoAmazonPlacements([p(TOP, 80)], [p(TOP, 80)], [p(TOP, 50), p(PP, 40)], { resend: true })
    expect(pmap(out.adjustments)).toEqual({ [TOP]: 80, [PP]: 40 })
    // without resend the same call would carry Amazon's 50 — the re-push would deliver nothing
    expect(pmap(mergeOntoAmazonPlacements([p(TOP, 80)], [p(TOP, 80)], [p(TOP, 50)]).adjustments)).toEqual({ [TOP]: 50 })
  })

  // CM-18 — a screen sends only the lanes the operator changed (`partial`).
  it('partial: a lane left out is never removed — it keeps Amazon\'s value even when the local copy has it above 0', () => {
    // local Top 50 / Product 25; rank-defend moved Top to 70 on Amazon since; the operator changed only Rest
    const out = mergeOntoAmazonPlacements([p(REST, 30)], [p(TOP, 50), p(PP, 25)], [p(TOP, 70), p(PP, 25)], { partial: true })
    expect(pmap(out.adjustments)).toEqual({ [TOP]: 70, [PP]: 25, [REST]: 30 })
    // the same request without `partial` removes Product (the full-array contract the engines and undo keep)
    expect(pmap(mergeOntoAmazonPlacements([p(REST, 30)], [p(TOP, 50), p(PP, 25)], [p(TOP, 70), p(PP, 25)]).adjustments)).toEqual({ [TOP]: 0, [PP]: 0, [REST]: 30 })
  })

  it('partial: a listed lane is set even at the local copy\'s value, and 0 clears it', () => {
    // the operator typed Top 50 = the local copy, while the console moved it to 60: his 50 goes out
    const out = mergeOntoAmazonPlacements([p(TOP, 50), p(PP, 0)], [p(TOP, 50), p(PP, 25)], [p(TOP, 60), p(PP, 25)], { partial: true })
    expect(pmap(out.adjustments)).toEqual({ [TOP]: 50, [PP]: 0 })
  })

  it('partial merged onto the local copy alone (no Amazon read): untouched lanes keep the stored value', () => {
    const local = [p(TOP, 50), p(PP, 25), p(AB, 10)]
    const out = mergeOntoAmazonPlacements([p(PP, 40)], local, local, { partial: true })
    expect(pmap(out.adjustments)).toEqual({ [TOP]: 50, [PP]: 40, [AB]: 10 })
    expect(out.drift).toEqual([])
  })
})
