/**
 * SGX (2026-08-24) — the four honesty fixes to the Suggestions queue, pinned.
 *
 * Each case here is a defect that was LIVE on prod and reproduced before the fix, so these tests
 * describe observed behaviour rather than an imagined contract.
 */
import { describe, it, expect } from 'vitest'
import { appliedChangeOf, projectPlacementPct, placementLaneOf } from './ads-suggestions.service.js'
import { ruleWindowOf, conditionsTextOf } from './rule-conditions-text.js'

describe('appliedChangeOf — an applied row states what it ACTUALLY changed', () => {
  it('reads the prod budget row that used to advertise a change that never happened', () => {
    // Prod, DE_Exact_3_Keywords: the grid showed "€11.25 → €8.44 ↓€2.81 · Delivered" because both
    // halves were re-projected against today's value. The apply was €15.00 → €11.25.
    expect(appliedChangeOf({
      proposedAction: { type: 'budget_apply', op: 'decPct', value: 25, wouldChange: '€15.00 → €11.25' },
      appliedResult: { ok: true, output: { campaignId: 'c1', newDailyBudget: 11.25, outboundQueueId: 'q1' } },
    })).toEqual({ from: '€15.00', to: '€11.25', note: null })
  })

  it('reads the June row whose campaign has since moved to €1.00', () => {
    expect(appliedChangeOf({
      proposedAction: { type: 'budget_apply', op: 'incPct', value: 20, wouldChange: '€10.00 → €12.00' },
      appliedResult: { ok: true, output: { campaignId: 'c2', newDailyBudget: 12, outboundQueueId: 'q2' } },
    })).toEqual({ from: '€10.00', to: '€12.00', note: null })
  })

  it('converts a bid pair out of the CENTS the dry run writes it in', () => {
    expect(appliedChangeOf({
      proposedAction: { type: 'bid_apply', wouldChange: '38¢ → 42¢' },
      appliedResult: { ok: true, output: { adTargetId: 't1', newBidCents: 42 } },
    })).toEqual({ from: '€0.38', to: '€0.42', note: null })
  })

  it('the WRITTEN value wins over the proposed one, and says so — an edit-before-apply override', () => {
    expect(appliedChangeOf({
      proposedAction: { type: 'bid_apply', wouldChange: '38¢ → 42¢' },
      appliedResult: { ok: true, output: { adTargetId: 't1', newBidCents: 50 } },
    })).toEqual({ from: '€0.38', to: '€0.50', note: 'proposed €0.42 — applied €0.50' })
  })

  it('reads a placement percentage', () => {
    expect(appliedChangeOf({
      proposedAction: { type: 'placement_apply', wouldChange: '30% → 24%' },
      appliedResult: { ok: true, output: { campaignId: 'c1', placement: 'PLACEMENT_TOP', percentage: 24 } },
    })).toEqual({ from: '30%', to: '24%', note: null })
  })

  it('a settled no-change is a real outcome, not an absence', () => {
    expect(appliedChangeOf({
      proposedAction: { type: 'budget_apply', wouldChange: '€10.00 → €10.00' },
      appliedResult: { ok: true, output: { campaignId: 'c1', noChange: true } },
    })).toEqual({ from: '€10.00', to: '€10.00', note: 'nothing to change — it already held this value' })
  })

  it('returns null rather than half a sentence when nothing is readable', () => {
    // A harvest apply creates entities; it has no numeric before/after at all.
    expect(appliedChangeOf({
      proposedAction: { type: 'promote_to_exact', query: 'x' },
      appliedResult: { ok: true, output: { confirmed: 1, failedWrites: 0 } },
    })).toBeNull()
    expect(appliedChangeOf({})).toBeNull()
  })

  it('falls back to the proposal when the handler reported no written value', () => {
    expect(appliedChangeOf({
      proposedAction: { type: 'budget_apply', wouldChange: '€10.00 → €12.00' },
      appliedResult: { ok: true, output: {} },
    })).toEqual({ from: '€10.00', to: '€12.00', note: null })
  })
})

describe('projectPlacementPct — mirrors ACTION_HANDLERS.placement_apply', () => {
  const A = (o: Record<string, unknown>) => ({ type: 'placement_apply', minPct: 0, maxPct: 900, ...o })

  it('matches the prod row: 30% decPct 20 → 24%', () => {
    expect(projectPlacementPct(A({ op: 'decPct', value: 20 }), 30)).toBe(24)
  })

  it('handles every builder op the handler does', () => {
    expect(projectPlacementPct(A({ op: 'incPct', value: 50 }), 30)).toBe(45)
    expect(projectPlacementPct(A({ op: 'setValue', value: 75 }), 30)).toBe(75)
    expect(projectPlacementPct(A({ op: 'incAbs', value: 5 }), 30)).toBe(35)
    expect(projectPlacementPct(A({ op: 'decAbs', value: 5 }), 30)).toBe(25)
  })

  it('clamps to the rule band, then to Amazon’s own 0–900', () => {
    expect(projectPlacementPct(A({ op: 'decPct', value: 90, minPct: 10 }), 30)).toBe(10)
    expect(projectPlacementPct(A({ op: 'incPct', value: 900, maxPct: 200 }), 30)).toBe(200)
    expect(projectPlacementPct(A({ op: 'incPct', value: 100000, maxPct: 5000 }), 30)).toBe(900)
  })

  it('rounds to a whole percent, as the handler does', () => {
    expect(projectPlacementPct(A({ op: 'decPct', value: 33 }), 25)).toBe(17) // 16.75
  })

  it('refuses to project for another family, or without a current reading', () => {
    expect(projectPlacementPct({ type: 'budget_apply', op: 'decPct', value: 20 }, 30)).toBeNull()
    expect(projectPlacementPct(A({ op: 'decPct', value: 20 }), null)).toBeNull()
    expect(projectPlacementPct(A({ op: 'decPct' }), 30)).toBeNull()
  })

  it('names the lane the handler defaults to', () => {
    expect(placementLaneOf({ placement: 'PLACEMENT_REST_OF_SEARCH' })).toBe('PLACEMENT_REST_OF_SEARCH')
    expect(placementLaneOf({})).toBe('PLACEMENT_TOP')
  })
})

describe('ruleWindowOf — the window that stops a Reason contradicting its own metrics', () => {
  // The exact prod rule behind "Sales = €0 and Clicks ≥ 20" beside a Sales column of €162.30.
  const placementRule = [{
    match: 'all', exclude: 'Last 2 Days', lookback: 'Last 7 Days',
    conditions: [
      { op: 'eq', scope: 'campaign', value: '0', metric: 'Sales' },
      { op: 'gte', value: '20', metric: 'Clicks' },
    ],
  }]

  it('reads the builder group’s own lookback and exclusion', () => {
    expect(ruleWindowOf(placementRule)).toBe('Last 7 Days, excluding the last 2 days')
  })

  it('leaves the criteria sentence untouched — they are separate readings', () => {
    expect(conditionsTextOf(placementRule)).toBe('Sales = €0 and Clicks ≥ 20')
  })

  it('does not say "excluding" when the builder excluded nothing', () => {
    expect(ruleWindowOf([{ lookback: 'Last 30 Days', exclude: 'None', conditions: [] }])).toBe('Last 30 Days')
    expect(ruleWindowOf([{ lookback: 'Last 30 Days', conditions: [] }])).toBe('Last 30 Days')
  })

  it('finds a window nested one group deeper', () => {
    expect(ruleWindowOf([{ match: 'any', conditions: [{ lookback: 'Last 14 Days', conditions: [] }] }]))
      .toBe('Last 14 Days')
  })

  it('is null for an engine-flat rule, whose window lives on the ACTION instead', () => {
    expect(ruleWindowOf([{ field: 'campaign.acos', operator: 'lte', value: 0.3 }])).toBeNull()
    expect(ruleWindowOf([])).toBeNull()
    expect(ruleWindowOf(null)).toBeNull()
  })
})

/**
 * SGX — the Recommendations feed's own two honesty defects, measured on the live feed:
 * CTR read "—" on all ten `graduate` rows while Impressions (131,620) and Clicks (257) sat on
 * the same row, and every builder's figure shared one column labelled "estimated monthly impact".
 */
describe('recommendations — derived metrics and what the impact figure MEANS', () => {
  it('derives a ratio whenever the primitives are on the row', async () => {
    const { __test_withDerived: withDerived } = await import('./ads-recommendations.service.js')
    // the exact prod graduate row that rendered CTR as "—"
    expect(withDerived({ impressions: 131620, clicks: 257, spendCents: 20404, salesCents: 66553, orders: 8 }))
      .toEqual({
        impressions: 131620, clicks: 257, spendCents: 20404, salesCents: 66553, orders: 8,
        ctr: 257 / 131620, cvr: 8 / 257, acos: 20404 / 66553, roas: 66553 / 20404,
      })
  })

  it('keeps an unmeasurable ratio null rather than inventing a zero', async () => {
    const { __test_withDerived: withDerived } = await import('./ads-recommendations.service.js')
    const m = withDerived({ impressions: 0, clicks: 0, spendCents: 500, salesCents: 0, orders: 0 })
    expect(m.ctr).toBeNull()   // no impressions — CTR has no denominator
    expect(m.cvr).toBeNull()   // no clicks
    expect(m.acos).toBeNull()  // spend with zero sales: the cell shows "— ●red", never a number
    expect(m.roas).toBe(0)     // zero sales over real spend IS zero, and reads red
  })

  it('never overwrites a ratio a builder computed itself', async () => {
    const { __test_withDerived: withDerived } = await import('./ads-recommendations.service.js')
    expect(withDerived({ impressions: 100, clicks: 5, ctr: 0.42 }).ctr).toBe(0.42)
  })

  it('leaves absent primitives absent — a missing metric is not a zero', async () => {
    const { __test_withDerived: withDerived } = await import('./ads-recommendations.service.js')
    expect(withDerived({ spendCents: 100 })).toEqual({ spendCents: 100 })
  })
})
