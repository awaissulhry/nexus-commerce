/**
 * Meta step 20 — set-meta-targeting's draft (pure): the whole live spec goes back with only the keys asked; location_types
 * never sent (1870199); Advantage+ audience always said; reaching more people on an ad set that is on is SPENDS MONEY
 * (said when its campaign is off), narrower is safe; the EU payer / beneficiary, under-18s in the EU and special ad
 * categories are kept; the read-back judge sees past the names Meta adds; undo puts back each key as Meta held it. Made-up
 * ids and names only.
 */
import { describe, expect, it } from 'vitest'
import { applyLocations, mayReach, placePageSetDraft, restoreArgs, targetingDraft, targetingJudge, widerParts, type AudienceAsk, type TargetingLive, type TargetingRecord } from './change-targeting.js'
import { AUDIENCE_TARGETING_KEYS } from '../../gateway/meta-targeting-rules.js'
import { DSA_COUNTRIES } from './live-create.js'
import type { TargetingAdSetState } from './live-targeting-change.js'

const AD_SET = '120000000000002'
const TARGETING = {
  geo_locations: { countries: ['US'], location_types: ['home', 'recent'] }, age_min: 18,
  flexible_spec: [{ interests: [{ id: '6003000000001', name: 'Interest A' }] }],
  targeting_automation: { advantage_audience: 0 }, brand_safety_content_filter_levels: ['FEED_STANDARD'], effective_publisher_platforms: ['facebook'],
}
const state = (over: Partial<TargetingAdSetState> = {}): TargetingAdSetState => ({
  id: AD_SET, name: 'Ad set B', status: 'ACTIVE', optimizationGoal: 'OFFSITE_CONVERSIONS', destinationType: 'WEBSITE', dsaPayor: null, dsaBeneficiary: null,
  campaign: { id: '120000000000001', name: 'Campaign A', status: 'ACTIVE', objective: 'OUTCOME_SALES', specialAdCategories: [], advantageState: 'DISABLED' },
  targeting: structuredClone(TARGETING), ...over,
})
const live = (s: TargetingAdSetState = state(), over: Partial<TargetingLive> = {}): TargetingLive => ({ adSets: new Map([[s.id, s]]), dsaDefaults: null, accountExcludedEmployers: null, ...over })
const draft = (ask: Omit<AudienceAsk, 'adSetId'>, l: TargetingLive = live()) => targetingDraft([{ adSetId: AD_SET, ...ask }], l)
const ok = (d: ReturnType<typeof draft>) => { if ('refusal' in d) throw new Error(d.refusal); return d }
const sent = (d: ReturnType<typeof draft>) => JSON.parse(ok(d).requests[0].params.targeting) as Record<string, unknown>

describe('the request: the whole live spec, only the keys asked', () => {
  it('adds a country: every other key as Meta has it, read-only keys and location_types left out, Advantage+ audience said', () => {
    const d = ok(draft({ locations: { add: { countries: ['CA'] } } }))
    const r = d.requests[0]
    expect(r).toMatchObject({ kind: 'adset', objectKind: 'adsetaudience', operation: 'adset.targeting', objectId: AD_SET, check: 'none', readBackFields: 'id,targeting', undoable: true, budget: false, targetingKeys: ['geo_locations'] })
    expect(sent(d)).toEqual({ geo_locations: { countries: ['US', 'CA'] }, age_min: 18, flexible_spec: TARGETING.flexible_spec, targeting_automation: { advantage_audience: 0 }, brand_safety_content_filter_levels: ['FEED_STANDARD'] })
    expect(d.changes['ad set "Ad set B" (120000000000002): geo_locations']).toEqual({ from: 'countries US', to: 'countries US, CA' })
    expect(d.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/back to its review/), expect.stringMatching(/whole targeting is sent/)]))
  })
  it('an ad set with no Advantage+ audience setting gets it explicitly off (the silent opt-in rule), named', () => {
    const s = state({ targeting: { geo_locations: { countries: ['US'] }, age_min: 18 } })
    const d = ok(draft({ ageMin: 21 }, live(s)))
    expect(sent(d).targeting_automation).toEqual({ advantage_audience: 0 })
    expect(d.warnings.join(' ')).toMatch(/Advantage\+ audience is sent explicitly as off \(0\)/)
    expect(d.spendsMoney).toEqual([])
  })
  it('refused in words: a place not there to remove, a city radius Meta does not take, a key a caller cannot restore, nothing asked', () => {
    expect(draft({ locations: { remove: { countries: ['DE'] } } })).toEqual({ refusal: expect.stringMatching(/holds no countries DE to remove/) })
    expect(draft({ locations: { add: { cities: [{ key: '2420605', radius: 5, unit: 'kilometer' }] } } })).toEqual({ refusal: expect.stringMatching(/radius is 17–80 km/) })
    expect(draft({ locations: { add: { zips: ['20121'] } } })).toEqual({ refusal: expect.stringMatching(/COUNTRY:CODE/) })
    expect(draft({ restore: { brand_safety_content_filter_levels: ['FEED_STRICT'] } })).toEqual({ refusal: expect.stringMatching(/not a key set-meta-targeting puts back/) })
    expect(draft({ restore: { age_min: 9 } })).toEqual({ refusal: expect.stringMatching(/age_min is 13 to 65/) })
    expect(targetingDraft([{ adSetId: AD_SET }], live())).toEqual({ refusal: expect.stringMatching(/Say what to change/) })
    expect(draft({ locations: { remove: { countries: ['US'] } } })).toEqual({ refusal: expect.stringMatching(/names a place/) })
    expect(draft({ tuneForCategory: 'HOUSING', ageMin: 21 })).toEqual({ refusal: expect.stringMatching(/goes alone/) })
  })
  it('a city already there takes the new radius; one asked again with the same radius is said, not sent twice', () => {
    const s = state({ targeting: { ...TARGETING, geo_locations: { cities: [{ key: '2420605', name: 'City A', country: 'US', radius: 20, distance_unit: 'kilometer' }] } } })
    expect(sent(draft({ locations: { add: { cities: [{ key: '2420605', radius: 40 }] } } }, live(s))).geo_locations).toEqual({ cities: [{ key: '2420605', name: 'City A', country: 'US', radius: 40, distance_unit: 'kilometer' }] })
    const geo = applyLocations(s.targeting.geo_locations, { add: { cities: [{ key: '2420605', radius: 20 }] } }, 'x')
    expect(geo.notes).toEqual([expect.stringMatching(/already holds cities 2420605/)])
  })
})

describe('spending: wider on an ad set that is on is SPENDS MONEY, narrower is safe', () => {
  it('more places, a lower age, more genders, an exclusion removed, Advantage+ switches on: each said', () => {
    const d = ok(draft({ locations: { add: { countries: ['CA'] } }, ageMin: 16, advantageDetailedTargeting: true }, live(state({ targeting: { ...TARGETING, age_min: 21 } }))))
    expect(d.requests[0].raisesSpend).toBe(true)
    expect(d.spendsMoney[0]).toMatch(/^ad set "Ad set B" \(120000000000002\) is on: adds countries CA; a lower minimum age \(21 → 16\); Advantage detailed targeting switched on .* spend more from now\.$/)
  })
  it('the campaign off: nothing spends yet (said); the ad set off: a warning, no SPENDS MONEY', () => {
    const paused = state()
    paused.campaign!.status = 'PAUSED'
    expect(ok(draft({ genders: 'all' }, live({ ...paused, targeting: { ...TARGETING, genders: [2] } }))).spendsMoney[0]).toMatch(/nothing spends yet, its campaign "Campaign A" \(120000000000001\) is not on/)
    const off = ok(draft({ advantageAudience: true }, live(state({ status: 'PAUSED' }))))
    expect(off.spendsMoney).toEqual([])
    expect(off.requests[0].raisesSpend).toBe(false)
    expect(off.warnings.join(' ')).toMatch(/is not on: Advantage\+ audience switched on/)
  })
  it('narrower: an excluded audience, an AND group, fewer countries, Wi-Fi only — nothing spends', () => {
    const s = state({ targeting: { ...TARGETING, geo_locations: { countries: ['US', 'CA'] } } })
    const d = ok(draft({
      excludedAudiences: { add: ['120000000000072'] }, locations: { remove: { countries: ['CA'] } }, wifiOnly: true,
      detailedTargeting: [{ interests: ['6003000000001'] }, { behaviors: ['6002000000001'] }],
    }, live(s)))
    expect(d.spendsMoney).toEqual([])
    expect(d.requests[0].raisesSpend).toBe(false)
    expect(sent(d).flexible_spec).toEqual([{ interests: [{ id: '6003000000001' }] }, { behaviors: [{ id: '6002000000001' }] }])
  })
  it('detailed targeting loosened (an option added to an OR group, or a group dropped) is wider', () => {
    expect(widerParts(TARGETING, { ...TARGETING, flexible_spec: [{ interests: [{ id: '6003000000001' }, { id: '6003000000002' }] }] }, ['flexible_spec'])).toEqual([expect.stringMatching(/detailed targeting loosened/)])
    expect(widerParts(TARGETING, { ...TARGETING, flexible_spec: undefined }, ['flexible_spec'])).toEqual([expect.stringMatching(/detailed targeting loosened/)])
    expect(widerParts({ ...TARGETING, custom_audiences: [] }, { ...TARGETING, custom_audiences: [{ id: '1' }] }, ['custom_audiences'])).toEqual([])
    expect(widerParts({ ...TARGETING, custom_audiences: [{ id: '1' }] }, { ...TARGETING, custom_audiences: [{ id: '1' }, { id: '2' }] }, ['custom_audiences'])).toEqual([expect.stringMatching(/custom audiences loosened/)])
    expect(widerParts({ excluded_geo_locations: { countries: ['CA'] } }, {}, ['excluded_geo_locations'])).toEqual(['no longer excludes countries CA'])
  })
  it('a re-tune can reach more people (Meta removes exclusions): SPENDS MONEY on an ad set that is on; it goes alone, undo is the old whole spec', () => {
    const d = ok(draft({ tuneForCategory: 'EMPLOYMENT' }))
    expect(d.requests[0]).toMatchObject({ operation: 'adset.tuneForCategory', params: { tune_for_category: 'EMPLOYMENT' }, raisesSpend: true, kind: 'adset' })
    expect(d.requests[0].objectKind).toBeUndefined()
    expect(d.spendsMoney[0]).toMatch(/Meta makes its targeting fit employment itself/)
    const before = d.before as TargetingRecord
    expect(Object.keys(before.adSets![0].keys)).toEqual(['geo_locations', 'age_min', 'flexible_spec', 'targeting_automation', 'brand_safety_content_filter_levels'])
  })
})

describe('Advantage+ audience, the EU, under-18s and special ad categories', () => {
  it('Advantage+ audience on: a minimum age over 25 refused; age_max removed and the ages not judged on the read-back', () => {
    expect(draft({ advantageAudience: true }, live(state({ targeting: { ...TARGETING, age_min: 30 } })))).toEqual({ refusal: expect.stringMatching(/minimum age of 25 at most/) })
    expect(draft({ advantageAudience: true, ageMin: 16 })).toEqual({ refusal: expect.stringMatching(/18 at least/) })
    const d = ok(draft({ advantageAudience: true }, live(state({ targeting: { ...TARGETING, age_max: 44 } }))))
    expect(sent(d)).not.toHaveProperty('age_max')
    expect(sent(d).targeting_automation).toEqual({ advantage_audience: 1 })
    const judge = d.requests[0].judge!
    expect(judge({ targeting: { ...sent(d), age_min: 18, age_max: 65 } }).moved).toEqual([])
    expect(draft({ ageMax: 40 }, live(state({ targeting: { ...TARGETING, targeting_automation: { advantage_audience: 1 } } })))).toEqual({ refusal: expect.stringMatching(/fixes age_max at 65/) })
    // Switching it off takes its age suggestion with it (Meta takes age_range only with a suggestion on).
    const off = ok(draft({ advantageAudience: false }, live(state({ targeting: { ...TARGETING, targeting_automation: { advantage_audience: 1 }, age_range: [25, 45] } }))))
    expect(sent(off)).not.toHaveProperty('age_range')
    expect(off.warnings.join(' ')).toMatch(/suggested age range goes too/)
  })
  it('newly reaching the EU: refused with no payer / beneficiary anywhere; the account\'s saved defaults are said', () => {
    expect(draft({ locations: { add: { countries: ['IT'] } } })).toEqual({ refusal: expect.stringMatching(/may reach the EU \(it targets IT\).*no saved defaults/) })
    const d = ok(draft({ locations: { add: { countries: ['IT'] } } }, live(state(), { dsaDefaults: { payor: 'Shop A', beneficiary: 'Shop A' } })))
    expect(d.warnings.join(' ')).toMatch(/fills in the ad account's saved EU payer and beneficiary \("Shop A" \/ "Shop A"\)/)
    expect(ok(draft({ locations: { add: { countries: ['IT'] } } }, live(state({ dsaPayor: 'Shop A', dsaBeneficiary: 'Shop A' })))).requests).toHaveLength(1)
    // A key Nexus cannot place (a new region key) counts as reaching the EU; a country only from Meta's own live read.
    expect(mayReach({ regions: [{ key: '3847' }] }, DSA_COUNTRIES)).toMatchObject({ reaches: true })
    expect(mayReach({ regions: [{ key: '3847', country: 'US' }], zips: [{ key: 'US:94304' }] }, DSA_COUNTRIES, { regions: [{ key: '3847', country: 'US' }] })).toMatchObject({ reaches: false })
    expect(mayReach({ country_groups: ['north_america'] }, DSA_COUNTRIES)).toMatchObject({ reaches: false })
    expect(mayReach({ country_groups: ['worldwide'] }, DSA_COUNTRIES)).toMatchObject({ reaches: true })
    // Review A5 — no location at all is every location: the widest case.
    expect(mayReach({}, DSA_COUNTRIES)).toMatchObject({ reaches: true, why: expect.stringMatching(/every location/) })
  })
  it('review A1 — the Italian city labelled US: a label on an item is never Meta\'s fact (only the live read\'s country counts)', () => {
    // A label a caller (or an old record) puts on an item says nothing: the city counts as reaching the EU.
    expect(mayReach({ cities: [{ key: '2420605', country: 'US' }] }, DSA_COUNTRIES)).toMatchObject({ reaches: true, why: expect.stringMatching(/cannot tell which country/) })
    expect(mayReach({ cities: [{ key: '2420605', country: 'US' }] }, DSA_COUNTRIES, { cities: [{ key: '2420605', name: 'City A', country: 'IT' }] })).toMatchObject({ reaches: true, why: 'it targets places in IT' })
    // An undo restoring such a spec onto a US-only ad set with no payer: refused, never let through by the label.
    const restore = { geo_locations: { cities: [{ key: '2420605', name: 'City A', country: 'US', radius: 20, distance_unit: 'kilometer' }] } }
    expect(targetingDraft([{ adSetId: AD_SET, restore }], live())).toEqual({ refusal: expect.stringMatching(/may reach the EU \(Nexus cannot tell which country a cities item is in/) })
    // A city added by key: the same.
    expect(draft({ locations: { add: { cities: [{ key: '2420605', radius: 20 }] } } })).toEqual({ refusal: expect.stringMatching(/may reach the EU/) })
  })
  it('review A5 — every place removed (an audience-only spec): every location, the widest case, judged so', () => {
    const s = state({ targeting: { ...TARGETING, custom_audiences: [{ id: '120000000000071' }] } })
    const d = draft({ locations: { remove: { countries: ['US'] } } }, live(s, { dsaDefaults: { payor: 'Shop A', beneficiary: 'Shop A' } }))
    expect(ok(d).spendsMoney[0]).toMatch(/no location limit any more \(every location\)/)
    expect(ok(d).warnings.join(' ')).toMatch(/may now reach the EU \(it names no location/)
    expect(draft({ locations: { remove: { countries: ['US'] } }, ageMin: 16 }, live(s))).toEqual({ refusal: expect.stringMatching(/no ads to people under 18/) })
  })
  it('review A3 — location_types: Meta\'s only option dropped silently; ["home"] alone, dropped by a rewrite, is SPENDS MONEY; left alone otherwise', () => {
    const quiet = ok(draft({ ageMin: 21 }))
    expect(sent(quiet).geo_locations).toEqual({ countries: ['US'] })
    expect(quiet.warnings.join(' ')).not.toMatch(/location_types/)
    const home = state({ targeting: { ...TARGETING, geo_locations: { countries: ['US'], location_types: ['home'] } } })
    const untouched = ok(draft({ ageMin: 21 }, live(home)))
    expect(sent(untouched).geo_locations).toEqual({ countries: ['US'], location_types: ['home'] })
    const rewritten = ok(draft({ locations: { add: { countries: ['CA'] } } }, live(home)))
    expect(sent(rewritten).geo_locations).toEqual({ countries: ['US', 'CA'] })
    expect(rewritten.spendsMoney[0]).toMatch(/location types \["home"\] → Meta's only option/)
  })
  it('review A1 — an empty detailed group never reads as narrower', () => {
    expect(widerParts(TARGETING, { ...TARGETING, flexible_spec: [{}] }, ['flexible_spec'])).toEqual([expect.stringMatching(/detailed targeting loosened/)])
    expect(widerParts(TARGETING, { ...TARGETING, flexible_spec: [{ interests: [] }] }, ['flexible_spec'])).toEqual([expect.stringMatching(/detailed targeting loosened/)])
    // An empty group asked is left out (the whole detailed targeting goes): said as loosened.
    const d = ok(draft({ detailedTargeting: [{ interests: [] }] }))
    expect(sent(d)).not.toHaveProperty('flexible_spec')
    expect(d.spendsMoney[0]).toMatch(/detailed targeting loosened/)
  })
  it('review A6 — an undo where Meta held no Advantage+ audience setting puts back exactly that (never a forced 0)', () => {
    const before: TargetingRecord = { adSets: [{ id: AD_SET, name: 'Ad set B', keys: { targeting_automation: null, age_min: 18 } }] }
    const after: TargetingRecord = { adSets: [{ id: AD_SET, name: 'Ad set B', keys: { targeting_automation: { advantage_audience: 0 }, age_min: 21 } }] }
    const back = restoreArgs(before, after, AUDIENCE_TARGETING_KEYS) as AudienceAsk[]
    const d = ok(targetingDraft(back, live(state({ targeting: { ...TARGETING, age_min: 21 } }))))
    expect(sent(d)).not.toHaveProperty('targeting_automation')
    expect(sent(d).age_min).toBe(18)
    // Meta's undocumented switches stay as Meta holds them now.
    const kept = ok(targetingDraft([{ adSetId: AD_SET, restore: { targeting_automation: { advantage_audience: 1 } } }], live(state({ targeting: { ...TARGETING, targeting_automation: { advantage_audience: 0, shared_audiences: 1 } } }))))
    expect(sent(kept).targeting_automation).toEqual({ advantage_audience: 1, shared_audiences: 1 })
  })
  it('review B5 — an ad set still holding placements v26 removed: said, pointing to set-meta-placements', () => {
    const old = ok(draft({ ageMin: 21 }, live(state({ targeting: { ...TARGETING, instagram_positions: ['stream', 'explore'] } }))))
    expect(old.warnings.join(' ')).toMatch(/placement Meta removed in v26 \(instagram explore\).*set-meta-placements/)
  })
  it('under 18 where Meta allows none (EU, EEA, Switzerland): refused; elsewhere said', () => {
    expect(draft({ ageMin: 16 }, live(state({ targeting: { ...TARGETING, geo_locations: { countries: ['CH'] } } })))).toEqual({ refusal: expect.stringMatching(/no ads to people under 18/) })
    expect(ok(draft({ ageMin: 16 })).warnings.join(' ')).toMatch(/under-18 audiences take only location, age and gender/)
  })
  it('a special ad category campaign: a gender, small radius or postcodes refused (2909035), as Meta would', () => {
    const s = state()
    s.campaign!.specialAdCategories = ['EMPLOYMENT']
    expect(draft({ genders: 'women' }, live(s))).toEqual({ refusal: expect.stringMatching(/special ad category \(EMPLOYMENT\).*no gender of its own/) })
    expect(draft({ locations: { add: { zips: ['US:94304'] } } }, live(s))).toEqual({ refusal: expect.stringMatching(/no zips/) })
    expect(draft({ detailedTargeting: [{ behaviors: ['6002000000001'] }] }, live(s))).toEqual({ refusal: expect.stringMatching(/no behaviours or demographics/) })
    expect(ok(draft({ detailedTargeting: [{ interests: ['6003000000002'] }] }, live(s))).requests).toHaveLength(1)
    // Review B6 — the least radius: 15 mi in the US and Canada, 15 km elsewhere (by Meta's own country for the place).
    const city = (country: string, radius: number) => state({ targeting: { ...TARGETING, geo_locations: { cities: [{ key: '2420605', country, radius, distance_unit: 'kilometer' }] } }, campaign: { ...s.campaign! } })
    expect(draft({ locations: { add: { cities: [{ key: '2420605', radius: 20 }] } } }, live(city('US', 30)))).toEqual({ refusal: expect.stringMatching(/15 mi in the US and Canada/) })
    expect(ok(draft({ locations: { add: { cities: [{ key: '2420605', radius: 20 }] } } }, live(city('IT', 30), { dsaDefaults: { payor: 'Shop A', beneficiary: 'Shop A' } }))).requests).toHaveLength(1)
    // EU credit ads: other ages are not refused (special-ad-category.md); housing / employment ages are.
    const credit = state({ targeting: { ...TARGETING, geo_locations: { countries: ['IT'] } }, dsaPayor: 'Shop A', dsaBeneficiary: 'Shop A' })
    credit.campaign!.specialAdCategories = ['FINANCIAL_PRODUCTS_SERVICES']
    expect(ok(draft({ ageMin: 25 }, live(credit))).requests).toHaveLength(1)
    credit.campaign!.specialAdCategories = ['HOUSING']
    expect(draft({ ageMin: 25 }, live(credit))).toEqual({ refusal: expect.stringMatching(/ages 18 to 65\+ only/) })
  })
  it('an Advantage+ campaign: switching Advantage+ audience off is said (Meta turns Advantage+ off silently)', () => {
    const s = state({ targeting: { ...TARGETING, targeting_automation: { advantage_audience: 1 } } })
    s.campaign!.advantageState = 'ADVANTAGE_PLUS_SALES'
    expect(ok(draft({ advantageAudience: false }, live(s))).warnings.join(' ')).toMatch(/is ADVANTAGE_PLUS_SALES: switching Advantage\+ audience off can turn Advantage\+ off/)
  })
  it('TG-056: an employer exclusion the account\'s controls do not hold is named (Meta refuses new ones otherwise)', () => {
    const d = ok(draft({ excludedEmployers: { add: ['108000000000001'] } }, live(state(), { accountExcludedEmployers: [] })))
    expect(sent(d).exclusions).toEqual({ work_employers: [{ id: '108000000000001' }] })
    expect(d.warnings.join(' ')).toMatch(/employer 108000000000001 is not in them/)
  })
})

describe('the read-back and undo', () => {
  it('the judge sees past the names Meta adds and location_types; a key that reads otherwise moved', () => {
    const judge = targetingJudge({ geo_locations: { countries: ['US', 'CA'] }, custom_audiences: [{ id: '120000000000071' }], genders: null })
    expect(judge({ targeting: { geo_locations: { countries: ['CA', 'US'], location_types: ['home', 'recent'] }, custom_audiences: [{ id: '120000000000071', name: 'Buyers' }] } }).moved).toEqual([])
    expect(judge({ targeting: { geo_locations: { countries: ['US', 'CA'] }, custom_audiences: [{ id: '120000000000071' }], genders: [1, 2] } }).moved).toEqual([])
    expect(judge({ targeting: { geo_locations: { countries: ['US'] }, custom_audiences: [], genders: [2] } }).moved).toEqual(['geo_locations', 'custom_audiences', 'genders'])
  })
  it('undo: each key whose view moved, put back as Meta held it (null when it was not set); a key the tool cannot send is said', () => {
    const d = ok(draft({ locations: { add: { countries: ['CA'] } }, genders: 'women' }))
    const back = restoreArgs(d.before as TargetingRecord, d.after as TargetingRecord, AUDIENCE_TARGETING_KEYS)
    expect(back).toEqual([{ adSetId: AD_SET, restore: { geo_locations: { countries: ['US'], location_types: ['home', 'recent'] }, genders: null } }])
    // The restore goes back through the same draft: location_types dropped again (1870199).
    const undone = ok(targetingDraft(back as AudienceAsk[], live(state({ targeting: { ...TARGETING, geo_locations: { countries: ['US', 'CA'] }, genders: [2] } }))))
    expect(JSON.parse(undone.requests[0].params.targeting)).toMatchObject({ geo_locations: { countries: ['US'] } })
    expect(JSON.parse(undone.requests[0].params.targeting)).not.toHaveProperty('genders')
    expect(restoreArgs({ adSets: [{ id: AD_SET, name: null, keys: { publisher_platforms: null } }] }, { adSets: [{ id: AD_SET, name: null, keys: { publisher_platforms: ['facebook'] } }] }, AUDIENCE_TARGETING_KEYS)).toEqual({ refusal: expect.stringMatching(/publisher_platforms back/) })
  })
})

describe('TG-018 / TG-019: a place page set', () => {
  it('only under the chosen Page; no undo (Meta has no delete); the SDK-only parts said', () => {
    expect(placePageSetDraft({ name: 'Stores A' }, { adAccountId: '1234567890', pageId: null })).toEqual({ refusal: expect.stringMatching(/none chosen/) })
    const d = placePageSetDraft({ name: 'Stores A', locationTypes: ['home'], background: true }, { adAccountId: '1234567890', pageId: '120000000000010' })
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.requests[0]).toMatchObject({ objectKind: 'adaccount', objectId: 'act_1234567890', edge: 'ad_place_page_sets_async', operation: 'adaccount.placePageSetAsync', undoable: false, params: { name: 'Stores A', parent_page: '120000000000010', location_types: '["home"]' } })
    expect(d.warnings.join(' ')).toMatch(/no delete of a place page set.*SDK/)
  })
})
