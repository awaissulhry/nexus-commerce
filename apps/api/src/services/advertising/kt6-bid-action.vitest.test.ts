/**
 * KT.6 — the arithmetic that goes into a sentence before money moves.
 *
 * Every fixture below is built from numbers measured on prod 2026-08-13, not invented: `giacca moto`
 * is 100 targets / 53 campaigns / 42 writable in 17 campaigns, of which 9 carry a suppression flag
 * and 12 bid ≤3¢; the IT bid ceiling is €0.80; `Campaign.minBidCents` is null on all 220.
 *
 * No mocks. This programme has already had a mocked shape-assertion test pin a bug in place
 * (`daily_cap_not_enforced`), so these assert observable consequences of pure functions instead.
 */
import { describe, it, expect } from 'vitest'
import {
  computeBlastRadius, blastRadiusSentence, KT6_BID_FLOOR_CENTS, KT6_SUPPRESSION_CENTS,
  type Kt6Target,
} from './kt6-bid-action.js'
import {
  resolveCeiling, checkCeiling, commitmentCents, type Kt6Ceiling,
} from './kt6-spend-ceiling.js'

const IT_CEILING = 80

function target(over: Partial<Kt6Target> & { id: string; campaignId: string }): Kt6Target {
  return {
    expressionValue: 'giacca moto', matchType: 'EXACT', bidCents: 36,
    suppressedFromBidCents: null, campaignName: `C-${over.campaignId}`,
    writable: true, maxBidCents: IT_CEILING, minBidCents: null,
    ...over,
  }
}

/** The measured shape of `giacca moto`: 100 targets, 58 unwritable, 9 flagged, 12 at ≤3¢. */
function giaccaMoto(): Kt6Target[] {
  const out: Kt6Target[] = []
  // 42 writable across 17 campaigns
  for (let i = 0; i < 42; i++) {
    const campaignId = `w${i % 17}`
    // 9 carry a suppression flag; 3 more bid ≤3¢ with no flag (12 at ≤3¢ in total)
    const suppressedFromBidCents = i < 9 ? 45 : null
    const bidCents = i < 9 ? 2 : i < 12 ? 2 : 36
    out.push(target({ id: `t${i}`, campaignId, suppressedFromBidCents, bidCents }))
  }
  // 58 in campaigns that are not write-enabled, across 36 campaigns
  for (let i = 0; i < 58; i++) {
    out.push(target({ id: `n${i}`, campaignId: `x${i % 36}`, writable: false, maxBidCents: null }))
  }
  return out
}

describe('computeBlastRadius — matched vs allowed, on the widest real row', () => {
  it('reports 100 matched and 30 actionable at €0.55, with the 58 unwritable named separately', () => {
    const r = computeBlastRadius(giaccaMoto(), 55)
    expect(r.matchedTargets).toBe(100)
    expect(r.matchedCampaigns).toBe(53)
    // 42 writable − 9 flagged − 3 low-bid-unflagged = 30
    expect(r.actionable).toHaveLength(30)
    expect(r.byReason.not_write_enabled).toBe(58)
    expect(r.byReason.suppressed_flag).toBe(9)
    expect(r.byReason.suppressed_by_bid).toBe(3)
  })

  it('counts flagged and unflagged suppressions SEPARATELY', () => {
    // Conflating them would hide the 141 account-wide low bids the flag does not know about.
    const r = computeBlastRadius(giaccaMoto(), 55)
    expect(r.byReason.suppressed_flag).not.toBe(r.byReason.suppressed_flag + r.byReason.suppressed_by_bid)
    expect(r.byReason.suppressed_flag + r.byReason.suppressed_by_bid).toBe(12)
  })

  it('includes suppressed targets only when explicitly asked', () => {
    const r = computeBlastRadius(giaccaMoto(), 55, { includeSuppressed: true })
    expect(r.actionable).toHaveLength(42)
    expect(r.byReason.suppressed_flag).toBe(0)
    expect(r.byReason.suppressed_by_bid).toBe(0)
  })

  it('refuses rather than clamps a bid over the campaign ceiling, and names the value that would fit', () => {
    const r = computeBlastRadius(giaccaMoto(), 95) // above IT's €0.80
    expect(r.actionable).toHaveLength(0)
    expect(r.byReason.over_campaign_ceiling).toBe(30)
    expect(r.highestUniformAllowed).toBe(IT_CEILING)
  })

  it('checks permission BEFORE the ceiling, so an unwritable campaign is never reported as capped', () => {
    // Reporting a ceiling breach on a campaign that was never writable would send the operator to
    // fix the wrong thing — the write gate checks pins before bounds for the same reason.
    const r = computeBlastRadius(giaccaMoto(), 95)
    const unwritableReportedAsCapped = r.excluded.some(
      (e) => e.why === 'over_campaign_ceiling' && !e.target.writable,
    )
    expect(unwritableReportedAsCapped).toBe(false)
  })

  it('holds a floor of its own, because Campaign.minBidCents is null on all 220 campaigns', () => {
    const r = computeBlastRadius(giaccaMoto(), 2)
    expect(r.actionable).toHaveLength(0)
    expect(r.byReason.below_floor).toBe(30)
    expect(KT6_BID_FLOOR_CENTS).toBeGreaterThan(KT6_SUPPRESSION_CENTS)
  })

  it('treats "already at this bid" as nothing to do, not as a change', () => {
    const r = computeBlastRadius(giaccaMoto(), 36)
    expect(r.actionable).toHaveLength(0)
    expect(r.byReason.no_change).toBe(30)
  })

  it('reports FR honestly: 17 matched, 2 writable', () => {
    // Measured: FR's widest row is `veste moto` — 9 campaigns, 17 targets, 2 writable.
    const fr: Kt6Target[] = []
    for (let i = 0; i < 2; i++) fr.push(target({ id: `f${i}`, campaignId: 'fw0', expressionValue: 'veste moto' }))
    for (let i = 0; i < 15; i++) fr.push(target({ id: `fn${i}`, campaignId: `fx${i % 8}`, writable: false, expressionValue: 'veste moto' }))
    const r = computeBlastRadius(fr, 55)
    expect(r.matchedTargets).toBe(17)
    expect(r.actionable).toHaveLength(2)
    expect(r.byReason.not_write_enabled).toBe(15)
  })
})

describe('blastRadiusSentence — D4: loud, exact, and five different zeros', () => {
  const ctx = { term: 'giacca moto', marketplace: 'IT', shareAgeDays: 24, undoWindowHours: 24, proposeOnly: true }

  it('states both numbers, the exclusions, the evidence age and the undo window', () => {
    const s = blastRadiusSentence(computeBlastRadius(giaccaMoto(), 55), ctx)
    expect(s).toContain('30 targets')
    expect(s).toContain('€0.55')
    expect(s).toContain('58 further targets')
    expect(s).toContain('not write-enabled')
    expect(s).toContain('24 days ago')
    expect(s).toContain('undoable in one action for 24 hours')
    expect(s).toContain('Nothing changes until the proposal is approved')
  })

  it('does not say "will spend" anywhere — a bid is a ceiling per click, not a forecast', () => {
    const s = blastRadiusSentence(computeBlastRadius(giaccaMoto(), 55), ctx)
    expect(s.toLowerCase()).not.toContain('will spend')
  })

  it('distinguishes "no campaign bids this" from "nothing is writable"', () => {
    const unbid = blastRadiusSentence(computeBlastRadius([], 55), ctx)
    const locked = blastRadiusSentence(
      computeBlastRadius([target({ id: 'a', campaignId: 'x', writable: false })], 55), ctx,
    )
    expect(unbid).toContain('No campaign bids')
    expect(unbid).toContain('is not being bought')
    expect(locked).toContain('not one of them is write-enabled')
    expect(locked).not.toContain('No campaign bids')
    expect(unbid).not.toEqual(locked)
  })

  it('distinguishes "already at this bid" from every other zero, and LEADS with it', () => {
    // The first version of this asserted the sentence omitted the unwritable count. That was the
    // test being wrong, not the code: 58 unwritable targets is a true and useful fact worth saying.
    // What matters is which zero the sentence LEADS with, because that is the one the operator reads
    // as the answer — so assert the opening clause, not the absence of other facts.
    const same = blastRadiusSentence(computeBlastRadius(giaccaMoto(), 36), ctx)
    expect(same.startsWith('Nothing to do — every target')).toBe(true)
    expect(same).toContain('already bids €0.36')
    const locked = blastRadiusSentence(
      computeBlastRadius([target({ id: 'a', campaignId: 'x', writable: false })], 55), ctx,
    )
    expect(locked.startsWith('Nothing to do')).toBe(false)
  })

  it('agrees in number for a single target', () => {
    // KT.4 shipped "the point stand alone" by pluralising the noun and leaving the verb.
    const one = computeBlastRadius([target({ id: 'a', campaignId: 'w0' })], 55)
    const s = blastRadiusSentence(one, ctx)
    expect(s).toContain('1 target across 1 campaign')
    expect(s).not.toContain('1 targets')
    expect(s).not.toContain('1 campaigns')
  })

  it('says the share is too old to lean on when it is 24 days old', () => {
    const s = blastRadiusSentence(computeBlastRadius(giaccaMoto(), 55), ctx)
    expect(s).toContain('judge this on the bid and the spend, not on the share')
  })
})

describe('resolveCeiling — most specific wins, and an empty ceiling is not a ceiling', () => {
  const ceilings: Kt6Ceiling[] = [
    { grain: 'MARKET', scopeId: 'IT', dailyCapCents: 4000, label: 'the IT market', enabled: true },
    { grain: 'PORTFOLIO', scopeId: 'p1', dailyCapCents: 1500, label: 'the GALE portfolio', enabled: true },
    { grain: 'CAMPAIGN', scopeId: 'c1', dailyCapCents: 500, label: 'GALE | IT | Exact', enabled: true },
  ]
  const scope = { campaignId: 'c1', portfolioId: 'p1', marketplace: 'IT' }

  it('binds on the campaign when one is set', () => {
    expect(resolveCeiling(scope, ceilings).bound?.grain).toBe('CAMPAIGN')
  })

  it('falls outward to the portfolio, then the market', () => {
    expect(resolveCeiling(scope, ceilings.filter((c) => c.grain !== 'CAMPAIGN')).bound?.grain).toBe('PORTFOLIO')
    expect(resolveCeiling(scope, ceilings.filter((c) => c.grain === 'MARKET')).bound?.grain).toBe('MARKET')
  })

  it('🔴 a ceiling row with a null value does NOT become an unlimited allowance', () => {
    // Otherwise an operator could disable a market cap by opening a campaign control and saving
    // nothing, which is the opposite of what setting a ceiling means.
    const withEmptyCampaign: Kt6Ceiling[] = [
      { grain: 'CAMPAIGN', scopeId: 'c1', dailyCapCents: null, label: 'GALE | IT | Exact', enabled: true },
      { grain: 'MARKET', scopeId: 'IT', dailyCapCents: 4000, label: 'the IT market', enabled: true },
    ]
    const r = resolveCeiling(scope, withEmptyCampaign)
    expect(r.bound?.grain).toBe('MARKET')
    expect(r.presentButUnset.map((c) => c.grain)).toEqual(['CAMPAIGN'])
  })

  it('ignores a disabled ceiling', () => {
    const off = ceilings.map((c) => (c.grain === 'CAMPAIGN' ? { ...c, enabled: false } : c))
    expect(resolveCeiling(scope, off).bound?.grain).toBe('PORTFOLIO')
  })

  it('returns no ceiling at all when nothing is set, and says so distinctly', () => {
    const r = checkCeiling(resolveCeiling(scope, []), { committedCents: 0 }, 100)
    expect(r.verdict).toBe('NO_CEILING')
    expect(r.message).toContain('No spend ceiling is set')
    expect(r.message).not.toContain('unlimited')
  })
})

describe('checkCeiling — the refusal is specific, and names which ceiling bound it', () => {
  const res = resolveCeiling({ marketplace: 'IT' }, [
    { grain: 'MARKET', scopeId: 'IT', dailyCapCents: 4000, label: 'the IT market', enabled: true },
  ])

  it('refuses with the cap, what is committed and what was requested — the operator\'s own wording', () => {
    const r = checkCeiling(res, { committedCents: 3890 }, 420)
    expect(r.verdict).toBe('REFUSED')
    expect(r.message).toContain('Refused')
    expect(r.message).toContain('the IT market')
    expect(r.message).toContain('€40.00')
    expect(r.message).toContain('€38.90')
    expect(r.message).toContain('€4.20')
    expect(r.remainingCents).toBe(110)
  })

  it('allows and states the headroom left afterwards', () => {
    const r = checkCeiling(res, { committedCents: 1000 }, 500)
    expect(r.verdict).toBe('ALLOWED')
    expect(r.message).toContain('€25.00 left afterwards')
  })

  it('says "fully committed" rather than a negative remainder', () => {
    const r = checkCeiling(res, { committedCents: 4200 }, 100)
    expect(r.message).toContain('already fully committed')
    expect(r.message).not.toContain('€-')
  })

  it('labels Amazon spend with its date and never presents it as today', () => {
    const r = checkCeiling(res, { committedCents: 3890, amazonSpendCents: 8273, amazonSpendDate: '2026-08-10' }, 420)
    expect(r.message).toContain('2026-08-10')
    expect(r.message).toContain('it is not today')
  })

  it('names the grain that bound when more than one ceiling was considered', () => {
    const both = resolveCeiling({ campaignId: 'c1', marketplace: 'IT' }, [
      { grain: 'CAMPAIGN', scopeId: 'c1', dailyCapCents: 500, label: 'GALE | IT | Exact', enabled: true },
      { grain: 'MARKET', scopeId: 'IT', dailyCapCents: 4000, label: 'the IT market', enabled: true },
    ])
    const r = checkCeiling(both, { committedCents: 490 }, 100)
    expect(r.message).toContain('the most specific one set for this scope')
    expect(r.bound?.grain).toBe('CAMPAIGN')
  })
})

describe('commitmentCents — an upper bound, stated as one', () => {
  it('is the sum of bids, not a forecast', () => {
    expect(commitmentCents(30, 55)).toBe(1650)
  })
  it('is zero when nothing is actionable, so a fully-blocked row commits nothing', () => {
    expect(commitmentCents(0, 55)).toBe(0)
  })
})
