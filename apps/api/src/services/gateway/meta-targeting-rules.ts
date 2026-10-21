/**
 * Meta step 20 (2026-10-21) — targeting, placements and the ad account's controls on the write allow-list: the exact
 * (method, path, keys, values) that set-meta-targeting, set-meta-placements and set-meta-account-controls send. An ad set's
 * targeting goes WHOLE (Q7, marketing/meta-ads/targeting-merge.ts): the gateway reads the ad set's live targeting itself
 * (gateway.ts → meta-brand-safety-owner.ts metaTargetingOwnerProblem) and refuses any top-level key outside the rule's own
 * set that is not exactly Meta's; each key the change SETS is judged here, key by key, value by value (Meta's own read-back
 * shapes included, so undo can put a value back), and every id the change ADDS inside the spec (custom audiences, product
 * audiences, place page sets, product sets) goes to the gateway's owner check (at most 150 per body).
 *
 * Checked 2026-10-21 (developers.facebook.com/documentation/ads-commerce/marketing-api/…, `.md` pages, paced; Meta's Python
 * Business SDK facebook_business/adobjects/{targeting,targetinggeolocation*,flexibletargeting,targetingautomation,
 * targetingrelaxation,targetingproductaudience*,placementsoftoptout,adaccountbusinessconstraints,adplacepageset,
 * adaccount}.py on GitHub main; Graph's targeting reference docs/graph-api/reference/targeting; error-reference.md):
 *   - audiences/reference/basic-targeting.md: geo_locations countries | regions [{key}] (≤ 200) | cities [{key, radius
 *     10–50 mi / 17–80 km, distance_unit}] (≤ 250) | zips [{key "US:94304"}] | places [{key, radius, distance_unit}] (≤ 200)
 *     | custom_locations [{latitude, longitude | address_string, radius 0.63–50 mi / 1–80 km, distance_unit, name}] (≤ 200;
 *     custom_type multi_city) | geo_markets [{key "COMSCORE_MARKET:…"}] (≤ 2,500) | electoral_districts | country_groups;
 *     location_types: "['home', 'recent'] is the only option" (TG-049 CORRECTED) and error 1870199 asks to "remove all
 *     values from the location_types field" (error-reference.md): Nexus never sets it, and drops it from a location list
 *     it rewrites. The other area lists (large/medium/small geo areas, metro areas, subcities, neighborhoods,
 *     subneighborhoods, political districts, location_cluster_ids) are SDK only (targetinggeolocation.py) — TG-048
 *     STILL-UNVERIFIED: built with {key}, LIVE-PROBES TG-048.
 *   - advanced-targeting.md: user_os (iOS, Android, iOS_ver_x.x_to_y.y …), user_device / excluded_user_device (match
 *     user_os), wireless_carrier ["Wifi"], relationship_statuses 1,2,3,4,6 ("do not use 0"), education_statuses 1–13,
 *     college_years (from 1980), custom_audiences / excluded_custom_audiences ≤ 500 each, locales (limit 50),
 *     targeting_automation.individual_setting {age, gender, geo} 0/1 (age/gender for OUTCOME_SALES and APP_INSTALLS only).
 *   - audiences/reference/flexible-targeting.md (TG-055): flexible_spec — AND between groups (≤ 25), OR inside (≤ 1,000);
 *     allowed keys custom_audiences, interests, behaviors, college_years, education_*, family_statuses, income, industries,
 *     life_events, user_adclusters, work_positions, work_employers (+ relationship_statuses, flexibletargeting.py).
 *   - targeting-expansion/advantage-audience.md (TG-059): targeting_automation.advantage_audience 0/1; with 1, age_min only
 *     18–25 and age_max fixed at 65; age_range [min, max] is a suggestion (TG-060). targetingautomation.py:
 *     creative_audience_pairing (OCC 2026-10-19, TG-064), individual_setting, shared_audiences, value_expression (the last
 *     two on no page: never SET by Nexus, kept as Meta has them — TG-065). targetingrelaxation.py {lookalike,
 *     custom_audience} (TG-062); targeting_optimization expansion_all | none (TG-061).
 *   - placement-targeting.md (TG-080–088): publisher_platforms facebook, instagram, threads, messenger, audience_network
 *     (+ whatsapp); facebook_positions feed, right_hand_column, marketplace, video_feeds, story, search, instream_video,
 *     facebook_reels, facebook_reels_overlay, profile_feed, notification; instagram_positions (v26 changelog removed
 *     `explore`, TG-083) stream, story, explore_home, reels, profile_feed, ig_search, profile_reels; threads_positions
 *     threads_stream (needs Instagram stream); audience_network_positions classic, rewarded_video ("you cannot use Audience
 *     Network alone"); messenger_positions sponsored_messages (v26 removed Messenger `story`, TG-086; sponsored_messages is
 *     combined with no other placement); whatsapp_positions status (needs Instagram story), marketing_messages; story and
 *     notification never alone; subscriber_universe is READ-ONLY (never sent). placement_soft_opt_out (top-level ad set
 *     field) {facebook_positions, audience_network_positions, instagram_positions, threads_positions, messenger_positions}.
 *     Graph's targeting reference: device_platforms mobile | desktop | connected_tv, user_age_unknown,
 *     instream_video_skippable_excluded, instream_video_sponsorship_placements ("pre-roll/mid-roll/", values undocumented),
 *     exclude_reached_since (list<string>, format undocumented), keywords, contextual_targeting_categories, site_category,
 *     product_audience_specs / excluded_product_audience_specs (audiences/guides/dynamic-product-audiences.md: product_set_id,
 *     inclusions / exclusions [{retention_seconds, rule {event: {eq}}}]), dynamic_audience_ids ("a product audience is a
 *     specific type of custom audience"), place_page_set_ids.
 *   - reference/ad-campaign.md (TG-075, SDK adset.py): tune_for_category NONE | EMPLOYMENT | HOUSING | CREDIT |
 *     ISSUES_ELECTIONS_POLITICS | ONLINE_GAMBLING_AND_GAMING | FINANCIAL_PRODUCTS_SERVICES — Nexus never sends CREDIT
 *     (replaced) nor ISSUES_ELECTIONS_POLITICS (no political ads in the EU).
 *   - reference/ad-account/account_controls.md (TG-100 / TG-101): POST audience_controls [required] {age_min,
 *     geo_locations, excluded_geo_locations, exclusions}, placement_controls {placement_exclusions [AUDIENCE_NETWORK_CLASSIC,
 *     AUDIENCE_NETWORK_REWARDED_VIDEO, AUDIENCE_NETWORK_INSTREAM_VIDEO, FACEBOOK_MARKETPLACE, FACEBOOK_RIGHT_HAND_COLUMN],
 *     campaign_ids_to_set_ap array<numeric string>}; no update, no delete (a POST replaces); errors 2641, 1870219 (only
 *     employer exclusions), 1870220 (too many).
 *   - reference/ad-account/ad_place_page_sets.md (TG-018): POST name [required], parent_page [required], location_types
 *     [recent, home]; read-after-write. targeted_area_type CUSTOM_RADIUS | MARKETING_AREA | NONE and the `_async` edge
 *     (TG-019) are SDK only (adaccount.py create_ad_place_page_set(s_async)): LIVE-PROBES TG-019.
 * Not sent at all (the tools say why): connections / excluded_connections / friends_of_connections (error 1870088
 * "Connection targeting is being deprecated"), engagement_specs (TargetingDynamicRule: shape on no page), prospecting_audience
 * and alternate_auto_targeting_option (one line each), is_whatsapp_destination_ad, subscriber_universe (read-only),
 * catalog_based_targeting (kept as Meta has it).
 */
import type { MetaWriteBodyId, MetaWriteRule } from './meta-calls.js'
import { canonicalJson, holdsInexactNumber, MAX_TARGETING_BODY, sameJson, TARGETING_TEXT } from './meta-brand-safety-rules.js'
import { META_NAME_TEXT } from './meta-write-text.js'

type Params = ReadonlyMap<string, string>
type Row = Record<string, unknown>
const plainObject = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
const DIGITS = /^\d{1,20}$/
/** An id as Meta writes it in a spec: digits, as a string (or a number JavaScript carries exactly). */
const isIdValue = (v: unknown): boolean => (typeof v === 'string' && DIGITS.test(v)) || (typeof v === 'number' && Number.isSafeInteger(v) && v > 0)
export const idText = (v: unknown): string | null => (isIdValue(v) ? String(v) : null)
/** Text Meta holds in a spec (a name, a region): printable, at most 300 characters. */
const printable = (v: unknown, max = 300): boolean => typeof v === 'string' && [...v].length <= max && TARGETING_TEXT.test(v)
const unique = (list: unknown[]): boolean => new Set(list.map((x) => JSON.stringify(x))).size === list.length

// ── facts ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const COUNTRY_GROUPS = [
  'worldwide', 'africa', 'afta', 'android_app_store', 'android_free_store', 'apec', 'asia', 'caribbean', 'central_america', 'cisfta', 'eea',
  'emerging_markets', 'europe', 'gcc', 'itunes_app_store', 'mercosur', 'nafta', 'north_america', 'oceania', 'south_america',
] as const
/** The lists of a location spec whose items are {key, …} (cities and places also take a radius). */
export const GEO_KEYED_LISTS = [
  'regions', 'cities', 'zips', 'places', 'geo_markets', 'electoral_districts', 'large_geo_areas', 'medium_geo_areas', 'small_geo_areas',
  'metro_areas', 'subcities', 'neighborhoods', 'subneighborhoods', 'political_districts', 'location_cluster_ids',
] as const
export type GeoKeyedList = typeof GEO_KEYED_LISTS[number]
const GEO_KEYS = ['countries', 'country_groups', 'custom_locations', 'location_types', ...GEO_KEYED_LISTS] as const
/** Fields Meta answers on a location item (SDK targetinggeolocation*.py): kept as read, never typed by a caller. */
const GEO_ITEM_FIELDS = new Set([
  'key', 'name', 'country', 'region', 'region_id', 'primary_city_id', 'radius', 'distance_unit', 'latitude', 'longitude', 'address_string',
  'custom_type', 'min_population', 'max_population', 'country_group', 'market_type', 'electoral_district', 'deprecation_code',
  // Review B2 — Meta's label of a political district (targetinggeolocationpoliticaldistrict.py).
  'political_district',
])
const GEO_CAPS: Readonly<Record<string, number>> = {
  countries: 250, country_groups: COUNTRY_GROUPS.length, custom_locations: 200, regions: 200, cities: 250, zips: 2500, places: 200, geo_markets: 2500,
  electoral_districts: 250, large_geo_areas: 250, medium_geo_areas: 250, small_geo_areas: 250, metro_areas: 250, subcities: 250, neighborhoods: 250,
  subneighborhoods: 250, political_districts: 250, location_cluster_ids: 50,
}
/** Detailed-targeting lists of {id, name} (flexible-targeting.md; also at the top level of a spec, ORed together). */
export const OPTION_LISTS = ['interests', 'behaviors', 'life_events', 'industries', 'income', 'family_statuses', 'user_adclusters', 'work_positions', 'work_employers', 'education_schools', 'education_majors'] as const
/** Detailed-targeting lists of Meta's codes (numbers). */
export const CODE_LISTS = ['education_statuses', 'relationship_statuses', 'college_years'] as const
/** The keys a flexible_spec group (and `exclusions`) may hold. */
export const FLEX_KEYS = [...OPTION_LISTS, ...CODE_LISTS, 'custom_audiences'] as const
export const FACEBOOK_POSITIONS = ['feed', 'right_hand_column', 'marketplace', 'video_feeds', 'story', 'search', 'instream_video', 'facebook_reels', 'facebook_reels_overlay', 'profile_feed', 'notification'] as const
/** v26 removed `explore` (Instagram Explore feed, TG-083). */
export const INSTAGRAM_POSITIONS = ['stream', 'story', 'explore_home', 'reels', 'profile_feed', 'ig_search', 'profile_reels'] as const
export const THREADS_POSITIONS = ['threads_stream'] as const
export const AUDIENCE_NETWORK_POSITIONS = ['classic', 'rewarded_video'] as const
/** v26 removed Messenger `story` (TG-086). */
export const MESSENGER_POSITIONS = ['sponsored_messages'] as const
export const WHATSAPP_POSITIONS = ['status', 'marketing_messages'] as const
export const PUBLISHER_PLATFORMS = ['facebook', 'instagram', 'threads', 'messenger', 'audience_network', 'whatsapp'] as const
export type PublisherPlatform = typeof PUBLISHER_PLATFORMS[number]
/** Each platform's positions key and its documented positions. */
export const POSITIONS_OF: Readonly<Record<PublisherPlatform, { key: string; positions: readonly string[] }>> = {
  facebook: { key: 'facebook_positions', positions: FACEBOOK_POSITIONS },
  instagram: { key: 'instagram_positions', positions: INSTAGRAM_POSITIONS },
  threads: { key: 'threads_positions', positions: THREADS_POSITIONS },
  messenger: { key: 'messenger_positions', positions: MESSENGER_POSITIONS },
  audience_network: { key: 'audience_network_positions', positions: AUDIENCE_NETWORK_POSITIONS },
  whatsapp: { key: 'whatsapp_positions', positions: WHATSAPP_POSITIONS },
}
export const DEVICE_PLATFORMS = ['mobile', 'desktop', 'connected_tv'] as const
/** placement_soft_opt_out (placement-targeting.md "Limited spend on excluded placements"): the documented five. */
export const SOFT_OPT_OUT_KEYS = ['facebook_positions', 'instagram_positions', 'threads_positions', 'messenger_positions', 'audience_network_positions'] as const
/** tune_for_category values Nexus sends (never CREDIT — replaced — nor ISSUES_ELECTIONS_POLITICS). */
export const TUNE_CATEGORIES = ['NONE', 'EMPLOYMENT', 'HOUSING', 'FINANCIAL_PRODUCTS_SERVICES', 'ONLINE_GAMBLING_AND_GAMING'] as const
/** account_controls placement_controls.placement_exclusions (account_controls.md). */
export const ACCOUNT_PLACEMENT_EXCLUSIONS = ['AUDIENCE_NETWORK_CLASSIC', 'AUDIENCE_NETWORK_REWARDED_VIDEO', 'AUDIENCE_NETWORK_INSTREAM_VIDEO', 'FACEBOOK_MARKETPLACE', 'FACEBOOK_RIGHT_HAND_COLUMN'] as const
/** The product events a product audience rule names (dynamic-product-audiences.md: ViewContent, AddToCart, Purchase …). */
export const PRODUCT_EVENTS = ['ViewContent', 'AddToCart', 'Purchase', 'InitiateCheckout', 'AddToWishlist', 'Search', 'ViewCategory', 'AddPaymentInfo', 'Lead', 'CompleteRegistration'] as const
/** At most this many days a person stays in a product audience Nexus writes (Meta's website audiences keep 180 days). */
export const MAX_RETENTION_DAYS = 180

/** The top-level keys set-meta-targeting may change (every other key goes back exactly as Meta has it). */
export const AUDIENCE_TARGETING_KEYS = [
  'geo_locations', 'excluded_geo_locations', 'age_min', 'age_max', 'genders', 'locales',
  'flexible_spec', 'exclusions', 'custom_audiences', 'excluded_custom_audiences', ...OPTION_LISTS, ...CODE_LISTS,
  'targeting_automation', 'age_range', 'targeting_optimization', 'targeting_relaxation_types', 'exclude_reached_since',
  'product_audience_specs', 'excluded_product_audience_specs', 'dynamic_audience_ids', 'excluded_dynamic_audience_ids', 'place_page_set_ids',
  'device_platforms', 'user_os', 'user_device', 'excluded_user_device', 'excluded_mobile_device_model', 'wireless_carrier',
  'keywords', 'contextual_targeting_categories', 'site_category',
] as const
/** The top-level keys set-meta-placements may change. */
export const PLACEMENT_TARGETING_KEYS = [
  'publisher_platforms', 'facebook_positions', 'instagram_positions', 'threads_positions', 'audience_network_positions', 'messenger_positions',
  'whatsapp_positions', 'user_age_unknown', 'instream_video_skippable_excluded', 'instream_video_sponsorship_placements',
] as const

// ── value judges (Meta's read-back shapes too: undo puts a value back as Meta held it) ──────────────────────────────

/** One location item, as a caller writes it or Meta reads it back. */
function geoItemProblem(list: string, item: unknown): string | null {
  const where = `a ${list} item`
  if (!plainObject(item)) return `${where} is an object`
  for (const [k, v] of Object.entries(item)) {
    if (!GEO_ITEM_FIELDS.has(k)) return `${where} takes no ${k}`
    if (k === 'distance_unit') { if (v !== 'mile' && v !== 'kilometer') return 'distance_unit is mile or kilometer'; continue }
    if (k === 'latitude') { if (typeof v !== 'number' || !Number.isFinite(v) || v < -90 || v > 90) return 'latitude is −90 to 90'; continue }
    if (k === 'longitude') { if (typeof v !== 'number' || !Number.isFinite(v) || v < -180 || v > 180) return 'longitude is −180 to 180'; continue }
    if (k === 'radius') {
      const r = typeof v === 'string' ? Number(v) : v
      if (typeof r !== 'number' || !Number.isFinite(r) || r < 0 || r > 80) return 'radius is at most 80'
      // Review B6 — a city's radius is a whole number (SDK targetinggeolocationcity.py: unsigned int).
      if (list === 'cities' && !Number.isInteger(r)) return 'a city\'s radius is a whole number'
      continue
    }
    if (k === 'min_population' || k === 'max_population' || k === 'primary_city_id' || k === 'region_id') { if (!(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) && !(typeof v === 'string' && /^\d{1,20}$/.test(v))) return `${k} is a whole number`; continue }
    if (k === 'key') { if (!((typeof v === 'string' && /^[A-Za-z0-9_:.\- ]{1,80}$/.test(v)) || isIdValue(v))) return `${where}'s key is Meta's key (letters, digits, : _ . -)`; continue }
    if (!printable(v)) return `${where}'s ${k} is printable text`
  }
  if (list === 'custom_locations') {
    const pin = typeof item.latitude === 'number' && typeof item.longitude === 'number'
    if (!pin && !printable(item.address_string, 300) && item.custom_type !== 'multi_city') return 'a custom location has latitude and longitude, an address_string, or custom_type multi_city'
    if (item.custom_type !== undefined && item.custom_type !== 'multi_city') return 'custom_type is multi_city'
  } else if (item.key === undefined) return `${where} has its key`
  return null
}

/** A location spec (geo_locations, excluded_geo_locations, or an account control's): its documented lists only. */
export function geoSpecProblem(value: unknown, what: string, exclusion = false): string | null {
  if (!plainObject(value)) return `${what} is an object`
  for (const [k, v] of Object.entries(value)) {
    if (!(GEO_KEYS as readonly string[]).includes(k)) return `${what} takes no ${k}`
    // Review A1 — never an empty list (a list Nexus empties is left out).
    if (!Array.isArray(v) || v.length < 1 || v.length > (GEO_CAPS[k] ?? 2)) return `${what}.${k} is a list of 1 to ${GEO_CAPS[k] ?? 2}`
    if (!unique(v)) return `${what}.${k} names each place once`
    if (k === 'countries') { if (!v.every((c) => typeof c === 'string' && /^[A-Z]{2}$/.test(c))) return `${what}.countries lists two-letter country codes`; continue }
    if (k === 'country_groups') { if (!v.every((c) => (COUNTRY_GROUPS as readonly unknown[]).includes(c))) return `${what}.country_groups lists ${COUNTRY_GROUPS.join(', ')}`; continue }
    if (k === 'location_types') {
      if (!v.length || !v.every((t) => t === 'home' || t === 'recent')) return `${what}.location_types is home and / or recent`
      if (exclusion && v.includes('recent')) return 'Meta takes no location_types "recent" in an exclusion'
      continue
    }
    for (const item of v) { const p = geoItemProblem(k, item); if (p) return `${what}.${k}: ${p}` }
  }
  return null
}

function optionListProblem(value: unknown, what: string, max: number): string | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) return `${what} is a list of 1 to ${max} options`
  for (const o of value) {
    if (!plainObject(o) || !isIdValue(o.id) || Object.keys(o).some((k) => k !== 'id' && k !== 'name') || (o.name !== undefined && !printable(o.name))) return `${what} lists {id, name} options (ids digits)`
  }
  return new Set(value.map((o) => String((o as Row).id))).size === value.length ? null : `${what} names each option once`
}

/** relationship_statuses: 1 single, 2 in a relationship, 3 married, 4 engaged, 6 not specified (advanced-targeting.md: never 0). */
export const RELATIONSHIP_STATUSES = [1, 2, 3, 4, 6] as const
function codeListProblem(key: string, value: unknown, what: string): string | null {
  if (key === 'relationship_statuses') {
    return Array.isArray(value) && value.length >= 1 && value.every((n) => (RELATIONSHIP_STATUSES as readonly unknown[]).includes(n)) && unique(value) ? null : `${what} lists ${RELATIONSHIP_STATUSES.join(', ')}, each once`
  }
  const [min, max] = key === 'college_years' ? [1980, 2100] : [1, 13]
  if (!Array.isArray(value) || value.length < 1 || value.length > (key === 'college_years' ? 130 : 13) || !value.every((n) => isInt(n, min, max)) || !unique(value)) return `${what} lists Meta's codes ${min}–${max}, each once`
  return null
}

function audienceListProblem(value: unknown, what: string, max = 500): string | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) return `${what} lists 1 to ${max} audiences`
  for (const a of value) {
    const ok = isIdValue(a) || (plainObject(a) && isIdValue(a.id) && Object.keys(a).every((k) => k === 'id' || k === 'name') && (a.name === undefined || printable(a.name)))
    if (!ok) return `${what} lists audiences as {id} (digits)`
  }
  return new Set(value.map((a) => (plainObject(a) ? String(a.id) : String(a)))).size === value.length ? null : `${what} names each audience once`
}

/**
 * A flexible_spec group or `exclusions` (FlexibleTargeting): its documented keys, each a non-empty list (an empty group
 * would read as "narrower" and is refused, review A1). `exclusions` takes no custom_audiences: the v22 changelog deprecated
 * them there ("use excluded_custom_audiences").
 */
function flexGroupProblem(value: unknown, what: string, exclusions = false): string | null {
  if (!plainObject(value) || !Object.keys(value).length) return `${what} is an object with at least one list`
  for (const [k, v] of Object.entries(value)) {
    if (exclusions && k === 'custom_audiences') return `${what} takes no custom_audiences (deprecated there since v22: excluded_custom_audiences)`
    if (!(FLEX_KEYS as readonly string[]).includes(k)) return `${what} takes no ${k} (Meta's detailed targeting: ${FLEX_KEYS.join(', ')})`
    const p = k === 'custom_audiences' ? audienceListProblem(v, `${what}.${k}`, 500)
      : (CODE_LISTS as readonly string[]).includes(k) ? codeListProblem(k, v, `${what}.${k}`)
        : optionListProblem(v, `${what}.${k}`, 1000)
    if (p) return p
  }
  return null
}

const stringList = (value: unknown, what: string, max: number, ok: (s: string) => boolean): string | null =>
  (Array.isArray(value) && value.length >= 1 && value.length <= max && value.every((s) => typeof s === 'string' && ok(s)) && unique(value) ? null : `${what} is a list of at most ${max} values, each once`)
const subsetOf = (value: unknown, allowed: readonly string[], what: string, min = 1): string | null =>
  (Array.isArray(value) && value.length >= min && value.length <= allowed.length && value.every((v) => allowed.includes(v as string)) && unique(value) ? null : `${what} lists ${allowed.join(', ')}, each once`)
const zeroOne = (v: unknown) => v === 0 || v === 1

function productSubSpecProblem(value: unknown, what: string): string | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) return `${what} lists 1 to 10 events`
  for (const s of value) {
    if (!plainObject(s) || Object.keys(s).some((k) => !['retention_seconds', 'min_retention_seconds', 'rule'].includes(k))) return `${what} items have retention_seconds and rule (and min_retention_seconds)`
    for (const k of ['retention_seconds', 'min_retention_seconds'] as const) {
      if (s[k] === undefined) { if (k === 'retention_seconds') return `${what} items have retention_seconds`; continue }
      const n = typeof s[k] === 'string' ? Number(s[k]) : s[k]
      // Review A4 — at least one day kept (retention_seconds), never more than Meta's 180 days.
      if (!isInt(n, k === 'retention_seconds' ? 86_400 : 0, MAX_RETENTION_DAYS * 86_400)) return `${what}.${k} is ${k === 'retention_seconds' ? '1' : '0'} to ${MAX_RETENTION_DAYS} days in seconds`
    }
    // Review A4 — exactly {"event": {"eq": <a product event>}} (dynamic-product-audiences.md), nothing else.
    const rule = typeof s.rule === 'string' ? (() => { try { return JSON.parse(s.rule as string) } catch { return undefined } })() : s.rule
    const event = plainObject(rule) && Object.keys(rule).length === 1 && plainObject(rule.event) && Object.keys(rule.event).length === 1 ? rule.event.eq : undefined
    if (!(PRODUCT_EVENTS as readonly unknown[]).includes(event)) return `${what}.rule is exactly {"event": {"eq": <one of ${PRODUCT_EVENTS.join(', ')}>}}`
  }
  return null
}

function productSpecsProblem(value: unknown, what: string): string | null {
  if (!Array.isArray(value) || value.length > 20) return `${what} lists at most 20 product audiences`
  for (const p of value) {
    if (!plainObject(p) || !isIdValue(p.product_set_id) || Object.keys(p).some((k) => !['product_set_id', 'inclusions', 'exclusions'].includes(k))) return `${what} items have product_set_id (digits) and inclusions / exclusions`
    if (p.inclusions !== undefined) { const e = productSubSpecProblem(p.inclusions, `${what}.inclusions`); if (e) return e }
    if (p.exclusions !== undefined) { const e = productSubSpecProblem(p.exclusions, `${what}.exclusions`); if (e) return e }
    if (p.inclusions === undefined && p.exclusions === undefined) return `${what} items name inclusions or exclusions`
  }
  return null
}

const DEVICE_TEXT = /^[A-Za-z0-9_ .+()/-]{1,80}$/
const TOKEN = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/

/** targeting_automation's switches Meta documents on no page: never SET by Nexus, kept exactly as Meta has them (TG-065). */
const KEPT_AUTOMATION = ['shared_audiences', 'value_expression'] as const

/**
 * The value judge of each top-level targeting key a step 20 change may SET (a key it does not touch goes back as Meta
 * has it): its documented shape, Meta's read-back fields included. `live` (the gateway's own read of the key): what must
 * stay exactly as Meta has it inside a key (targeting_automation's undocumented switches).
 */
export function targetingValueProblem(key: string, value: unknown, live?: unknown): string | null {
  const what = `targeting.${key}`
  switch (key) {
    case 'geo_locations': return geoSpecProblem(value, what)
    case 'excluded_geo_locations': return geoSpecProblem(value, what, true)
    case 'age_min': case 'age_max': return isInt(value, 13, 65) ? null : `${what} is 13 to 65`
    case 'genders': return subsetOf(value, [1, 2] as unknown as string[], `${what} (1 men, 2 women)`)
    case 'locales': return Array.isArray(value) && value.length >= 1 && value.length <= 90 && value.every((n) => isInt(n, 1, 100_000)) && unique(value) ? null : `${what} lists 1 to 90 language ids (meta-targeting-search kind language)`
    case 'flexible_spec':
      if (!Array.isArray(value) || value.length < 1 || value.length > 25) return `${what} lists 1 to 25 groups (AND between groups, OR inside)`
      for (const [i, g] of value.entries()) { const p = flexGroupProblem(g, `${what}[${i}]`); if (p) return p }
      return null
    case 'exclusions': return flexGroupProblem(value, what, true)
    case 'custom_audiences': case 'excluded_custom_audiences': return audienceListProblem(value, what)
    case 'targeting_automation': {
      if (!plainObject(value)) return `${what} is an object`
      for (const [k, v] of Object.entries(value)) {
        if (k === 'individual_setting') {
          if (!plainObject(v) || !Object.keys(v).length || !Object.entries(v).every(([s, x]) => ['age', 'gender', 'geo'].includes(s) && zeroOne(x))) return `${what}.individual_setting is {age, gender, geo} each 0 or 1`
          continue
        }
        if (!['advantage_audience', 'creative_audience_pairing', 'shared_audiences', 'value_expression'].includes(k)) return `${what} takes no ${k}`
        if (!zeroOne(v)) return `${what}.${k} is 0 or 1`
      }
      // Review A1 — Meta's undocumented switches stay exactly as the live spec holds them (none there: null, read as {}).
      if (live !== undefined) {
        const now = plainObject(live) ? live : {}
        for (const k of KEPT_AUTOMATION) if ((value as Row)[k] !== now[k]) return `${what}.${k} stays as Meta holds it (Nexus never sets it: Meta documents it on no page)`
      }
      return null
    }
    case 'age_range': return Array.isArray(value) && value.length === 2 && isInt(value[0], 18, 65) && isInt(value[1], 18, 65) && value[0] <= value[1] ? null : `${what} is [min, max], 18 to 65`
    case 'targeting_optimization': return value === 'expansion_all' || value === 'none' ? null : `${what} is expansion_all or none`
    case 'targeting_relaxation_types':
      return plainObject(value) && Object.keys(value).length > 0 && Object.entries(value).every(([k, v]) => (k === 'lookalike' || k === 'custom_audience') && zeroOne(v)) ? null : `${what} is {lookalike, custom_audience} each 0 or 1`
    case 'exclude_reached_since': return stringList(value, what, 10, (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) || /^\d{9,11}$/.test(s))
    case 'product_audience_specs': case 'excluded_product_audience_specs': return productSpecsProblem(value, what)
    case 'dynamic_audience_ids': case 'excluded_dynamic_audience_ids': case 'place_page_set_ids':
      return Array.isArray(value) && value.length >= 1 && value.length <= (key === 'place_page_set_ids' ? 50 : 100) && value.every(isIdValue) && unique(value.map(String)) ? null : `${what} lists ids (digits), each once`
    case 'device_platforms': return subsetOf(value, DEVICE_PLATFORMS, what)
    case 'user_os': return stringList(value, what, 20, (s) => /^[A-Za-z0-9_.]{1,40}$/.test(s))
    case 'user_device': case 'excluded_user_device': case 'excluded_mobile_device_model': return stringList(value, what, 200, (s) => DEVICE_TEXT.test(s))
    case 'wireless_carrier': return Array.isArray(value) && value.length === 1 && value[0] === 'Wifi' ? null : `${what} is ["Wifi"]`
    case 'keywords': return stringList(value, what, 100, (s) => s.trim() === s && s.length > 0 && printable(s, 100))
    case 'contextual_targeting_categories': return optionListProblem(value, what, 100)
    case 'site_category': case 'instream_video_sponsorship_placements': return stringList(value, what, 20, (s) => TOKEN.test(s))
    case 'publisher_platforms': return subsetOf(value, PUBLISHER_PLATFORMS, what)
    case 'facebook_positions': return subsetOf(value, FACEBOOK_POSITIONS, what)
    case 'instagram_positions': return subsetOf(value, INSTAGRAM_POSITIONS, `${what} (v26 removed explore)`)
    case 'threads_positions': return subsetOf(value, THREADS_POSITIONS, what)
    case 'audience_network_positions': return subsetOf(value, AUDIENCE_NETWORK_POSITIONS, what)
    case 'messenger_positions': return subsetOf(value, MESSENGER_POSITIONS, `${what} (v26 removed story)`)
    case 'whatsapp_positions': return subsetOf(value, WHATSAPP_POSITIONS, what)
    case 'user_age_unknown': case 'instream_video_skippable_excluded': return typeof value === 'boolean' ? null : `${what} is true or false`
    default:
      if ((OPTION_LISTS as readonly string[]).includes(key)) return optionListProblem(value, what, 1000)
      if ((CODE_LISTS as readonly string[]).includes(key)) return codeListProblem(key, value, what)
      return `targeting.${key} is not a key this change sets`
  }
}

/** The rules between placement keys (placement-targeting.md "Limitations"; v26 changelog), on the whole spec sent. */
export function placementWholeProblem(spec: Row): string | null {
  const list = (k: string): string[] => (Array.isArray(spec[k]) ? (spec[k] as unknown[]).filter((x): x is string => typeof x === 'string') : [])
  const platforms = list('publisher_platforms')
  if (platforms.length === 1 && platforms[0] === 'audience_network') return 'Meta does not take Audience Network alone (publisher_platforms)'
  // A platform with no positions of its own takes every position ("Facebook considers all default positions"), when it
  // is on (no publisher_platforms: every platform is).
  const on = (p: PublisherPlatform) => !platforms.length || platforms.includes(p)
  const effective = (p: PublisherPlatform): readonly string[] => (list(POSITIONS_OF[p].key).length ? list(POSITIONS_OF[p].key) : on(p) ? POSITIONS_OF[p].positions : [])
  const fbOwn = list('facebook_positions')
  const fb = effective('facebook')
  const ig = effective('instagram')
  if (fb.includes('story') && !fb.includes('feed') && !ig.includes('story')) return 'Facebook story needs Facebook feed or Instagram story too'
  if (fb.includes('notification') && !fb.includes('feed')) return 'Facebook notification needs Facebook feed too'
  // Review B6 — facts F1 M4-00: marketplace, search and profile_feed need Facebook feed too; a story is mobile only.
  const needFeed = fbOwn.filter((x) => x === 'marketplace' || x === 'search' || x === 'profile_feed')
  if (needFeed.length && !fb.includes('feed')) return `Facebook ${needFeed.join(', ')} need${needFeed.length === 1 ? 's' : ''} Facebook feed too`
  const devices = list('device_platforms')
  if (fbOwn.includes('story') && devices.length && !devices.includes('mobile')) return 'Facebook story is shown on mobile only: device_platforms includes mobile'
  if (fbOwn.length === 1 && (fbOwn[0] === 'story' || fbOwn[0] === 'notification')) return `Facebook ${fbOwn[0]} cannot be the only Facebook position`
  if (list('threads_positions').includes('threads_stream') && !ig.includes('stream')) return 'the Threads placement needs the Instagram stream (feed) placement too'
  if (list('threads_positions').length && platforms.length && !(platforms.includes('threads') && platforms.includes('instagram'))) return 'the Threads placement needs both instagram and threads in publisher_platforms'
  if (list('whatsapp_positions').includes('status') && !ig.includes('story')) return 'the WhatsApp status placement needs the Instagram story placement too'
  if (list('messenger_positions').includes('sponsored_messages')) {
    const others = ['facebook_positions', 'instagram_positions', 'threads_positions', 'audience_network_positions', 'whatsapp_positions'].some((k) => list(k).length)
    if (others || !(platforms.length === 1 && platforms[0] === 'messenger')) return 'Messenger sponsored messages go with no other placement (publisher_platforms messenger only)'
  }
  for (const platform of PUBLISHER_PLATFORMS) {
    if (list(POSITIONS_OF[platform].key).length && platforms.length && !platforms.includes(platform)) return `${POSITIONS_OF[platform].key} needs ${platform} in publisher_platforms`
  }
  return null
}

/** The rules between audience keys, on the whole spec sent (advantage-audience.md, basic-targeting.md). */
export function audienceWholeProblem(spec: Row): string | null {
  if (isInt(spec.age_min, 13, 65) && isInt(spec.age_max, 13, 65) && spec.age_max < spec.age_min) return 'age_max is at least age_min'
  const auto = plainObject(spec.targeting_automation) ? spec.targeting_automation : {}
  if (auto.advantage_audience === 1) {
    // advantage-audience.md: age_max fixed at 65 (absent or 65, as step 19's create judges it); age_min 18 to 25.
    if (spec.age_max !== undefined && spec.age_max !== 65) return 'with Advantage+ audience on, Meta fixes age_max at 65 (use age_range as a suggestion)'
    if (isInt(spec.age_min, 13, 65) && (spec.age_min > 25 || spec.age_min < 18)) return 'with Advantage+ audience on, Meta takes an age_min of 25 at most (18 to 25)'
  }
  if (spec.age_range !== undefined && auto.advantage_audience !== 1 && !(plainObject(auto.individual_setting) && auto.individual_setting.age === 1)) {
    return 'age_range is a suggestion for Advantage+ audience (or age suggestions): it goes with one of them on'
  }
  const geo = plainObject(spec.geo_locations) ? spec.geo_locations : {}
  const placed = Object.entries(geo).some(([k, v]) => k !== 'location_types' && Array.isArray(v) && v.length > 0)
  const audienced = ['custom_audiences', 'product_audience_specs', 'dynamic_audience_ids'].some((k) => Array.isArray(spec[k]) && (spec[k] as unknown[]).length > 0)
  if (!placed && !audienced) return 'targeting names a place (geo_locations) or a custom audience: Meta needs one of them'
  return null
}

/** A targeting value as the rule takes it before the live comparison: one JSON object, written once, every number exact. */
function targetingShape(value: string): Row | string {
  const parsed = canonicalJson(value)
  if (!plainObject(parsed)) return 'targeting is one JSON object in one spelling only (as Nexus writes it)'
  if (holdsInexactNumber(parsed)) return 'targeting holds a number Nexus cannot carry exactly'
  return parsed
}

const softOptOutProblem = (value: string): string | null => {
  const parsed = canonicalJson(value)
  if (!plainObject(parsed)) return 'placement_soft_opt_out is one JSON object in one spelling only'
  for (const [k, v] of Object.entries(parsed)) {
    if (!(SOFT_OPT_OUT_KEYS as readonly string[]).includes(k)) return `placement_soft_opt_out takes ${SOFT_OPT_OUT_KEYS.join(', ')} only`
    const platform = PUBLISHER_PLATFORMS.find((p) => POSITIONS_OF[p].key === k)!
    const p = subsetOf(v, POSITIONS_OF[platform].positions, `placement_soft_opt_out.${k}`)
    if (p) return p
  }
  return null
}

// ── ids inside a spec ───────────────────────────────────────────────────────────────────────────────────────────────

const idsIn = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => idText(plainObject(x) ? x.id : x)).filter((x): x is string => !!x) : [])
function audienceIdsOf(spec: Row): Set<string> {
  const out = new Set<string>([...idsIn(spec.custom_audiences), ...idsIn(spec.excluded_custom_audiences), ...idsIn(spec.dynamic_audience_ids), ...idsIn(spec.excluded_dynamic_audience_ids)])
  if (Array.isArray(spec.flexible_spec)) for (const g of spec.flexible_spec) if (plainObject(g)) for (const id of idsIn(g.custom_audiences)) out.add(id)
  if (plainObject(spec.exclusions)) for (const id of idsIn(spec.exclusions.custom_audiences)) out.add(id)
  return out
}
const productSetsOf = (spec: Row): Set<string> => new Set(['product_audience_specs', 'excluded_product_audience_specs']
  .flatMap((k) => (Array.isArray(spec[k]) ? (spec[k] as unknown[]).map((p) => idText(plainObject(p) ? p.product_set_id : null)) : []))
  .filter((x): x is string => !!x))

/**
 * Every object id the spec SENT names that the LIVE spec does not (the gateway's owner check takes each: a custom or
 * product audience of the chosen ad account, one of its place page sets, a product set of its own catalogs). An id the ad
 * set already holds is Meta's own state and is not read again.
 */
export function targetingAddedIds(live: Row, sent: Row): MetaWriteBodyId[] {
  const out: MetaWriteBodyId[] = []
  const had = audienceIdsOf(live)
  for (const id of audienceIdsOf(sent)) if (!had.has(id)) out.push({ id, kind: 'customaudience' })
  const pageSets = new Set(idsIn(live.place_page_set_ids))
  for (const id of idsIn(sent.place_page_set_ids)) if (!pageSets.has(id)) out.push({ id, kind: 'placepageset' })
  const sets = productSetsOf(live)
  for (const id of productSetsOf(sent)) if (!sets.has(id)) out.push({ id, kind: 'productset' })
  return out
}

// ── one view of a value (a change, its read-back and undo's "has it moved?" compare the same way) ──────────────────

const VIEW_DROP = new Set(['name', 'region', 'primary_city_id', 'market_type', 'deprecation_code', 'electoral_district', 'political_district'])
/** location_types that are Meta's only option (home AND recent: basic-targeting.md) — the same as none at all. */
export const isDefaultLocationTypes = (v: unknown): boolean => Array.isArray(v) && v.length === 2 && v.includes('home') && v.includes('recent')
/**
 * A top-level targeting value as Nexus compares it: names and the other labels Meta adds when it reads a spec back are
 * left out (Meta answers a city sent as {key, radius, distance_unit} with its name, region and country), ids as strings,
 * numbers as numbers, lists in one order, location_types left out ONLY when it is Meta's only option (home and recent,
 * 1870199) — `["home"]` alone is a real difference (review A3).
 */
export function targetingView(value: unknown, depth = 0): unknown {
  if (depth > 12) return null
  if (Array.isArray(value)) {
    const items = value.map((v) => targetingView(v, depth + 1))
    return items.map((v) => JSON.stringify(v)).sort().map((s) => JSON.parse(s) as unknown)
  }
  if (plainObject(value)) {
    const out: Row = {}
    for (const k of Object.keys(value).sort()) {
      if (VIEW_DROP.has(k) || (k === 'location_types' && isDefaultLocationTypes(value[k]))) continue
      // A location's own country / region id: kept only where it identifies the item (a multi-city custom location).
      if ((k === 'country' || k === 'region_id') && value.key !== undefined) continue
      const v = value[k]
      out[k] = k === 'id' || k === 'key' || k === 'product_set_id' ? (isIdValue(v) ? String(v) : v)
        : k === 'radius' || k === 'retention_seconds' || k === 'min_retention_seconds' ? (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : v)
          : k === 'rule' && typeof v === 'string' ? (() => { try { return targetingView(JSON.parse(v), depth + 1) } catch { return v } })()
            : targetingView(v, depth + 1)
    }
    return out
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 99_999) return String(value)
  return value
}
/** Two top-level targeting values are the same for Nexus (targetingView). */
export const sameTargeting = (a: unknown, b: unknown): boolean => sameJson(targetingView(a ?? null), targetingView(b ?? null))

const round4 = (n: unknown): unknown => (typeof n === 'number' ? Math.round(n * 1e4) / 1e4 : typeof n === 'string' && /^-?\d+(\.\d+)?$/.test(n) ? Math.round(Number(n) * 1e4) / 1e4 : n)
/** One location item read back as sent: each field Nexus sent reads back equal; what Meta adds does not count. */
function geoItemReadsBack(sent: unknown, got: unknown): boolean {
  if (!plainObject(sent)) return sent === got
  if (!plainObject(got)) return false
  return Object.entries(sent).every(([f, v]) => {
    if (VIEW_DROP.has(f)) return true
    const w = got[f]
    if (f === 'latitude' || f === 'longitude' || f === 'radius') return round4(v) === round4(w)
    if (f === 'key' || f === 'region_id' || f === 'primary_city_id') return String(v) === String(w)
    return sameJson(v, w)
  })
}
/**
 * Review B2 — a location spec reads back as sent when every list sent reads back with the same places (no more, no less)
 * and each field Nexus sent of a place reads back equal (latitude / longitude to 4 decimals, a radius as a number). Fields
 * Meta adds (country, region_id, primary_city_id, a place's latitude / longitude, names) do not count as moved; location
 * types count only when one side is not Meta's only option.
 */
export function geoReadsBackAsSent(sent: unknown, got: unknown): boolean {
  const s = plainObject(sent) ? sent : {}
  const g = plainObject(got) ? got : {}
  for (const k of new Set([...Object.keys(s), ...Object.keys(g)])) {
    if (k === 'location_types') {
      const plain = (v: unknown) => v === undefined || isDefaultLocationTypes(v)
      if (!(plain(s[k]) && plain(g[k])) && !sameJson(targetingView(s[k] ?? null), targetingView(g[k] ?? null))) return false
      continue
    }
    const sl = Array.isArray(s[k]) ? s[k] as unknown[] : []
    const left = Array.isArray(g[k]) ? [...g[k] as unknown[]] : []
    if (sl.length !== left.length) return false
    for (const item of sl) {
      const at = left.findIndex((x) => geoItemReadsBack(item, x))
      if (at < 0) return false
      left.splice(at, 1)
    }
  }
  return true
}

// ── the account controls (TG-100 / TG-101) ───────────────────────────────────────────────────────────────────────────

/**
 * Review B1 — how Meta READS a placement exclusion back: ad-account-business-constraints shows `platform_position` strings
 * in lower case (`facebook_rhc` = FACEBOOK_RIGHT_HAND_COLUMN) where the POST documents the upper-case enum. The ONE
 * normaliser (read → enum), used by the draft and its read-back judge. A value Meta reads back that it documents nowhere
 * (FACEBOOK_BIZ_DISCO_FEED, MESSENGER_STORY) is kept as Meta holds it: posted back exactly, never added by Nexus.
 */
const READ_EXCLUSION: Readonly<Record<string, typeof ACCOUNT_PLACEMENT_EXCLUSIONS[number]>> = {
  audience_network_classic: 'AUDIENCE_NETWORK_CLASSIC', audience_network_rewarded_video: 'AUDIENCE_NETWORK_REWARDED_VIDEO',
  audience_network_instream_video: 'AUDIENCE_NETWORK_INSTREAM_VIDEO', facebook_marketplace: 'FACEBOOK_MARKETPLACE', facebook_rhc: 'FACEBOOK_RIGHT_HAND_COLUMN',
  facebook_right_hand_column: 'FACEBOOK_RIGHT_HAND_COLUMN',
}
export const KEPT_PLACEMENT_EXCLUSIONS = ['FACEBOOK_BIZ_DISCO_FEED', 'MESSENGER_STORY', 'facebook_biz_disco_feed', 'messenger_story'] as const
/** A placement exclusion as Nexus sends and compares it: the documented enum, else Meta's own spelling. */
export const placementExclusionOf = (v: string): string => ((ACCOUNT_PLACEMENT_EXCLUSIONS as readonly string[]).includes(v) ? v : READ_EXCLUSION[v] ?? v)
/** A value Meta holds that is neither documented nor a known read-back extra: Nexus cannot post the controls back. */
export const unknownPlacementExclusion = (v: string): boolean => !(ACCOUNT_PLACEMENT_EXCLUSIONS as readonly string[]).includes(placementExclusionOf(v)) && !(KEPT_PLACEMENT_EXCLUSIONS as readonly string[]).includes(v)

/**
 * audience_controls as Nexus sends it: age_min, geo_locations, excluded_geo_locations, exclusions (employers only), and
 * is_gender_exclusion_enabled only as Meta holds it (read back by Meta, documented nowhere: review B1).
 */
export function audienceControlsProblem(value: unknown): string | null {
  if (!plainObject(value) || !Object.keys(value).length) return 'Meta requires audience_controls (an object with age_min, geo_locations, excluded_geo_locations or exclusions)'
  for (const [k, v] of Object.entries(value)) {
    if (k === 'is_gender_exclusion_enabled') { if (typeof v !== 'boolean') return 'audience_controls.is_gender_exclusion_enabled is true or false (as Meta holds it)'; continue }
    if (k === 'age_min') { if (!isInt(v, 13, 65)) return 'audience_controls.age_min is 13 to 65'; continue }
    if (k === 'geo_locations' || k === 'excluded_geo_locations') {
      // Re-review 3 — never an empty location object (a control with no place is left out).
      if (plainObject(v) && !Object.keys(v).length) return `audience_controls.${k} names at least one place (leave it out instead of {})`
      const p = geoSpecProblem(v, `audience_controls.${k}`, k === 'excluded_geo_locations')
      if (p) return p
      continue
    }
    if (k === 'exclusions') {
      // 1870219: only employer exclusions are saved in account controls.
      if (!plainObject(v) || Object.keys(v).some((x) => x !== 'work_employers')) return 'audience_controls.exclusions holds employers only (work_employers: Meta refuses any other, 1870219)'
      if (v.work_employers !== undefined) { const p = optionListProblem(v.work_employers, 'audience_controls.exclusions.work_employers', 500); if (p) return p }
      continue
    }
    return `audience_controls takes age_min, geo_locations, excluded_geo_locations and exclusions only (not ${k})`
  }
  return null
}

export function placementControlsProblem(value: unknown): string | null {
  if (!plainObject(value)) return 'placement_controls is an object'
  for (const [k, v] of Object.entries(value)) {
    if (k === 'placement_exclusions') {
      const allowed = [...ACCOUNT_PLACEMENT_EXCLUSIONS, ...KEPT_PLACEMENT_EXCLUSIONS]
      if (!Array.isArray(v) || v.length > allowed.length || !v.every((x) => allowed.includes(x)) || !unique(v)) return `placement_controls.placement_exclusions lists ${ACCOUNT_PLACEMENT_EXCLUSIONS.join(', ')} (and only as Meta holds them: ${KEPT_PLACEMENT_EXCLUSIONS.slice(0, 2).join(', ')}), each once`
      continue
    }
    if (k === 'campaign_ids_to_set_ap') { if (!Array.isArray(v) || v.length > 50 || !v.every((x) => typeof x === 'string' && DIGITS.test(x)) || !unique(v)) return 'placement_controls.campaign_ids_to_set_ap lists campaign ids (digits, as strings), each once'; continue }
    return `placement_controls takes placement_exclusions and campaign_ids_to_set_ap only (not ${k})`
  }
  return null
}

// ── the rules ───────────────────────────────────────────────────────────────────────────────────────────────────────

const AUDIENCE_SET: ReadonlySet<string> = new Set(AUDIENCE_TARGETING_KEYS)
const PLACEMENT_SET: ReadonlySet<string> = new Set(PLACEMENT_TARGETING_KEYS)
const judgedTargeting = (whole: (spec: Row) => string | null) => (params: Params): string | null => {
  for (const key of params.keys()) {
    if (key === 'placement_soft_opt_out') { const p = softOptOutProblem(params.get(key)!); if (p) return p; continue }
    if (key !== 'targeting') return `${key} is not a key of this change`
  }
  const spec = targetingShape(params.get('targeting') ?? '')
  return typeof spec === 'string' ? spec : whole(spec)
}
const oneOf = (values: readonly string[], what: string) => (value: string) => (values.includes(value) ? null : `${what} is one of ${values.join(', ')}`)
const jsonJudge = (judge: (v: unknown) => string | null, what: string) => (value: string): string | null => {
  const parsed = canonicalJson(value)
  return parsed === undefined ? `${what} is JSON in one spelling only (as Nexus writes it)` : judge(parsed)
}
const keysJudged = (judges: Record<string, (value: string) => string | null>, also?: (params: Params) => string | null) => (params: Params): string | null => {
  for (const [key, value] of params) {
    const judge = judges[key]
    if (!judge) return `${key} is not a key of this change`
    const problem = judge(value)
    if (problem) return problem
  }
  return also ? also(params) : null
}
const placePageSetJudges = {
  name: (v: string) => (v.trim() === v && v.length >= 1 && [...v].length <= 200 ? null : 'a place page set\'s name is 1 to 200 characters, with no space at either end'),
  parent_page: (v: string) => (DIGITS.test(v) ? null : 'parent_page is the Page id (digits)'),
  location_types: jsonJudge((v) => subsetOf(v, ['home', 'recent'], 'location_types'), 'location_types'),
  targeted_area_type: oneOf(['CUSTOM_RADIUS', 'MARKETING_AREA', 'NONE'], 'targeted_area_type'),
}

/** Step 20 — set-meta-targeting, set-meta-placements and set-meta-account-controls on the write allow-list. */
export const META_TARGETING_WRITE_RULES: readonly MetaWriteRule[] = [
  {
    // TG-040–075, TG-078: POST /{ad_set_id} targeting=<the whole spec>, named an ad set's AUDIENCE (its own kind: step 39's
    // brand-safety rule and the placements rule below each have theirs). The gateway compares the rest with the live spec.
    name: 'adset.targeting',
    method: 'POST',
    path: /^\d{1,20}$/,
    kinds: ['adsetaudience'],
    required: ['targeting'],
    optional: [],
    text: { targeting: TARGETING_TEXT },
    maxBody: MAX_TARGETING_BODY,
    values: judgedTargeting(audienceWholeProblem),
    budget: false,
    targeting: AUDIENCE_SET,
    targetingJudge: targetingValueProblem,
    targetingIds: targetingAddedIds,
  },
  {
    // TG-077, TG-080–088, TG-090: the placement keys of the whole spec, and the limited spend on excluded placements.
    name: 'adset.placements',
    method: 'POST',
    path: /^\d{1,20}$/,
    kinds: ['adsetplacement'],
    required: ['targeting'],
    optional: ['placement_soft_opt_out'],
    text: { targeting: TARGETING_TEXT },
    maxBody: MAX_TARGETING_BODY,
    values: judgedTargeting(placementWholeProblem),
    budget: false,
    targeting: PLACEMENT_SET,
    targetingJudge: targetingValueProblem,
  },
  {
    // TG-088 alone: the ad set's limited spend on excluded placements (a top-level ad set field; no targeting sent).
    name: 'adset.placementSoftOptOut',
    method: 'POST',
    path: /^\d{1,20}$/,
    kinds: ['adset'],
    required: ['placement_soft_opt_out'],
    optional: [],
    values: keysJudged({ placement_soft_opt_out: softOptOutProblem }),
    budget: false,
  },
  {
    // TG-075: Meta makes the ad set's targeting fit a special ad category at once (it removes and changes options itself).
    name: 'adset.tuneForCategory',
    method: 'POST',
    path: /^\d{1,20}$/,
    kinds: ['adset'],
    required: ['tune_for_category'],
    optional: [],
    values: keysJudged({ tune_for_category: oneOf(TUNE_CATEGORIES, 'tune_for_category (never CREDIT — replaced — nor political ads)') }),
    budget: false,
  },
  {
    // TG-100 / TG-101: the ad account's controls, sent WHOLE (Meta has no update or delete: a POST replaces them).
    name: 'adaccount.accountControls',
    method: 'POST',
    path: /^act_\d{1,25}\/account_controls$/,
    kinds: ['adaccount'],
    required: ['audience_controls'],
    optional: ['placement_controls'],
    text: { audience_controls: TARGETING_TEXT },
    maxBody: 60_000,
    values: keysJudged({ audience_controls: jsonJudge(audienceControlsProblem, 'audience_controls'), placement_controls: jsonJudge(placementControlsProblem, 'placement_controls') }),
    budget: false,
    ids: (params) => {
      const controls = canonicalJson(params.get('placement_controls') ?? '')
      const list = plainObject(controls) && Array.isArray(controls.campaign_ids_to_set_ap) ? controls.campaign_ids_to_set_ap : []
      return list.filter((x): x is string => typeof x === 'string' && DIGITS.test(x)).map((id) => ({ id, kind: 'campaign' as const }))
    },
  },
  {
    // TG-018: a place page set of the chosen Page (parent_page: the gateway's Page check).
    name: 'adaccount.placePageSet',
    method: 'POST',
    path: /^act_\d{1,25}\/ad_place_page_sets$/,
    kinds: ['adaccount'],
    // A create on an edge of the ad account: it edits no object (step 23's rule), so no 30-s gap of the account holds it.
    edgeCall: true,
    required: ['name', 'parent_page'],
    optional: ['location_types', 'targeted_area_type'],
    text: { name: META_NAME_TEXT },
    values: keysJudged(placePageSetJudges),
    budget: false,
    ids: (params) => (DIGITS.test(params.get('parent_page') ?? '') ? [{ id: params.get('parent_page')!, kind: 'page' }] : []),
  },
  {
    // TG-019 (SDK only): the same, made by Meta in the background.
    name: 'adaccount.placePageSetAsync',
    method: 'POST',
    path: /^act_\d{1,25}\/ad_place_page_sets_async$/,
    kinds: ['adaccount'],
    edgeCall: true,
    required: ['name', 'parent_page'],
    optional: ['location_types', 'targeted_area_type'],
    text: { name: META_NAME_TEXT },
    values: keysJudged(placePageSetJudges),
    budget: false,
    ids: (params) => (DIGITS.test(params.get('parent_page') ?? '') ? [{ id: params.get('parent_page')!, kind: 'page' }] : []),
  },
]
