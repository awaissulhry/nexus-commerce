/**
 * Meta step 21 — create-meta-reach-frequency as a draft (pure): a prediction (a quote: nothing spends) with one country, the
 * chosen Page / Instagram account, dates Meta takes and a frequency cap; a booking (SPENDS MONEY, the amount and dates
 * named) only of a ready prediction; a cancel only before it runs; an ad set takes a reservation only in a RESERVED campaign,
 * with an ad, not active, and lets it go with 0; Meta's grant missing is said in words; units by one helper each; every
 * request judged by the gateway's exact rule. Made-up ids.
 */
import { describe, expect, it } from 'vitest'
import { reachFrequencyDraft, reservationUndoState, rfBudgetCents, rfBudgetParam, rfResetHours, rfStatusWords, type ReachFrequencyLive, type ReachFrequencyRequest } from './change-reach-frequency.js'
import type { MetaChangeDraft } from './change-draft.js'
import type { LivePrediction, RulesAdSet } from './live-labels-rules.js'
import { metaWriteVerdict } from '../../gateway/meta-calls.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../../meta/api-version.js'

const NOW = new Date('2026-10-21T08:00:00Z')
const P = '120000000000090'
const S = '120000000000002'
const PAGE = '120000000000085'
const IG = '120000000000086'
const READY: LivePrediction = {
  id: P, status: 1, predictionMode: 1, reservationStatus: 0, adSetId: null, campaignId: null, start: Date.parse('2026-11-01T00:00:00Z') / 1000, stop: Date.parse('2026-11-15T00:00:00Z') / 1000,
  expiration: null, budgetCents: 500000, reach: 1200000, impressions: 3600000, frequencyCap: 3, intervalFrequencyCap: null, intervalResetHours: null, destinationId: PAGE, instagramDestinationId: null, unread: [],
}
const AD_SET: RulesAdSet = {
  id: S, name: 'Ad set B', status: 'PAUSED', effectiveStatus: 'PAUSED', bidStrategy: null, legacyBidMultipliers: null, valueRuleSetId: null, valueRulesApplied: null, rfPredictionId: null,
  campaign: { id: '120000000000001', name: 'Campaign A', status: 'ACTIVE', buyingType: 'RESERVED', bidStrategy: null, specialAdCategories: [] },
}
const LIVE: ReachFrequencyLive = { adAccountId: '1234567890', currency: 'EUR', now: NOW, capabilities: ['CAN_USE_REACH_AND_FREQUENCY'], pageId: PAGE, instagramId: IG, prediction: READY, adSet: AD_SET, adSetHasAds: true }
const PREDICT: ReachFrequencyRequest = { action: 'predict', mode: 'reach-from-budget', budgetCents: 500000, startTime: '2026-11-01T00:00:00Z', stopTime: '2026-11-15T00:00:00Z', frequencyCap: 3, targeting: { country: 'IT' } }
const draft = (r: ReachFrequencyRequest, live: Partial<ReachFrequencyLive> = {}) => reachFrequencyDraft(r, { ...LIVE, ...live })
const ok = (r: ReachFrequencyRequest, live: Partial<ReachFrequencyLive> = {}) => { const d = draft(r, live); if ('refusal' in d) throw new Error(d.refusal); return d }
const no = (r: ReachFrequencyRequest, live: Partial<ReachFrequencyLive> = {}) => { const d = draft(r, live); return 'refusal' in d ? d.refusal : null }
const rule = (d: MetaChangeDraft) => {
  const q = d.requests[0]
  const v = metaWriteVerdict({ method: 'POST', url: `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}/${q.objectId}${q.edge ? `/${q.edge}` : ''}`, kind: 'write', body: new URLSearchParams(q.params).toString(), objectKind: q.objectKind ?? q.kind })
  return 'write' in v ? v.write.rule : v.problem
}

describe('units, one helper each', () => {
  it('the budget in Meta\'s unit (cents of the account currency) and back; a reset period in hours', () => {
    expect(rfBudgetParam(500000, 'EUR')).toBe('500000')
    expect(rfBudgetParam(5000, 'JPY')).toBe('5000')
    expect(rfBudgetCents('500000', 'EUR')).toBe(500000)
    expect(rfBudgetCents(null, 'EUR')).toBeNull()
    expect(rfResetHours(2)).toBe('48')
    expect(rfStatusWords(15)).toMatch(/not enough inventory/)
    expect(rfStatusWords(2)).toMatch(/pending/)
    expect(rfStatusWords(150)).toMatch(/Meta's side/)
  })
})

describe('predict: a quote', () => {
  it('one country, the chosen Page, Unix times, the cap; books and spends nothing; judged by the gateway', () => {
    const d = ok(PREDICT)
    expect(d.requests[0]).toMatchObject({ objectId: 'act_1234567890', edge: 'reachfrequencypredictions', objectKind: 'adaccount', raisesSpend: false, check: 'none' })
    expect(d.requests[0].params).toEqual({
      prediction_mode: '1', start_time: String(Date.parse('2026-11-01T00:00:00Z') / 1000), stop_time: String(Date.parse('2026-11-15T00:00:00Z') / 1000),
      target_spec: '{"geo_locations":{"countries":["IT"]},"publisher_platforms":["facebook"]}', destination_ids: JSON.stringify([PAGE]), budget: '500000', frequency_cap: '3',
      story_event_type: '0',
    })
    expect(rule(d)).toBe('rf.predict')
    expect(d.spendsMoney).toEqual([])
    expect(d.summary).toMatch(/books and spends nothing/)
  })
  it('the other mode, placements with Instagram, a cap over days, a target frequency (SDK) instead', () => {
    const d = ok({ ...PREDICT, mode: 'budget-from-reach', budgetCents: undefined, reach: 1000000, destinations: ['page', 'instagram'], frequencyCapDays: 7, targeting: { country: 'IT', platforms: ['facebook', 'instagram'], instagramPositions: ['stream', 'reels'], genders: ['female'] } })
    expect(d.requests[0].params).toMatchObject({ prediction_mode: '0', reach: '1000000', interval_frequency_cap_reset_period: '168', destination_ids: JSON.stringify([PAGE, IG]) })
    expect(JSON.parse(d.requests[0].params.target_spec)).toEqual({ geo_locations: { countries: ['IT'] }, genders: [2], publisher_platforms: ['facebook', 'instagram'], instagram_positions: ['stream', 'reels'] })
    // Placements left out: Facebook only — or Facebook and Instagram when the Instagram account is a destination.
    expect(JSON.parse(ok({ ...PREDICT, destinations: ['page', 'instagram'] }).requests[0].params.target_spec).publisher_platforms).toEqual(['facebook', 'instagram'])
    expect(ok({ ...PREDICT, videoAds: 'video' }).requests[0].params.story_event_type).toBe('128')
    expect(rule(d)).toBe('rf.predict')
    const t = ok({ ...PREDICT, frequencyCap: undefined, targetFrequency: 2, targetFrequencyDays: 7 })
    expect(t.requests[0].params).toMatchObject({ target_frequency: '2', is_balanced_frequency: 'true', target_frequency_reset_period: '168' })
    expect(t.warnings.join(' ')).toMatch(/SDK only/)
    expect(rule(t)).toBe('rf.predict')
  })
  it('refused in words: no grant, dates Meta will not take, no cap, no Page, Instagram placements without the account', () => {
    expect(no(PREDICT, { capabilities: [] })).toMatch(/has not granted reach and frequency/)
    expect(ok(PREDICT, { capabilities: null }).warnings.join(' ')).toMatch(/could not read whether Meta granted/)
    expect(no({ ...PREDICT, startTime: '2026-10-20T00:00:00Z' })).toMatch(/starts in the future/)
    expect(no({ ...PREDICT, stopTime: '2026-12-31T00:00:00Z' })).toMatch(/8 weeks ahead/)
    expect(no({ ...PREDICT, frequencyCap: undefined })).toMatch(/frequency cap .* or a target frequency/)
    expect(no(PREDICT, { pageId: null })).toMatch(/No Facebook Page is chosen/)
    expect(no({ ...PREDICT, targeting: { country: 'IT', platforms: ['instagram'] } })).toMatch(/Instagram placements need the chosen Instagram account/)
    expect(no({ ...PREDICT, reach: 5 })).toMatch(/names budgetCents .* and no reach/)
    expect(ok({ ...PREDICT, campaignId: '120000000000001' }, { campaignBuyingType: 'AUCTION' }).warnings.join(' ')).toMatch(/buyingType RESERVED/)
  })
})

describe('reserve: a booking (SPENDS MONEY)', () => {
  it('only a ready prediction; the amount and dates named; Meta\'s hour said; judged by the gateway', () => {
    const d = ok({ action: 'reserve', predictionId: P })
    expect(d.requests[0]).toMatchObject({ params: { action: 'reserve', rf_prediction_id: P }, raisesSpend: true })
    expect(rule(d)).toBe('rf.reservation')
    expect(d.spendsMoney.join(' ')).toMatch(/agreeing to pay Meta's proposed costs: about 5000\.00 EUR for about 1,200,000 people, at most 3 times each, 2026-11-01 00:00 UTC → 2026-11-15 00:00 UTC.*about an hour/)
    const point = ok({ action: 'reserve', predictionId: P, point: { reach: 900000, budgetCents: 300000, impressions: 2000000 } })
    expect(point.requests[0].params).toMatchObject({ reach: '900000', budget: '300000', impression: '2000000' })
    expect(point.spendsMoney.join(' ')).toMatch(/about 3000\.00 EUR for about 900,000 people/)
    expect(rule(point)).toBe('rf.reservation')
    expect(no({ action: 'reserve', predictionId: P }, { prediction: { ...READY, status: 2 } })).toMatch(/not ready to book — status: still being worked out/)
    expect(no({ action: 'reserve', predictionId: P }, { prediction: { ...READY, status: 15 } })).toMatch(/not enough inventory/)
    expect(no({ action: 'reserve', predictionId: P }, { prediction: { ...READY, reservationStatus: 2, adSetId: S } })).toMatch(/attached to ad set/)
    expect(no({ action: 'reserve', predictionId: P }, { prediction: { ...READY, expiration: Date.parse('2026-10-21T07:00:00Z') / 1000 } })).toMatch(/expired/)
  })
  it('review A4/A5 — never booked twice; never without an amount to name', () => {
    expect(no({ action: 'reserve', predictionId: P }, { prediction: { ...READY, reservationStatus: 1 } })).toMatch(/already booked/)
    expect(no({ action: 'reserve', predictionId: P }, { prediction: { ...READY, budgetCents: null } })).toMatch(/did not answer an amount .*name the point of its curve/)
    expect(ok({ action: 'reserve', predictionId: P, point: { reach: 900000, budgetCents: 300000, impressions: 2000000 } }, { prediction: { ...READY, budgetCents: null } }).spendsMoney.join(' ')).toMatch(/about 3000\.00 EUR/)
  })
  it('review A3 — a released reservation: read, never one an ad set holds, its amount shown, in what the booking stands on, said not to come back', () => {
    const R = '120000000000091'
    const released = { ...READY, id: R, reservationStatus: 1, budgetCents: 200000 }
    expect(no({ action: 'reserve', predictionId: P, releasePredictionId: R })).toMatch(/could not read reservation/)
    expect(no({ action: 'reserve', predictionId: P, releasePredictionId: R }, { released: { ...released, reservationStatus: 2, adSetId: S } })).toMatch(/attached to ad set 120000000000002/)
    expect(no({ action: 'reserve', predictionId: P, releasePredictionId: R }, { released: { ...released, reservationStatus: 0 } })).toMatch(/nothing to release/)
    const d = ok({ action: 'reserve', predictionId: P, releasePredictionId: R }, { released })
    expect(d.requests[0].params).toMatchObject({ rf_prediction_id_to_release: R })
    expect(d.warnings.join(' ')).toMatch(/RELEASES reservation 120000000000091 \(about 2000\.00 EUR.*does not bring it back/)
    expect(d.stands).toMatchObject({ released: { id: R } })
    expect(d.before).toMatchObject({ noUndo: [expect.stringMatching(/does not come back by undo/)] })
    expect(rule(d)).toBe('rf.reservation')
  })
  it('review A1 — a booking\'s undo stays possible only while it reads reserved, free, not expired, not running', () => {
    const now = Date.parse('2026-10-21T08:00:00Z') / 1000
    expect(reservationUndoState({ reservationStatus: 1, adSetId: null, expiration: null, start: READY.start }, now)).toBeNull()
    expect(reservationUndoState({ reservationStatus: 2, adSetId: S, expiration: null, start: READY.start }, now)).toMatch(/attached to ad set .*let it go first/)
    expect(reservationUndoState({ reservationStatus: 2, adSetId: S, expiration: null, start: now - 60 }, now)).toMatch(/it runs .*cannot cancel a running reservation/)
    expect(reservationUndoState({ reservationStatus: 0, adSetId: null, expiration: null, start: READY.start }, now)).toMatch(/not reserved/)
    expect(reservationUndoState({ reservationStatus: 1, adSetId: null, expiration: now - 1, start: READY.start }, now)).toMatch(/expired/)
  })
})

describe('cancel', () => {
  it('frees a reservation that does not run; a running one is refused (delete its campaign); one cancelled already is said', () => {
    const d = ok({ action: 'cancel', predictionId: P }, { prediction: { ...READY, reservationStatus: 1 } })
    expect(d.requests[0]).toMatchObject({ params: { action: 'cancel', rf_prediction_id: P }, raisesSpend: false })
    expect(rule(d)).toBe('rf.reservation')
    expect(no({ action: 'cancel', predictionId: P }, { prediction: { ...READY, reservationStatus: 2, adSetId: S, start: Date.parse('2026-10-20T00:00:00Z') / 1000 } })).toMatch(/runs .*cannot cancel a running reservation.*remove-meta-ads-items/)
    expect(no({ action: 'cancel', predictionId: P })).toMatch(/Nothing to cancel/)
  })
})

describe('an ad set takes a reservation, or lets it go', () => {
  it('attach: a RESERVED campaign, an ad, not active, no reservation yet; SPENDS MONEY (nothing yet while the ad set is off)', () => {
    const reserved = { ...READY, reservationStatus: 1 }
    const d = ok({ action: 'attach', adSetId: S, predictionId: P }, { prediction: reserved })
    expect(d.requests[0]).toMatchObject({ objectId: S, kind: 'adset', params: { rf_prediction_id: P }, raisesSpend: true, expect: { rf_prediction_id: P } })
    expect(rule(d)).toBe('adset.rfPrediction')
    expect(d.spendsMoney.join(' ')).toMatch(/nothing spends yet: ad set "Ad set B" \(120000000000002\) is not on/)
    expect(no({ action: 'attach', adSetId: S, predictionId: P }, { prediction: reserved, adSet: { ...AD_SET, campaign: { ...AD_SET.campaign, buyingType: 'AUCTION' } } })).toMatch(/buyingType RESERVED/)
    expect(no({ action: 'attach', adSetId: S, predictionId: P }, { prediction: reserved, adSetHasAds: false })).toMatch(/has no ad/)
    expect(no({ action: 'attach', adSetId: S, predictionId: P }, { prediction: reserved, adSet: { ...AD_SET, rfPredictionId: '120000000000091' } })).toMatch(/detach it first/)
    expect(no({ action: 'attach', adSetId: S, predictionId: P }, { prediction: reserved, adSet: { ...AD_SET, effectiveStatus: 'ACTIVE' } })).toMatch(/is active/)
    expect(no({ action: 'attach', adSetId: S, predictionId: P }, { prediction: { ...READY, reservationStatus: 0 } })).toMatch(/not a booked reservation/)
    // Review B4 — only a finished booking (status 1): 2 still pending, 15 not enough inventory.
    expect(no({ action: 'attach', adSetId: S, predictionId: P }, { prediction: { ...reserved, status: 2 } })).toMatch(/not a finished booking — status: still being worked out/)
    expect(no({ action: 'attach', adSetId: S, predictionId: P }, { prediction: { ...reserved, status: 15 } })).toMatch(/not enough inventory/)
  })
  it('detach: rf_prediction_id=0; nothing spends; refused while active or with nothing attached', () => {
    const d = ok({ action: 'detach', adSetId: S }, { adSet: { ...AD_SET, rfPredictionId: P } })
    expect(d.requests[0]).toMatchObject({ params: { rf_prediction_id: '0' }, raisesSpend: false })
    expect(rule(d)).toBe('adset.rfPrediction')
    expect(d.before).toEqual({ op: 'detach', adSetId: S, adSetPrediction: P })
    expect(no({ action: 'detach', adSetId: S })).toMatch(/has no reservation/)
    expect(no({ action: 'detach', adSetId: S }, { adSet: { ...AD_SET, rfPredictionId: P, effectiveStatus: 'ACTIVE' } })).toMatch(/is active/)
  })
})
