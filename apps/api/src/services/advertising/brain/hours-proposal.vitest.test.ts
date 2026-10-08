/**
 * ONE BRAIN AB-13 — the pure parts of the hours proposal (brain/hours-proposal.ts): the cadence, the lever over the plan's
 * campaigns (the strictest wins, the Owner's locks gathered), a rank target as the painter reads it, two time zones on one
 * clock, and what an approval stands on.
 */
import { describe, expect, it } from 'vitest'
import { hoursSettingsOf, paintTargetOf, planBasisOf, proposalDue, sameClock } from './hours-proposal.js'
import { resolveBrainSettings, type OverrideRow } from './settings.js'

const NOW = new Date('2026-10-12T04:50:00Z')
const DAY = 86_400_000

describe('the cadence', () => {
  it('once a week by default, a few hours early rather than a day late; never while a request waits; 0 = never', () => {
    expect(proposalDue(null, 1, NOW, false)).toEqual({ due: true, why: 'no research yet' })
    expect(proposalDue({ createdAt: new Date(NOW.getTime() - 7 * DAY + 3 * 3_600_000), status: 'SHADOW' }, 1, NOW, false).due).toBe(true)
    expect(proposalDue({ createdAt: new Date(NOW.getTime() - 6 * DAY), status: 'SHADOW' }, 1, NOW, false)).toMatchObject({ due: false, why: expect.stringMatching(/the next research is due after 2026-10-12T22:50 UTC \(1 a week\)/) })
    expect(proposalDue({ createdAt: new Date(NOW.getTime() - 4 * DAY), status: 'NO_CHANGE' }, 2, NOW, false).due).toBe(true)
    expect(proposalDue({ createdAt: new Date(NOW.getTime() - 30 * DAY), status: 'PROPOSED' }, 1, NOW, true)).toMatchObject({ due: false, why: expect.stringMatching(/still waits for a person/) })
    expect(proposalDue(null, 0, NOW, false)).toMatchObject({ due: false, why: expect.stringMatching(/hourProposalsPerWeek is 0/) })
  })
})

const row = (o: Partial<OverrideRow>): OverrideRow => ({ id: Math.random().toString(36).slice(2), productId: 'p', marketplace: 'IT', scope: 'PRODUCT', campaignId: null, kind: 'LEVEL', key: 'hours', ref: '', value: 'PROPOSE', by: 'user:owner', reason: null, createdAt: '2026-10-08T10:00:00Z', endedAt: null, ...o })
const settings = (overrides: OverrideRow[], campaignId: string | null = null, enrolled = true) => resolveBrainSettings({ productId: 'p', market: 'IT', campaignId, enrolled, overrides })

describe('the hours lever over the plan', () => {
  it('the strictest of the product and its plan\'s campaigns wins; locks of every one are gathered; values from the product', () => {
    const o = [
      row({}),
      row({ kind: 'LOCK', ref: 'hourCell:d1h14', value: null }),
      row({ scope: 'CAMPAIGN', campaignId: 'c-2', kind: 'LOCK', ref: 'hourCell:d2h9', value: null }),
      row({ scope: 'CAMPAIGN', campaignId: 'c-2', kind: 'LOCK', key: 'placements', ref: 'lane:TOP_OF_SEARCH', value: null }),
      row({ kind: 'VALUE', key: 'minBidEntriesPerDay', value: 3 }),
      row({ scope: 'CAMPAIGN', campaignId: 'c-2', kind: 'VALUE', key: 'minBidEntriesPerDay', value: 1 }),
      row({ kind: 'VALUE', key: 'hourPlanAsLimits', value: true }),
    ]
    const s = hoursSettingsOf(settings(o), [{ campaignId: 'c-1', name: 'one', settings: settings(o, 'c-1') }, { campaignId: 'c-2', name: 'two', settings: settings(o, 'c-2') }])
    expect(s).toMatchObject({ level: 'PROPOSE', hourCellMovePct: 30, minBidEntriesPerDay: 1, hourProposalsPerWeek: 1, hourResearchWeeks: 4, hourPlanAsLimits: true })
    expect([...s.cells].sort()).toEqual(['d1h14', 'd2h9'])
    expect([...s.lanes]).toEqual(['TOP_OF_SEARCH'])
    // A campaign of the plan at OBSERVE keeps the whole plan in shadow, and says which.
    const shadow = [...o, row({ scope: 'CAMPAIGN', campaignId: 'c-2', value: 'OBSERVE' })]
    expect(hoursSettingsOf(settings(shadow), [{ campaignId: 'c-2', name: 'two', settings: settings(shadow, 'c-2') }])).toMatchObject({ level: 'OBSERVE', why: expect.stringMatching(/campaign "two" of the plan/) })
    // The Owner's lock of the whole lever on one campaign: a recommendation only.
    const locked = [...o, row({ scope: 'CAMPAIGN', campaignId: 'c-1', kind: 'LOCK', ref: '', value: null })]
    expect(hoursSettingsOf(settings(locked), [{ campaignId: 'c-1', name: 'one', settings: settings(locked, 'c-1') }]).level).toBe('LOCKED')
    // Excluded or off on a campaign: nothing painted there; not enrolled: nothing at all.
    const excluded = [...o, row({ scope: 'CAMPAIGN', campaignId: 'c-1', kind: 'EXCLUDE', key: '*', value: null })]
    expect(hoursSettingsOf(settings(excluded), [{ campaignId: 'c-1', name: 'one', settings: settings(excluded, 'c-1') }]).level).toBe('EXCLUDED')
    expect(hoursSettingsOf(settings(o, null, false), []).level).toBe('NOT_ENROLLED')
    // A whole-lever placements lock holds every lane (or the lanes it names).
    const lanes = [row({ kind: 'LOCK', key: 'placements', ref: '', value: null })]
    expect([...hoursSettingsOf(settings(lanes), []).lanes].sort()).toEqual(['PRODUCT_PAGE', 'REST_OF_SEARCH', 'TOP_OF_SEARCH'])
  })
})

describe('a rank target as the painter reads it', () => {
  it('a single placement declares its lane; a blend owns all three (undeclared 0); Min bid declares none', () => {
    expect(paintTargetOf({ key: 'own', placement: 'PLACEMENT_TOP', biasPct: 100 }, 'Own')).toEqual({ key: 'own', name: 'Own', floor: false, placementPct: 100, lanes: { TOP_OF_SEARCH: 100 }, maxCpcCents: null })
    expect(paintTargetOf({ key: 'blend', placement: 'PLACEMENT_TOP', lanes: [{ placement: 'PLACEMENT_TOP', biasPct: 150 }, { placement: 'PLACEMENT_PRODUCT_PAGE', biasPct: 50 }], maxCpcCents: 120 }, 'Blend'))
      .toMatchObject({ placementPct: 150, lanes: { TOP_OF_SEARCH: 150, PRODUCT_PAGE: 50, REST_OF_SEARCH: 0 }, maxCpcCents: 120 })
    expect(paintTargetOf({ key: 'pause', pause: true }, 'Min bid')).toMatchObject({ floor: true, lanes: {} })
  })
})

describe('clocks and bases', () => {
  it('two zones on one clock all year (Rome and Berlin), or not (Rome and London)', () => {
    expect(sameClock('Europe/Rome', 'Europe/Berlin')).toBe(true)
    expect(sameClock('Europe/Rome', 'Europe/London')).toBe(false)
  })

  it('what an approval stands on moves with the week, the members, the on/off, a campaign\'s own values or a target\'s values', () => {
    const plan = { windows: [{ days: [1], startHour: 0, endHour: 4, targetKey: 'own' }], defaultTargetKey: 'rest', enabled: true, members: ['c-2', 'c-1'], timezone: 'Europe/Rome', overrides: {} }
    const t = [paintTargetOf({ key: 'own', placement: 'PLACEMENT_TOP', biasPct: 100 }, 'Own')]
    const base = planBasisOf(plan, t)
    expect(planBasisOf({ ...plan, members: ['c-1', 'c-2'] }, t)).toBe(base) // order does not matter
    expect(planBasisOf({ ...plan, enabled: false }, t)).not.toBe(base)
    expect(planBasisOf({ ...plan, overrides: { 'c-1': { own: { biasPct: 50 } } } }, t)).not.toBe(base)
    expect(planBasisOf(plan, [paintTargetOf({ key: 'own', placement: 'PLACEMENT_TOP', biasPct: 120 }, 'Own')])).not.toBe(base)
  })
})
