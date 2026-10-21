/**
 * Meta step 20 on the gateway — targeting, placements and the ad account's controls reach Meta ONLY as their exact
 * allow-list entries, and only for THIS business's objects: an ad set's audience or placements (each its own kind) may
 * differ from its LIVE targeting (read by the gateway itself) only in that rule's own keys, each value judged; every
 * custom audience, product set and place page set a change ADDS inside the spec is the chosen ad account's (one already
 * there is not read again); the controls only on the chosen ad account, whole, employers only; a place page set only under
 * the chosen Page. Made-up ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response> }))
vi.mock('./account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../cx/token.service.js', () => ({
  getAccessToken: vi.fn(async () => 'meta-system-user-token'),
  metaAppAccessToken: vi.fn(async () => '1234567|app-secret-for-tests'),
  metaAppIdOf: vi.fn(async () => '1234567'),
  metaRenewalToken: vi.fn(async () => 'stored-meta-token'),
  metaRequestProof: vi.fn(async () => ({ appsecret_proof: 'proof', appsecret_time: '1760000000' })),
}))
vi.mock('../cx/deprecation-watch.service.js', () => ({ watchForDeprecation: vi.fn(async () => undefined) }))
vi.mock('../cx/connectors/meta/token-check.js', () => ({ forgetMetaTokenCheck: vi.fn(async () => undefined) }))

import { gatewayLedger, gatewayMetaChosen, gatewayMetaPage, gatewayMetaStored } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { metaWriteCall, metaUrl } from './meta.js'
import { metaReadOnlyProblem, metaWriteVerdict } from './meta-calls.js'
import { __metaObjectLimitsTest } from './meta-object-limits.js'
import {
  AUDIENCE_TARGETING_KEYS, PLACEMENT_TARGETING_KEYS, audienceControlsProblem, audienceWholeProblem, geoSpecProblem, placementWholeProblem, sameTargeting, targetingAddedIds,
  targetingValueProblem, targetingView,
} from './meta-targeting-rules.js'
import { BRAND_SAFETY_TARGETING_KEYS, targetingOutsideProblem } from './meta-brand-safety-rules.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const AD_SET = '120000000000002'
const ACCOUNT = '1234567890'
const PAGE = '120000000000010'
const AUDIENCE = '120000000000070'
const LIVE = {
  geo_locations: { countries: ['IT'], location_types: ['home', 'recent'] }, age_min: 18,
  flexible_spec: [{ interests: [{ id: '6003000000000', name: 'Motò' }] }], custom_audiences: [{ id: '120000000000071', name: 'Buyers' }],
  targeting_automation: { advantage_audience: 0 }, brand_safety_content_filter_levels: ['FEED_STANDARD'],
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })
const form = (params: Record<string, string>) => new URLSearchParams(params).toString()
const verdict = (input: Partial<Parameters<typeof metaWriteVerdict>[0]>) => metaWriteVerdict({ method: 'POST', url: `${BASE}/${AD_SET}`, kind: 'write', ...input })
const problem = (input: Partial<Parameters<typeof metaWriteVerdict>[0]>) => { const v = verdict(input); return 'problem' in v ? v.problem : null }
const sent = (i: number) => ({ method: h.calls[i].init.method, url: new URL(h.calls[i].url), body: h.calls[i].init.body })
const adSetLive = (targeting: unknown = LIVE, account = ACCOUNT) => json({ id: AD_SET, account_id: account, optimization_goal: 'OFFSITE_CONVERSIONS', billing_event: 'IMPRESSIONS', targeting })
/** Review A2 — a step 20 targeting write names the keys its draft changed (the gateway lets only those differ from live). */
const audience = (targeting: unknown, targetingKeys: string[] = ['age_min']) => metaWriteCall({ connectionId: 'm-1', operation: 'adset.targeting', objectId: AD_SET, objectKind: 'adsetaudience', params: { targeting: JSON.stringify(targeting) }, check: false, ...(targetingKeys.length ? { targetingKeys } : {}) })
const placements = (targeting: unknown, extra: Record<string, string> = {}, targetingKeys: string[] = ['publisher_platforms']) => metaWriteCall({ connectionId: 'm-1', operation: 'adset.placements', objectId: AD_SET, objectKind: 'adsetplacement', params: { targeting: JSON.stringify(targeting), ...extra }, check: false, targetingKeys })

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  h.calls = []; h.answers = []; gatewayLedger.length = 0
  for (const record of [gatewayMetaChosen, gatewayMetaStored, gatewayMetaPage]) for (const key of Object.keys(record)) delete (record as Record<string, unknown>)[key]
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ success: true }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); __metaObjectLimitsTest.reset() })

describe('the step 20 allow-list entries (metaWriteVerdict)', () => {
  it('an ad set\'s audience and its placements: each its own kind and rule; step 39\'s brand safety keeps its own', () => {
    const next = { ...LIVE, age_min: 21 }
    expect(verdict({ body: form({ targeting: JSON.stringify(next) }), objectKind: 'adsetaudience' })).toMatchObject({ write: { rule: 'adset.targeting', kinds: ['adsetaudience'], targeting: { sent: next } } })
    expect(verdict({ body: form({ targeting: JSON.stringify(next) }), objectKind: 'adsetplacement' })).toMatchObject({ write: { rule: 'adset.placements', kinds: ['adsetplacement'] } })
    expect(verdict({ body: form({ targeting: JSON.stringify(next) }), objectKind: 'adsettargeting' })).toMatchObject({ write: { rule: 'adset.brand_safety' } })
    // Never without its kind (an ad set's settings rule never takes targeting).
    expect(problem({ body: form({ targeting: JSON.stringify(next) }), objectKind: 'adset' })).toMatch(/only Meta change/)
    expect(problem({ body: form({ targeting: JSON.stringify(next) }) })).toMatch(/only Meta change/)
    // The judge and the added ids travel with the write.
    const v = verdict({ body: form({ targeting: JSON.stringify(next) }), objectKind: 'adsetaudience' })
    expect('write' in v && typeof v.write.targeting?.judge).toBe('function')
    expect('write' in v && typeof v.write.targeting?.addedIds).toBe('function')
  })
  it('the audience rule judges the whole spec sent: one spelling, a place or an audience, Advantage+ audience\'s ages', () => {
    const p = (t: unknown, raw?: string) => problem({ body: form({ targeting: raw ?? JSON.stringify(t) }), objectKind: 'adsetaudience' })
    expect(p(null, '{"age_min": 21}')).toMatch(/one spelling/)
    expect(p({ age_min: 21 })).toMatch(/names a place/)
    expect(p({ ...LIVE, targeting_automation: { advantage_audience: 1 }, age_max: 40 })).toMatch(/fixes age_max at 65/)
    expect(p({ ...LIVE, targeting_automation: { advantage_audience: 1 }, age_min: 30 })).toMatch(/25 at most/)
    expect(p({ ...LIVE, age_min: 40, age_max: 30 })).toMatch(/age_max is at least age_min/)
    expect(p({ ...LIVE, targeting_automation: { advantage_audience: 1 }, age_min: 16 })).toMatch(/18 to 25/)
    expect(p({ ...LIVE, targeting_automation: { advantage_audience: 1 }, age_max: 65 })).toBeNull()
    expect(p({ ...LIVE, age_range: [20, 40] })).toMatch(/age_range is a suggestion/)
    expect(p({ ...LIVE, targeting_automation: { advantage_audience: 1 }, age_range: [20, 40] })).toBeNull()
    expect(problem({ body: form({ targeting: JSON.stringify(LIVE), placement_soft_opt_out: '{}' }), objectKind: 'adsetaudience' })).toMatch(/only Meta change/)
  })
  it('the placements rule: the documented combinations only, the limited spend with it; alone on an ad set', () => {
    const p = (t: unknown, extra: Record<string, string> = {}) => problem({ body: form({ targeting: JSON.stringify(t), ...extra }), objectKind: 'adsetplacement' })
    expect(p({ ...LIVE, publisher_platforms: ['audience_network'] })).toMatch(/Audience Network alone/)
    expect(p({ ...LIVE, publisher_platforms: ['facebook'], facebook_positions: ['story'] })).toMatch(/story needs Facebook feed or Instagram story/)
    expect(p({ ...LIVE, publisher_platforms: ['facebook'], facebook_positions: ['feed', 'notification'] })).toBeNull()
    expect(p({ ...LIVE, publisher_platforms: ['instagram', 'threads'], instagram_positions: ['reels'], threads_positions: ['threads_stream'] })).toMatch(/Instagram stream/)
    expect(p({ ...LIVE, publisher_platforms: ['messenger', 'facebook'], messenger_positions: ['sponsored_messages'] })).toMatch(/no other placement/)
    // A platform with no positions of its own takes all of them: Instagram story is there when Instagram is on.
    expect(p({ ...LIVE, whatsapp_positions: ['status'] })).toBeNull()
    expect(p({ ...LIVE, publisher_platforms: ['instagram', 'whatsapp'], instagram_positions: ['stream'], whatsapp_positions: ['status'] })).toMatch(/Instagram story/)
    expect(p({ ...LIVE, messenger_positions: ['sponsored_messages'] })).toMatch(/no other placement/)
    expect(p({ ...LIVE, publisher_platforms: ['messenger'], messenger_positions: ['sponsored_messages'] })).toBeNull()
    // Review B6 — marketplace / search / profile_feed need Facebook feed; a Facebook story is mobile only.
    expect(p({ ...LIVE, publisher_platforms: ['facebook'], facebook_positions: ['marketplace'] })).toMatch(/marketplace needs Facebook feed/)
    expect(p({ ...LIVE, publisher_platforms: ['facebook', 'instagram'], facebook_positions: ['feed', 'story'], device_platforms: ['desktop'] })).toMatch(/mobile only/)
    expect(p({ ...LIVE, publisher_platforms: ['facebook'], instagram_positions: ['stream'] })).toMatch(/instagram_positions needs instagram/)
    expect(p(LIVE, { placement_soft_opt_out: '{"facebook_positions":["marketplace"]}' })).toBeNull()
    expect(p(LIVE, { placement_soft_opt_out: '{"oculus_positions":["x"]}' })).toMatch(/placement_soft_opt_out takes/)
    expect(p(LIVE, { placement_soft_opt_out: '{"facebook_positions": ["marketplace"]}' })).toMatch(/one spelling/)
    expect(verdict({ body: form({ placement_soft_opt_out: '{"audience_network_positions":["classic"]}' }), objectKind: 'adset' })).toMatchObject({ write: { rule: 'adset.placementSoftOptOut', kinds: ['adset'] } })
    expect(problem({ body: form({ placement_soft_opt_out: '{"audience_network_positions":["explore"]}' }), objectKind: 'adset' })).toMatch(/audience_network_positions lists/)
  })
  it('a re-tune: the documented categories, never CREDIT nor political ads', () => {
    expect(verdict({ body: form({ tune_for_category: 'HOUSING' }), objectKind: 'adset' })).toMatchObject({ write: { rule: 'adset.tuneForCategory' } })
    expect(problem({ body: form({ tune_for_category: 'CREDIT' }), objectKind: 'adset' })).toMatch(/never CREDIT/)
    expect(problem({ body: form({ tune_for_category: 'ISSUES_ELECTIONS_POLITICS' }), objectKind: 'adset' })).toMatch(/never CREDIT/)
    expect(problem({ body: form({ tune_for_category: 'HOUSING', status: 'ACTIVE' }), objectKind: 'adset' })).toMatch(/only Meta change/)
  })
  it('the account\'s controls: whole, on act_<id> named an ad account; employers only; documented placements; campaigns to the owner check', () => {
    const url = `${BASE}/act_${ACCOUNT}/account_controls`
    const ok = verdict({ url, objectKind: 'adaccount', body: form({ audience_controls: '{"age_min":21,"geo_locations":{"countries":["IT"]}}', placement_controls: '{"placement_exclusions":["FACEBOOK_MARKETPLACE"],"campaign_ids_to_set_ap":["120000000000001"]}' }) })
    expect(ok).toMatchObject({ write: { rule: 'adaccount.accountControls', objectId: `act_${ACCOUNT}`, ids: [{ id: '120000000000001', kind: 'campaign' }] } })
    expect(problem({ url, objectKind: 'adaccount', body: form({ audience_controls: '{"age_min":21,"exclusions":{"interests":[{"id":"6003000000000"}]}}' }) })).toMatch(/employers only/)
    expect(problem({ url, objectKind: 'adaccount', body: form({ audience_controls: '{"age_min":21}', placement_controls: '{"placement_exclusions":["INSTAGRAM_STORIES"]}' }) })).toMatch(/placement_exclusions lists/)
    expect(problem({ url, objectKind: 'adaccount', body: form({ placement_controls: '{"placement_exclusions":[]}' }) })).toMatch(/only Meta change/)
    expect(problem({ url, objectKind: 'adaccount', body: form({ audience_controls: '{"age_min":21}', other: 'x' }) })).toMatch(/only Meta change/)
    expect(problem({ url, objectKind: 'campaign', body: form({ audience_controls: '{"age_min":21}' }) })).toMatch(/only Meta change/)
  })
  it('a place page set: name and the parent Page (to the owner check), the documented location types; the SDK-only background edge', () => {
    const ok = verdict({ url: `${BASE}/act_${ACCOUNT}/ad_place_page_sets`, objectKind: 'adaccount', body: form({ name: 'Stores A', parent_page: PAGE, location_types: '["home"]' }) })
    expect(ok).toMatchObject({ write: { rule: 'adaccount.placePageSet', ids: [{ id: PAGE, kind: 'page' }] } })
    expect(verdict({ url: `${BASE}/act_${ACCOUNT}/ad_place_page_sets_async`, objectKind: 'adaccount', body: form({ name: 'Stores A', parent_page: PAGE, targeted_area_type: 'CUSTOM_RADIUS' }) })).toMatchObject({ write: { rule: 'adaccount.placePageSetAsync' } })
    expect(problem({ url: `${BASE}/act_${ACCOUNT}/ad_place_page_sets`, objectKind: 'adaccount', body: form({ name: 'Stores A', parent_page: PAGE, location_types: '["work"]' }) })).toMatch(/location_types lists/)
    expect(problem({ url: `${BASE}/act_${ACCOUNT}/ad_place_page_sets`, objectKind: 'adaccount', body: form({ name: 'Stores A' }) })).toMatch(/only Meta change/)
  })
})

describe('the value judges (Meta\'s read-back shapes too)', () => {
  it('locations: documented lists, Meta\'s item fields, never "recent" in an exclusion', () => {
    expect(geoSpecProblem({ countries: ['IT'], cities: [{ key: '2420605', name: 'Milano', region: 'Lombardia', region_id: '1234', country: 'IT', radius: 20, distance_unit: 'kilometer' }] }, 'g')).toBeNull()
    expect(geoSpecProblem({ zips: [{ key: 'IT:20121', name: '20121', primary_city_id: 2420605, region_id: 1234, country: 'IT' }] }, 'g')).toBeNull()
    expect(geoSpecProblem({ custom_locations: [{ latitude: 45.46, longitude: 9.19, radius: 5, distance_unit: 'kilometer' }] }, 'g')).toBeNull()
    expect(geoSpecProblem({ custom_locations: [{ radius: 5 }] }, 'g')).toMatch(/latitude and longitude/)
    expect(geoSpecProblem({ countries: ['it'] }, 'g')).toMatch(/two-letter/)
    expect(geoSpecProblem({ countries: ['IT'], location_types: ['recent'] }, 'g', true)).toMatch(/recent/)
    expect(geoSpecProblem({ countries: ['IT'], places_of_worship: [] }, 'g')).toMatch(/takes no places_of_worship/)
    expect(geoSpecProblem({ cities: [{ key: '1', radius: 120 }] }, 'g')).toMatch(/radius is at most 80/)
    expect(geoSpecProblem({ cities: [{ key: '1', script: '<x>\u0007' }] }, 'g')).toMatch(/takes no script/)
  })
  it('detailed targeting, audiences, switches, devices and placements', () => {
    expect(targetingValueProblem('flexible_spec', [{ interests: [{ id: '1', name: 'A' }], custom_audiences: [{ id: AUDIENCE }] }, { education_statuses: [1, 2] }])).toBeNull()
    expect(targetingValueProblem('flexible_spec', Array.from({ length: 26 }, () => ({ interests: [{ id: '1' }] })))).toMatch(/1 to 25 groups/)
    expect(targetingValueProblem('flexible_spec', [{ politics: [{ id: '1' }] }])).toMatch(/takes no politics/)
    expect(targetingValueProblem('exclusions', { work_employers: [{ id: '1' }] })).toBeNull()
    expect(targetingValueProblem('custom_audiences', [{ id: AUDIENCE, name: 'A' }, AUDIENCE])).toMatch(/each audience once/)
    expect(targetingValueProblem('targeting_automation', { advantage_audience: 1, individual_setting: { age: 1, geo: 0 }, creative_audience_pairing: 0 })).toBeNull()
    expect(targetingValueProblem('targeting_automation', { advantage_audience: 2 })).toMatch(/0 or 1/)
    expect(targetingValueProblem('targeting_automation', { prospecting: 1 })).toMatch(/takes no prospecting/)
    expect(targetingValueProblem('device_platforms', ['mobile', 'connected_tv'])).toBeNull()
    expect(targetingValueProblem('device_platforms', ['watch'])).toMatch(/mobile, desktop, connected_tv/)
    expect(targetingValueProblem('instagram_positions', ['stream', 'explore'])).toMatch(/v26 removed explore/)
    expect(targetingValueProblem('messenger_positions', ['story'])).toMatch(/v26 removed story/)
    expect(targetingValueProblem('wireless_carrier', ['Wifi'])).toBeNull()
    expect(targetingValueProblem('product_audience_specs', [{ product_set_id: '120000000000061', inclusions: [{ retention_seconds: 86400, rule: { event: { eq: 'AddToCart' } } }] }])).toBeNull()
    expect(targetingValueProblem('product_audience_specs', [{ product_set_id: '120000000000061', inclusions: [{ retention_seconds: 86400, rule: { url: { i_contains: 'x' } } }] }])).toMatch(/exactly \{"event"/)
    // Review A4 — exactly one event with eq, at least one day.
    expect(targetingValueProblem('product_audience_specs', [{ product_set_id: '120000000000061', inclusions: [{ retention_seconds: 86400, rule: { and: [{ event: { eq: 'AddToCart' } }, { userAgent: { i_contains: 'iPhone' } }] } }] }])).toMatch(/exactly/)
    expect(targetingValueProblem('product_audience_specs', [{ product_set_id: '120000000000061', inclusions: [{ retention_seconds: 3600, rule: { event: { eq: 'AddToCart' } } }] }])).toMatch(/1 to 180 days/)
    expect(targetingValueProblem('product_audience_specs', [{ product_set_id: '120000000000061', inclusions: [{ retention_seconds: 86400, rule: { event: { eq: 'Visit' } } }] }])).toMatch(/exactly/)
    // Review A1 / B6 — no empty list or group anywhere; exclusions take no custom audiences; Meta's relationship codes only.
    expect(targetingValueProblem('flexible_spec', [{}])).toMatch(/at least one list/)
    expect(targetingValueProblem('flexible_spec', [{ interests: [] }])).toMatch(/1 to 1000 options/)
    expect(targetingValueProblem('custom_audiences', [])).toMatch(/1 to 500/)
    expect(targetingValueProblem('geo_locations', { countries: [] })).toMatch(/1 to 250/)
    expect(targetingValueProblem('exclusions', { custom_audiences: [{ id: AUDIENCE }] })).toMatch(/deprecated there since v22/)
    expect(targetingValueProblem('relationship_statuses', [5])).toMatch(/1, 2, 3, 4, 6/)
    expect(geoSpecProblem({ cities: [{ key: '1', radius: 20.5, distance_unit: 'kilometer' }] }, 'g')).toMatch(/whole number/)
    expect(geoSpecProblem({ places: [{ key: '1', name: 'Place A', political_district: 'District A' }] }, 'g')).toBeNull()
    // Review A1 — targeting_automation's undocumented switches stay as the live spec holds them.
    expect(targetingValueProblem('targeting_automation', { advantage_audience: 1, shared_audiences: 1 }, { advantage_audience: 0 })).toMatch(/shared_audiences stays as Meta holds it/)
    expect(targetingValueProblem('targeting_automation', { advantage_audience: 1, shared_audiences: 1 }, { advantage_audience: 0, shared_audiences: 1 })).toBeNull()
    expect(targetingValueProblem('connections', [{ id: '1' }])).toMatch(/not a key this change sets/)
    expect(targetingValueProblem('engagement_specs', [])).toMatch(/not a key this change sets/)
    expect(audienceControlsProblem({ age_min: 18, geo_locations: { countries: ['IT'] }, exclusions: { work_employers: [{ id: '1', name: 'Employer A' }] } })).toBeNull()
    expect(audienceControlsProblem({ age_min: 18, interests: [] })).toMatch(/age_min, geo_locations, excluded_geo_locations and exclusions only/)
    // Re-review 3 — an empty location object is refused.
    expect(audienceControlsProblem({ age_min: 18, geo_locations: {} })).toMatch(/geo_locations names at least one place/)
    expect(audienceControlsProblem({ age_min: 18, excluded_geo_locations: {} })).toMatch(/excluded_geo_locations names at least one place/)
  })
  it('the whole-spec rules hold placements apart from audience, and the key sets are disjoint from brand safety', () => {
    expect(placementWholeProblem({ publisher_platforms: ['facebook', 'instagram'], instagram_positions: ['stream'], threads_positions: [] })).toBeNull()
    expect(audienceWholeProblem({ custom_audiences: [{ id: AUDIENCE }] })).toBeNull()
    const audienceKeys = new Set<string>(AUDIENCE_TARGETING_KEYS)
    for (const k of [...PLACEMENT_TARGETING_KEYS, ...BRAND_SAFETY_TARGETING_KEYS]) expect(audienceKeys.has(k), k).toBe(false)
    for (const k of BRAND_SAFETY_TARGETING_KEYS) expect((PLACEMENT_TARGETING_KEYS as readonly string[]).includes(k), k).toBe(false)
  })
  it('one view of a value: names Meta adds and location_types aside, lists in one order, ids as strings', () => {
    expect(sameTargeting({ countries: ['IT'], cities: [{ key: '1', radius: 20, distance_unit: 'kilometer' }] }, { location_types: ['home', 'recent'], cities: [{ key: '1', name: 'X', region: 'Y', region_id: '2', country: 'IT', radius: 20, distance_unit: 'kilometer' }], countries: ['IT'] })).toBe(true)
    expect(sameTargeting([{ id: '2' }, { id: '1' }], [{ id: 1, name: 'A' }, { id: '2', name: 'B' }])).toBe(true)
    expect(sameTargeting({ cities: [{ key: '1', radius: 20 }] }, { cities: [{ key: '1', radius: 30 }] })).toBe(false)
    expect(targetingView([{ retention_seconds: '86400', rule: '{"event":{"eq":"Purchase"}}' }])).toEqual([{ retention_seconds: 86400, rule: { event: { eq: 'Purchase' } } }])
  })
  it('the ids a change ADDS (an id the live spec holds is not checked again)', () => {
    const live = { custom_audiences: [{ id: '120000000000071' }], place_page_set_ids: ['120000000000090'], product_audience_specs: [{ product_set_id: '120000000000061' }] }
    const sentSpec = {
      custom_audiences: [{ id: '120000000000071' }, { id: AUDIENCE }], flexible_spec: [{ custom_audiences: [{ id: '120000000000072' }] }], excluded_dynamic_audience_ids: ['120000000000073'],
      place_page_set_ids: ['120000000000090', '120000000000091'], product_audience_specs: [{ product_set_id: '120000000000061' }, { product_set_id: '120000000000062' }],
    }
    expect(targetingAddedIds(live, sentSpec)).toEqual([
      { id: AUDIENCE, kind: 'customaudience' }, { id: '120000000000073', kind: 'customaudience' }, { id: '120000000000072', kind: 'customaudience' },
      { id: '120000000000091', kind: 'placepageset' }, { id: '120000000000062', kind: 'productset' },
    ])
  })
  it('the live comparison with the rule\'s own keys and judge (step 39\'s brand-safety default unchanged)', () => {
    const keys = new Set<string>(AUDIENCE_TARGETING_KEYS)
    expect(targetingOutsideProblem(LIVE, { ...LIVE, age_min: 21 }, keys, targetingValueProblem, 'this change')).toBeNull()
    expect(targetingOutsideProblem(LIVE, { ...LIVE, brand_safety_content_filter_levels: ['FEED_STRICT'] }, keys, targetingValueProblem, 'this change')).toMatch(/brand_safety_content_filter_levels differs .*this change changes only/)
    expect(targetingOutsideProblem(LIVE, { ...LIVE, age_min: 9 }, keys, targetingValueProblem, 'this change')).toMatch(/age_min is 13 to 65/)
    // The judge sees the live value: Meta's undocumented automation switch cannot move inside a changed key.
    const auto = { ...LIVE, targeting_automation: { advantage_audience: 0, value_expression: 1 } }
    expect(targetingOutsideProblem(auto, { ...auto, targeting_automation: { advantage_audience: 1 } }, keys, targetingValueProblem, 'this change')).toMatch(/value_expression stays as Meta holds it/)
    // Re-review 1 — live with NO targeting_automation at all: the switches are pinned against nothing, too.
    const { targeting_automation: _none, ...bare } = LIVE
    expect(targetingOutsideProblem(bare, { ...bare, targeting_automation: { advantage_audience: 0, shared_audiences: 1, value_expression: 1 } }, keys, targetingValueProblem, 'this change')).toMatch(/shared_audiences stays as Meta holds it/)
    expect(targetingOutsideProblem(bare, { ...bare, targeting_automation: { advantage_audience: 0 } }, keys, targetingValueProblem, 'this change')).toBeNull()
    expect(targetingOutsideProblem(LIVE, { ...LIVE, age_min: 21 }, new Set(BRAND_SAFETY_TARGETING_KEYS))).toMatch(/a brand-safety change changes only/)
  })
})

describe('the gateway reads the ad set and checks every object a change adds', () => {
  it('an audience change: the slot, then the live read, then the judged spec once; nothing else may differ', async () => {
    gatewayMetaStored[AD_SET] = { adAccountId: ACCOUNT, kind: 'adset' }
    h.answers.push(adSetLive(), json({ success: true }))
    const next = { ...LIVE, age_min: 21 }
    expect((await audience(next)).ok).toBe(true)
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET', 'POST'])
    expect(sent(0).url.searchParams.get('fields')).toBe('account_id,optimization_goal,billing_event,targeting')
    expect(sent(1).body).toBe(form({ targeting: JSON.stringify(next) }))
    h.calls = []
    __metaObjectLimitsTest.useMemory()
    // A brand-safety key is not this change's: refused with nothing sent.
    h.answers.push(adSetLive())
    expect(await audience({ ...LIVE, brand_safety_content_filter_levels: ['FEED_STRICT'] }).catch((e) => e)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/differs from the ad set's live targeting: this change changes only/) })
    // Another business's ad set: refused, its account never named.
    h.answers.push(adSetLive(LIVE, '5555555555'))
    const other = await audience({ ...LIVE, age_min: 21 }).catch((e) => e)
    expect(other).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(other.message).not.toContain('5555555555')
    expect(h.calls.every((c) => c.init.method === 'GET')).toBe(true)
  })
  it('review A2 — only the keys the draft changed may differ: a newer Ads Manager edit in the wait is never overwritten; no keys named: refused', async () => {
    // The draft read LIVE and changed age_min; meanwhile someone excluded a place in Ads Manager.
    h.answers.push(adSetLive({ ...LIVE, excluded_geo_locations: { countries: ['CA'] } }))
    expect(await audience({ ...LIVE, age_min: 21 }, ['age_min']).catch((e) => e)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/excluded_geo_locations of the ad set's live targeting is missing: this change changes only age_min/) })
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET'])
    // A key of the rule's own set the draft did not name is held to the live value too.
    h.calls = []
    __metaObjectLimitsTest.useMemory()
    h.answers.push(adSetLive())
    expect(await audience({ ...LIVE, age_min: 21, genders: [2] }, ['age_min']).catch((e) => e)).toMatchObject({ message: expect.stringMatching(/genders is not in the ad set's live targeting/) })
    // A step 20 targeting write that names no key is refused before any read.
    h.calls = []
    __metaObjectLimitsTest.useMemory()
    expect(await audience({ ...LIVE, age_min: 21 }, []).catch((e) => e)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/names the keys it changes/) })
    expect(h.calls).toHaveLength(0)
  })
  it('placements: only the placement keys may differ (an audience key is refused)', async () => {
    h.answers.push(adSetLive(), json({ success: true }))
    expect((await placements({ ...LIVE, publisher_platforms: ['facebook', 'instagram'] }, { placement_soft_opt_out: '{"facebook_positions":["marketplace"]}' })).ok).toBe(true)
    expect(String(sent(1).body)).toContain('placement_soft_opt_out=')
    h.calls = []
    __metaObjectLimitsTest.useMemory()
    h.answers.push(adSetLive())
    expect(await placements({ ...LIVE, age_min: 30, publisher_platforms: ['facebook'] }, {}, ['publisher_platforms', 'age_min']).catch((e) => e)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/age_min differs/) })
    // Named with the other kind: never through the placements rule's key set.
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: AD_SET, objectKind: 'adsettargeting', params: { targeting: JSON.stringify({ ...LIVE, publisher_platforms: ['facebook'] }) }, check: false }).catch((e) => e)).toBeTruthy()
  })
  it('a custom audience it ADDS is the chosen account\'s (one live read); another account\'s is refused; one already there is not read', async () => {
    const next = { ...LIVE, custom_audiences: [...LIVE.custom_audiences, { id: AUDIENCE }] }
    h.answers.push(adSetLive(), json({ id: AUDIENCE, account_id: ACCOUNT, subtype: 'CUSTOM', time_created: 1700000000 }), json({ success: true }))
    expect((await audience(next, ['custom_audiences'])).ok).toBe(true)
    expect(sent(1).url.pathname).toBe(`/${META_DEFAULT_GRAPH_API_VERSION}/${AUDIENCE}`)
    expect(sent(1).url.searchParams.get('fields')).toBe('account_id,subtype,time_created')
    h.calls = []
    __metaObjectLimitsTest.useMemory()
    h.answers.push(adSetLive(), json({ id: AUDIENCE, account_id: '5555555555', subtype: 'CUSTOM', time_created: 1700000000 }))
    expect(await audience(next, ['custom_audiences']).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/inside this change/) })
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET', 'GET'])
    // Already there: no read of it.
    h.calls = []
    __metaObjectLimitsTest.useMemory()
    h.answers.push(adSetLive(next), json({ success: true }))
    expect((await audience({ ...next, age_min: 22 })).ok).toBe(true)
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET', 'POST'])
  })
  it('a place page set it adds is one Meta lists for the chosen ad account', async () => {
    const next = { ...LIVE, place_page_set_ids: ['120000000000091'] }
    h.answers.push(adSetLive(), json({ data: [{ id: '120000000000091' }] }), json({ success: true }))
    expect((await audience(next, ['place_page_set_ids'])).ok).toBe(true)
    expect(sent(1).url.pathname).toBe(`/${META_DEFAULT_GRAPH_API_VERSION}/act_${ACCOUNT}/ad_place_page_sets`)
    h.calls = []
    __metaObjectLimitsTest.useMemory()
    h.answers.push(adSetLive(), json({ data: [{ id: '120000000000099' }] }))
    expect(await audience(next, ['place_page_set_ids']).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/place page set 120000000000091 is not one of the chosen ad account's own/) })
  })
  it('the controls only on the chosen ad account; a place page set only under the chosen Page', async () => {
    const controls = (account: string) => metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: `act_${account}`, edge: 'account_controls', objectKind: 'adaccount', params: { audience_controls: '{"age_min":21}' }, check: false })
    expect((await controls(ACCOUNT)).ok).toBe(true)
    expect(await controls('5555555555').catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    const pageSet = (page: string) => metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: `act_${ACCOUNT}`, edge: 'ad_place_page_sets', objectKind: 'adaccount', params: { name: 'Stores A', parent_page: page }, check: false })
    gatewayMetaPage['m-1'] = PAGE
    expect((await pageSet(PAGE)).ok).toBe(true)
    expect(await pageSet('120000000000011').catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/not the Facebook Page this business chose/) })
  })
})

describe('the reads step 20 makes pass the read gate as they are', () => {
  it('the ad set with its campaign and targeting, its limited spend, the campaign\'s Advantage+ state, the account\'s controls and every read-back', () => {
    const reads: Array<[string, Record<string, unknown>]> = [
      [AD_SET, { fields: 'id,name,account_id,status,optimization_goal,billing_event,destination_type,dsa_payor,dsa_beneficiary,campaign{id,name,status,objective,special_ad_categories},targeting' }],
      [AD_SET, { fields: 'id,placement_soft_opt_out' }],
      ['120000000000001', { fields: 'advantage_state_info' }],
      [`act_${ACCOUNT}/account_controls`, { fields: 'audience_controls,placement_controls,status' }],
      [`act_${ACCOUNT}/account_controls`, { fields: 'placement_controls_per_objective' }],
      [AD_SET, { fields: 'id,targeting' }],
      [AD_SET, { fields: 'id,targeting,placement_soft_opt_out' }],
      ['120000000000091', { fields: 'id,name,location_types' }],
      [`act_${ACCOUNT}/ad_place_page_sets`, { fields: 'id', limit: 100 }],
    ]
    for (const [path, query] of reads) expect(metaReadOnlyProblem({ method: 'GET', url: metaUrl(path, query as never), kind: 'read' }), path).toBeNull()
  })
})
