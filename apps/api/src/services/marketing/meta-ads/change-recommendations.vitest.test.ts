/**
 * Meta step 28 — apply-meta-recommendations as a pure draft: ONE request to act_<id>/recommendations with the
 * recommendation's signature and Meta's extra_data for its type; the 14 types Meta applies by API and nothing else; a
 * selection only among the objects Meta names; every creative feature named; a budget raise in Meta's budget unit and
 * SPENDS MONEY; wider delivery in an object that is on SPENDS MONEY; copies always SPENDS MONEY; the record undo reads; the
 * restore (undo) through step 18's and step 17's rules. Made-up ids.
 */
import { describe, expect, it } from 'vitest'
import { additionalBudgetParam, applyDraft, applyTargetIds, deliversNow, restoreDraft, APPLY_TYPES, type ApplyLive, type ApplyRecord } from './change-recommendations.js'
import type { ApplyTarget, LiveRecommendation } from './live-optimize-changes.js'
import type { MetaChangeDraft } from './change-draft.js'

const S1 = '120000000000201'
const S2 = '120000000000202'
const A1 = '120000000000301'
const C1 = '120000000000101'
const target = (o: Partial<ApplyTarget> & Pick<ApplyTarget, 'kind' | 'id'>): ApplyTarget => ({
  name: `Shop A ${o.kind} ${o.id.slice(-3)}`, status: 'ACTIVE', effectiveStatus: 'ACTIVE', dailyBudget: null, lifetimeBudget: null, campaignId: C1, campaignStatus: 'ACTIVE',
  campaignHasBudget: false, optimizationGoal: 'LINK_CLICKS', billingEvent: 'IMPRESSIONS', destinationType: 'WEBSITE', advantageAudience: 0,
  placements: { publisher_platforms: ['facebook'], facebook_positions: ['feed'] }, adSetId: null, adSetStatus: null, creativeId: null, ...o,
})
const rec = (type: string, objectIds: string[]): LiveRecommendation => ({ signature: '1234567', type, stage: 'mid_flight_recommendation', objectIds, adsManagerUrl: 'https://adsmanager.example/rec', time: null })
const live = (r: LiveRecommendation | null, targets: ApplyTarget[], extra: Partial<ApplyLive> = {}): ApplyLive => ({ recommendation: r, targets, currency: 'EUR', adAccountId: '1234567890', budgetChangesLastHour: {}, ...extra })
const ok = (d: MetaChangeDraft | { refusal: string }): MetaChangeDraft => { if ('refusal' in d) throw new Error(d.refusal); return d }
const refusal = (d: MetaChangeDraft | { refusal: string }) => ('refusal' in d ? d.refusal : null)
const extra = (d: MetaChangeDraft) => JSON.parse(d.requests[0].params.extra_data)

describe('the request', () => {
  it('is ONE POST to the chosen account\'s recommendations edge, with the signature as Meta writes it, and no check', () => {
    const d = ok(applyDraft({ signature: '1234567' }, live(rec('ADVANTAGE_PLUS_AUDIENCE', [S1]), [target({ kind: 'adset', id: S1 })])))
    expect(d.requests).toEqual([expect.objectContaining({
      objectId: 'act_1234567890', objectKind: 'adaccount', edge: 'recommendations', operation: 'recommendation.apply', check: 'none',
      params: { recommendation_signature: '"1234567"', extra_data: '{}' }, raisesSpend: true, undoable: false,
    })])
    expect(d.warnings.join(' ')).toMatch(/Terms of Service/)
    expect(d.warnings.join(' ')).toMatch(/silent opt-ins/)
  })
  it('the 14 types and only them; any other type answers with the Nexus tool or the Ads Manager link', () => {
    expect(Object.keys(APPLY_TYPES).sort()).toEqual([
      'ADVANTAGE_PLUS_AUDIENCE', 'APLUSC_STANDARD_ENHANCEMENTS_BUNDLE', 'AUTOFLOW_OPT_IN', 'AUTOMATIC_PLACEMENTS', 'BACKGROUND_GENERATION', 'CONVERSION_LEADS_OPTIMIZATION',
      'CREATIVE_FATIGUE', 'LANDING_PAGE_VIEW_OPTIMIZATION_GOAL', 'MUSIC', 'PERFORMANT_CREATIVE_REELS_OPT_IN', 'PRODUCT_SET_BOOSTING', 'SCALE_GOOD_CAMPAIGN', 'SHOPS_ADS_SAOFF', 'UNCROP_IMAGE',
    ])
    expect(refusal(applyTargetIds({ signature: '1' }, rec('BUDGET_LIMITED', [C1])))).toMatch(/does not apply BUDGET_LIMITED by API.*set-meta-ad-set or set-meta-campaign.*adsmanager/)
    expect(refusal(applyDraft({ signature: '1' }, live(null, [])))).toMatch(/no longer lists a recommendation with this signature/)
  })
})

describe('which objects', () => {
  it('a type without a choice takes every object Meta names, and refuses a selection', () => {
    expect(applyTargetIds({ signature: '1' }, rec('AUTOMATIC_PLACEMENTS', [S1, S2]))).toEqual([S1, S2])
    expect(refusal(applyTargetIds({ signature: '1', objectIds: [S1] }, rec('AUTOMATIC_PLACEMENTS', [S1, S2])))).toMatch(/every object the recommendation names/)
  })
  it('a type with a choice takes a subset only, and Nexus always names the selection', () => {
    expect(applyTargetIds({ signature: '1', objectIds: [A1] }, rec('MUSIC', [A1, '120000000000302']))).toEqual([A1])
    expect(refusal(applyTargetIds({ signature: '1', objectIds: ['120000000000399'] }, rec('MUSIC', [A1])))).toMatch(/takes only the objects its recommendation names/)
    const d = ok(applyDraft({ signature: '1' }, live(rec('MUSIC', [A1]), [target({ kind: 'ad', id: A1, creativeId: '9' })])))
    expect(extra(d)).toEqual({ object_selection: A1 })
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings.join(' ')).toMatch(/Sound Collection Terms/)
    expect(d.warnings.join(' ')).toMatch(/No undo in Nexus/)
  })
})

describe('per type', () => {
  it('APLUSC: every ad gets its override, standard_enhancements always, the features not named are said', () => {
    const d = ok(applyDraft({ signature: '1', creativeFeatures: ['image_touchups'] }, live(rec('APLUSC_STANDARD_ENHANCEMENTS_BUNDLE', [A1]), [target({ kind: 'ad', id: A1 })])))
    expect(extra(d)).toEqual({ object_selection: A1, creative_feature_opt_in_overrides: JSON.stringify([{ ad_id: A1, opted_in_creative_feature_names: ['standard_enhancements', 'image_touchups'] }]) })
    expect(d.warnings.join(' ')).toMatch(/Not opted in.*image_templates/)
    expect(refusal(applyDraft({ signature: '1', creativeFeatures: ['image_touchups'] }, live(rec('MUSIC', [A1]), [target({ kind: 'ad', id: A1 })])))).toMatch(/APLUSC_STANDARD_ENHANCEMENTS_BUNDLE recommendation only/)
  })
  it('BACKGROUND_GENERATION needs on or off; its undo is the other one, through a recommendation Meta offers', () => {
    expect(refusal(applyDraft({ signature: '1' }, live(rec('BACKGROUND_GENERATION', [A1]), [target({ kind: 'ad', id: A1 })])))).toMatch(/backgroundAction OPT_IN or OPT_OUT/)
    const d = ok(applyDraft({ signature: '1', backgroundAction: 'OPT_OUT' }, live(rec('BACKGROUND_GENERATION', [A1]), [target({ kind: 'ad', id: A1 })])))
    expect(extra(d)).toEqual({ object_selection: A1, action_type: 'OPT_OUT' })
    expect((d.before as ApplyRecord).undo).toBeNull()
    expect((d.before as ApplyRecord).noUndo!.join(' ')).toMatch(/backgroundAction OPT_IN/)
  })
  it('wider delivery SPENDS MONEY only when an object is on (the line says when nothing is)', () => {
    const on = ok(applyDraft({ signature: '1' }, live(rec('AUTOMATIC_PLACEMENTS', [S1]), [target({ kind: 'adset', id: S1 })])))
    expect(on.spendsMoney.join(' ')).toMatch(/can spend more of their budgets from now/)
    expect(on.changes[Object.keys(on.changes)[0]]).toEqual({ from: 'publisher_platforms: facebook; facebook_positions: feed', to: 'Advantage+ placements (Meta picks)' })
    const off = ok(applyDraft({ signature: '1' }, live(rec('AUTOMATIC_PLACEMENTS', [S1]), [target({ kind: 'adset', id: S1, effectiveStatus: 'CAMPAIGN_PAUSED', campaignStatus: 'PAUSED' })])))
    expect(off.spendsMoney).toEqual([])
    expect(off.requests[0].raisesSpend).toBe(false)
    expect(off.warnings.join(' ')).toMatch(/Nothing spends more yet/)
    expect((off.before as ApplyRecord).objects[0].fields).toEqual({ placements: '{"publisher_platforms":["facebook"],"facebook_positions":["feed"]}' })
  })
  it('copies always SPEND MONEY (Meta does not say whether they run); undo pauses the copies Nexus finds', () => {
    expect(refusal(applyDraft({ signature: '1' }, live(rec('CONVERSION_LEADS_OPTIMIZATION', [S1]), [target({ kind: 'adset', id: S1 })])))).toMatch(/allowNewObjects: true.*adsmanager/)
    expect(refusal(applyDraft({ signature: '1', allowNewObjects: true }, live(rec('MUSIC', [A1]), [target({ kind: 'ad', id: A1 })])))).toMatch(/allowNewObjects goes with/)
    const d = ok(applyDraft({ signature: '1', allowNewObjects: true }, live(rec('CONVERSION_LEADS_OPTIMIZATION', [S1]), [target({ kind: 'adset', id: S1, effectiveStatus: 'PAUSED', status: 'PAUSED' })])))
    expect(d.spendsMoney.join(' ')).toMatch(/does not say whether they start running/)
    expect(d.requests[0]).toMatchObject({ raisesSpend: true, undoable: true })
  })
  it('review A3 — creative fatigue always SPENDS MONEY (Meta adds ads and does not say whether they start ACTIVE), even when nothing is on', () => {
    const d = ok(applyDraft({ signature: '1', allowNewObjects: true }, live(rec('CREATIVE_FATIGUE', [A1]), [target({ kind: 'ad', id: A1, status: 'PAUSED' })])))
    expect(d.spendsMoney.join(' ')).toMatch(/does not say whether they start running.*none of these ads is on/)
    expect(d.requests[0].raisesSpend).toBe(true)
  })
  it('review B2 — the landing-page goal (Meta\'s texts differ: a goal change or a new campaign): allowNewObjects, SPENDS MONEY, undo sets each goal back and pauses the copies', () => {
    expect(refusal(applyDraft({ signature: '1' }, live(rec('LANDING_PAGE_VIEW_OPTIMIZATION_GOAL', [S1]), [target({ kind: 'adset', id: S1 })])))).toMatch(/allowNewObjects: true/)
    const d = ok(applyDraft({ signature: '1', allowNewObjects: true }, live(rec('LANDING_PAGE_VIEW_OPTIMIZATION_GOAL', [S1]), [target({ kind: 'adset', id: S1 })])))
    expect(d.spendsMoney.join(' ')).toMatch(/or a campaign/)
    expect(d.warnings.join(' ')).toMatch(/texts differ/)
    expect((d.before as ApplyRecord).undo).toEqual([{ kind: 'adset', id: S1, optimizationGoal: 'LINK_CLICKS', billingEvent: 'IMPRESSIONS' }])
    // Review A9 — a goal or billing outside Nexus's own lists never goes into the undo.
    const odd = ok(applyDraft({ signature: '1', allowNewObjects: true }, live(rec('LANDING_PAGE_VIEW_OPTIMIZATION_GOAL', [S1]), [target({ kind: 'adset', id: S1, billingEvent: 'CLICKS' })])))
    expect((odd.before as ApplyRecord).undo).toBeNull()
    expect((odd.before as ApplyRecord).noUndo!.join(' ')).toMatch(/billing CLICKS is not one Nexus sends/)
  })
  it('review A1 — Meta picks the objects: a recommendation that names none is never applied', () => {
    expect(refusal(applyTargetIds({ signature: '1' }, rec('ADVANTAGE_PLUS_AUDIENCE', [])))).toMatch(/names no object/)
    expect(refusal(applyDraft({ signature: '1' }, live(rec('ADVANTAGE_PLUS_AUDIENCE', []), [])))).toMatch(/read no object/)
  })
  it('review A2 — "on" is the configured status chain (an ad with its ad set and campaign); a status not read may be on', () => {
    expect(deliversNow(target({ kind: 'adset', id: S1, effectiveStatus: 'IN_PROCESS' }))).toBe(true)
    expect(deliversNow(target({ kind: 'adset', id: S1, effectiveStatus: 'ACTIVE', campaignStatus: 'PAUSED' }))).toBe(false)
    expect(deliversNow(target({ kind: 'ad', id: A1, effectiveStatus: 'PENDING_REVIEW', adSetStatus: 'ACTIVE', campaignStatus: 'ACTIVE' }))).toBe(true)
    expect(deliversNow(target({ kind: 'ad', id: A1, adSetStatus: 'PAUSED' }))).toBe(false)
    expect(deliversNow(target({ kind: 'ad', id: A1, adSetStatus: null, campaignStatus: null }))).toBe(true)
    const pending = ok(applyDraft({ signature: '1' }, live(rec('AUTOMATIC_PLACEMENTS', [S1]), [target({ kind: 'adset', id: S1, effectiveStatus: 'WITH_ISSUES' })])))
    expect(pending.spendsMoney.join(' ')).toMatch(/can spend more/)
  })
})

describe('SCALE_GOOD_CAMPAIGN', () => {
  const adSet = target({ kind: 'adset', id: S1, dailyBudget: '5000' })
  const cbo = target({ kind: 'campaign', id: C1, dailyBudget: '20000' })
  it('the raises you name, in Meta\'s budget unit; SPENDS MONEY from → to; undo the old budgets', () => {
    expect(refusal(applyTargetIds({ signature: '1' }, rec('SCALE_GOOD_CAMPAIGN', [S1])))).toMatch(/budgetRaises/)
    expect(refusal(applyTargetIds({ signature: '1', budgetRaises: [{ objectId: '120000000000299', additionalBudgetCents: 100 }] }, rec('SCALE_GOOD_CAMPAIGN', [S1])))).toMatch(/not one of them/)
    const d = ok(applyDraft({ signature: '1', budgetRaises: [{ objectId: S1, additionalBudgetCents: 6000 }, { objectId: C1, additionalBudgetCents: 1000 }] }, live(rec('SCALE_GOOD_CAMPAIGN', [S1, C1]), [adSet, cbo])))
    expect(extra(d)).toEqual({ adsets: JSON.stringify([{ ad_object_id: S1, additional_budget: 6000 }]), campaigns: JSON.stringify([{ ad_object_id: C1, additional_budget: 1000 }]) })
    expect(d.changes).toMatchObject({ [`ad set "Shop A adset 201" (${S1}) daily budget`]: { from: '50.00 EUR', to: '110.00 EUR (+60.00 EUR)' } })
    expect(d.spendsMoney).toHaveLength(2)
    expect((d.before as ApplyRecord).undo).toEqual([{ kind: 'adset', id: S1, dailyBudgetCents: 5000 }, { kind: 'campaign', id: C1, dailyBudgetCents: 20000 }])
    expect((d.before as ApplyRecord).objects.map((o) => o.fields)).toEqual([{ daily_budget: '5000', lifetime_budget: null }, { daily_budget: '20000', lifetime_budget: null }])
    // What Meta should make of them (the run replaces it with Meta's read-back).
    expect((d.after as ApplyRecord).objects.map((o) => o.fields)).toEqual([{ daily_budget: '11000', lifetime_budget: null }, { daily_budget: '21000', lifetime_budget: null }])
  })
  it('an ad set under a campaign budget is the campaign\'s; a campaign without one, its ad sets\'; 4 budget changes an hour', () => {
    expect(refusal(applyDraft({ signature: '1', budgetRaises: [{ objectId: S1, additionalBudgetCents: 100 }] }, live(rec('SCALE_GOOD_CAMPAIGN', [S1]), [{ ...adSet, campaignHasBudget: true }])))).toMatch(/under a campaign budget/)
    expect(refusal(applyDraft({ signature: '1', budgetRaises: [{ objectId: C1, additionalBudgetCents: 100 }] }, live(rec('SCALE_GOOD_CAMPAIGN', [C1]), [{ ...cbo, dailyBudget: null }])))).toMatch(/no campaign budget/)
    const busy = ok(applyDraft({ signature: '1', budgetRaises: [{ objectId: S1, additionalBudgetCents: 100 }] }, live(rec('SCALE_GOOD_CAMPAIGN', [S1]), [adSet], { budgetChangesLastHour: { [S1]: 3 } })))
    expect(busy.warnings.join(' ')).toMatch(/changed 3 times in the last hour; Meta allows 4 an hour/)
  })
  it('the unit: one helper — EUR cents, JPY whole yen, nothing Meta cannot hold', () => {
    expect(additionalBudgetParam(6000, 'EUR')).toBe(6000)
    expect(additionalBudgetParam(6000, 'JPY')).toBe(6000)
    expect(() => additionalBudgetParam(1234, 'BHD')).toThrow(/cannot be sent exactly/)
    expect(additionalBudgetParam(1230, 'BHD')).toBe(123)
  })
})

describe('restore (the undo of an apply)', () => {
  it('each object back through step 18\'s and step 17\'s rules; what reads as recorded is skipped; a raise back up SPENDS', () => {
    const now = [target({ kind: 'adset', id: S1, dailyBudget: '11000' }), target({ kind: 'campaign', id: C1, dailyBudget: '20000' }), target({ kind: 'adset', id: S2, status: 'ACTIVE' })]
    const d = ok(restoreDraft('SCALE_GOOD_CAMPAIGN', [{ kind: 'adset', id: S1, dailyBudgetCents: 5000 }, { kind: 'campaign', id: C1, dailyBudgetCents: 20000 }, { kind: 'adset', id: S2, status: 'PAUSED' }], { targets: now, currency: 'EUR', budgetChangesLastHour: {} }))
    expect(d.requests.map((r) => [r.objectId, r.operation, r.params, r.budget, r.check])).toEqual([[S1, 'adset.settings', { daily_budget: '5000' }, true, 'none'], [S2, 'adset.status', { status: 'PAUSED' }, false, 'none']])
    expect(d.requests[0]).toMatchObject({ expect: { daily_budget: '5000' }, readBackFields: 'id,daily_budget' })
    expect(d.skipped.join(' ')).toMatch(/daily budget is 200.00 EUR already/)
    expect(d.spendsMoney).toEqual([])
    // Review A6 — an undo only lowers a budget back: a raise is refused (set-meta-ad-set's, with its own SPENDS MONEY).
    expect(refusal(restoreDraft('SCALE_GOOD_CAMPAIGN', [{ kind: 'adset', id: S1, dailyBudgetCents: 20000 }], { targets: now, currency: 'EUR', budgetChangesLastHour: {} }))).toMatch(/would raise it.*only lowers a budget back/)
    // Review A4 — a copy found by its time only is named so in the undo's preview.
    const byTime = ok(restoreDraft('CONVERSION_LEADS_OPTIMIZATION', [{ kind: 'adset', id: S2, status: 'PAUSED', foundBy: 'time' }], { targets: now, currency: 'EUR', budgetChangesLastHour: {} }))
    expect(byTime.changes[Object.keys(byTime.changes)[0]]).toEqual({ from: 'ACTIVE', to: 'PAUSED (found by its time only)' })
    expect(byTime.warnings.join(' ')).toMatch(/found by its time only.*a person may have made it by hand/)
  })
  it('a goal goes back with its billing; a campaign budget goes back with the campaign check the kit decides', () => {
    const d = ok(restoreDraft('LANDING_PAGE_VIEW_OPTIMIZATION_GOAL', [{ kind: 'adset', id: S1, optimizationGoal: 'LINK_CLICKS', billingEvent: 'LINK_CLICKS' }], { targets: [target({ kind: 'adset', id: S1, optimizationGoal: 'LANDING_PAGE_VIEWS' })], currency: 'EUR', budgetChangesLastHour: {} }))
    expect(d.requests[0].params).toEqual({ optimization_goal: 'LINK_CLICKS', billing_event: 'LINK_CLICKS' })
    const c = ok(restoreDraft('SCALE_GOOD_CAMPAIGN', [{ kind: 'campaign', id: C1, dailyBudgetCents: 15000 }], { targets: [target({ kind: 'campaign', id: C1, dailyBudget: '20000' })], currency: 'EUR', budgetChangesLastHour: {} }))
    expect(c.requests[0]).toMatchObject({ operation: 'campaign.settings', check: 'not-yet', budget: false })
  })
})
