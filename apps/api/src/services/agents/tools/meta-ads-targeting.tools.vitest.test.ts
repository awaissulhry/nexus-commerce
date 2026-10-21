/**
 * Meta ads step 9 — meta-targeting-search and meta-targeting-check. Every kind and check sends a fixed request the real
 * gateway lets through (its query-key allow-list, and /search with a targeting `type` only); a targeting spec is an
 * allow-list (unknown keys, detailed exclusions other than employers, retired placements and political categories are
 * refused before any call); every id a caller gives is the chosen account's own; a promoted object names only the
 * chosen Page / Instagram account and a pixel of the chosen account; a Page another business uses is its id only;
 * answers keep only the keys named per kind; money goes in minor units and is Meta's raw cost back (restricted).
 * Meta and the database are stubbed; made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Req = { operation: string; path: string; query?: Record<string, unknown> }
const h = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ operation: string; path: string; query?: Record<string, unknown> }>,
  answer: null as null | ((req: { operation: string; path: string; query?: Record<string, unknown> }) => unknown),
  rowsFor: null as null | ((req: { operation: string; path: string; query?: Record<string, unknown> }) => Record<string, unknown>[]),
  known: new Map<string, string>(),
  taken: [] as Array<{ id: string }>,
}))
vi.mock('../../meta/meta-accounts.service.js', () => ({ listMetaConnections: vi.fn(async () => h.connections) }))
vi.mock('../../marketing/meta-ads/read-client.js', async () => ({
  metaReadOne: vi.fn(async (_t: unknown, req: Req) => {
    h.calls.push(req)
    const body = h.answer?.(req)
    if (body instanceof Error) throw body
    return { body: body ?? { data: [] }, calls: 1 }
  }),
  metaReadAll: vi.fn(async (_t: unknown, req: Req, onRows: (rows: Record<string, unknown>[]) => void) => {
    h.calls.push(req)
    const rows = h.rowsFor?.(req) ?? []
    onRows(rows)
    return { rows: rows.length, calls: 1, truncated: false }
  }),
}))
vi.mock('../../../db.js', () => {
  const found = (pairs: Array<[string, string]>) => vi.fn(async ({ where }: { where: Record<string, string> }) =>
    (pairs.some(([key, kind]) => where[key] && h.known.get(where[key]) === kind) ? { id: 'x' } : null))
  return {
    default: {
      metaAdsCampaign: { findFirst: found([['campaignId', 'campaign']]) },
      metaAdsAdSet: { findFirst: found([['adSetId', 'adset']]) },
      metaAdsAd: { findFirst: found([['adId', 'ad'], ['creativeId', 'creative']]) },
      $queryRaw: vi.fn(async () => h.taken),
    },
  }
})

import { META_ADS_TARGETING_TOOLS } from './meta-ads-targeting.tools.js'
import { CHECKS, minorToMetaUnits, SEARCH_KINDS, SEARCH_TYPE_OF, sentenceLines, TARGETING_SPEC } from '../../marketing/meta-ads/live-targeting.js'
import { metaUrl } from '../../gateway/meta.js'
import { META_SEARCH_TYPES, metaReadOnlyProblem } from '../../gateway/meta-calls.js'

const tool = (name: string) => META_ADS_TARGETING_TOOLS.find((t) => t.name === name)!
const ctx = { can: () => true, via: 'claude' as const }
const run = (name: string, args: Record<string, unknown>) => tool(name).handler(tool(name).input.parse(args), ctx as never)
const search = (args: Record<string, unknown>) => run('meta-targeting-search', args)
const check = (args: Record<string, unknown>) => run('meta-targeting-check', args)
const data = (res: { data?: unknown }) => res.data as Record<string, any>
const CHOSEN = {
  connectionId: 'conn-1', state: 'ok', stateText: 'ok',
  adAccount: { adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR', timeZone: 'Europe/Rome', businessId: '9876543210' },
  page: { pageId: '120000000000010' }, instagram: { instagramId: '170000000000001' }, read: {},
}
const SPEC = { geo_locations: { countries: ['IT'] }, age_min: 18, age_max: 65 }
const OWN = '1234567890'
/** Meta's answer to Nexus's owner check: the account asked, and a value for every field asked (as that kind has them). */
const owned = (req: Req, account = OWN) => Object.fromEntries(String(req.query?.fields ?? '').split(',').map((f) => [f, f === 'account_id' ? account : 'x']))
const OWNER = 'targeting.ownerCheck'
/** Every call the gateway would refuse (none may be). */
const refusedCalls = () => h.calls
  .map((c) => [c.operation, metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' })])
  .filter(([, problem]) => problem)

beforeEach(() => {
  h.connections = [CHOSEN]; h.calls.length = 0; h.answer = null; h.rowsFor = null; h.taken = []
  h.known = new Map([['120000000000201', 'adset'], ['120000000000301', 'ad'], ['120000000000101', 'campaign']])
})

describe('the two tools are reads', () => {
  it('read only, open world (they call Meta), ads.view; the message estimate\'s money is restricted', () => {
    expect(META_ADS_TARGETING_TOOLS.map((t) => [t.name, t.readOnly, t.openWorld, t.execute, t.requires])).toEqual([
      ['meta-targeting-search', true, true, undefined, ['ads.view']],
      ['meta-targeting-check', true, true, undefined, ['ads.view']],
    ])
    expect(tool('meta-targeting-check').restrictedFields).toEqual({
      bidAmountCents: 'financials.adspend.view', lifetimeBudgetCents: 'financials.adspend.view', dailyBudgetCents: 'financials.adspend.view', estimateCostMetaUnits: 'financials.adspend.view',
      estimateCostLowerBoundMetaUnits: 'financials.adspend.view', estimateCostUpperBoundMetaUnits: 'financials.adspend.view',
    })
  })
  it('a business without Meta, or without a chosen account, is told who sets it up — before any call', async () => {
    h.connections = []
    expect((await search({ kind: 'interest', q: 'moto' })).error).toMatch(/Settings › Channels › Meta/)
    expect((await check({ check: 'reach', targeting: SPEC })).error).toMatch(/Settings › Channels › Meta/)
    h.connections = [{ ...CHOSEN, adAccount: null }]
    expect((await check({ check: 'retired-adsets' })).error).toMatch(/No Meta ad account is chosen/)
    expect(h.calls).toHaveLength(0)
  })
})

describe('every kind and every check — only what the real gateway lets through', () => {
  const SEARCHES: Array<[string, Record<string, unknown>, string]> = [
    ['location', { q: 'mil', locationTypes: ['city', 'region'], countryCode: 'it', regionId: '1', matchCountryCode: true }, 'search'],
    ['location-details', { locations: { countries: ['IT'], regions: ['1'], cities: ['2'], zips: ['IT:20121'], countryGroups: ['eea'] } }, 'search'],
    ['radius', { latitude: 45.46, longitude: 9.19, distanceUnit: 'kilometer' }, 'search'],
    ['interest', { q: 'motorcycle', locale: 'it_IT' }, 'search'],
    ['interest-suggestions', { interestNames: ['Motorcycles'] }, 'search'],
    ['category', { categoryClass: 'behaviors' }, 'search'],
    ['school', { q: 'poli' }, 'search'], ['major', { q: 'eng' }, 'search'], ['employer', { q: 'shop' }, 'search'], ['job-title', { q: 'rider' }, 'search'],
    ['language', { q: '' , limit: 1000 }, 'search'],
    ['any', { q: 'moto', limitType: 'interests', regulatedCategories: ['NONE'], objective: 'OUTCOME_SALES', locale: 'it_IT', vettedOnly: true }, `act_${OWN}/targetingsearch`],
    ['suggest', { options: [{ type: 'interests', id: '6003000000001' }] }, `act_${OWN}/targetingsuggestions`],
    ['browse', { limitType: 'behaviors' }, `act_${OWN}/targetingbrowse`],
    ['broad-categories', { customOnly: true }, `act_${OWN}/broadtargetingcategories`],
    ['place-page-sets', {}, `act_${OWN}/ad_place_page_sets`],
    ['saved-keywords', {}, `act_${OWN}/ad_saved_keywords`],
    ['location-cluster', { adSetId: '120000000000201' }, '120000000000201'],
  ]
  it('covers every search kind', () => { expect(SEARCHES.map(([k]) => k).sort()).toEqual([...SEARCH_KINDS].sort()) })
  it.each(SEARCHES)('kind %s', async (kind, args, path) => {
    const res = await search({ kind, ...args })
    expect(res.ok, String(res.error)).toBe(true)
    expect(h.calls.at(-1)?.path).toBe(path)
    expect(refusedCalls()).toEqual([])
  })
  it('every /search type Nexus sends is on the gateway\'s list, and nothing else is', () => {
    expect([...new Set(Object.values(SEARCH_TYPE_OF))].sort()).toEqual([...META_SEARCH_TYPES].sort())
  })
  const CHECK_ARGS: Array<[string, Record<string, unknown>, string]> = [
    ['interests', { interestIds: ['6003000000001'] }, 'search'],
    ['options', { options: [{ type: 'interests', id: '6003000000001' }], isExclusion: true, locale: 'it_IT' }, `act_${OWN}/targetingvalidation`],
    ['status', { optionIds: ['6003000000001'] }, 'search'],
    ['retired-adsets', { deprecation: 'delivery_paused' }, `act_${OWN}/deprecatedtargetingadsets`],
    ['affected-adsets', {}, `act_${OWN}/affectedadsets`],
    ['audience-special-category', { audienceId: '23000000000001', specialAdCategories: ['HOUSING', 'EMPLOYMENT'], countries: ['it', 'DE'] }, '23000000000001'],
    ['reach', { targeting: SPEC }, `act_${OWN}/reachestimate`],
    ['delivery', { optimizationGoal: 'OFFSITE_CONVERSIONS', targeting: SPEC, promotedObject: { page_id: '120000000000010' } }, `act_${OWN}/delivery_estimate`],
    ['message-delivery', { targeting: SPEC, promotedObject: { page_id: '120000000000010' }, bidAmountCents: 150, lifetimeBudgetCents: 10000, lifetimeDays: 7, pacingType: 'STANDARD', optimizationGoal: 'REACH' }, `act_${OWN}/message_delivery_estimate`],
    ['describe', { targeting: SPEC }, `act_${OWN}/targetingsentencelines`],
  ]
  it('covers every check', () => { expect(CHECK_ARGS.map(([c]) => c).sort()).toEqual([...CHECKS].sort()) })
  it.each(CHECK_ARGS)('check %s', async (name, args, path) => {
    h.answer = (req) => (req.operation === OWNER ? owned(req) : { data: [] })
    const res = await check({ check: name, ...args })
    expect(res.ok, String(res.error)).toBe(true)
    expect(h.calls.at(-1)?.path).toBe(path)
    expect(refusedCalls()).toEqual([])
  })
})

describe('meta-targeting-search — fixed requests, answers through an allow-list', () => {
  it('location: Meta\'s keys only (camelCase, ids as text); nothing nested, nothing unnamed passes', async () => {
    h.answer = () => ({ data: [{ key: 2420379, name: 'Milano', type: 'city', country_code: 'IT', region_id: 1, supports_city: true, geo_hierarchy_level: 'SUBCITY', secret: 'x', nested: { a: 1 } }] })
    const res = await search({ kind: 'location', q: 'mil', locationTypes: ['city'] })
    expect(data(res).items).toEqual([{ key: '2420379', name: 'Milano', type: 'city', countryCode: 'IT', regionId: '1', supportsCity: true, geoHierarchyLevel: 'SUBCITY' }])
    expect(h.calls[0]).toEqual({ operation: 'targeting.search.adgeolocation', path: 'search', query: { type: 'adgeolocation', q: 'mil', limit: 25, location_types: ['city'] } })
  })
  it('location-details reads Meta\'s map of each group', async () => {
    h.answer = () => ({ data: { countries: { IT: { key: 'IT', name: 'Italy', type: 'country', supports_region: true } }, zips: { 'IT:20121': { key: 'IT:20121', name: '20121', primary_city: 'Milano' } } } })
    const res = await search({ kind: 'location-details', locations: { countries: ['it'], zips: ['IT:20121'] } })
    expect(data(res)).toMatchObject({ countries: [{ key: 'IT', name: 'Italy' }], zips: [{ key: 'IT:20121', primaryCity: 'Milano' }] })
    expect(h.calls[0].query).toEqual({ type: 'adgeolocationmeta', countries: ['IT'], zips: ['IT:20121'] })
  })
  it('a search needs its words; a class, a point or names where Meta needs them — said before any call', async () => {
    expect((await search({ kind: 'interest' })).error).toMatch(/Name what to search for/)
    expect((await search({ kind: 'category' })).error).toMatch(/categoryClass/)
    expect((await search({ kind: 'radius', latitude: 45 })).error).toMatch(/latitude and longitude/)
    expect((await search({ kind: 'interest-suggestions' })).error).toMatch(/interestNames/)
    expect((await search({ kind: 'suggest' })).error).toMatch(/options/)
    expect((await search({ kind: 'location-details' })).error).toMatch(/Name the places/)
    expect(h.calls).toHaveLength(0)
  })
  it('the unified search narrows by the special ad category; political and the replaced CREDIT category are never sent', async () => {
    await search({ kind: 'any', q: 'moto', regulatedCategories: ['HOUSING'] })
    expect(h.calls[0].query).toMatchObject({ q: 'moto', regulated_categories: ['HOUSING'] })
    for (const bad of ['ISSUES_ELECTIONS_POLITICS', 'CREDIT']) expect(() => tool('meta-targeting-search').input.parse({ kind: 'any', q: 'x', regulatedCategories: [bad] })).toThrow()
  })
  it('suggest caps Meta\'s limit at 45 and sends options as {type, id}', async () => {
    await search({ kind: 'suggest', options: [{ type: 'interests', id: '6003000000001' }], limit: 200 })
    expect(h.calls[0].query).toEqual({ targeting_list: [{ type: 'interests', id: 6003000000001 }], limit: 45 })
  })
  it('place page sets: a parent Page another business uses is its id and the flag only', async () => {
    h.rowsFor = () => [
      { id: '880000000000001', account_id: OWN, name: 'Shops', pages_count: 3, parent_page: { id: '120000000000010' }, location_types: ['home'] },
      { id: '880000000000002', account_id: OWN, name: 'Other', pages_count: 2, parent_page: { id: '120000000000011' } },
    ]
    h.taken = [{ id: '120000000000011' }]
    const res = await search({ kind: 'place-page-sets' })
    expect(data(res).items).toEqual([
      { id: '880000000000001', name: 'Shops', locationTypes: ['home'], pagesCount: 3, parentPage: { pageId: '120000000000010', chosenHere: true, takenByAnotherBusiness: false } },
      { id: '880000000000002', name: 'Other', pagesCount: 2, parentPage: { pageId: '120000000000011', takenByAnotherBusiness: true } },
    ])
  })
  it('one place page set by id only when it is the chosen account\'s (its account_id read first)', async () => {
    h.answer = (req) => (req.operation === OWNER ? owned(req, '5550001112') : {})
    expect((await search({ kind: 'place-page-sets', placePageSetId: '880000000000009' })).error).toMatch(/does not belong to the ad account/)
    expect(h.calls).toEqual([{ operation: OWNER, path: '880000000000009', query: { fields: 'account_id,parent_page,pages_count' } }])
    h.calls.length = 0
    h.answer = (req) => (req.operation === OWNER ? owned(req) : { id: '880000000000001', account_id: OWN, name: 'Shops' })
    expect(data(await search({ kind: 'place-page-sets', placePageSetId: '880000000000001' })).items).toEqual([{ id: '880000000000001', name: 'Shops', parentPage: null }])
    expect(h.calls.at(-1)).toMatchObject({ path: '880000000000001', query: { fields: 'id,account_id,name,location_types,pages_count,parent_page,targeted_area_type' } })
    expect(refusedCalls()).toEqual([])
  })
  it('a location cluster is read only through an ad set of the chosen account whose targeting names it', async () => {
    expect((await search({ kind: 'location-cluster' })).error).toMatch(/adSetId/)
    h.answer = (req) => (req.path === '120000000000201'
      ? { targeting: { geo_locations: { location_cluster_ids: [{ key: '990000000000001' }], zips: [{ key: 'IT:20121' }] } } }
      : { id: '990000000000001', other: 'x' })
    expect((await search({ kind: 'location-cluster', adSetId: '120000000000201', locationClusterId: '990000000000002' })).error).toMatch(/not in this ad set's targeting/)
    const res = await search({ kind: 'location-cluster', adSetId: '120000000000201', locationClusterId: '990000000000001' })
    expect(data(res)).toMatchObject({ includedClusters: ['990000000000001'], excludedClusters: [], zipsListed: 1, cluster: { id: '990000000000001' } })
    expect(h.calls.at(-1)).toEqual({ operation: 'targeting.locationCluster', path: '990000000000001', query: { fields: 'id' } })
    // Review B5 — a cluster key Meta sends as a JSON number past 2^53 has lost digits: never compared.
    h.calls.length = 0
    h.answer = (req) => (req.path === '120000000000201' ? { targeting: { geo_locations: { location_cluster_ids: [{ key: 99000000000000012345 }] } } } : {})
    const inexact = await search({ kind: 'location-cluster', adSetId: '120000000000201' })
    expect(data(inexact)).toMatchObject({ includedClusters: [], clustersNotExact: 1 })
    expect((await search({ kind: 'location-cluster', adSetId: '120000000000201', locationClusterId: '99000000000000012345' })).error).toMatch(/too long to compare exactly/)
    expect(h.calls.map((c) => c.operation)).toEqual(['targeting.adsetGeo', 'targeting.adsetGeo'])
    // An ad set of another account is never read.
    h.calls.length = 0
    h.answer = (req) => (req.operation === OWNER ? owned(req, '5550001112') : {})
    expect((await search({ kind: 'location-cluster', adSetId: '120000000000999' })).error).toMatch(/does not belong/)
    expect(h.calls.map((c) => c.operation)).toEqual([OWNER])
  })
})

describe('the targeting spec is an allow-list', () => {
  const parse = (targeting: unknown) => () => tool('meta-targeting-check').input.parse({ check: 'reach', targeting })
  it.each([
    ['an unknown key', { ...SPEC, custom_field: 1 }],
    ['an unknown key inside geo_locations', { geo_locations: { countries: ['IT'], metadata: 1 } }],
    ['detailed exclusions other than employers (v22)', { ...SPEC, exclusions: { interests: [{ id: '6003000000001' }] } }],
    ['"recent" in an exclusion', { ...SPEC, excluded_geo_locations: { countries: ['FR'], location_types: ['recent'] } }],
    ['the Instagram Explore feed (gone in v26)', { ...SPEC, instagram_positions: ['explore'] }],
    ['Messenger stories (gone in v26)', { ...SPEC, messenger_positions: ['story'] }],
    ['age_min above age_max', { ...SPEC, age_min: 40, age_max: 30 }],
    ['an age under 13', { ...SPEC, age_min: 12 }],
    ['an id that is not digits', { ...SPEC, interests: [{ id: '60x' }] }],
    ['more than 250 countries', { geo_locations: { countries: Array.from({ length: 251 }, () => 'IT') } }],
    ['free JSON in a list', { ...SPEC, interests: [{ id: '6003000000001', extra: { a: 1 } }] }],
    ['a lower-case country', { geo_locations: { countries: ['it'] } }],
    ['a location cluster (review A2: it cannot be checked inside a spec)', { geo_locations: { countries: ['IT'], location_cluster_ids: [{ key: '990000000000001' }] } }],
    ['WhatsApp status without the Instagram story placement', { ...SPEC, publisher_platforms: ['whatsapp', 'instagram'], whatsapp_positions: ['status'] }],
    ['WhatsApp positions without WhatsApp as a platform', { ...SPEC, publisher_platforms: ['facebook'], whatsapp_positions: ['marketing_messages'] }],
    ['an electoral district that is not COUNTRY:CODE', { geo_locations: { electoral_districts: [{ key: 'CA14' }] } }],
    ['a place page set id that is not digits', { ...SPEC, place_page_set_ids: ['x1'] }],
  ])('refuses %s', (_what, targeting) => { expect(parse(targeting)).toThrow() })
  it('takes employer exclusions, flexible groups, placements and Advantage+ switches', () => {
    expect(() => TARGETING_SPEC.parse({
      ...SPEC, exclusions: { work_employers: [{ id: '100000000000001' }] }, flexible_spec: [{ interests: [{ id: '6003000000001', name: 'Motorcycles' }] }, { behaviors: [{ id: '6003000000002' }] }],
      publisher_platforms: ['facebook', 'instagram'], instagram_positions: ['stream', 'reels'], targeting_automation: { advantage_audience: 0 }, targeting_optimization: 'none',
    })).not.toThrow()
    // Review B1 / B2 — WhatsApp placements, Meta's other geo lists and place page sets.
    expect(() => TARGETING_SPEC.parse({
      geo_locations: { countries: ['IT'], subcities: [{ key: '2703980' }], neighborhoods: [{ key: '1' }], large_geo_areas: [{ key: '2' }], medium_geo_areas: [{ key: '3' }], small_geo_areas: [{ key: '4' }], metro_areas: [{ key: '5' }], electoral_districts: [{ key: 'US:CA14' }] },
      publisher_platforms: ['instagram', 'whatsapp'], instagram_positions: ['story'], whatsapp_positions: ['status', 'marketing_messages'], place_page_set_ids: ['880000000000001'],
    })).not.toThrow()
  })
  it('the size cap counts the spec as it travels: URL-encoded', async () => {
    const interests = Array.from({ length: 30 }, (_, i) => ({ id: String(6003000000001 + i), name: 'é'.repeat(200) }))
    const spec = { ...SPEC, interests }
    expect(JSON.stringify(spec).length).toBeLessThan(8000)
    expect((await check({ check: 'reach', targeting: spec })).error).toMatch(/longer than 8000 characters as sent \(URL-encoded\)/)
    expect(h.calls).toHaveLength(0)
  })
  it('a place page set in a spec is checked to be the chosen account\'s (its own two fields)', async () => {
    h.answer = (req) => (req.operation === OWNER ? owned(req, '5550001112') : { data: [] })
    expect((await check({ check: 'reach', targeting: { ...SPEC, place_page_set_ids: ['880000000000009'] } })).error).toMatch(/place page set does not belong/)
    expect(h.calls).toEqual([{ operation: OWNER, path: '880000000000009', query: { fields: 'account_id,parent_page,pages_count' } }])
  })
  it('a spec with no place and no audience, or too long to travel in a URL, is refused before any call', async () => {
    expect((await check({ check: 'reach', targeting: { age_min: 18 } })).error).toMatch(/names no location/)
    const cities = Array.from({ length: 250 }, (_, i) => ({ key: String(1000000000000 + i), radius: 50, distance_unit: 'kilometer' }))
    expect((await check({ check: 'reach', targeting: { geo_locations: { cities } } })).error).toMatch(/longer than 8000 characters/)
    expect(h.calls).toHaveLength(0)
  })
  it('a custom audience of another account is refused before the estimate (each one checked)', async () => {
    h.answer = (req) => (req.operation === OWNER ? owned(req, '5550001112') : { data: [] })
    const res = await check({ check: 'reach', targeting: { ...SPEC, excluded_custom_audiences: [{ id: '23000000000009' }] } })
    expect(res.error).toMatch(/custom audience does not belong to the ad account/)
    expect(h.calls).toEqual([{ operation: OWNER, path: '23000000000009', query: { fields: 'account_id,subtype,time_created' } }])
    // A campaign id is not an audience.
    expect((await check({ check: 'reach', targeting: { ...SPEC, custom_audiences: [{ id: '120000000000101' }] } })).error).toMatch(/is a campaign of this ad account, not a custom audience/)
  })
})

describe('review A5 — an id is the chosen account\'s AND of the kind named', () => {
  it('an own campaign (Nexus\'s rows) is never an ad set; no call is made', async () => {
    expect((await check({ check: 'delivery', adSetId: '120000000000101' })).error).toMatch(/is a campaign of this ad account, not an ad set\./)
    expect(h.calls).toHaveLength(0)
  })
  it('an id Nexus has not read: one read of its account_id and two fields only an ad set has', async () => {
    h.answer = (req) => (req.operation === OWNER ? { account_id: OWN, optimization_goal: 'REACH' } : { data: [] })
    expect((await check({ check: 'delivery', adSetId: '120000000000777' })).error).toMatch(/is not an ad set of this ad account/)
    expect(h.calls).toEqual([{ operation: OWNER, path: '120000000000777', query: { fields: 'account_id,optimization_goal,billing_event' } }])
    const { MetaReadError, failureOfAnswer } = await import('../../marketing/meta-ads/errors.js')
    h.answer = (req) => (req.operation === OWNER ? new MetaReadError(failureOfAnswer({ status: 400, verdict: { errorClass: 'validation', channelCode: '100', channelMessage: '(#100) Tried accessing nonexisting field (optimization_goal) on node type (CustomAudience)' } as never }), req.operation, 1) : { data: [] })
    expect((await check({ check: 'delivery', adSetId: '120000000000778' })).error).toMatch(/is not an ad set \(Meta does not know/)
    h.answer = (req) => (req.operation === OWNER ? owned(req) : { data: [{ estimate_ready: true }] })
    expect((await check({ check: 'delivery', adSetId: '120000000000779' })).ok).toBe(true)
    expect(h.calls.filter((c) => c.operation === OWNER).at(-1)).toMatchObject({ path: '120000000000779' })
    expect(refusedCalls()).toEqual([])
  })
  it('an ad asks an ad\'s own fields; an audience a custom audience\'s', async () => {
    h.answer = (req) => (req.operation === OWNER ? owned(req) : { data: [] })
    await check({ check: 'describe', adId: '120000000000888' })
    await check({ check: 'audience-special-category', audienceId: '23000000000001', specialAdCategories: ['HOUSING'], countries: ['IT'] })
    expect(h.calls.filter((c) => c.operation === OWNER).map((c) => c.query?.fields)).toEqual(['account_id,adset_id,creative', 'account_id,subtype,time_created'])
  })
})

describe('meta-targeting-check', () => {
  it('status of every option an ad set holds (also in flexible groups and exclusions), in words, with the plan', async () => {
    h.answer = (req) => {
      if (req.path === '120000000000201') return { targeting: { education_statuses: [2, 3], relationship_statuses: [1], interests: [{ id: '6003000000001', name: 'Motorcycles' }], flexible_spec: [{ behaviors: [{ id: '6003000000002', name: 'Riders' }] }], exclusions: { work_employers: [{ id: '100000000000001' }] } } }
      return { data: [
        { id: '6003000000001', current_status: 'NORMAL' },
        { id: '6003000000002', current_status: 'DEPRECATING', future_plan: [{ key: '2026-12-01T00:00:00+0000', value: 'NON-DELIVERABLE' }] },
        { id: '100000000000001', current_status: 'NON-DELIVERABLE-IN-EXCLUSION', future_plan: { '2027-01-01T00:00:00+0000': 'NON-DELIVERABLE' } },
      ] }
    }
    const res = await check({ check: 'status', adSetId: '120000000000201' })
    expect(h.calls.map((c) => [c.path, c.query])).toEqual([
      ['120000000000201', { fields: 'targeting' }],
      ['search', { type: 'targetingoptionstatus', targeting_option_list: [6003000000001, 6003000000002, 100000000000001] }],
    ])
    expect(data(res)).toMatchObject({ adSetId: '120000000000201', retiring: 2, note: expect.stringMatching(/remove them before the next edit/) })
    expect(data(res).items).toEqual([
      expect.objectContaining({ id: '6003000000001', name: 'Motorcycles', where: ['interests'], currentStatus: 'NORMAL', futurePlan: null }),
      expect.objectContaining({ id: '6003000000002', where: ['flexible_spec[0].behaviors'], currentStatus: 'DEPRECATING', words: expect.stringMatching(/rejected at its next edit/), futurePlan: [{ date: '2026-12-01T00:00:00+0000', status: 'NON-DELIVERABLE', words: expect.stringMatching(/Retired/) }] }),
      expect.objectContaining({ id: '100000000000001', where: ['exclusions.work_employers'], words: expect.stringMatching(/exclude/), futurePlan: [expect.objectContaining({ date: '2027-01-01T00:00:00+0000' })] }),
    ])
  })
  it('review B4 — retiring counts DEPRECATING and NON-DELIVERABLE; not-for-exclusion only under exclusions; never UNKNOWN or none', async () => {
    h.answer = () => ({ data: [
      { id: '6003000000001', current_status: 'UNKNOWN' }, { id: '6003000000002', current_status: 'NON-DELIVERABLE-IN-EXCLUSION' },
      { id: '6003000000003' }, { id: '6003000000004', current_status: 'NON-DELIVERABLE' },
    ] })
    const res = await check({ check: 'status', optionIds: ['6003000000001', '6003000000002', '6003000000003', '6003000000004'] })
    expect(data(res).retiring).toBe(1)
  })
  it('interests and options that Meta no longer takes are said plainly', async () => {
    h.answer = () => ({ data: [{ name: 'Japan', valid: true, id: 6003000000001, audience_size: 1000 }, { name: 'gone', valid: false }] })
    const res = await check({ check: 'interests', interestNames: ['Japan', 'gone'] })
    expect(data(res)).toMatchObject({ invalid: 1, items: [{ id: '6003000000001', valid: true }, { name: 'gone', valid: false, words: expect.stringMatching(/retired or renamed/) }] })
    expect(h.calls[0].query).toEqual({ type: 'adinterestvalid', interest_list: ['Japan', 'gone'] })
    h.answer = () => ({ data: [{ id: '6003000000002', name: 'Old', valid: false }] })
    expect(data(await check({ check: 'options', optionIds: ['6003000000002'] })).items[0]).toMatchObject({ valid: false, words: expect.stringMatching(/remove it/) })
    expect(h.calls.at(-1)!.query).toEqual({ id_list: [6003000000002] })
  })
  it('retired ad sets: deprecating by default, a fixed field list', async () => {
    h.rowsFor = () => [{ id: '120000000000201', name: 'Shop A set', effective_status: 'ACTIVE', targeting: { x: 1 } }]
    const res = await check({ check: 'retired-adsets' })
    expect(h.calls[0].query).toEqual({ limit: 100, type: 'deprecating', fields: 'id,name,campaign_id,status,effective_status,updated_time' })
    expect(data(res).items).toEqual([{ id: '120000000000201', name: 'Shop A set', effectiveStatus: 'ACTIVE' }])
  })
  it('reach: -1 from Meta is "no estimate for a custom audience", never an empty audience', async () => {
    h.answer = (req) => (req.operation === OWNER ? owned(req) : { data: { users_lower_bound: -1, users_upper_bound: -1, estimate_ready: true } })
    const res = await check({ check: 'reach', targeting: { custom_audiences: [{ id: '23000000000001' }] } })
    expect(data(res)).toMatchObject({ usersLowerBound: null, usersUpperBound: null, note: expect.stringMatching(/NOT an empty audience/) })
    expect(h.calls.at(-1)).toEqual({ operation: 'targeting.reachestimate', path: `act_${OWN}/reachestimate`, query: { targeting_spec: { custom_audiences: [{ id: '23000000000001' }] } } })
    h.answer = () => ({ data: [{ users_lower_bound: 1000, users_upper_bound: 2000, estimate_ready: true }] })
    expect(data(await check({ check: 'reach', targeting: SPEC }))).toMatchObject({ usersLowerBound: 1000, usersUpperBound: 2000, estimateReady: true })
  })
  it('delivery: an ad set before → after an edit; no daily results curve (gone in v26) — said plainly', async () => {
    let n = 0
    h.answer = () => ({ data: [{ estimate_mau_lower_bound: ++n * 1000, estimate_mau_upper_bound: n * 2000, estimate_ready: true, targeting_optimization_types: [{ key: 'interests', value: 1 }] }] })
    const res = await check({ check: 'delivery', adSetId: '120000000000201', targeting: SPEC })
    expect(h.calls.map((c) => [c.path, Object.keys(c.query ?? {}).sort().join(',')])).toEqual([
      ['120000000000201/delivery_estimate', 'fields'], ['120000000000201/delivery_estimate', 'fields,targeting_spec'],
    ])
    expect(h.calls[0].query!.fields).toBe('estimate_mau_lower_bound,estimate_mau_upper_bound,estimate_ready,targeting_optimization_types')
    expect(data(res)).toMatchObject({ before: { estimateMauLowerBound: 1000 }, after: { estimateMauLowerBound: 2000, targetingOptimizationTypes: [{ key: 'interests', value: 1 }] }, note: expect.stringMatching(/THIS WHOLE targeting in place of its own.*no longer estimates results per day.*2026-10-27/) })
    h.calls.length = 0
    expect((await check({ check: 'delivery', targeting: SPEC })).error).toMatch(/optimization goal/)
    expect(h.calls).toHaveLength(0)
  })
  it('a promoted object names only the chosen Page / Instagram account and a pixel of the chosen account', async () => {
    const delivery = (promotedObject: unknown) => check({ check: 'delivery', optimizationGoal: 'OFFSITE_CONVERSIONS', targeting: SPEC, promotedObject })
    expect((await delivery({ page_id: '120000000000011' })).error).toMatch(/must be the Facebook Page this business chose/)
    expect((await delivery({ instagram_profile_id: '170000000000002' })).error).toMatch(/Instagram account this business chose/)
    h.rowsFor = (req) => (req.path === `act_${OWN}/adspixels` ? [{ id: '330000000000001' }] : [])
    expect((await delivery({ pixel_id: '330000000000002', custom_event_type: 'PURCHASE' })).error).toMatch(/not a pixel of the ad account/)
    expect((await delivery({ custom_event_type: 'PURCHASE' })).error).toMatch(/goes with the pixel/)
    expect(() => tool('meta-targeting-check').input.parse({ check: 'delivery', promotedObject: { product_catalog_id: '1' } })).toThrow()
    h.calls.length = 0
    expect((await delivery({ pixel_id: '330000000000001', custom_event_type: 'PURCHASE' })).ok).toBe(true)
    expect(h.calls.map((c) => c.path)).toEqual([`act_${OWN}/adspixels`, `act_${OWN}/delivery_estimate`])
    expect(h.calls[1].query).toMatchObject({ optimization_goal: 'OFFSITE_CONVERSIONS', promoted_object: { pixel_id: '330000000000001', custom_event_type: 'PURCHASE' } })
    expect(refusedCalls()).toEqual([])
  })
  it('message-delivery: the WhatsApp activation first; money goes in Meta\'s unit from minor units; Meta\'s cost comes back raw', async () => {
    h.answer = (req) => (req.path === `act_${OWN}` ? { marketing_messages_settings: { whatsapp_activation_status: 'ACTIVE' } } : { data: [{ estimate_cost: 12.5, estimate_delivery: 900, estimate_status: 'READY' }] })
    const res = await check({ check: 'message-delivery', adSetId: '120000000000201', bidAmountCents: 150, lifetimeBudgetCents: 10000 })
    expect(h.calls.map((c) => [c.path, c.query])).toEqual([
      [`act_${OWN}`, { fields: 'marketing_messages_settings{whatsapp_activation_status}' }],
      ['120000000000201/message_delivery_estimate', expect.objectContaining({ bid_amount: 150, lifetime_budget: 10000 })],
    ])
    expect(data(res)).toMatchObject({
      whatsappActivationStatus: 'ACTIVE', currency: 'EUR', minorUnitDigits: 2, bidAmountCents: 150, lifetimeBudgetCents: 10000,
      estimateCostMetaUnits: 12.5, estimateDelivery: 900, estimateStatus: 'READY', note: expect.stringMatching(/Meta does not document its unit/),
    })
    // The account estimate takes a daily budget and a direct send; an ad set's does not.
    h.calls.length = 0
    const spec = { ...SPEC, publisher_platforms: ['whatsapp'], whatsapp_positions: ['marketing_messages'] }
    expect((await check({ check: 'message-delivery', targeting: spec, promotedObject: { page_id: '120000000000010' }, dailyBudgetCents: 2500, directSend: true })).ok).toBe(true)
    expect(h.calls.at(-1)).toMatchObject({ path: `act_${OWN}/message_delivery_estimate`, query: { daily_budget: 2500, is_direct_send_campaign: true, targeting_spec: spec } })
    expect(refusedCalls()).toEqual([])
    expect((await check({ check: 'message-delivery', adSetId: '120000000000201', dailyBudgetCents: 2500 })).error).toMatch(/account estimate only/)
    // Meta refusing the activation read is said, not fatal.
    const { MetaReadError, failureOfAnswer } = await import('../../marketing/meta-ads/errors.js')
    h.answer = (req) => (req.path === `act_${OWN}` ? new MetaReadError(failureOfAnswer({ status: 400, verdict: { errorClass: 'validation', channelCode: '100', channelMessage: 'nonexisting field (marketing_messages_settings)' } as never }), req.operation, 1) : { data: [] })
    expect(data(await check({ check: 'message-delivery', adSetId: '120000000000201' }))).toMatchObject({ whatsappActivationStatus: null, whatsappNote: expect.stringMatching(/did not say whether/) })
    // A currency with cents that Meta counts in whole units (offset 1: TWD) refuses a part of a unit.
    h.answer = null
    h.connections = [{ ...CHOSEN, adAccount: { ...CHOSEN.adAccount, currency: 'TWD' } }]
    expect((await check({ check: 'message-delivery', adSetId: '120000000000201', bidAmountCents: 1250 })).error).toMatch(/not a whole amount Meta takes in TWD/)
    // A currency Nexus has not read is never assumed (review fix A4).
    h.connections = [{ ...CHOSEN, adAccount: { ...CHOSEN.adAccount, currency: null } }]
    h.calls.length = 0
    expect((await check({ check: 'message-delivery', adSetId: '120000000000201', bidAmountCents: 100 })).error).toMatch(/has not read this ad account's currency/)
    expect(h.calls).toHaveLength(0)
    h.connections = [CHOSEN]
    expect((await check({ check: 'message-delivery', targeting: SPEC })).error).toMatch(/promoted object/)
  })
  it('minorToMetaUnits: one helper, per currency', () => {
    expect(minorToMetaUnits(1234, 'EUR')).toBe(1234)
    expect(minorToMetaUnits(500, 'JPY')).toBe(500)
    // TWD: two decimals (ISO), Meta's offset 1 (whole dollars); HUF: no decimals here (as Intl knows it), offset 1.
    expect(minorToMetaUnits(1200, 'TWD')).toBe(12)
    expect(minorToMetaUnits(1250, 'TWD')).toBeNull()
    expect(minorToMetaUnits(1200, 'HUF')).toBe(1200)
    expect(minorToMetaUnits(-1, 'EUR')).toBeNull()
    // Review fix A4 — 3 decimals (Intl) with Meta's offset 100 (currencies.md: BHD, JOD): only whole hundredths go.
    expect(minorToMetaUnits(1230, 'BHD')).toBe(123)
    expect(minorToMetaUnits(1234, 'JOD')).toBeNull()
    // A currency Nexus has not read is never assumed.
    expect(minorToMetaUnits(1234, '')).toBeNull()
  })
  it('audience-special-category: the chosen account\'s audience, Meta\'s own comma lists', async () => {
    h.answer = (req) => (req.operation === OWNER ? owned(req) : { id: '23000000000001', name: 'Buyers', is_eligible_for_sac_campaigns: false })
    const res = await check({ check: 'audience-special-category', audienceId: '23000000000001', specialAdCategories: ['HOUSING'], countries: ['it'] })
    expect(h.calls.at(-1)).toEqual({ operation: 'targeting.audienceSacEligibility', path: '23000000000001', query: { fields: 'id,name,is_eligible_for_sac_campaigns', ad_account_id: OWN, special_ad_categories: 'HOUSING', special_ad_category_countries: 'IT' } })
    expect(data(res)).toMatchObject({ eligible: false, name: 'Buyers', note: expect.stringMatching(/does not let this audience/) })
    expect(() => tool('meta-targeting-check').input.parse({ check: 'audience-special-category', specialAdCategories: ['ISSUES_ELECTIONS_POLITICS'] })).toThrow()
  })
  it('describe: a spec, an ad set or an ad of the chosen account, in either of Meta\'s shapes', async () => {
    h.answer = () => ({ targetingsentencelines: [{ content: 'Location:', children: ['Italy'] }], params: { secret: 1 } })
    expect(data(await check({ check: 'describe', targeting: SPEC })).lines).toEqual([{ content: 'Location:', children: ['Italy'] }])
    expect(h.calls.at(-1)!.query).toEqual({ targeting_spec: SPEC, hide_targeting_spec_from_return: true })
    h.answer = () => ({ data: [{ id: '120000000000301/targetingsentencelines', targetingsentencelines: [{ content: 'Age:', children: ['18 - 65+'] }] }] })
    expect(data(await check({ check: 'describe', adId: '120000000000301' })).lines).toEqual([{ content: 'Age:', children: ['18 - 65+'] }])
    expect(h.calls.at(-1)!.path).toBe('120000000000301/targetingsentencelines')
    await check({ check: 'describe', adSetId: '120000000000201' })
    expect(h.calls.at(-1)!.path).toBe('120000000000201/targetingsentencelines')
    expect((await check({ check: 'describe', adId: '120000000000201' })).error).toMatch(/is an ad set of this ad account, not an ad\./)
    expect(sentenceLines({ data: [{ content: 'Gender:', children: ['Men', 3] }] })).toEqual([{ content: 'Gender:', children: ['Men'] }])
    expect(refusedCalls()).toEqual([])
  })
  it('Meta\'s refusal of an SDK-only read is passed on in words', async () => {
    const { MetaReadError, failureOfAnswer } = await import('../../marketing/meta-ads/errors.js')
    h.rowsFor = (req) => { throw new MetaReadError(failureOfAnswer({ status: 400, verdict: { errorClass: 'validation', channelCode: '100', channelMessage: 'Unknown path components: /affectedadsets' } as never }), req.operation, 1) }
    expect(await check({ check: 'affected-adsets' })).toEqual({ ok: false, error: expect.stringMatching(/Unknown path components: \/affectedadsets/) })
  })
})
