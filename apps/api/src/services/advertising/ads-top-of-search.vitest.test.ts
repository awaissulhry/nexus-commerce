import { describe, it, expect } from 'vitest'
import { buildSearchPlacementAdjustments, decideTopOfSearch, newDayGate, ruleTargetIS, TOS_IS_MIN_DAYS, type TosDecisionInput } from './ads-top-of-search.service.js'
import { ACTION_HANDLERS } from '../automation-rule.service.js'

// PP — Top ↔ Rest are mutually exclusive search positions: setting one zeros the other,
// Product-page bias is preserved (engine never touches it).
const m = (adj: Array<{ placement: string; percentage: number }>) => Object.fromEntries(adj.map((a) => [a.placement, a.percentage]))

describe('buildSearchPlacementAdjustments (per-placement)', () => {
  it('Top active → sets Top, zeros Rest, preserves Product', () => {
    const r = m(buildSearchPlacementAdjustments([{ placement: 'PLACEMENT_TOP', percentage: 130 }, { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 0 }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 50 }], 'PLACEMENT_TOP', 100))
    expect(r.PLACEMENT_TOP).toBe(100); expect(r.PLACEMENT_REST_OF_SEARCH).toBe(0); expect(r.PLACEMENT_PRODUCT_PAGE).toBe(50)
  })
  it('Rest active → sets Rest, zeros Top, preserves Product', () => {
    const r = m(buildSearchPlacementAdjustments([{ placement: 'PLACEMENT_TOP', percentage: 400 }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 50 }], 'PLACEMENT_REST_OF_SEARCH', 30))
    expect(r.PLACEMENT_REST_OF_SEARCH).toBe(30); expect(r.PLACEMENT_TOP).toBe(0); expect(r.PLACEMENT_PRODUCT_PAGE).toBe(50)
  })
  it('non-search placement (Product) just sets itself, preserves Top/Rest', () => {
    const r = m(buildSearchPlacementAdjustments([{ placement: 'PLACEMENT_TOP', percentage: 100 }], 'PLACEMENT_PRODUCT_PAGE', 20))
    expect(r.PLACEMENT_PRODUCT_PAGE).toBe(20); expect(r.PLACEMENT_TOP).toBe(100)
  })
  it('clamps to 0..900', () => {
    expect(m(buildSearchPlacementAdjustments([], 'PLACEMENT_TOP', 9999)).PLACEMENT_TOP).toBe(900)
    expect(m(buildSearchPlacementAdjustments([], 'PLACEMENT_TOP', -5)).PLACEMENT_TOP).toBe(0)
  })
})

// ── A1 / A4 (2026-10-10) — what a Top-of-Search step may rest on ─────────────────────────────────────────────────

const WINDOW = { since: '2026-08-04', until: '2026-09-02', days: 30 }
// Made-up numbers: top-of-search €10 spend, €100 sales (ACoS 10 %), multiplier at 30 %.
const base: TosDecisionInput = {
  topSpendCents: 1_000, topSalesCents: 10_000, topAcos: 0.1, currentPct: 30, targetAcos: 0.25, targetIS: 0.5,
  is: 0.3, isDays: 12, isNewest: '2026-09-01', newestDay: '2026-09-02', window: WINDOW,
}

describe('decideTopOfSearch — under a target IS the IS must be there, on enough days, and recent', () => {
  it('raises below the target, and the reason names the IS, the window, the days with a reading and the newest day', () => {
    const d = decideTopOfSearch(base)
    expect(d).toMatchObject({ action: 'raise', recommendedPct: 45, dataDay: '2026-09-01' })
    expect(d.reason).toBe("the campaign's top-of-search IS (Amazon's, per day) 30%, weighted by impressions over 12 of the 30 settled days 2026-08-04…2026-09-02 with a reading, newest 2026-09-01: below the target 50% with top-of-search ACoS 10% in budget — push for top slots")
  })

  it('🔴 target set, no IS reported → holds and says so (no silent fall-back to ACoS alone)', () => {
    const d = decideTopOfSearch({ ...base, is: null, isDays: 0, isNewest: null })
    expect(d).toMatchObject({ action: 'keep', recommendedPct: 30, hold: 'no-is' })
    expect(d.reason).toBe('held: target top-of-search IS 50% is set, but Amazon reported no top-of-search IS for this campaign in the 30 settled days 2026-08-04…2026-09-02')
  })

  it(`🔴 fewer than ${TOS_IS_MIN_DAYS} days with a reading → holds`, () => {
    const d = decideTopOfSearch({ ...base, isDays: 4 })
    expect(d).toMatchObject({ action: 'keep', hold: 'thin-is' })
    expect(d.reason).toContain('only 4 of the 30 settled days 2026-08-04…2026-09-02 carry Amazon\'s top-of-search IS (newest 2026-09-01); at least 5 are needed')
    expect(decideTopOfSearch({ ...base, isDays: 5 }).action).toBe('raise')
  })

  it('🔴 the newest reading more than 3 days before the window\'s last settled day → holds', () => {
    const d = decideTopOfSearch({ ...base, isNewest: '2026-08-29' })
    expect(d).toMatchObject({ action: 'keep', hold: 'stale-is' })
    expect(d.reason).toBe("held: the newest top-of-search IS reading (2026-08-29) is 4 days before the window's last settled day 2026-09-02; at most 3 are allowed")
    expect(decideTopOfSearch({ ...base, isNewest: '2026-08-30' }).action).toBe('raise')
  })

  it('eases off comfortably above the target', () => {
    const d = decideTopOfSearch({ ...base, is: 0.6 })
    expect(d).toMatchObject({ action: 'lower', recommendedPct: 15 })
    expect(d.reason).toContain('comfortably above the target 50%')
  })

  it('no target IS → ACoS alone, as before, and said', () => {
    const d = decideTopOfSearch({ ...base, targetIS: null, is: null, isDays: 0, isNewest: null })
    expect(d).toMatchObject({ action: 'raise', recommendedPct: 45, dataDay: '2026-09-02' })
    expect(d.reason).toBe('ACoS only: no target IS set — top-of-search ACoS 10% well under the target 25% over the 30 settled days 2026-08-04…2026-09-02 (newest data 2026-09-02) — capture more top slots')
    expect(d).not.toHaveProperty('hold')
  })

  it('spend with no attributed sales is said in words, not as a 999 % ACoS', () => {
    const d = decideTopOfSearch({ ...base, targetIS: null, topSalesCents: 0, topAcos: 9.99 })
    expect(d.action).toBe('lower')
    expect(d.reason).toContain('top-of-search spend with no attributed sales over the target 25%')
  })
})

describe('newDayGate — one step per campaign per new settled day', () => {
  const at = new Date('2026-09-10T08:00:00Z')
  it('first step: allowed', () => expect(newDayGate('2026-09-02', null)).toEqual({ ok: true }))
  it('🔴 the same settled day again (the other 47 runs of the day): held, with why', () => {
    const g = newDayGate('2026-09-02', { at, dataDay: '2026-09-02' })
    expect(g).toEqual({ ok: false, why: 'held: its last step (2026-09-10) already rested on settled data through 2026-09-02; the next step waits for a newer settled day (newest now 2026-09-02)' })
  })
  it('a newer settled day: allowed', () => expect(newDayGate('2026-09-03', { at, dataDay: '2026-09-02' })).toEqual({ ok: true }))
  it('a step from before A1 (no data day kept): the window end of its day stands in', () => {
    // 2026-09-10 with the 7-day Sponsored Products lag: the settled window ended 2026-09-03.
    expect(newDayGate('2026-09-03', { at, dataDay: null }, 'attribution').ok).toBe(false)
    expect(newDayGate('2026-09-04', { at, dataDay: null }, 'attribution').ok).toBe(true)
  })
  it('no data day at all: held', () => expect(newDayGate(null, null).ok).toBe(false))
})

describe('A4 — defend_top_of_search takes targetIS as a fraction and refuses anything else', () => {
  it('a fraction in (0, 1] passes; absent means no target', () => {
    expect(ruleTargetIS(0.5)).toEqual({ ok: true, targetIS: 0.5 })
    expect(ruleTargetIS(1)).toEqual({ ok: true, targetIS: 1 })
    expect(ruleTargetIS(undefined)).toEqual({ ok: true, targetIS: undefined })
  })
  it('🔴 25 (meant as %), 0, a negative or a string is refused, never converted', () => {
    for (const bad of [25, 0, -0.1, '0.5', Number.NaN]) expect(ruleTargetIS(bad).ok).toBe(false)
    expect(ruleTargetIS(25)).toEqual({ ok: false, error: 'targetIS must be a fraction above 0 and at most 1 (0.5 = 50 % top-of-search impression share); got 25. Nothing was changed.' })
  })
  it('🔴 the rule action returns the refusal in its result and reads nothing', async () => {
    const r = await ACTION_HANDLERS.defend_top_of_search({ type: 'defend_top_of_search', targetIS: 25 }, {}, { dryRun: false, ruleId: 'r1' } as never)
    expect(r).toEqual({ type: 'defend_top_of_search', ok: false, error: expect.stringContaining('got 25. Nothing was changed.') })
  })
})
