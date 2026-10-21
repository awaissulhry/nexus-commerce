/**
 * Meta ads, step 9 — targeting search and checks, read LIVE from Meta (GET only, through the gateway). Nothing here
 * stores or changes anything.
 *
 *   meta-targeting-search  Graph's targeting search (`GET /search?type=…`: locations, location details, a suggested
 *                          radius, interests and suggestions, categories, schools, majors, employers, job titles,
 *                          languages) and the chosen ad account's own targeting edges (targetingsearch,
 *                          targetingsuggestions, targetingbrowse, broadtargetingcategories, ad_place_page_sets,
 *                          ad_saved_keywords), a location cluster one of its ad sets uses, one of its place page sets;
 *   meta-targeting-check   interests still valid, options valid (targetingvalidation), retired options
 *                          (targetingoptionstatus), ad sets holding retired options (deprecatedtargetingadsets) or touched
 *                          by a Meta-side change (affectedadsets), a custom audience's special-ad-category eligibility,
 *                          reach (reachestimate), delivery (delivery_estimate, account or ad set: before → after), a
 *                          marketing-message estimate, and the targeting in plain words (targetingsentencelines).
 *
 * ALLOW-LISTS ONLY (lesson from steps 1–2): the caller never names a Graph path, field or parameter. `/search` is sent
 * only with the `type` values below (the gateway holds the same list: meta-calls.ts META_SEARCH_TYPES); a targeting spec
 * is parsed by TARGETING_SPEC (allow-listed keys, every list capped, unknown keys refused) and re-encoded by Nexus; every
 * answer keeps only the keys named per kind. Every id a caller gives is the chosen account's own AND of the kind named
 * (Nexus's rows, else one live read of its account_id and two fields only that kind has: ownId); a promoted object names
 * only the chosen Page / Instagram account and a pixel of the chosen ad account; a Page another business in Nexus uses is
 * its id and the flag only.
 *
 * Checked 2026-10-21 with `curl -sL <page>.md` (developers.facebook.com/documentation/ads-commerce/marketing-api/…) and
 * Meta's Python Business SDK (github.com/facebook/facebook-python-business-sdk, main, facebook_business/adobjects):
 *   - audiences/reference/targeting-search: /search types adgeolocation (q, location_types country | country_group |
 *     region | city | zip | geo_market | electoral_district [US], region_id, country_code, match_country_code; limit
 *     default 8, `q=` + limit 1000 lists all), adgeolocationmeta (countries, regions, country_groups, cities, zips),
 *     adradiussuggestion (latitude, longitude required; distance_unit mile | kilometer), adinterest (q, locale),
 *     adinterestsuggestion (interest_list, case-sensitive), adinterestvalid (interest_list or interest_fbid_list: validate
 *     by id, interests get renamed), adTargetingCategory (class interests | behaviors | demographics | life_events |
 *     industries | income | family_statuses | user_device | user_os; q ignored; demographics vary with the token user's
 *     home country), adeducationschool | adeducationmajor | adworkemployer | adworkposition (q; id, name, coverage,
 *     subtext), adlocale (q), targetingoptionstatus (targeting_option_list → current_status NORMAL | NON-DELIVERABLE |
 *     DEPRECATING | NON-DELIVERABLE-IN-EXCLUSION | UNKNOWN, future_plan). `list=GLOBAL` is for the legacy adzipcode type
 *     only: not sent;
 *   - reference/ad-account/targetingsearch (q required; limit_type, objective, regulated_categories,
 *     allow_only_fat_head_interests, app_store), targetingsuggestions (targeting_list [{type,id}], limit_type,
 *     regulated_categories; limit default 30, max 45 — audiences/reference/detailed-targeting), targetingbrowse (flat
 *     list, "use parent key to recreate the tree"; limit_type, regulated_categories; include_nodes is "internal use only":
 *     not sent), targetingvalidation (targeting_list, id_list, name_list, is_exclusion; locale in detailed-targeting),
 *     broadtargetingcategories (custom_categories_only; fields from SDK broadtargetingcategories.py),
 *     deprecatedtargetingadsets (type deprecating | delivery_paused), reachestimate (targeting_spec required, "countries is
 *     required"; -1 when a custom-audience estimate is unavailable — not an empty audience), delivery_estimate
 *     (optimization_goal and targeting_spec required, promoted_object; SDK adaccountdeliveryestimate.py fields
 *     estimate_mau_lower_bound, estimate_mau_upper_bound, estimate_ready, targeting_optimization_types; v26 removed
 *     daily_outcomes_curve, budget_guardrail and estimate_dau, all versions on 2026-10-27 — facts F1 M4-13),
 *     message_delivery_estimate (account: promoted_object and targeting_spec required, bid_amount, lifetime_budget,
 *     lifetime_in_days, optimization_goal, pacing_type; SDK adaccount.py adds daily_budget and is_direct_send_campaign;
 *     SDK messagedeliveryestimate.py: estimate_cost* are floats in an undocumented unit; audiences/reference/
 *     placement-targeting: whatsapp_positions status | marketing_messages — status needs Instagram story, marketing
 *     messages need the account onboarded, read as marketing_messages_settings{whatsapp_activation_status}), ad_place_page_sets (list documented; the node GET /{id} is SDK only, adplacepageset.py);
 *   - reference/ad-campaign/delivery_estimate (all optional; the ad set's own settings by default, overrides preview an
 *     edit), ad-campaign/message_delivery_estimate, ad-campaign/targetingsentencelines, adgroup/targetingsentencelines,
 *     audiences/reference/targeting-description (act_<id>/targetingsentencelines: targeting_spec,
 *     hide_targeting_spec_from_return; the answer is `targetingsentencelines` [{content, children}], or a `data` list on
 *     the reference pages — both read), audiences/special-ad-category (GET /{custom_audience_id}?fields=
 *     is_eligible_for_sac_campaigns&ad_account_id=&special_ad_categories=HOUSING,EMPLOYMENT&special_ad_category_countries=
 *     US,UK — customer-list audiences; the page's sample wrongly prefixes act_), audiences/reference/basic-targeting
 *     ("To read a location_cluster … GET /location_cluster_ID", no field list);
 *   - SDK only (no docs page): act_<id>/affectedadsets (no params; AdSet nodes), act_<id>/ad_saved_keywords (fields;
 *     AdSavedKeywords: id, name, keywords {brands, product_categories, product_names, search_terms}, run_status,
 *     time_created, time_updated). These, the place page set node, a location cluster's fields and the message estimate
 *     are LIVE-PROBES rows (~/nexus-archive/2026-10-20-meta-ads/LIVE-PROBES.md): when Meta refuses, the tool says so.
 * Review round 1 (2026-10-21): the spec takes no location_cluster_ids (a cluster cannot be checked to be the chosen
 * account's inside a spec), and adds Meta's other geo lists (SDK targetinggeolocation.py), place_page_set_ids (each the
 * chosen account's) and the WhatsApp placements; app optimization goals are not estimated.
 * Traps kept here: detailed-targeting exclusions error since v22 (only `exclusions.work_employers` is taken — facts F2
 * O2: estimates allow employer exclusions only); location_types home | recent only, never `recent` in an exclusion
 * (TG-049); Instagram `explore` and Messenger `story` placements are gone in v26; ISSUES_ELECTIONS_POLITICS and the
 * replaced CREDIT category are never sent (Nexus runs no political ads; FINANCIAL_PRODUCTS_SERVICES replaced CREDIT).
 */
import { z } from 'zod'
import { metaAdAccountId, metaObjectId } from '../../cx/connectors/meta/discovery.js'
import type { MetaQueryValue } from '../../gateway/meta.js'
import { META_AUDIENCE_SAC_FIELDS } from '../../gateway/meta-calls.js'
import { MetaReadError } from './errors.js'
import { metaReadAll, metaReadOne } from './read-client.js'
import { metaChosenAccount, metaConnectionFor, MetaLiveRefusal, objectKindOf, type MetaChosenAccount } from './live.js'
import { currencyExponent, metaOffset } from './money.js'
import { takenIds } from './taken.js'

// ── enums (Meta's, narrowed to what Nexus sends) ─────────────────────────────────────────────────────────────────

export const SEARCH_KINDS = [
  'location', 'location-details', 'radius', 'interest', 'interest-suggestions', 'category', 'school', 'major', 'employer', 'job-title', 'language',
  'any', 'suggest', 'browse', 'broad-categories', 'location-cluster', 'place-page-sets', 'saved-keywords',
] as const
export type SearchKind = typeof SEARCH_KINDS[number]

export const CHECKS = ['interests', 'options', 'status', 'retired-adsets', 'affected-adsets', 'audience-special-category', 'reach', 'delivery', 'message-delivery', 'describe'] as const
export type TargetingCheck = typeof CHECKS[number]

/** The /search `type` of each Graph search kind (and of two checks). The gateway allows exactly these (META_SEARCH_TYPES). */
export const SEARCH_TYPE_OF = {
  location: 'adgeolocation', 'location-details': 'adgeolocationmeta', radius: 'adradiussuggestion', interest: 'adinterest',
  'interest-suggestions': 'adinterestsuggestion', category: 'adTargetingCategory', school: 'adeducationschool', major: 'adeducationmajor',
  employer: 'adworkemployer', 'job-title': 'adworkposition', language: 'adlocale', interests: 'adinterestvalid', status: 'targetingoptionstatus',
} as const

export const LOCATION_TYPES = ['country', 'country_group', 'region', 'city', 'zip', 'geo_market', 'electoral_district'] as const
export const COUNTRY_GROUPS = [
  'worldwide', 'africa', 'afta', 'android_app_store', 'android_free_store', 'apec', 'asia', 'caribbean', 'central_america', 'cisfta', 'eea',
  'emerging_markets', 'europe', 'gcc', 'itunes_app_store', 'mercosur', 'nafta', 'north_america', 'oceania', 'south_america',
] as const
export const CATEGORY_CLASSES = ['interests', 'behaviors', 'demographics', 'life_events', 'industries', 'income', 'family_statuses', 'user_device', 'user_os'] as const
/** Detailed-targeting types every unified edge (search, suggestions, browse, validation) takes. */
export const DETAILED_TYPES = [
  'interests', 'behaviors', 'life_events', 'industries', 'income', 'family_statuses', 'user_adclusters', 'work_positions', 'work_employers',
  'education_schools', 'education_majors', 'education_statuses', 'relationship_statuses', 'college_years',
] as const
/** Never ISSUES_ELECTIONS_POLITICS (Nexus runs no political ads) nor CREDIT (replaced by FINANCIAL_PRODUCTS_SERVICES). */
export const REGULATED_CATEGORIES = ['NONE', 'EMPLOYMENT', 'HOUSING', 'FINANCIAL_PRODUCTS_SERVICES', 'ONLINE_GAMBLING_AND_GAMING'] as const
export const SPECIAL_AD_CATEGORIES = ['HOUSING', 'EMPLOYMENT', 'FINANCIAL_PRODUCTS_SERVICES'] as const
export const CAMPAIGN_OBJECTIVES = ['OUTCOME_AWARENESS', 'OUTCOME_ENGAGEMENT', 'OUTCOME_LEADS', 'OUTCOME_SALES', 'OUTCOME_TRAFFIC', 'OUTCOME_APP_PROMOTION'] as const
/**
 * Meta's optimization goals, without the app goals (APP_INSTALLS, IN_APP_VALUE, APP_INSTALLS_AND_OFFSITE_CONVERSIONS):
 * they need an application_id and store URL in the promoted object, which Nexus does not send — app goals are not
 * estimated here (review fix B6).
 */
export const OPTIMIZATION_GOALS = [
  'AD_RECALL_LIFT', 'ENGAGED_USERS', 'EVENT_RESPONSES', 'IMPRESSIONS', 'LEAD_GENERATION', 'QUALITY_LEAD', 'LINK_CLICKS',
  'OFFSITE_CONVERSIONS', 'PAGE_LIKES', 'POST_ENGAGEMENT', 'QUALITY_CALL', 'REACH', 'LANDING_PAGE_VIEWS', 'VISIT_INSTAGRAM_PROFILE',
  'ENGAGED_PAGE_VIEWS', 'VALUE', 'THRUPLAY', 'DERIVED_EVENTS', 'CONVERSATIONS',
  'MESSAGING_PURCHASE_CONVERSION', 'MESSAGING_DEEP_CONVERSATION_AND_FOLLOW', 'SUBSCRIBERS', 'REMINDERS_SET', 'MEANINGFUL_CALL_ATTEMPT',
  'PROFILE_VISIT', 'PROFILE_AND_PAGE_ENGAGEMENT', 'ADVERTISER_SILOED_VALUE', 'AUTOMATIC_OBJECTIVE', 'MESSAGING_APPOINTMENT_CONVERSION',
] as const
export const CUSTOM_EVENT_TYPES = [
  'PURCHASE', 'ADD_TO_CART', 'INITIATED_CHECKOUT', 'ADD_PAYMENT_INFO', 'ADD_TO_WISHLIST', 'LEAD', 'COMPLETE_REGISTRATION', 'CONTENT_VIEW',
  'SEARCH', 'CONTACT', 'SUBSCRIBE', 'START_TRIAL', 'SUBMIT_APPLICATION', 'SCHEDULE', 'CUSTOMIZE_PRODUCT', 'DONATE', 'FIND_LOCATION', 'OTHER',
] as const
export const PACING_TYPES = ['STANDARD', 'NO_PACING', 'DAY_PARTING'] as const
export const DEPRECATION_TYPES = ['deprecating', 'delivery_paused'] as const

// ── the targeting spec a caller may give (checks and estimates) ──────────────────────────────────────────────────

const digits = z.string().trim().regex(/^\d{1,25}$/, 'a Meta id is digits')
const option = z.object({ id: digits, name: z.string().trim().max(200).optional() }).strict()
const options = (max: number) => z.array(option).min(1).max(max)
const distanceUnit = z.enum(['mile', 'kilometer'])
const iso2 = z.string().trim().regex(/^[A-Z]{2}$/, 'a country is its ISO code in capitals (IT, DE)')

const geoKeys = z.array(z.object({ key: digits }).strict()).min(1).max(200)
const geoSpec = z.object({
  countries: z.array(iso2).min(1).max(250).optional(),
  regions: z.array(z.object({ key: digits }).strict()).min(1).max(200).optional(),
  cities: z.array(z.object({ key: digits, radius: z.number().min(0).max(80).optional(), distance_unit: distanceUnit.optional() }).strict()).min(1).max(250).optional(),
  zips: z.array(z.object({ key: z.string().trim().regex(/^[A-Z]{2}:[A-Za-z0-9 -]{1,12}$/, 'a postcode key is COUNTRY:CODE (IT:20121)') }).strict()).min(1).max(250).optional(),
  places: z.array(z.object({ key: digits, radius: z.number().min(0).max(80).optional(), distance_unit: distanceUnit.optional() }).strict()).min(1).max(200).optional(),
  custom_locations: z.array(z.object({
    latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), radius: z.number().min(0.63).max(80), distance_unit: distanceUnit.optional(),
  }).strict()).min(1).max(200).optional(),
  geo_markets: z.array(z.object({ key: z.string().trim().regex(/^COMSCORE_MARKET:\d{1,6}$/) }).strict()).min(1).max(210).optional(),
  country_groups: z.array(z.enum(COUNTRY_GROUPS)).min(1).max(20).optional(),
  // Review fix B2 — Meta's other geo lists (SDK targetinggeolocation.py, TargetingGeoLocationGeoEntities {key}).
  subcities: geoKeys.optional(), neighborhoods: geoKeys.optional(), large_geo_areas: geoKeys.optional(), medium_geo_areas: geoKeys.optional(),
  small_geo_areas: geoKeys.optional(), metro_areas: geoKeys.optional(),
  electoral_districts: z.array(z.object({ key: z.string().trim().regex(/^[A-Z]{2}:[A-Za-z0-9]{1,12}$/, 'an electoral district key is COUNTRY:CODE (US:CA14)') }).strict()).min(1).max(200).optional(),
  // Review fix A2 — no location_cluster_ids: a cluster cannot be checked to be the chosen account's inside a spec; estimate
  // the ad set that uses it (adSetId) instead.
  location_types: z.array(z.enum(['home', 'recent'])).min(1).max(2).optional(),
}).strict()

const detailed = {
  interests: options(250).optional(), behaviors: options(250).optional(), life_events: options(250).optional(), industries: options(250).optional(),
  income: options(250).optional(), family_statuses: options(250).optional(), user_adclusters: options(50).optional(),
  work_positions: options(200).optional(), work_employers: options(200).optional(), education_schools: options(200).optional(),
  education_majors: options(200).optional(),
}
const audiences = z.array(z.object({ id: digits }).strict()).min(1).max(100)
const flexibleGroup = z.object({ ...detailed, custom_audiences: audiences.optional() }).strict()
  .refine((g) => Object.keys(g).length > 0, 'a flexible_spec group names at least one list')

/**
 * A targeting spec, allow-listed (facts F1 M4-00; audiences/reference/basic-targeting, advanced-targeting,
 * placement-targeting): unknown keys are refused, every list capped (≤ 250), and Nexus re-encodes it.
 */
export const TARGETING_SPEC = z.object({
  geo_locations: geoSpec.optional(),
  excluded_geo_locations: geoSpec.refine((g) => !g.location_types?.includes('recent'), 'Meta does not take location_types "recent" in an exclusion').optional(),
  age_min: z.number().int().min(13).max(65).optional(),
  age_max: z.number().int().min(13).max(65).optional(),
  genders: z.array(z.union([z.literal(1), z.literal(2)])).min(1).max(2).optional(),
  locales: z.array(z.number().int().min(1).max(100_000)).min(1).max(50).optional(),
  ...detailed,
  education_statuses: z.array(z.number().int().min(1).max(13)).min(1).max(13).optional(),
  relationship_statuses: z.array(z.number().int().min(1).max(13)).min(1).max(13).optional(),
  flexible_spec: z.array(flexibleGroup).min(1).max(25).optional(),
  // Since v22 detailed-targeting exclusions error; estimates take employer exclusions only (facts F2 O2).
  exclusions: z.object({ work_employers: options(200) }).strict().optional(),
  custom_audiences: audiences.optional(),
  excluded_custom_audiences: audiences.optional(),
  device_platforms: z.array(z.enum(['mobile', 'desktop'])).min(1).max(2).optional(),
  publisher_platforms: z.array(z.enum(['facebook', 'instagram', 'threads', 'messenger', 'audience_network', 'whatsapp'])).min(1).max(6).optional(),
  facebook_positions: z.array(z.enum(['feed', 'right_hand_column', 'marketplace', 'video_feeds', 'story', 'search', 'instream_video', 'facebook_reels', 'facebook_reels_overlay', 'profile_feed', 'notification'])).min(1).max(11).optional(),
  // v26 removed Instagram `explore` (Explore feed) and Messenger `story`.
  instagram_positions: z.array(z.enum(['stream', 'story', 'explore_home', 'reels', 'profile_feed', 'ig_search', 'profile_reels'])).min(1).max(7).optional(),
  audience_network_positions: z.array(z.enum(['classic', 'rewarded_video'])).min(1).max(2).optional(),
  messenger_positions: z.array(z.enum(['sponsored_messages'])).min(1).max(1).optional(),
  threads_positions: z.array(z.enum(['threads_stream'])).min(1).max(1).optional(),
  // Review fix B1 — placement-targeting "whatsapp_positions": status needs the Instagram story placement too;
  // marketing_messages needs the ad account onboarded to marketing messages (marketing_messages_settings).
  whatsapp_positions: z.array(z.enum(['status', 'marketing_messages'])).min(1).max(2).optional(),
  // Review fix B2 — place page sets (SDK targeting.py), each checked to be the chosen account's own.
  place_page_set_ids: z.array(digits).min(1).max(50).optional(),
  user_os: z.array(z.string().trim().regex(/^[A-Za-z0-9_.]{1,40}$/)).min(1).max(10).optional(),
  user_device: z.array(z.string().trim().regex(/^[A-Za-z0-9_ .+-]{1,60}$/)).min(1).max(50).optional(),
  excluded_user_device: z.array(z.string().trim().regex(/^[A-Za-z0-9_ .+-]{1,60}$/)).min(1).max(50).optional(),
  wireless_carrier: z.array(z.literal('Wifi')).min(1).max(1).optional(),
  targeting_automation: z.object({ advantage_audience: z.union([z.literal(0), z.literal(1)]) }).strict().optional(),
  targeting_relaxation_types: z.object({ lookalike: z.union([z.literal(0), z.literal(1)]).optional(), custom_audience: z.union([z.literal(0), z.literal(1)]).optional() }).strict().optional(),
  targeting_optimization: z.enum(['none', 'expansion_all']).optional(),
  brand_safety_content_filter_levels: z.array(z.enum([
    'FACEBOOK_RELAXED', 'FACEBOOK_STANDARD', 'FACEBOOK_STRICT', 'AN_RELAXED', 'AN_STANDARD', 'AN_STRICT', 'FEED_RELAXED', 'FEED_STANDARD', 'FEED_STRICT',
  ])).min(1).max(3).optional(),
}).strict()
  .refine((s) => s.age_min === undefined || s.age_max === undefined || s.age_min <= s.age_max, 'age_min is at most age_max')
  .refine((s) => !s.whatsapp_positions?.includes('status') || !!s.instagram_positions?.includes('story'), 'the WhatsApp status placement needs the Instagram story placement too (instagram_positions story)')
  .refine((s) => !s.whatsapp_positions || !s.publisher_platforms || s.publisher_platforms.includes('whatsapp'), 'whatsapp_positions need whatsapp in publisher_platforms')
export type TargetingSpec = z.infer<typeof TARGETING_SPEC>

/** A promoted object for an estimate: the chosen Page / Instagram account, a pixel of the chosen ad account and its event. */
export const PROMOTED_OBJECT = z.object({
  pixel_id: digits.optional(),
  custom_event_type: z.enum(CUSTOM_EVENT_TYPES).optional(),
  page_id: digits.optional(),
  instagram_profile_id: digits.optional(),
}).strict().refine((p) => Object.keys(p).length > 0, 'a promoted object names at least one key')
export type PromotedObject = z.infer<typeof PROMOTED_OBJECT>

/** At most this many characters, a targeting spec as sent: URL-encoded, as it travels in the URL of a GET (review fix A5). */
export const MAX_SPEC_CHARS = 8000
/** At most this many custom audiences and place page sets in one spec (each checked to be the chosen account's: a read each at most). */
export const MAX_SPEC_OWNED = 25

/** The length of a spec as it goes in the query string (form-encoded, as metaUrl / URLSearchParams send it). */
export const encodedSpecLength = (spec: unknown) => new URLSearchParams([['targeting_spec', JSON.stringify(spec)]]).toString().length - 'targeting_spec='.length

const refuse = (sentence: string): never => { throw new MetaLiveRefusal(sentence) }

/** The spec parsed again (a caller that skipped the tool's schema is still held to it), sized, and with a location or audience. */
export function parsedSpec(value: unknown, what = 'targeting'): TargetingSpec {
  const parsed = TARGETING_SPEC.safeParse(value)
  if (!parsed.success) refuse(`${what} is not a targeting spec Nexus sends: ${parsed.error.issues.map((i) => `${i.path.join('.') || what}: ${i.message}`).join('; ')}`)
  const spec = parsed.data!
  if (encodedSpecLength(spec) > MAX_SPEC_CHARS) refuse(`${what} is longer than ${MAX_SPEC_CHARS} characters as sent (URL-encoded): split it, or estimate the ad set itself (adSetId).`)
  const geo = spec.geo_locations
  const hasPlace = !!geo && Object.entries(geo).some(([key, list]) => key !== 'location_types' && Array.isArray(list) && list.length > 0)
  if (!hasPlace && !spec.custom_audiences?.length) refuse(`${what} names no location: Meta needs at least one country (or other place) in geo_locations, unless it targets a custom audience.`)
  return spec
}

/** Every custom audience a spec names (included, excluded, inside flexible_spec). */
export function specAudienceIds(spec: TargetingSpec): string[] {
  const ids = [...(spec.custom_audiences ?? []), ...(spec.excluded_custom_audiences ?? []), ...(spec.flexible_spec ?? []).flatMap((g) => g.custom_audiences ?? [])].map((a) => a.id)
  return [...new Set(ids)]
}

/**
 * The detailed-targeting lists whose items are options ({id, name}); education_statuses, relationship_statuses and
 * college_years hold Meta's codes (1, 2, …), never option ids, so they are not checked for retirement.
 */
const OPTION_LISTS = ['interests', 'behaviors', 'life_events', 'industries', 'income', 'family_statuses', 'user_adclusters', 'work_positions', 'work_employers', 'education_schools', 'education_majors'] as const

/** Every detailed-targeting option of a spec as Meta stores it on an ad set, with where it sits. */
export function specOptionIds(targeting: Record<string, unknown>): Array<{ id: string; name: string | null; where: string }> {
  const out: Array<{ id: string; name: string | null; where: string }> = []
  const take = (holder: unknown, prefix: string) => {
    if (!holder || typeof holder !== 'object') return
    for (const type of OPTION_LISTS) {
      const list = (holder as Record<string, unknown>)[type]
      if (!Array.isArray(list)) continue
      for (const item of list) {
        if (!item || typeof item !== 'object') continue
        const id = metaObjectId((item as { id?: unknown }).id)
        if (id) out.push({ id, name: text((item as { name?: unknown }).name), where: `${prefix}${type}` })
      }
    }
  }
  take(targeting, '')
  const flexible = targeting.flexible_spec
  if (Array.isArray(flexible)) flexible.forEach((group, i) => take(group, `flexible_spec[${i}].`))
  take(targeting.exclusions, 'exclusions.')
  return out
}

// ── small helpers ────────────────────────────────────────────────────────────────────────────────────────────────

const act = (id: string) => `act_${id}`
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const camel = (key: string) => key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())
/** An id inside a JSON list Meta reads as int64: a number while it is exact in JavaScript, else the digits as a string. */
const idValue = (id: string): number | string => { const n = Number(id); return Number.isSafeInteger(n) ? n : id }
const ID_KEYS = new Set(['id', 'key', 'region_id', 'primary_city_id', 'campaign_id', 'account_id', 'parent'])

function cleanValue(key: string, value: unknown): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return ID_KEYS.has(key) ? String(value) : (Number.isFinite(value) ? value : null)
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 499)}…` : value
  if (Array.isArray(value)) return value.slice(0, 100).filter((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)).map((v) => (typeof v === 'string' && v.length > 200 ? `${v.slice(0, 199)}…` : v))
  return undefined
}

/** One answer row with only the keys named (camelCase), plain values only: an object inside is never passed on. */
export function pickRow(row: unknown, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!row || typeof row !== 'object') return out
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue
    const value = cleanValue(key, (row as Record<string, unknown>)[key])
    if (value !== undefined) out[camel(key)] = value
  }
  return out
}

const LOCATION_KEYS = ['key', 'name', 'type', 'country_code', 'country_name', 'region', 'region_id', 'primary_city', 'primary_city_id', 'supports_region', 'supports_city', 'geo_hierarchy_level', 'geo_hierarchy_name', 'country_codes', 'is_worldwide'] as const
const AUDIENCE_KEYS = ['id', 'name', 'type', 'path', 'description', 'topic', 'platform', 'audience_size', 'audience_size_lower_bound', 'audience_size_upper_bound', 'valid'] as const
const WORK_EDU_KEYS = ['id', 'name', 'coverage', 'subtext'] as const
const LANGUAGE_KEYS = ['key', 'name'] as const
const UNIFIED_KEYS = ['id', 'key', 'name', 'type', 'path', 'description', 'audience_size_lower_bound', 'audience_size_upper_bound', 'valid', 'parent'] as const
const BROAD_FIELDS = 'id,name,parent_category,path,size_lower_bound,size_upper_bound,type,type_name,category_description'
const ADSET_FIELDS = 'id,name,campaign_id,status,effective_status,updated_time'
const PLACE_PAGE_SET_FIELDS = 'id,account_id,name,location_types,pages_count,parent_page,targeted_area_type'
const SAVED_KEYWORDS_FIELDS = 'id,name,keywords,run_status,time_created,time_updated'
const DELIVERY_FIELDS = 'estimate_mau_lower_bound,estimate_mau_upper_bound,estimate_ready,targeting_optimization_types'
const MESSAGE_FIELDS = 'estimate_cost,estimate_cost_lower_bound,estimate_cost_upper_bound,estimate_coverage_lower_bound,estimate_coverage_upper_bound,estimate_delivery,estimate_delivery_lower_bound,estimate_delivery_upper_bound,estimate_status'

/** Rows of a `data` list (or the one node of a `data` object), never anything else of the body. */
function dataRows(body: unknown): Record<string, unknown>[] {
  const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : undefined
  if (Array.isArray(data)) return data.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
  return data && typeof data === 'object' ? [data as Record<string, unknown>] : []
}

const hasMore = (body: unknown) => !!(body && typeof body === 'object' && (body as { paging?: { next?: unknown } }).paging?.next)

async function readRows(connectionId: string, operation: string, path: string, query: Record<string, MetaQueryValue>, maxRows: number) {
  const rows: Record<string, unknown>[] = []
  const pageSize = Math.min(100, maxRows)
  const read = await metaReadAll({ connectionId }, { operation, path, query: { limit: pageSize, ...query }, maxPages: Math.ceil(maxRows / pageSize) }, (page) => { rows.push(...page) })
  return { rows: rows.slice(0, maxRows), more: read.truncated || rows.length > maxRows }
}

type OwnKind = 'ad set' | 'ad' | 'custom audience' | 'place page set'
/**
 * Review fix A5 — TWO fields only that kind of object has together (as step 17's gateway owner check, gateway.ts
 * META_KIND_FIELD), checked 2026-10-21 on Meta's Python Business SDK (adset.py, ad.py, customaudience.py,
 * adplacepageset.py; campaign.py, adcreative.py, savedaudience.py and reachfrequencyprediction.py have neither pair): a
 * read asking them of another kind is refused by Meta ("nonexisting field") or comes back without them.
 */
const OWN_KIND_FIELDS: Readonly<Record<OwnKind, readonly [string, string]>> = {
  'ad set': ['optimization_goal', 'billing_event'],
  ad: ['adset_id', 'creative'],
  'custom audience': ['subtype', 'time_created'],
  'place page set': ['parent_page', 'pages_count'],
}
const KIND_WORD: Readonly<Record<string, string>> = { campaign: 'campaign', adset: 'ad set', ad: 'ad', creative: 'creative' }
const an = (word: string) => `${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word}`

/**
 * A Meta id that is the chosen account's own AND of the kind named, else refused in words: Nexus's own rows of the daily
 * read first, else ONE live read of its account_id and two fields only that kind has. An own campaign or audience is never
 * taken as an ad set, nor an ad set as an ad.
 */
async function ownId(account: MetaChosenAccount, id: string, what: OwnKind): Promise<string> {
  const objectId = metaObjectId(id) ?? refuse(`"${id}" is not a Meta ${what} id (digits).`)
  const stored = await objectKindOf(account, objectId)
  if (stored) {
    if (KIND_WORD[stored] !== what) refuse(`That id is ${an(KIND_WORD[stored])} of this ad account, not ${an(what)}.`)
    return objectId
  }
  const fields = OWN_KIND_FIELDS[what]
  let body: Record<string, unknown>
  try {
    body = (await metaReadOne({ connectionId: account.connectionId }, { operation: 'targeting.ownerCheck', path: objectId, query: { fields: ['account_id', ...fields].join(',') } })).body as Record<string, unknown>
  } catch (err) {
    if (!(err instanceof MetaReadError)) throw err
    if (/nonexisting field/i.test(err.failure.sentence)) refuse(`That id is not ${an(what)} (Meta does not know ${an(what)}'s own fields on it), so it is not read.`)
    refuse(`Nexus could not confirm that this ${what} is of the ad account this business chose (${err.failure.sentence}), so it is not read.`)
  }
  if (metaAdAccountId(body!.account_id) !== account.adAccountId) refuse(`That ${what} does not belong to the ad account this business chose, so it is not read.`)
  if (fields.some((name) => { const value = body![name]; return value === undefined || value === null || value === '' })) refuse(`That id is not ${an(what)} of this ad account, so it is not read.`)
  return objectId
}

// ── meta-targeting-search ────────────────────────────────────────────────────────────────────────────────────────

export interface TargetingSearchInput {
  connectionId?: string | null
  kind: SearchKind
  q?: string | null
  locationTypes?: string[] | null
  countryCode?: string | null
  regionId?: string | null
  matchCountryCode?: boolean | null
  locations?: { countries?: string[]; regions?: string[]; cities?: string[]; zips?: string[]; countryGroups?: string[] } | null
  latitude?: number | null
  longitude?: number | null
  distanceUnit?: 'mile' | 'kilometer' | null
  locale?: string | null
  interestNames?: string[] | null
  categoryClass?: string | null
  limitType?: string | null
  regulatedCategories?: string[] | null
  objective?: string | null
  vettedOnly?: boolean | null
  options?: Array<{ type: string; id: string }> | null
  customOnly?: boolean | null
  adSetId?: string | null
  locationClusterId?: string | null
  placePageSetId?: string | null
  limit?: number | null
}

const NOT_ALL = 'Meta says not every option is returned by a search, and options get renamed: keep the id, never the name.'

/** One targeting search: Graph's /search, or one of the chosen ad account's own targeting edges. */
export async function targetingSearch(input: TargetingSearchInput) {
  const limit = Math.min(1000, Math.max(1, Math.trunc(input.limit ?? 25)))
  const q = input.q?.trim() ?? null
  const needQ = (what: string) => (q ? q : refuse(`Name what to search for (q): ${what}.`))
  switch (input.kind) {
    case 'location': case 'location-details': case 'radius': case 'interest': case 'interest-suggestions': case 'category':
    case 'school': case 'major': case 'employer': case 'job-title': case 'language':
      return graphSearch(input, q, limit, needQ)
    default:
      return accountSearch(input, q, limit, needQ)
  }
}

async function graphSearch(input: TargetingSearchInput, q: string | null, limit: number, needQ: (what: string) => string) {
  const connection = await metaConnectionFor(input.connectionId)
  const type = SEARCH_TYPE_OF[input.kind as keyof typeof SEARCH_TYPE_OF]
  const query: Record<string, MetaQueryValue> = { type }
  let keys: readonly string[] = AUDIENCE_KEYS
  let note: string | null = null
  switch (input.kind) {
    case 'location':
      // q may be empty with a type list: Meta then lists every country (or region) up to the limit.
      Object.assign(query, { q: q ?? '', limit })
      if (input.locationTypes?.length) query.location_types = input.locationTypes
      if (input.countryCode) query.country_code = input.countryCode.toUpperCase()
      if (input.regionId) query.region_id = Number(input.regionId)
      if (input.matchCountryCode) query.match_country_code = true
      keys = LOCATION_KEYS
      note = 'Target a place by its key (stable); its name may change. geoHierarchyLevel says when a "city" is a borough or a neighbourhood.'
      break
    case 'location-details': {
      const l = input.locations ?? {}
      if (!l.countries?.length && !l.regions?.length && !l.cities?.length && !l.zips?.length && !l.countryGroups?.length) refuse('Name the places to describe (locations: countries, regions, cities, zips or countryGroups — keys from kind location).')
      if (l.countries?.length) query.countries = l.countries.map((c) => c.toUpperCase())
      if (l.regions?.length) query.regions = l.regions.map(idValue)
      if (l.cities?.length) query.cities = l.cities.map(idValue)
      if (l.zips?.length) query.zips = l.zips
      if (l.countryGroups?.length) query.country_groups = l.countryGroups
      const read = await metaReadOne({ connectionId: connection.connectionId }, { operation: `targeting.search.${type}`, path: 'search', query })
      const data = (read.body as { data?: unknown }).data
      const groups: Record<string, Record<string, unknown>[]> = {}
      for (const group of ['countries', 'regions', 'cities', 'zips', 'country_groups']) {
        const map = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>)[group] : null
        if (map && typeof map === 'object') groups[camel(group)] = Object.values(map as Record<string, unknown>).slice(0, 250).map((row) => pickRow(row, LOCATION_KEYS))
      }
      return { kind: input.kind, ...groups, note: 'Meta\'s details of each place named (key, name, type, country, region; whether it holds regions or cities).' }
    }
    case 'radius':
      if (input.latitude == null || input.longitude == null) refuse('Name the point (latitude and longitude).')
      Object.assign(query, { latitude: input.latitude, longitude: input.longitude })
      if (input.distanceUnit) query.distance_unit = input.distanceUnit
      keys = ['suggested_radius', 'distance_unit']
      note = 'Meta\'s suggested radius to reach enough people around that point (special ad categories need at least 15 mi / 25 km in the US and Canada, 15 km in Europe).'
      break
    case 'interest':
      Object.assign(query, { q: needQ('an interest, e.g. motorcycle'), limit })
      if (input.locale) query.locale = input.locale
      note = NOT_ALL
      break
    case 'interest-suggestions':
      if (!input.interestNames?.length) refuse('Name the interests to get suggestions for (interestNames: their exact names, case-sensitive).')
      Object.assign(query, { interest_list: input.interestNames, limit })
      note = `Suggestions from interest NAMES (Meta matches them case-sensitively). ${NOT_ALL}`
      break
    case 'category':
      if (!input.categoryClass) refuse(`Name the class (categoryClass: ${CATEGORY_CLASSES.join(', ')}).`)
      Object.assign(query, { class: input.categoryClass, limit })
      note = input.categoryClass === 'demographics' || input.categoryClass === 'interests'
        ? `Meta's whole list for this class (q is not used). Demographic options depend on the home country of the system user Meta answers for and can be empty. ${NOT_ALL}`
        : 'Meta\'s whole list for this class (q is not used).'
      break
    case 'school': case 'major': case 'employer': case 'job-title':
      Object.assign(query, { q: needQ(`a ${input.kind === 'job-title' ? 'job title' : input.kind}`), limit })
      keys = WORK_EDU_KEYS
      note = 'coverage is Meta\'s estimate of how many people match. At most 200 of each may be targeted in one ad set.'
      break
    case 'language':
      Object.assign(query, { q: q ?? '', limit })
      keys = LANGUAGE_KEYS
      note = 'Target a language by its key (a number) in locales; q empty with a large limit lists them all.'
      break
  }
  const read = await metaReadOne({ connectionId: connection.connectionId }, { operation: `targeting.search.${type}`, path: 'search', query })
  return { kind: input.kind, items: dataRows(read.body).slice(0, limit).map((row) => pickRow(row, keys)), more: hasMore(read.body), note }
}

async function accountSearch(input: TargetingSearchInput, q: string | null, limit: number, needQ: (what: string) => string) {
  const account = await metaChosenAccount(input.connectionId)
  const { connectionId, adAccountId } = account
  const base = { kind: input.kind, adAccountId }
  const common: Record<string, MetaQueryValue> = {}
  if (input.limitType) common.limit_type = input.limitType
  if (input.regulatedCategories?.length) common.regulated_categories = input.regulatedCategories
  if (input.locale) common.locale = input.locale
  switch (input.kind) {
    case 'any': {
      const query: Record<string, MetaQueryValue> = { q: needQ('anything Meta targets: an interest, behaviour, employer, school …'), limit, ...common }
      if (input.objective) query.objective = input.objective
      if (input.vettedOnly) query.allow_only_fat_head_interests = true
      const read = await metaReadOne({ connectionId }, { operation: 'targeting.targetingsearch', path: `${act(adAccountId)}/targetingsearch`, query })
      return {
        ...base, items: dataRows(read.body).slice(0, limit).map((r) => pickRow(r, UNIFIED_KEYS)), more: hasMore(read.body),
        note: `Every kind of detailed targeting at once. Without limitType Meta leaves out employers, job titles, majors and schools under 2,000 people. For a special ad category, name it (regulatedCategories) so only allowed options come back. ${NOT_ALL}`,
      }
    }
    case 'suggest': {
      if (!input.options?.length) refuse('Name the options to get suggestions for (options: [{type, id}], from a search).')
      const query: Record<string, MetaQueryValue> = { targeting_list: input.options!.map((o) => ({ type: o.type, id: idValue(o.id) })), limit: Math.min(45, limit), ...common }
      const read = await metaReadOne({ connectionId }, { operation: 'targeting.targetingsuggestions', path: `${act(adAccountId)}/targetingsuggestions`, query })
      return { ...base, items: dataRows(read.body).map((r) => pickRow(r, UNIFIED_KEYS)), note: 'Meta\'s related options (at most 45).' }
    }
    case 'browse': {
      const read = await readRows(connectionId, 'targeting.targetingbrowse', `${act(adAccountId)}/targetingbrowse`, common, limit)
      return {
        ...base, items: read.rows.map((r) => pickRow(r, UNIFIED_KEYS)), more: read.more,
        note: 'Meta\'s whole detailed-targeting tree as a flat list: each row\'s parent is the key of the row above it. Use limitType to browse one kind.',
      }
    }
    case 'broad-categories': {
      const query: Record<string, MetaQueryValue> = { fields: BROAD_FIELDS }
      if (input.customOnly) query.custom_categories_only = true
      const read = await readRows(connectionId, 'targeting.broadtargetingcategories', `${act(adAccountId)}/broadtargetingcategories`, query, limit)
      return { ...base, items: read.rows.map((r) => pickRow(r, ['id', 'name', 'parent_category', 'path', 'size_lower_bound', 'size_upper_bound', 'type', 'type_name', 'category_description'])), more: read.more, note: 'Broad categories go in a spec as user_adclusters (at most 50).' }
    }
    case 'place-page-sets':
      return placePageSets(account, input.placePageSetId ?? null, limit)
    case 'saved-keywords': {
      // TG-022 — SDK only (no docs page): LIVE-PROBES.
      const read = await readRows(connectionId, 'targeting.adSavedKeywords', `${act(adAccountId)}/ad_saved_keywords`, { fields: SAVED_KEYWORDS_FIELDS }, limit)
      return {
        ...base,
        items: read.rows.map((r) => {
          const kw = r.keywords && typeof r.keywords === 'object' ? r.keywords as Record<string, unknown> : {}
          return { ...pickRow(r, ['id', 'name', 'run_status', 'time_created', 'time_updated']), keywords: pickRow(kw, ['brands', 'product_categories', 'product_names', 'search_terms']) }
        }),
        more: read.more,
        note: 'The account\'s saved keyword sets. Meta documents this list only in its SDK; if Meta refuses it, the answer says so.',
      }
    }
    case 'location-cluster':
      return locationCluster(account, input.adSetId ?? null, input.locationClusterId ?? null)
    default:
      return refuse('Unknown kind.')
  }
}

/** TG-020 — the account's place page sets (documented list), or one of them by id (the node read is SDK only). */
async function placePageSets(account: MetaChosenAccount, placePageSetId: string | null, limit: number) {
  const { connectionId, adAccountId } = account
  let rows: Record<string, unknown>[]
  let more = false
  if (placePageSetId) {
    const id = await ownId(account, placePageSetId, 'place page set')
    const read = await metaReadOne({ connectionId }, { operation: 'targeting.placePageSet', path: id, query: { fields: PLACE_PAGE_SET_FIELDS } })
    rows = [read.body as Record<string, unknown>]
  } else {
    const read = await readRows(connectionId, 'targeting.adPlacePageSets', `${act(adAccountId)}/ad_place_page_sets`, { fields: PLACE_PAGE_SET_FIELDS }, limit)
    rows = read.rows
    more = read.more
  }
  const parentOf = (r: Record<string, unknown>) => metaObjectId(r.parent_page && typeof r.parent_page === 'object' ? (r.parent_page as { id?: unknown }).id : r.parent_page)
  const taken = await takenIds('PAGE', rows.map(parentOf).filter((id): id is string => !!id))
  return {
    kind: 'place-page-sets', adAccountId,
    items: rows.map((r) => {
      const parent = parentOf(r)
      return {
        ...pickRow(r, ['id', 'name', 'location_types', 'pages_count', 'targeted_area_type']),
        parentPage: parent ? (taken.has(parent) ? { pageId: parent, takenByAnotherBusiness: true } : { pageId: parent, chosenHere: parent === account.pageId, takenByAnotherBusiness: false }) : null,
      }
    }),
    more,
    note: 'A place page set targets the people near the locations of a Page with many places (place_page_set_ids in a spec). One set by id is Meta\'s SDK read; if Meta refuses it, the answer says so.',
  }
}

/** TG-017 — a location cluster (a big postcode list Meta keeps as one key) that one of the chosen account's ad sets uses. */
async function locationCluster(account: MetaChosenAccount, adSetId: string | null, locationClusterId: string | null) {
  if (!adSetId) refuse('Name the ad set whose targeting uses the location cluster (adSetId): a cluster is read only through an ad set of this account.')
  const id = await ownId(account, adSetId!, 'ad set')
  const read = await metaReadOne({ connectionId: account.connectionId }, { operation: 'targeting.adsetGeo', path: id, query: { fields: 'targeting{geo_locations,excluded_geo_locations}' } })
  const targeting = ((read.body as { targeting?: unknown }).targeting ?? {}) as Record<string, unknown>
  // Review fix B5 — a cluster key is compared as text. One Meta sends as a JSON number past 2^53 has lost digits before
  // Nexus sees it (JSON numbers are doubles): it is counted, never compared (LIVE-PROBES TG-017 settles how Meta sends it).
  let inexact = 0
  const clustersOf = (geo: unknown) => {
    const list = geo && typeof geo === 'object' ? (geo as { location_cluster_ids?: unknown }).location_cluster_ids : null
    if (!Array.isArray(list)) return []
    return list.map((c) => {
      const key = c && typeof c === 'object' ? (c as { key?: unknown }).key : c
      if (typeof key === 'number' && !Number.isSafeInteger(key)) { inexact++; return null }
      return metaObjectId(key)
    }).filter((k): k is string => !!k)
  }
  const included = clustersOf(targeting.geo_locations)
  const excluded = clustersOf(targeting.excluded_geo_locations)
  const zipsOf = (geo: unknown) => { const z2 = geo && typeof geo === 'object' ? (geo as { zips?: unknown }).zips : null; return Array.isArray(z2) ? z2.length : 0 }
  const base = {
    kind: 'location-cluster', adSetId: id, includedClusters: included, excludedClusters: excluded, zipsListed: zipsOf(targeting.geo_locations),
    ...(inexact ? { clustersNotExact: inexact, clustersNote: 'Meta sent some cluster keys as numbers too long to keep exactly; they are not shown or compared.' } : {}),
  }
  if (!locationClusterId) return { ...base, note: 'The ad set\'s location clusters (more than 2,500 postcodes become one cluster). Name one (locationClusterId) to read it.' }
  const clusterId = metaObjectId(locationClusterId) ?? refuse('locationClusterId is digits.')
  if (!included.includes(clusterId) && !excluded.includes(clusterId)) {
    refuse(inexact
      ? 'Nexus cannot confirm that location cluster is in this ad set\'s targeting: Meta sent its cluster keys as numbers too long to compare exactly, so it is not read.'
      : 'That location cluster is not in this ad set\'s targeting, so it is not read.')
  }
  // Meta documents GET /<location_cluster_id> but no field list (basic-targeting); the SDK has no node for it. Nexus asks
  // only its id until a live read names its fields (LIVE-PROBES TG-017).
  const cluster = await metaReadOne({ connectionId: account.connectionId }, { operation: 'targeting.locationCluster', path: clusterId, query: { fields: 'id' } })
  return {
    ...base, cluster: pickRow(cluster.body, ['id']),
    note: 'Meta documents reading a location cluster but not what it answers; Nexus reads its id until a live check names its fields. Its postcodes: Ads Manager, on that ad set.',
  }
}

// ── meta-targeting-check ─────────────────────────────────────────────────────────────────────────────────────────

export interface TargetingCheckInput {
  connectionId?: string | null
  check: TargetingCheck
  interestIds?: string[] | null
  interestNames?: string[] | null
  options?: Array<{ type: string; id: string }> | null
  optionIds?: string[] | null
  isExclusion?: boolean | null
  locale?: string | null
  deprecation?: typeof DEPRECATION_TYPES[number] | null
  audienceId?: string | null
  specialAdCategories?: string[] | null
  countries?: string[] | null
  targeting?: unknown
  optimizationGoal?: string | null
  promotedObject?: unknown
  adSetId?: string | null
  adId?: string | null
  bidAmountCents?: number | null
  lifetimeBudgetCents?: number | null
  dailyBudgetCents?: number | null
  directSend?: boolean | null
  lifetimeDays?: number | null
  pacingType?: string | null
  maxRows?: number | null
}

/** What a targeting option's status means, in words (targeting-search "Targeting option status"). */
export const OPTION_STATUS_WORDS: Readonly<Record<string, string>> = {
  NORMAL: 'In use: nothing to do.',
  DEPRECATING: 'Being retired: ad sets keep delivering, but it cannot go in a new ad set, and an ad set holding it is rejected at its next edit unless it is removed first.',
  'NON-DELIVERABLE': 'Retired: it no longer delivers (an ad set may still run on its other targeting). Remove it.',
  'NON-DELIVERABLE-IN-EXCLUSION': 'It can no longer be used to exclude people.',
  UNKNOWN: 'Meta does not know this option\'s status.',
}
const statusWords = (status: string | null) => (status ? OPTION_STATUS_WORDS[status] ?? `Meta says ${status}.` : null)

/** future_plan as Meta answers it — a list of {key: date, value: status} (the sample) or a map of date → status (the table). */
function futurePlan(value: unknown): Array<{ date: string; status: string; words: string | null }> | null {
  const pairs: Array<[unknown, unknown]> = Array.isArray(value)
    ? value.map((p) => [p && typeof p === 'object' ? (p as { key?: unknown }).key : null, p && typeof p === 'object' ? (p as { value?: unknown }).value : null])
    : value && typeof value === 'object' ? Object.entries(value as Record<string, unknown>) : []
  const plan = pairs.map(([date, status]) => ({ date: text(date), status: text(status) })).filter((p): p is { date: string; status: string } => !!p.date && !!p.status)
  return plan.length ? plan.slice(0, 20).map((p) => ({ ...p, words: statusWords(p.status) })) : null
}

/**
 * Minor units of the account currency → Meta's own unit for a budget or bid (its offset unit); null when not whole.
 * "Minor units" are the currency's decimals as Nexus counts them everywhere (money.ts currencyExponent: Intl/CLDR — EUR 2,
 * JPY 0, HUF 0, TWD 2, BHD / JOD 3). Review fix A4, checked 2026-10-21 on documentation/ads-commerce/marketing-api/
 * currencies.md: Meta's offset is 1 for CLP, COP, CRC, HUF, ISK, IDR, JPY, KRW, PYG, TWD, VND and 100 for the rest —
 * BHD and JOD included (Meta counts hundredths of a dinar, so 3-decimal amounts must end in 0); KWD, OMR and TND are not
 * Meta ad-account currencies at all. A currency Nexus has not read is never assumed: the caller refuses first.
 */
export function minorToMetaUnits(minor: number, currency: string): number | null {
  if (!Number.isSafeInteger(minor) || minor < 0 || !currency) return null
  const micros = BigInt(minor) * 10n ** BigInt(Math.max(0, 6 - currencyExponent(currency)))
  const per = BigInt(1_000_000 / metaOffset(currency))
  return micros % per === 0n ? Number(micros / per) : null
}

/** The spec's custom audiences and place page sets, each the chosen account's own (at most MAX_SPEC_OWNED), else refused. */
async function checkSpecOwned(account: MetaChosenAccount, spec: TargetingSpec): Promise<void> {
  const audiences = specAudienceIds(spec)
  const pageSets = [...new Set(spec.place_page_set_ids ?? [])]
  if (audiences.length + pageSets.length > MAX_SPEC_OWNED) refuse(`The spec names ${audiences.length + pageSets.length} custom audiences and place page sets; Nexus checks at most ${MAX_SPEC_OWNED} per call (each must be this ad account's own).`)
  for (const id of audiences) await ownId(account, id, 'custom audience')
  for (const id of pageSets) await ownId(account, id, 'place page set')
}

/** A promoted object of the chosen assets only: its Page, its Instagram account, a pixel of the chosen ad account. */
async function checkPromotedObject(account: MetaChosenAccount, value: unknown): Promise<PromotedObject> {
  const parsed = PROMOTED_OBJECT.safeParse(value)
  if (!parsed.success) refuse(`promotedObject is not one Nexus sends: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'promotedObject'}: ${i.message}`).join('; ')}`)
  const promoted = parsed.data!
  if (promoted.page_id && promoted.page_id !== account.pageId) refuse('promotedObject.page_id must be the Facebook Page this business chose (meta-ad-accounts list chosen).')
  if (promoted.instagram_profile_id && promoted.instagram_profile_id !== account.instagramId) refuse('promotedObject.instagram_profile_id must be the Instagram account this business chose.')
  if (promoted.pixel_id) {
    // Review note A3 — act_<id>/adspixels lists the pixels the ad account can use, also ones another business portfolio
    // shared in, and taken.ts has no PIXEL kind yet (nexus_meta_links_taken answers ad accounts, Pages and Instagram
    // accounts only). Enough for a READ (an estimate names the pixel; nothing of it is answered back). The pixel WRITE
    // steps (M10 signals, M3b ad sets) must add the business's own pixel pick (a PIXEL link, one pixel in one business)
    // and check against it instead.
    const read = await readRows(account.connectionId, 'targeting.pixelCheck', `${act(account.adAccountId)}/adspixels`, { fields: 'id' }, 200)
    if (!read.rows.some((r) => metaObjectId(r.id) === promoted.pixel_id)) refuse('promotedObject.pixel_id is not a pixel of the ad account this business chose.')
  }
  if (promoted.custom_event_type && !promoted.pixel_id) refuse('promotedObject.custom_event_type goes with the pixel it counts (pixel_id).')
  return promoted
}

const DAILY_CURVE_GONE = 'Meta no longer estimates results per day for a budget: v26 removed daily_outcomes_curve, budget_guardrail and estimate_dau (every API version from 2026-10-27). This is the audience size only.'

/** One targeting check or estimate on the chosen ad account. */
export async function targetingCheck(input: TargetingCheckInput) {
  const maxRows = Math.min(1000, Math.max(1, Math.trunc(input.maxRows ?? 200)))
  if (input.check === 'interests') return interestsValid(input)
  const account = await metaChosenAccount(input.connectionId)
  const { connectionId, adAccountId, currency } = account
  const base = { check: input.check, adAccountId }
  switch (input.check) {
    case 'options': {
      const query: Record<string, MetaQueryValue> = {}
      if (input.options?.length) query.targeting_list = input.options.map((o) => ({ type: o.type, id: idValue(o.id) }))
      else if (input.optionIds?.length) query.id_list = input.optionIds.map(idValue)
      else if (input.interestNames?.length) query.name_list = input.interestNames
      else refuse('Name the options to check: options [{type, id}] (best), optionIds, or interestNames (interests only).')
      if (input.isExclusion) query.is_exclusion = true
      if (input.locale) query.locale = input.locale
      const read = await metaReadOne({ connectionId }, { operation: 'targeting.targetingvalidation', path: `${act(adAccountId)}/targetingvalidation`, query })
      return {
        ...base, isExclusion: !!input.isExclusion,
        items: dataRows(read.body).map((r) => { const row = pickRow(r, UNIFIED_KEYS); return row.valid === false ? { ...row, words: input.isExclusion ? 'Meta does not take this option to exclude people.' : 'Meta does not take this option any more (retired or renamed): remove it from the ad set.' } : row }),
        note: 'Meta\'s own check before a targeting change. To exclude people, check with isExclusion: detailed-targeting exclusions are refused since v22 except employers — exclude custom audiences instead.',
      }
    }
    case 'status': {
      let ids = (input.optionIds ?? []).map((id) => metaObjectId(id)).filter((id): id is string => !!id)
      let found: Array<{ id: string; name: string | null; where: string }> = []
      if (input.adSetId) {
        const id = await ownId(account, input.adSetId, 'ad set')
        const read = await metaReadOne({ connectionId }, { operation: 'targeting.adsetTargeting', path: id, query: { fields: 'targeting' } })
        found = specOptionIds(((read.body as { targeting?: unknown }).targeting ?? {}) as Record<string, unknown>)
        ids = [...new Set([...ids, ...found.map((f) => f.id)])]
        if (ids.length === 0) return { ...base, adSetId: id, items: [], note: 'This ad set holds no detailed-targeting option (interests, behaviours, …): nothing can be retired.' }
      }
      if (ids.length === 0) refuse('Name the options (optionIds) or an ad set (adSetId) whose options to check.')
      if (ids.length > 1000) refuse('At most 1,000 options at once.')
      const items: Array<Record<string, unknown>> = []
      for (let i = 0; i < ids.length; i += 250) {
        const chunk = ids.slice(i, i + 250)
        const read = await metaReadOne({ connectionId }, { operation: 'targeting.search.targetingoptionstatus', path: 'search', query: { type: SEARCH_TYPE_OF.status, targeting_option_list: chunk.map(idValue) } })
        for (const r of dataRows(read.body)) {
          const id = metaObjectId(r.id)
          const status = text(r.current_status)
          const at = found.filter((f) => f.id === id)
          items.push({ id, ...(at.length ? { name: at[0].name, where: at.map((f) => f.where) } : {}), currentStatus: status, words: statusWords(status), futurePlan: futurePlan(r.future_plan) })
        }
      }
      // Review fix B4 — retired or being retired: DEPRECATING and NON-DELIVERABLE; NON-DELIVERABLE-IN-EXCLUSION only for an
      // option that sits under exclusions; never UNKNOWN or a status Meta did not give.
      const retiring = items.filter((i) => i.currentStatus === 'DEPRECATING' || i.currentStatus === 'NON-DELIVERABLE'
        || (i.currentStatus === 'NON-DELIVERABLE-IN-EXCLUSION' && Array.isArray(i.where) && (i.where as string[]).some((w) => w.startsWith('exclusions.')))).length
      return {
        ...base, ...(input.adSetId ? { adSetId: metaObjectId(input.adSetId) } : {}), items, retiring,
        note: retiring ? `${retiring} option(s) are retired or being retired where they are used: remove them before the next edit of an ad set that holds them (Meta rejects that edit otherwise).` : 'No option checked is retired or being retired where it is used (see each one\'s words).',
      }
    }
    case 'retired-adsets': {
      const type = input.deprecation ?? 'deprecating'
      const read = await readRows(connectionId, 'targeting.deprecatedtargetingadsets', `${act(adAccountId)}/deprecatedtargetingadsets`, { type, fields: ADSET_FIELDS }, maxRows)
      return {
        ...base, deprecation: type, items: read.rows.map((r) => pickRow(r, ['id', 'name', 'campaign_id', 'status', 'effective_status', 'updated_time'])), more: read.more,
        note: type === 'deprecating'
          ? 'Ad sets that still hold an option Meta is retiring: they keep delivering, but Meta rejects their next edit until it is removed (check status with adSetId to see which).'
          : 'Ad sets whose delivery Meta paused because of a retired option: remove it to deliver again.',
      }
    }
    case 'affected-adsets': {
      // AS-020 — SDK only (no docs page; meaning undocumented): LIVE-PROBES.
      const read = await readRows(connectionId, 'targeting.affectedadsets', `${act(adAccountId)}/affectedadsets`, { fields: ADSET_FIELDS }, maxRows)
      return {
        ...base, items: read.rows.map((r) => pickRow(r, ['id', 'name', 'campaign_id', 'status', 'effective_status', 'updated_time'])), more: read.more,
        note: 'Meta\'s list of ad sets affected by a change on Meta\'s side. Meta documents it only in its SDK and does not say which change; if Meta refuses it, the answer says so.',
      }
    }
    case 'audience-special-category': {
      if (!input.audienceId) refuse('Name the custom audience (audienceId).')
      if (!input.specialAdCategories?.length || !input.countries?.length) refuse(`Name the special ad categories (${SPECIAL_AD_CATEGORIES.join(', ')}) and the countries the campaign reaches.`)
      const id = await ownId(account, input.audienceId!, 'custom audience')
      // The guide's own form: comma-separated lists (audiences/special-ad-category, "Eligibility").
      const read = await metaReadOne({ connectionId }, {
        operation: 'targeting.audienceSacEligibility', path: id,
        query: { fields: 'id,name,is_eligible_for_sac_campaigns', ad_account_id: adAccountId, special_ad_categories: input.specialAdCategories!.join(','), special_ad_category_countries: input.countries!.map((c) => c.toUpperCase()).join(',') },
      })
      const b = read.body as Record<string, unknown>
      const eligible = typeof b.is_eligible_for_sac_campaigns === 'boolean' ? b.is_eligible_for_sac_campaigns : null
      return {
        ...base, audienceId: id, name: text(b.name), specialAdCategories: input.specialAdCategories, countries: input.countries, eligible,
        note: eligible === false
          ? 'Meta does not let this audience into a campaign of these special ad categories in these countries.'
          : 'Meta checks customer-list audiences; lookalikes cannot be used at all for housing, employment or financial products and services.',
      }
    }
    case 'reach': {
      const spec = parsedSpec(input.targeting)
      await checkSpecOwned(account, spec)
      const read = await metaReadOne({ connectionId }, { operation: 'targeting.reachestimate', path: `${act(adAccountId)}/reachestimate`, query: { targeting_spec: spec } })
      const r = dataRows(read.body)[0] ?? {}
      const lower = typeof r.users_lower_bound === 'number' ? r.users_lower_bound : null
      const upper = typeof r.users_upper_bound === 'number' ? r.users_upper_bound : null
      const none = lower === -1 || upper === -1
      return {
        ...base, usersLowerBound: none ? null : lower, usersUpperBound: none ? null : upper, estimateReady: typeof r.estimate_ready === 'boolean' ? r.estimate_ready : null,
        note: none
          ? 'Meta has no size estimate for a custom audience in this spec (it answered -1): that is NOT an empty audience, and ads can still deliver.'
          : spec.targeting_optimization === 'expansion_all' || spec.targeting_automation?.advantage_audience === 1
            ? 'Meta\'s estimate counts the audience as Meta may widen it (Advantage+ / expansion), so it differs from Ads Manager.'
            : 'Meta\'s estimate of the people this targeting reaches (a range).',
      }
    }
    case 'delivery': {
      const goal = input.optimizationGoal ?? null
      const spec = input.targeting === undefined || input.targeting === null ? null : parsedSpec(input.targeting)
      if (spec) await checkSpecOwned(account, spec)
      const promoted = input.promotedObject === undefined || input.promotedObject === null ? null : await checkPromotedObject(account, input.promotedObject)
      const overrides: Record<string, MetaQueryValue> = {}
      if (goal) overrides.optimization_goal = goal
      if (spec) overrides.targeting_spec = spec
      if (promoted) overrides.promoted_object = promoted
      const estimate = (body: unknown) => {
        const r = dataRows(body)[0] ?? {}
        const types = Array.isArray(r.targeting_optimization_types)
          ? r.targeting_optimization_types.slice(0, 20).map((t) => pickRow(t, ['key', 'value'])) : null
        return { estimateMauLowerBound: typeof r.estimate_mau_lower_bound === 'number' ? r.estimate_mau_lower_bound : null, estimateMauUpperBound: typeof r.estimate_mau_upper_bound === 'number' ? r.estimate_mau_upper_bound : null, estimateReady: typeof r.estimate_ready === 'boolean' ? r.estimate_ready : null, targetingOptimizationTypes: types }
      }
      if (input.adSetId) {
        // TG-032 — the ad set as it is (before), and with the overrides (after: the preview of an edit).
        const id = await ownId(account, input.adSetId, 'ad set')
        const before = await metaReadOne({ connectionId }, { operation: 'targeting.adsetDeliveryEstimate', path: `${id}/delivery_estimate`, query: { fields: DELIVERY_FIELDS } })
        const after = Object.keys(overrides).length
          ? await metaReadOne({ connectionId }, { operation: 'targeting.adsetDeliveryEstimate', path: `${id}/delivery_estimate`, query: { ...overrides, fields: DELIVERY_FIELDS } })
          : null
        return {
          ...base, adSetId: id, before: estimate(before.body), after: after ? estimate(after.body) : null,
          note: `${after ? `before: the ad set as it is; after: the ad set with ${spec ? 'THIS WHOLE targeting in place of its own (Meta does not merge a partial spec: name everything the ad set should keep)' : 'the goal / promoted object named'}. ` : ''}${DAILY_CURVE_GONE}`,
        }
      }
      if (!goal || !spec) refuse('Name the optimization goal (optimizationGoal) and the targeting, or an ad set (adSetId) to estimate as it is.')
      const read = await metaReadOne({ connectionId }, { operation: 'targeting.deliveryEstimate', path: `${act(adAccountId)}/delivery_estimate`, query: { ...overrides, fields: DELIVERY_FIELDS } })
      return { ...base, optimizationGoal: goal, ...estimate(read.body), note: `Monthly active people Meta can reach with this targeting and goal. ${DAILY_CURVE_GONE}` }
    }
    case 'message-delivery': {
      // TG-034 / TG-035 — marketing messages need Meta's grant; the cost unit is undocumented (LIVE-PROBES).
      if (!currency && (input.bidAmountCents != null || input.lifetimeBudgetCents != null || input.dailyBudgetCents != null)) {
        refuse('Nexus has not read this ad account\'s currency yet, so it cannot send an amount (it never assumes one). Read the account first (meta-ads-live view account) or leave the amounts out.')
      }
      if (input.adSetId && (input.dailyBudgetCents != null || input.directSend)) refuse('dailyBudgetCents and directSend go on the account estimate only (no adSetId).')
      const spec = input.targeting === undefined || input.targeting === null ? null : parsedSpec(input.targeting)
      if (spec) await checkSpecOwned(account, spec)
      const promoted = input.promotedObject === undefined || input.promotedObject === null ? null : await checkPromotedObject(account, input.promotedObject)
      const query: Record<string, MetaQueryValue> = { fields: MESSAGE_FIELDS }
      if (spec) query.targeting_spec = spec
      if (promoted) query.promoted_object = promoted
      if (input.optimizationGoal) query.optimization_goal = input.optimizationGoal
      if (input.pacingType) query.pacing_type = input.pacingType
      if (input.lifetimeDays) query.lifetime_in_days = input.lifetimeDays
      // Review fix B1 — the account estimate also takes a daily budget and a direct send (SDK adaccount.py).
      if (input.directSend) query.is_direct_send_campaign = true
      const amounts = [['bid_amount', 'bidAmountCents', input.bidAmountCents], ['lifetime_budget', 'lifetimeBudgetCents', input.lifetimeBudgetCents], ['daily_budget', 'dailyBudgetCents', input.dailyBudgetCents]] as const
      for (const [key, arg, cents] of amounts) {
        if (cents === null || cents === undefined) continue
        const units = minorToMetaUnits(cents, currency!)
        if (units === null) refuse(`${arg} is not a whole amount Meta takes in ${currency} (Meta counts ${currency} in 1/${metaOffset(currency)} of a unit).`)
        query[key] = units
      }
      let path: string
      if (input.adSetId) path = `${await ownId(account, input.adSetId, 'ad set')}/message_delivery_estimate`
      else {
        if (!spec || !promoted) refuse('Name the targeting and the promoted object (both required for an account estimate), or an ad set (adSetId).')
        path = `${act(adAccountId)}/message_delivery_estimate`
      }
      // Review fix B1 — first, whether the account is onboarded to WhatsApp marketing messages (placement-targeting:
      // "read marketing_messages_settings{whatsapp_activation_status} on the ad account"); Meta's refusal is said, not fatal.
      let whatsappActivationStatus: string | null = null
      let whatsappNote: string | null = null
      try {
        const settings = await metaReadOne({ connectionId }, { operation: 'targeting.marketingMessagesSettings', path: act(adAccountId), query: { fields: 'marketing_messages_settings{whatsapp_activation_status}' } })
        const m = (settings.body as { marketing_messages_settings?: unknown }).marketing_messages_settings
        whatsappActivationStatus = text(m && typeof m === 'object' ? (m as { whatsapp_activation_status?: unknown }).whatsapp_activation_status : null)
      } catch (err) {
        if (!(err instanceof MetaReadError) || err.failure.authLost || err.failure.throttled) throw err
        whatsappNote = `Meta did not say whether this account is onboarded to WhatsApp marketing messages: ${err.failure.sentence}`
      }
      const read = await metaReadOne({ connectionId }, { operation: 'targeting.messageDeliveryEstimate', path, query })
      const r = dataRows(read.body)[0] ?? {}
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
      return {
        ...base, ...(input.adSetId ? { adSetId: metaObjectId(input.adSetId) } : {}),
        whatsappActivationStatus, ...(whatsappNote ? { whatsappNote } : {}),
        currency, minorUnitDigits: currency ? currencyExponent(currency) : null,
        bidAmountCents: input.bidAmountCents ?? null, lifetimeBudgetCents: input.lifetimeBudgetCents ?? null, dailyBudgetCents: input.dailyBudgetCents ?? null,
        estimateStatus: text(r.estimate_status),
        estimateDelivery: num(r.estimate_delivery), estimateDeliveryLowerBound: num(r.estimate_delivery_lower_bound), estimateDeliveryUpperBound: num(r.estimate_delivery_upper_bound),
        estimateCoverageLowerBound: num(r.estimate_coverage_lower_bound), estimateCoverageUpperBound: num(r.estimate_coverage_upper_bound),
        estimateCostMetaUnits: num(r.estimate_cost), estimateCostLowerBoundMetaUnits: num(r.estimate_cost_lower_bound), estimateCostUpperBoundMetaUnits: num(r.estimate_cost_upper_bound),
        note: 'Marketing-message estimates need the account onboarded to marketing messages (whatsappActivationStatus) and the WhatsApp marketing_messages placement (whatsapp_positions); without them Meta refuses and this says so. Amounts are in minor units of the account currency (minorUnitDigits decimals). The cost is Meta\'s number as it answers it: Meta does not document its unit, so it is not converted.',
      }
    }
    case 'describe': {
      let path: string
      const query: Record<string, MetaQueryValue> = {}
      if (input.adId) path = `${await ownId(account, input.adId, 'ad')}/targetingsentencelines`
      else if (input.adSetId) path = `${await ownId(account, input.adSetId, 'ad set')}/targetingsentencelines`
      else if (input.targeting !== undefined && input.targeting !== null) {
        const spec = parsedSpec(input.targeting)
        await checkSpecOwned(account, spec)
        path = `${act(adAccountId)}/targetingsentencelines`
        Object.assign(query, { targeting_spec: spec, hide_targeting_spec_from_return: true })
      } else return refuse('Name what to describe: targeting (a spec), an ad set (adSetId) or an ad (adId).')
      const read = await metaReadOne({ connectionId }, { operation: 'targeting.targetingsentencelines', path, query })
      return { ...base, lines: sentenceLines(read.body), note: 'Meta\'s own words for who sees it (effective placements only).' }
    }
    default:
      return refuse('Unknown check.')
  }
}

/** TG-006 — interests checked by id (best: interests get renamed) or by name. */
async function interestsValid(input: TargetingCheckInput) {
  const connection = await metaConnectionFor(input.connectionId)
  const query: Record<string, MetaQueryValue> = { type: SEARCH_TYPE_OF.interests }
  if (input.interestIds?.length) query.interest_fbid_list = input.interestIds.map(idValue)
  else if (input.interestNames?.length) query.interest_list = input.interestNames
  else refuse('Name the interests to check: interestIds (best — interests get renamed) or interestNames (case-sensitive).')
  const read = await metaReadOne({ connectionId: connection.connectionId }, { operation: 'targeting.search.adinterestvalid', path: 'search', query })
  const items = dataRows(read.body).map((r) => { const row = pickRow(r, ['id', 'name', 'valid', 'audience_size', 'audience_size_lower_bound', 'audience_size_upper_bound']); return row.valid === false ? { ...row, words: 'Meta does not know this interest any more (retired or renamed): remove it, or search for it again.' } : row })
  return { check: 'interests', items, invalid: items.filter((i) => i.valid === false).length, note: 'Check by id: Meta renames interests, so a name can fail while the id still works.' }
}

/** targetingsentencelines in either shape (the guide's top-level list, or the reference's `data` of nodes). */
export function sentenceLines(body: unknown): Array<{ content: string | null; children: string[] }> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  let lines: unknown = b.targetingsentencelines
  if (!Array.isArray(lines) && Array.isArray(b.data)) {
    const first = b.data[0] as Record<string, unknown> | undefined
    lines = first && Array.isArray(first.targetingsentencelines) ? first.targetingsentencelines : b.data.filter((r) => r && typeof r === 'object' && 'content' in (r as object))
  }
  if (!Array.isArray(lines)) return []
  return lines.slice(0, 100).map((line) => {
    const l = (line && typeof line === 'object' ? line : {}) as { content?: unknown; children?: unknown }
    const children = Array.isArray(l.children) ? l.children.filter((c): c is string => typeof c === 'string').slice(0, 200).map((c) => (c.length > 300 ? `${c.slice(0, 299)}…` : c)) : []
    return { content: text(l.content), children }
  })
}
