/**
 * Meta step 20 — set-meta-placements' draft (pure): only placement keys change, the rest of the spec goes back as Meta has
 * it; Meta's combinations kept (Audience Network never alone, Messenger sponsored messages alone, …); more placements,
 * Advantage+ placements or limited spend on an ad set that is on is SPENDS MONEY; leaving Advantage+ placements on an
 * Advantage+ campaign is said; WhatsApp marketing messages only for an onboarded account; undo puts back the keys and the
 * limited spend. Made-up ids only.
 */
import { describe, expect, it } from 'vitest'
import { placementRestoreArgs, placementsDraft, placementsOf, placementWider, type PlacementsAsk, type PlacementsLive } from './change-placements.js'
import type { TargetingRecord } from './change-targeting.js'
import type { TargetingAdSetState } from './live-targeting-change.js'

const AD_SET = '120000000000002'
const MANUAL = { geo_locations: { countries: ['US'] }, age_min: 18, publisher_platforms: ['facebook', 'instagram'], facebook_positions: ['feed'], instagram_positions: ['stream', 'story'] }
const state = (targeting: Record<string, unknown> = MANUAL, over: Partial<TargetingAdSetState> = {}): TargetingAdSetState => ({
  id: AD_SET, name: 'Ad set B', status: 'ACTIVE', optimizationGoal: 'OFFSITE_CONVERSIONS', destinationType: 'WEBSITE', dsaPayor: null, dsaBeneficiary: null,
  campaign: { id: '120000000000001', name: 'Campaign A', status: 'ACTIVE', objective: 'OUTCOME_SALES', specialAdCategories: [], advantageState: 'DISABLED' },
  targeting: structuredClone(targeting), ...over,
})
const live = (s: TargetingAdSetState = state(), whatsapp: PlacementsLive['whatsapp'] = { status: 'MARKETING_MESSAGE_NOT_ONBOARDED' }): PlacementsLive => ({ adSets: new Map([[s.id, s]]), whatsapp })
const draft = (ask: Omit<PlacementsAsk, 'adSetId'>, l: PlacementsLive = live()) => placementsDraft([{ adSetId: AD_SET, ...ask }], l)
const ok = (d: ReturnType<typeof draft>) => { if ('refusal' in d) throw new Error(d.refusal); return d }

describe('set-meta-placements', () => {
  it('Advantage+ placements: every placement key removed, the rest kept; SPENDS MONEY on an ad set that is on; Meta may add new ones (said)', () => {
    const d = ok(draft({ advantagePlacements: true }))
    expect(d.requests[0]).toMatchObject({ objectKind: 'adsetplacement', operation: 'adset.placements', raisesSpend: true, readBackFields: 'id,targeting' })
    expect(JSON.parse(d.requests[0].params.targeting)).toEqual({ geo_locations: { countries: ['US'] }, age_min: 18 })
    expect(d.spendsMoney[0]).toMatch(/Advantage\+ placements \(every placement, and new ones Meta adds\)/)
    expect(d.warnings.join(' ')).toMatch(/may add new positions or platforms later/)
  })
  it('fewer placements spend nothing; leaving Advantage+ placements on an Advantage+ campaign is said', () => {
    const fewer = ok(draft({ instagramPositions: ['stream'] }))
    expect(fewer.spendsMoney).toEqual([])
    const auto = state({ geo_locations: { countries: ['US'] } })
    auto.campaign!.advantageState = 'ADVANTAGE_PLUS_SALES'
    const manual = ok(draft({ platforms: ['facebook'], facebookPositions: ['feed'] }, live(auto)))
    expect(manual.warnings.join(' ')).toMatch(/ADVANTAGE_PLUS_SALES: choosing placements by hand turns Advantage\+ off/)
    expect(manual.spendsMoney).toEqual([])
  })
  it('Meta\'s combinations, refused in words before any call; WhatsApp marketing messages only for an onboarded account', () => {
    expect(draft({ platforms: ['audience_network'] })).toEqual({ refusal: expect.stringMatching(/Audience Network alone/) })
    expect(draft({ facebookPositions: ['story'], instagramPositions: ['stream'] })).toEqual({ refusal: expect.stringMatching(/story needs Facebook feed or Instagram story/) })
    expect(draft({ platforms: ['messenger', 'facebook'], messengerPositions: ['sponsored_messages'] })).toEqual({ refusal: expect.stringMatching(/no other placement/) })
    expect(draft({ instagramPositions: ['explore'] })).toEqual({ refusal: expect.stringMatching(/v26 removed explore/) })
    expect(draft({ advantagePlacements: true, platforms: ['facebook'] })).toEqual({ refusal: expect.stringMatching(/either advantagePlacements or the platforms/) })
    const wa = { platforms: ['facebook', 'instagram', 'whatsapp'] as PlacementsAsk['platforms'], whatsappPositions: ['marketing_messages'] }
    expect(draft(wa)).toEqual({ refusal: expect.stringMatching(/needs the ad account onboarded to marketing messages/) })
    expect(ok(draft(wa, live(state(), { status: 'MARKETING_MESSAGE_ONBOARDED' }))).requests).toHaveLength(1)
  })
  it('limited spend on excluded placements alone: its own request on the ad set; allowing it is SPENDS MONEY, clearing it is not', () => {
    const s = state(MANUAL, { softOptOut: null })
    const d = ok(draft({ softOptOut: { facebookPositions: ['marketplace'] } }, live(s)))
    expect(d.requests[0]).toMatchObject({ kind: 'adset', operation: 'adset.placementSoftOptOut', params: { placement_soft_opt_out: '{"facebook_positions":["marketplace"]}' }, readBackFields: 'id,placement_soft_opt_out' })
    expect(d.requests[0].objectKind).toBeUndefined()
    expect(d.spendsMoney[0]).toMatch(/limited spend \(up to 5% each\) allowed on excluded facebook_positions:marketplace/)
    const clear = ok(draft({ softOptOut: null }, live(state(MANUAL, { softOptOut: { facebook_positions: ['marketplace'] } }))))
    expect(clear.requests[0].params).toEqual({ placement_soft_opt_out: '{}' })
    expect(clear.spendsMoney).toEqual([])
    expect(draft({ softOptOut: null }, live(state(MANUAL, { softOptOut: { unread: 'Meta: no such field' } })))).toEqual({ refusal: expect.stringMatching(/did not let Nexus read its limited spend/) })
  })
  it('with placements, the limited spend rides on the same request and is judged on its read-back', () => {
    const d = ok(draft({ facebookPositions: ['feed', 'marketplace'], softOptOut: { audienceNetworkPositions: ['classic'] } }, live(state(MANUAL, { softOptOut: null }))))
    expect(d.requests[0]).toMatchObject({ operation: 'adset.placements', readBackFields: 'id,targeting,placement_soft_opt_out' })
    const judge = d.requests[0].judge!
    const spec = JSON.parse(d.requests[0].params.targeting)
    expect(judge({ targeting: spec, placement_soft_opt_out: { audience_network_positions: ['classic'] } }).moved).toEqual([])
    expect(judge({ targeting: spec, placement_soft_opt_out: {} }).moved).toEqual(['placement_soft_opt_out'])
  })
  it('review A5 — sponsorship placements added where there were none, and unknown ages back by default under WhatsApp Status: wider', () => {
    expect(placementWider(MANUAL, { ...MANUAL, instream_video_sponsorship_placements: ['pre_roll'] }, null, null)).toEqual([expect.stringMatching(/sponsorship placements changed/)])
    const status = { ...MANUAL, publisher_platforms: ['facebook', 'instagram', 'whatsapp'], whatsapp_positions: ['status'] }
    expect(placementWider({ ...status, user_age_unknown: false }, status, null, null)).toEqual([expect.stringMatching(/people whose age is unknown \(WhatsApp Status: Meta's default once the setting goes\)/)])
    expect(placementWider({ ...MANUAL, user_age_unknown: false }, MANUAL, null, null)).toEqual([])
  })
  it('review B5 — v26-removed placements an ad set still holds are said', () => {
    const d = ok(draft({ facebookPositions: ['feed', 'marketplace'] }, live(state({ ...MANUAL, instagram_positions: ['stream', 'explore'] }))))
    expect(d.warnings.join(' ')).toMatch(/removed in v26 \(instagram explore\)/)
    // Review A2 — the gateway lets only the keys this draft changed differ from the live spec.
    expect(d.requests[0].targetingKeys).toEqual(['facebook_positions'])
  })
  it('where a spec places ads, and what widens', () => {
    expect(placementsOf({}).advantage).toBe(true)
    expect([...placementsOf({ publisher_platforms: ['facebook'], facebook_positions: ['feed'] }).positions]).toEqual(['facebook:feed'])
    expect(placementWider(MANUAL, { ...MANUAL, user_age_unknown: true }, null, null)).toEqual(['people whose age is unknown (WhatsApp Status)'])
    expect(placementWider({ ...MANUAL, instream_video_skippable_excluded: true }, MANUAL, null, null)).toEqual(['skippable in-stream ads back in'])
  })
  it('undo: the placement keys and the limited spend as Meta held them', () => {
    const d = ok(draft({ advantagePlacements: true, softOptOut: { facebookPositions: ['marketplace'] } }, live(state(MANUAL, { softOptOut: null }))))
    const back = placementRestoreArgs(d.before as TargetingRecord, d.after as TargetingRecord)
    expect(back).toEqual([{ adSetId: AD_SET, restore: { publisher_platforms: ['facebook', 'instagram'], facebook_positions: ['feed'], instagram_positions: ['stream', 'story'] }, restoreSoftOptOut: null }])
    const s = state({ geo_locations: { countries: ['US'] }, age_min: 18 }, { softOptOut: { facebook_positions: ['marketplace'] } })
    const undone = ok(placementsDraft(back as PlacementsAsk[], live(s)))
    expect(JSON.parse(undone.requests[0].params.targeting)).toEqual(MANUAL)
    expect(undone.requests[0].params.placement_soft_opt_out).toBe('{}')
    expect(placementsDraft([{ adSetId: AD_SET, restore: { age_min: 30 } }], live())).toEqual({ refusal: expect.stringMatching(/not a key set-meta-placements puts back/) })
  })
})
