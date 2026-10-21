/**
 * Meta step 20 — set-meta-targeting as a draft. Pure: the request and the live state (live-targeting-change.ts) in, the
 * draft (or a refusal in words) out. An ad set's targeting goes WHOLE (Q7, targeting-merge.ts): each request sends the live
 * spec with only the keys this change sets, and the gateway reads the live spec again itself and refuses anything else
 * (gateway/meta-targeting-rules.ts, meta-brand-safety-owner.ts). Master rows (facts F1 M4-00, M4-16, M4-19, M4-22):
 *   TG-040–048  locations to add or remove: countries, country groups, regions, cities (+ radius), postcodes, places, a pin or
 *               an address with a radius, TV markets, electoral districts, and Meta's other area lists (TG-048, SDK only)
 *   TG-049      location_types: NO choice — "['home', 'recent'] is the only option" (RECHECK CORRECTED); Meta's error
 *               1870199 asks to remove the field, so Nexus drops it from every location spec it writes
 *   TG-050      locations to exclude · TG-051 ages · TG-052 genders · TG-053 languages
 *   TG-054/055  detailed targeting: groups AND, options OR inside (≤ 25 groups); TG-066 broad categories inside them
 *   TG-056      detailed EXCLUSIONS: Meta refuses new ones since v22 unless the account's own controls exclude them, and the
 *               account takes employers only (1870219): Nexus excludes employers only (the preview names the ones the
 *               account's controls do not hold); any other exclusion is a custom audience to exclude (TG-058)
 *   TG-057/058  custom audiences in / out (each the chosen account's: the gateway checks every id the change adds)
 *   TG-059–064  Advantage+ audience (sent EXPLICITLY on every targeting change: off unless asked), its age suggestion,
 *               Advantage detailed targeting, Advantage lookalike / custom audience, age / gender / city suggestions,
 *               creative-audience pairing
 *   TG-068/069  exclude people reached since a date; product audiences in / out, dynamic audiences in / out
 *   TG-071–074  devices, operating systems, phones in / out, Wi-Fi only · TG-078 keywords, contextual categories, site
 *               categories · TG-018 place page sets in the targeting (and made: placePageSetDraft) · TG-075 re-tune for a
 *               special ad category (Meta changes the targeting itself; undo puts the old spec back)
 *   Not sent (the tool says why): TG-065 prospecting_audience / alternate_auto_targeting_option / shared_audiences /
 *   value_expression (one line or no page: kept as Meta has them), TG-067 engagement_specs (shape on no page: use an
 *   engagement custom audience), TG-070 connections (error 1870088 "Connection targeting is being deprecated"), TG-091
 *   subscriber_universe (read-only, placement-targeting.md) and is_whatsapp_destination_ad (one line, no use documented).
 *
 * Spending (plan rule): anything that can reach more people — a place added, a radius widened, an exclusion removed, a wider
 * age, more genders or languages, a detailed group loosened, an audience restriction loosened, an Advantage+ switch on,
 * more devices or systems, Wi-Fi only off, a re-tune — on an ad set that is ON is SPENDS MONEY (raisesSpend; the line says
 * when its campaign is off, so nothing spends yet). Narrower is safe. Every targeting change sends the ad set's ads back to
 * Meta's review (best-practices.md). EU (facts F1 X7): a spec that may newly reach the EU needs the DSA payer and
 * beneficiary — on the ad set, or the account's saved defaults Meta fills in; with neither it is refused. Under-18s in the
 * EU, EEA and Switzerland: refused. Special ad categories (M4-22): what Meta refuses with 2909035 is refused in words.
 */
import { changeLines, plural, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import { mergeTargeting } from './targeting-merge.js'
import {
  AUDIENCE_TARGETING_KEYS, CODE_LISTS, COUNTRY_GROUPS, GEO_KEYED_LISTS, MAX_RETENTION_DAYS, OPTION_LISTS, PRODUCT_EVENTS, TUNE_CATEGORIES,
  audienceWholeProblem, geoReadsBackAsSent, idText, isDefaultLocationTypes, sameTargeting, targetingAddedIds, targetingValueProblem, targetingView,
} from '../../gateway/meta-targeting-rules.js'
import { isReadOnlyTargetingKey, MAX_TARGETING_BODY, sameJson } from '../../gateway/meta-brand-safety-rules.js'
import { DSA_COUNTRIES, NO_YOUTH_COUNTRIES, type DsaDefaults } from './live-create.js'
import type { TargetingAdSetState } from './live-targeting-change.js'

type Row = Record<string, unknown>
const plainObject = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const uniq = <T>(items: T[]): T[] => [...new Set(items)]

// ── shared with set-meta-placements and set-meta-account-controls ─────────────────────────────────────────────────

export const adSetWho = (s: Pick<TargetingAdSetState, 'id' | 'name'>) => `ad set "${s.name ?? 'no name'}" (${s.id})`
export const REVIEW_SENTENCE = 'Meta sends every ad of a changed ad set back to its review after a targeting change (an ad that is paused stays paused); an ad under review may not deliver for a while.'
export const WHOLE_SENTENCE = 'Each ad set\'s whole targeting is sent (Meta takes it only whole): every other part of it goes back exactly as Meta has it now, and Nexus\'s gateway reads it again itself and sends nothing if anything else would change.'

const short = (v: unknown, max = 160): string => { const t = JSON.stringify(v) ?? 'none'; return t.length > max ? `${t.slice(0, max - 1)}…` : t }

/** A location spec in words: each list with its count and first few. */
export function geoWords(geo: unknown): string {
  if (!plainObject(geo)) return 'none'
  const parts: string[] = []
  for (const [k, v] of Object.entries(geo)) {
    if (k === 'location_types' || !Array.isArray(v) || !v.length) continue
    const names = v.slice(0, 4).map((x) => (typeof x === 'string' ? x : plainObject(x) ? String(x.name ?? x.key ?? x.address_string ?? `${x.latitude},${x.longitude}`) + (x.radius !== undefined ? ` +${x.radius} ${x.distance_unit ?? 'mile'}` : '') : '?'))
    parts.push(`${k.replace(/_/g, ' ')} ${names.join(', ')}${v.length > 4 ? ` (+${v.length - 4})` : ''}`)
  }
  return parts.length ? parts.join('; ') : 'none'
}

/** One targeting value in words, for the from → to lines. */
export function valueWords(key: string, value: unknown): string {
  if (value === undefined || value === null) {
    return key === 'age_min' ? 'not set (Meta: 18)' : key === 'age_max' ? 'not set (Meta: 65+)' : key === 'genders' ? 'not set (everyone)' : 'not set'
  }
  if (key === 'geo_locations' || key === 'excluded_geo_locations') return geoWords(value)
  if (key === 'genders') return sameJson([...(value as number[])].sort(), [1, 2]) ? 'everyone' : (value as number[])[0] === 1 ? 'men' : 'women'
  if (Array.isArray(value) && value.every((x) => typeof x === 'string' || typeof x === 'number')) return value.length ? `${value.slice(0, 10).join(', ')}${value.length > 10 ? ` (+${value.length - 10})` : ''}` : 'none'
  if (Array.isArray(value) && value.every((x) => plainObject(x) && (x.id !== undefined))) return `${value.slice(0, 8).map((x) => String((x as Row).name ?? (x as Row).id)).join(', ')}${value.length > 8 ? ` (+${value.length - 8})` : ''}`
  return typeof value === 'object' ? short(value) : String(value)
}

/** Review B5 — placements Meta removed (v26 changelog: Instagram Explore feed, Messenger Stories; messenger_home earlier). */
export function retiredPlacements(t: Row): string[] {
  const has = (k: string, v: string) => list(t[k]).includes(v)
  return [
    ...(has('instagram_positions', 'explore') ? ['instagram explore'] : []),
    ...(has('messenger_positions', 'story') ? ['messenger story'] : []),
    ...(has('messenger_positions', 'messenger_home') ? ['messenger messenger_home'] : []),
  ]
}

/** The read-back judge of a targeting change: each key it set reads back the same (names Meta adds aside). */
export function targetingJudge(set: Readonly<Record<string, unknown>>, skip: ReadonlySet<string> = new Set(), extra?: { softOptOut?: Row | null }) {
  const DEFAULTS: Readonly<Record<string, unknown>> = { age_min: 18, age_max: 65 }
  return (node: Record<string, unknown>) => {
    const got = plainObject(node.targeting) ? node.targeting : {}
    const moved: string[] = []
    const reads: string[] = []
    for (const [key, sent] of Object.entries(set)) {
      if (skip.has(key)) continue
      const now = got[key]
      reads.push(`${key} ${valueWords(key, now ?? null)}`)
      if (sent === null) {
        // Removed: Meta reads back nothing, an empty list, or its own default (18, 65, everyone).
        const gone = now === undefined || now === null || (Array.isArray(now) && !now.length) || (key in DEFAULTS && now === DEFAULTS[key]) || (key === 'genders' && sameJson(targetingView(now), [1, 2]))
        if (!gone) moved.push(key)
        continue
      }
      // Review B2 — a location spec reads back as a superset of what was sent (Meta adds countries, ids, coordinates).
      if (key === 'geo_locations' || key === 'excluded_geo_locations') {
        if (!geoReadsBackAsSent(sent, now ?? null)) moved.push(key)
        continue
      }
      if (key === 'targeting_automation' && plainObject(sent)) {
        // Only the switches Nexus set: Meta may add its own (individual_setting defaults).
        const nowAuto = plainObject(now) ? now : {}
        if (Object.entries(sent).some(([k, v]) => !sameTargeting(nowAuto[k] ?? null, v))) moved.push(key)
        continue
      }
      if (!sameTargeting(now ?? null, sent)) moved.push(key)
    }
    if (extra && 'softOptOut' in extra) {
      const now = plainObject(node.placement_soft_opt_out) ? node.placement_soft_opt_out : null
      reads.push(`placement_soft_opt_out ${short(now)}`)
      if (node.placement_soft_opt_out !== undefined && !sameTargeting(now ?? null, extra.softOptOut ?? null) && !(extra.softOptOut === null && now && !Object.values(now).some((v) => Array.isArray(v) && v.length))) moved.push('placement_soft_opt_out')
    }
    return { moved, reads: reads.join(', ') || 'as before' }
  }
}

/** The spend sentence of an ad set's widening: SPENDS MONEY when it is on (said when its campaign is off), else a warning. */
export function spendOf(state: TargetingAdSetState, parts: string[]): { spends: string | null; warning: string | null; raises: boolean } {
  if (!parts.length) return { spends: null, warning: null, raises: false }
  const who = adSetWho(state)
  const what = parts.join('; ')
  if (state.status === 'ACTIVE') {
    const c = state.campaign
    return {
      raises: true, warning: null,
      spends: c?.status === 'ACTIVE'
        ? `${who} is on: ${what} — it can reach more people and spend more from now.`
        : `${who}: ${what} — nothing spends yet, its campaign "${c?.name ?? 'no name'}" (${c?.id ?? '?'}) is not on; it spends once that is switched on.`,
    }
  }
  return { spends: null, raises: false, warning: `${who} is not on: ${what} widens who its ads can reach once it is switched on (switching it on is SPENDS MONEY then).` }
}

// ── locations ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type DistanceUnit = 'kilometer' | 'mile'
export interface RadiusPlace { key: string; radius?: number; unit?: DistanceUnit }
/** A pin or an address (review A1: no label of the caller's — never a name, a country or a region). */
export interface CustomPlace { latitude?: number; longitude?: number; address?: string; radius?: number; unit?: DistanceUnit; key?: string }
/** Places named by Meta's keys (meta-targeting-search kind location; the area lists are SDK only, TG-048). */
export interface LocationAsk {
  countries?: string[]; countryGroups?: string[]; regions?: string[]; zips?: string[]; geoMarkets?: string[]; electoralDistricts?: string[]
  cities?: RadiusPlace[]; places?: RadiusPlace[]; customLocations?: CustomPlace[]
  largeGeoAreas?: string[]; mediumGeoAreas?: string[]; smallGeoAreas?: string[]; metroAreas?: string[]; subcities?: string[]; neighborhoods?: string[]
  subneighborhoods?: string[]; politicalDistricts?: string[]
}
export interface LocationChange { add?: LocationAsk; remove?: LocationAsk }

/** Each LocationAsk list and the Meta list it writes. */
export const LOCATION_ARGS: ReadonlyArray<[keyof LocationAsk, string]> = [
  ['countries', 'countries'], ['countryGroups', 'country_groups'], ['regions', 'regions'], ['zips', 'zips'], ['geoMarkets', 'geo_markets'],
  ['electoralDistricts', 'electoral_districts'], ['cities', 'cities'], ['places', 'places'], ['customLocations', 'custom_locations'],
  ['largeGeoAreas', 'large_geo_areas'], ['mediumGeoAreas', 'medium_geo_areas'], ['smallGeoAreas', 'small_geo_areas'], ['metroAreas', 'metro_areas'],
  ['subcities', 'subcities'], ['neighborhoods', 'neighborhoods'], ['subneighborhoods', 'subneighborhoods'], ['politicalDistricts', 'political_districts'],
]
const KEY_FORMAT: Readonly<Record<string, [RegExp, string]>> = {
  regions: [/^\d{1,20}$/, 'a region is its key (digits, meta-targeting-search kind location)'],
  cities: [/^\d{1,20}$/, 'a city is its key (digits)'],
  places: [/^\d{1,20}$/, 'a place is its key (digits)'],
  zips: [/^[A-Z]{2}:[A-Za-z0-9 -]{1,12}$/, 'a postcode is COUNTRY:CODE (IT:20121)'],
  geo_markets: [/^COMSCORE_MARKET:\d{1,6}$/, 'a TV market is COMSCORE_MARKET:<number> (US only)'],
  electoral_districts: [/^[A-Z]{2}:[A-Za-z0-9]{1,12}$/, 'an electoral district is COUNTRY:CODE (US only)'],
}
const AREA_FORMAT: [RegExp, string] = [/^\d{1,20}$/, 'an area is its key (digits)']

/** Kilometres of a radius in either unit. */
const km = (radius: number, unit: unknown) => (unit === 'kilometer' ? radius : radius * 1.609344)
/** The identity of one location item in its list (a radius aside). */
export function geoIdentity(listKey: string, item: unknown): string | null {
  if (typeof item === 'string') return item
  if (!plainObject(item)) return null
  if (listKey === 'custom_locations') {
    if (typeof item.latitude === 'number' && typeof item.longitude === 'number') return `${item.latitude.toFixed(5)},${item.longitude.toFixed(5)}`
    if (typeof item.address_string === 'string') return `address:${item.address_string.toLowerCase()}`
    if (item.custom_type === 'multi_city') return `multi_city:${String(item.country ?? item.country_group ?? '')}:${String(item.min_population ?? '')}:${String(item.max_population ?? '')}`
    return item.key !== undefined ? String(item.key) : null
  }
  return item.key !== undefined ? String(item.key) : null
}
const radiusKm = (item: unknown): number | null => (plainObject(item) && item.radius !== undefined ? km(Number(item.radius), item.distance_unit ?? 'mile') : null)

/** Each place a location spec reaches, by list and identity, with its radius in km (null: none). */
function geoItems(geo: unknown): Map<string, number | null> {
  const out = new Map<string, number | null>()
  if (!plainObject(geo)) return out
  for (const [k, v] of Object.entries(geo)) {
    if (k === 'location_types' || !Array.isArray(v)) continue
    for (const item of v) { const id = geoIdentity(k, item); if (id !== null) out.set(`${k}:${id}`, radiusKm(item)) }
  }
  return out
}

/** What a location change newly reaches (included) or no longer excludes (excluded), in words. */
export function geoWider(before: unknown, after: unknown, excluded: boolean): string[] {
  const b = geoItems(before)
  const a = geoItems(after)
  const [from, to] = excluded ? [a, b] : [b, a]
  const more: string[] = []
  for (const [id, r] of to) {
    if (!from.has(id)) more.push(id.replace(':', ' '))
    else if (r !== null && (from.get(id) ?? 0) < r - 1e-6) more.push(`${id.replace(':', ' ')} (larger radius)`)
  }
  if (!more.length) return []
  return [`${excluded ? 'no longer excludes' : 'adds'} ${more.slice(0, 6).join(', ')}${more.length > 6 ? ` (+${more.length - 6})` : ''}`]
}

function newGeoItem(listKey: string, raw: unknown): { item: unknown } | { problem: string } {
  if (listKey === 'countries') return typeof raw === 'string' && /^[A-Z]{2}$/.test(raw) ? { item: raw } : { problem: `"${String(raw)}" is not a country code (two capitals: IT, DE)` }
  if (listKey === 'country_groups') return (COUNTRY_GROUPS as readonly unknown[]).includes(raw) ? { item: raw } : { problem: `"${String(raw)}" is not one of Meta's country groups (${COUNTRY_GROUPS.join(', ')})` }
  if (listKey === 'custom_locations') {
    const c = raw as CustomPlace
    const unit = c.unit ?? 'kilometer'
    const radius = c.radius
    const pin = typeof c.latitude === 'number' && typeof c.longitude === 'number'
    if (!pin && !c.address) return { problem: 'a pin needs latitude and longitude, or an address (a street address: Meta takes no PO box alone)' }
    if (typeof radius !== 'number') return { problem: 'a pin or an address needs its radius' }
    if (unit === 'kilometer' ? radius < 1 || radius > 80 : radius < 0.63 || radius > 50) return { problem: `a pin's radius is 1–80 km or 0.63–50 mi (Meta), not ${radius} ${unit}` }
    return { item: { ...(pin ? { latitude: c.latitude, longitude: c.longitude } : { address_string: c.address }), radius, distance_unit: unit } }
  }
  const r = (typeof raw === 'string' ? { key: raw } : raw) as RadiusPlace
  const [pattern, words] = KEY_FORMAT[listKey] ?? AREA_FORMAT
  if (typeof r?.key !== 'string' || !pattern.test(r.key)) return { problem: `${words}: "${String(r?.key)}" is not` }
  if (listKey === 'cities' || listKey === 'places') {
    if (r.radius === undefined) return { item: { key: r.key } }
    const unit = r.unit ?? 'kilometer'
    // basic-targeting.md: a city's radius 10–50 mi or 17–80 km; a place's the same range as a pin (1–80 km).
    const [min, max] = listKey === 'cities' ? (unit === 'kilometer' ? [17, 80] : [10, 50]) : (unit === 'kilometer' ? [1, 80] : [0.63, 50])
    if (r.radius < min || r.radius > max) return { problem: `a ${listKey === 'cities' ? 'city' : 'place'}'s radius is ${min}–${max} ${unit === 'kilometer' ? 'km' : 'mi'} (Meta), not ${r.radius}` }
    // Review B6 — a city's radius is a whole number (SDK targetinggeolocationcity.py: unsigned int).
    if (listKey === 'cities' && !Number.isInteger(r.radius)) return { problem: `a city's radius is a whole number of ${unit === 'kilometer' ? 'km' : 'mi'}, not ${r.radius}` }
    return { item: { key: r.key, radius: r.radius, distance_unit: unit } }
  }
  return { item: { key: r.key } }
}

/**
 * The location spec after a change: the live one (location_types dropped: 1870199 — locationTypesDropped says whether that
 * widens), named places removed (each must be there), named places added (a city or place already there takes the new
 * radius). Empty lists are left out.
 */
export function applyLocations(live: unknown, change: LocationChange, what: string): { geo: Row; problems: string[]; notes: string[] } {
  const geo: Row = {}
  if (plainObject(live)) for (const [k, v] of Object.entries(live)) if (k !== 'location_types' && Array.isArray(v)) geo[k] = [...v]
  const problems: string[] = []
  const notes: string[] = []
  for (const [arg, listKey] of LOCATION_ARGS) {
    for (const raw of (change.remove?.[arg] ?? []) as unknown[]) {
      const id = listKey === 'custom_locations'
        ? geoIdentity(listKey, { ...(raw as CustomPlace).key ? { key: (raw as CustomPlace).key } : {}, ...(typeof (raw as CustomPlace).latitude === 'number' ? { latitude: (raw as CustomPlace).latitude, longitude: (raw as CustomPlace).longitude } : {}), ...((raw as CustomPlace).address ? { address_string: (raw as CustomPlace).address } : {}) })
        : typeof raw === 'string' ? raw : (raw as RadiusPlace)?.key ?? null
      const items = list(geo[listKey])
      const at = items.findIndex((x) => geoIdentity(listKey, x) === id)
      if (id === null || at < 0) { problems.push(`${what} holds no ${listKey.replace(/_/g, ' ')} ${String(id ?? '?')} to remove`); continue }
      geo[listKey] = items.filter((_, i) => i !== at)
    }
    for (const raw of (change.add?.[arg] ?? []) as unknown[]) {
      const made = newGeoItem(listKey, raw)
      if ('problem' in made) { problems.push(`${what}: ${made.problem}`); continue }
      const id = geoIdentity(listKey, made.item)
      const items = list(geo[listKey])
      const at = items.findIndex((x) => geoIdentity(listKey, x) === id)
      if (at < 0) { geo[listKey] = [...items, made.item]; continue }
      if (plainObject(made.item) && made.item.radius !== undefined && !sameJson(radiusKm(items[at]), radiusKm(made.item))) {
        geo[listKey] = items.map((x, i) => (i === at ? { ...(x as Row), radius: (made.item as Row).radius, distance_unit: (made.item as Row).distance_unit } : x))
        continue
      }
      notes.push(`${what} already holds ${listKey.replace(/_/g, ' ')} ${id}.`)
    }
  }
  for (const k of Object.keys(geo)) if (!list(geo[k]).length) delete geo[k]
  return { geo, problems, notes }
}

/** Groups of countries that hold no EU country (every other group may reach the EU). */
const NON_EU_GROUPS = new Set(['africa', 'afta', 'apec', 'asia', 'caribbean', 'central_america', 'cisfta', 'gcc', 'mercosur', 'nafta', 'north_america', 'oceania', 'south_america'])
/**
 * May a location spec reach these countries (the EU for DSA, the EU + EEA + CH for under-18s)? A country, a group that may
 * hold one, a postcode's country prefix (its key), a place whose country META answered for it in the LIVE spec (`facts`:
 * the ad set's own read — review A1: a label on an item a caller wrote is never taken); a place Nexus cannot place (a new
 * key, a pin) counts as reaching them, and so does a spec with no location at all (every location, review A5).
 */
export function mayReach(geo: unknown, countries: ReadonlySet<string>, facts?: unknown): { reaches: boolean; why: string | null } {
  const placed = plainObject(geo) && Object.entries(geo).some(([k, v]) => k !== 'location_types' && Array.isArray(v) && v.length > 0)
  if (!plainObject(geo) || !placed) return { reaches: true, why: 'it names no location (every location)' }
  const known = new Map<string, string>()
  if (plainObject(facts)) {
    for (const [k, v] of Object.entries(facts)) {
      if (!Array.isArray(v)) continue
      for (const item of v) { const id = geoIdentity(k, item); if (id !== null && plainObject(item) && typeof item.country === 'string') known.set(`${k}:${id}`, item.country) }
    }
  }
  const hit = list(geo.countries).filter((c) => typeof c === 'string' && countries.has(c))
  if (hit.length) return { reaches: true, why: `it targets ${hit.join(', ')}` }
  const groups = list(geo.country_groups).filter((g) => typeof g === 'string' && !NON_EU_GROUPS.has(g))
  if (groups.length) return { reaches: true, why: `it targets the country group ${groups.join(', ')}` }
  for (const [k, v] of Object.entries(geo)) {
    if (k === 'countries' || k === 'country_groups' || k === 'location_types' || !Array.isArray(v)) continue
    for (const item of v) {
      const id = geoIdentity(k, item)
      const country = id !== null && known.has(`${k}:${id}`) ? known.get(`${k}:${id}`)!
        : k === 'zips' && plainObject(item) && typeof item.key === 'string' ? item.key.slice(0, 2) : null
      if (country === null) return { reaches: true, why: `Nexus cannot tell which country a ${k.replace(/_/g, ' ')} item is in, so it counts it as reaching them` }
      if (countries.has(country.toUpperCase())) return { reaches: true, why: `it targets places in ${country}` }
    }
  }
  return { reaches: false, why: null }
}

// ── the request ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface DetailedGroup {
  interests?: string[]; behaviors?: string[]; lifeEvents?: string[]; industries?: string[]; income?: string[]; familyStatuses?: string[]
  broadCategories?: string[]; workPositions?: string[]; workEmployers?: string[]; educationSchools?: string[]; educationMajors?: string[]
  educationStatuses?: number[]; relationshipStatuses?: number[]; collegeYears?: number[]; customAudiences?: string[]
}
const GROUP_ARGS: ReadonlyArray<[keyof DetailedGroup, string]> = [
  ['interests', 'interests'], ['behaviors', 'behaviors'], ['lifeEvents', 'life_events'], ['industries', 'industries'], ['income', 'income'],
  ['familyStatuses', 'family_statuses'], ['broadCategories', 'user_adclusters'], ['workPositions', 'work_positions'], ['workEmployers', 'work_employers'],
  ['educationSchools', 'education_schools'], ['educationMajors', 'education_majors'], ['educationStatuses', 'education_statuses'],
  ['relationshipStatuses', 'relationship_statuses'], ['collegeYears', 'college_years'], ['customAudiences', 'custom_audiences'],
]
export interface IdChange { add?: string[]; remove?: string[] }
export interface ProductAudienceAsk { productSetId: string; include: Array<{ event: string; days: number }>; exclude?: Array<{ event: string; days: number }> }
export const TUNE_WORDS: Readonly<Record<typeof TUNE_CATEGORIES[number], string>> = {
  NONE: 'no special ad category', EMPLOYMENT: 'employment', HOUSING: 'housing', FINANCIAL_PRODUCTS_SERVICES: 'financial products and services', ONLINE_GAMBLING_AND_GAMING: 'online gambling and gaming',
}

export interface AudienceAsk {
  adSetId: string
  locations?: LocationChange
  excludedLocations?: LocationChange
  ageMin?: number
  ageMax?: number
  genders?: 'all' | 'men' | 'women'
  languages?: number[]
  detailedTargeting?: DetailedGroup[]
  excludedEmployers?: IdChange
  audiences?: IdChange
  excludedAudiences?: IdChange
  advantageAudience?: boolean
  ageRange?: [number, number] | null
  advantageDetailedTargeting?: boolean
  advantageLookalike?: boolean
  advantageCustomAudience?: boolean
  suggestions?: { age?: boolean; gender?: boolean; geo?: boolean }
  creativeAudiencePairing?: boolean
  excludeReachedSince?: string[]
  productAudiences?: ProductAudienceAsk[]
  excludedProductAudiences?: ProductAudienceAsk[]
  dynamicAudiences?: IdChange
  excludedDynamicAudiences?: IdChange
  placePageSets?: IdChange
  devices?: Array<'mobile' | 'desktop' | 'connected_tv'>
  operatingSystems?: string[]
  phones?: string[]
  excludedPhones?: string[]
  excludedPhoneModels?: string[]
  wifiOnly?: boolean
  keywords?: string[]
  contextualCategories?: string[]
  siteCategories?: string[]
  tuneForCategory?: typeof TUNE_CATEGORIES[number]
  /** Undo: top-level keys put back as they were (each judged like any value Nexus sends; null removes it). */
  restore?: Record<string, unknown>
}

export interface TargetingLive {
  adSets: Map<string, TargetingAdSetState>
  dsaDefaults: DsaDefaults | null
  /** The employers the account's own controls exclude (TG-056), or null when Meta did not answer them. */
  accountExcludedEmployers: string[] | null
}

/** What a targeting change records, before (raw, for undo) and after (as Nexus views it: targetingView). */
export interface TargetingRecord {
  adSets?: Array<{ id: string; name: string | null; keys: Record<string, unknown>; softOptOut?: unknown }>
  tuned?: { id: string; name: string | null; category: string }
  placePageSet?: { id: string | null; name: string; background: boolean } | null
}

const idsOf = (v: unknown): string[] => list(v).map((x) => idText(plainObject(x) ? x.id : x)).filter((x): x is string => !!x)

/** An id list change (add / remove) on a list of {id} (or of plain ids): each removed one must be there. */
function idListChange(live: unknown, change: IdChange, what: string, plainIds: boolean): { value: unknown[] | null; problems: string[] } {
  const items = list(live)
  const problems: string[] = []
  const remove = new Set(change.remove ?? [])
  for (const id of remove) if (!idsOf(items).includes(id)) problems.push(`${what} holds no ${id} to remove`)
  const kept = items.filter((x) => !remove.has(idText(plainObject(x) ? x.id : x) ?? ''))
  const have = new Set(idsOf(kept))
  const added = uniq(change.add ?? []).filter((id) => !have.has(id)).map((id) => (plainIds ? id : { id }))
  const value = [...kept, ...added]
  return { value: value.length ? value : null, problems }
}

const groupOf = (g: DetailedGroup): Row => {
  const out: Row = {}
  for (const [arg, key] of GROUP_ARGS) {
    const v = g[arg]
    if (!v?.length) continue
    out[key] = (CODE_LISTS as readonly string[]).includes(key) ? uniq(v as number[]) : uniq(v as string[]).map((id) => ({ id }))
  }
  return out
}

const productSpecOf = (p: ProductAudienceAsk): Row => {
  const sub = (items: Array<{ event: string; days: number }>) => items.map((s) => ({ retention_seconds: Math.round(s.days * 86_400), rule: { event: { eq: s.event } } }))
  return { product_set_id: p.productSetId, inclusions: sub(p.include), ...(p.exclude?.length ? { exclusions: sub(p.exclude) } : {}) }
}

/** The detailed-targeting groups of a spec (flexible_spec, and the top-level options as one more OR group). */
function detailedGroups(spec: Row): Array<Set<string>> {
  const groups: Array<Set<string>> = []
  const itemsOf = (g: Row) => new Set(Object.entries(g).flatMap(([k, v]) => list(v).map((x) => `${k}:${plainObject(x) ? String(x.id) : String(x)}`)))
  for (const g of list(spec.flexible_spec)) if (plainObject(g)) groups.push(itemsOf(g))
  const top: Row = {}
  for (const k of [...OPTION_LISTS, ...CODE_LISTS]) if (Array.isArray(spec[k]) && (spec[k] as unknown[]).length) top[k] = spec[k]
  if (Object.keys(top).length) groups.push(itemsOf(top))
  // Review A1 — an empty group narrows nothing (and the judges refuse one): never counted.
  return groups.filter((g) => g.size > 0)
}
/** Narrower or the same: every old group (an AND) has a new group whose options (an OR) are among its own. */
const detailedNarrower = (before: Row, after: Row): boolean => detailedGroups(before).every((old) => detailedGroups(after).some((g) => [...g].every((x) => old.has(x))))

const setOf = (v: unknown): Set<string> => new Set(list(v).map((x) => (plainObject(x) ? String(x.id ?? x.key ?? JSON.stringify(x)) : String(x))))
const grows = (before: unknown, after: unknown) => { const b = setOf(before); return [...setOf(after)].some((x) => !b.has(x)) }
const shrinks = (before: unknown, after: unknown) => grows(after, before)
/** A list that restricts who is reached (absent = no restriction): it widens when it loosens or goes. */
const restrictionWider = (before: unknown, after: unknown) => list(before).length > 0 && (!list(after).length || grows(before, after))

/**
 * How a change of one top-level key can reach more people, in words (empty: it cannot). Every key of the change is judged
 * here, whichever argument set it (a restore too).
 */
export function widerParts(before: Row, after: Row, keys: readonly string[]): string[] {
  const out: string[] = []
  const auto = (s: Row) => (plainObject(s.targeting_automation) ? s.targeting_automation : {})
  const ind = (s: Row) => (plainObject(auto(s).individual_setting) ? auto(s).individual_setting as Row : {})
  const rel = (s: Row) => (plainObject(s.targeting_relaxation_types) ? s.targeting_relaxation_types : {})
  for (const key of keys) {
    const b = before[key]
    const a = after[key]
    if (sameTargeting(b ?? null, a ?? null)) continue
    switch (key) {
      case 'geo_locations':
        // Review A5 — no location left (an audience-only spec) is every location: the widest case.
        if (mayReach(b, new Set()).why !== 'it names no location (every location)' && mayReach(a, new Set()).why === 'it names no location (every location)') out.push('no location limit any more (every location)')
        else out.push(...geoWider(b, a, false))
        if (plainObject(b) && b.location_types !== undefined && !isDefaultLocationTypes(b.location_types) && !(plainObject(a) && sameJson(targetingView(a.location_types ?? null), targetingView(b.location_types)))) {
          out.push(`location types ${JSON.stringify(b.location_types)} → Meta's only option, people living in OR recently in the places (1870199)`)
        }
        break
      case 'excluded_geo_locations': out.push(...geoWider(b, a, true)); break
      case 'age_min': if ((typeof a === 'number' ? a : 18) < (typeof b === 'number' ? b : 18)) out.push(`a lower minimum age (${valueWords(key, b)} → ${valueWords(key, a)})`); break
      case 'age_max': if ((typeof a === 'number' ? a : 65) > (typeof b === 'number' ? b : 65)) out.push(`a higher maximum age (${valueWords(key, b)} → ${valueWords(key, a)})`); break
      case 'genders': { const g = (v: unknown) => (list(v).length ? setOf(v) : new Set(['1', '2'])); if ([...g(a)].some((x) => !g(b).has(x))) out.push(`more genders (${valueWords(key, b ?? null)} → ${valueWords(key, a ?? null)})`); break }
      case 'locales': case 'device_platforms': case 'user_os': case 'user_device':
        if (restrictionWider(b, a)) out.push(`${key.replace(/_/g, ' ')} loosened (${valueWords(key, b)} → ${valueWords(key, a ?? null)})`); break
      case 'custom_audiences': case 'dynamic_audience_ids': case 'place_page_set_ids': case 'product_audience_specs': case 'keywords': case 'contextual_targeting_categories': case 'site_category':
        if (restrictionWider(b, a) || (key === 'product_audience_specs' && list(b).length > 0 && !sameTargeting(b, a))) out.push(`${key.replace(/_/g, ' ')} loosened`); break
      case 'excluded_custom_audiences': case 'excluded_dynamic_audience_ids': case 'excluded_user_device': case 'excluded_mobile_device_model':
        if (shrinks(b, a)) out.push(`fewer ${key.replace(/^excluded_/, 'excluded ').replace(/_/g, ' ')}`); break
      case 'excluded_product_audience_specs': if (list(b).some((spec) => !list(a).some((x) => sameTargeting(x, spec)))) out.push('product audiences excluded loosened'); break
      case 'exclusions': {
        const flat = (v: unknown) => new Set(plainObject(v) ? Object.entries(v).flatMap(([k, x]) => list(x).map((i) => `${k}:${plainObject(i) ? String(i.id) : String(i)}`)) : [])
        if ([...flat(b)].some((x) => !flat(a).has(x))) out.push('fewer detailed exclusions'); break
      }
      case 'wireless_carrier': if (list(b).length && !list(a).length) out.push('Wi-Fi only switched off'); break
      case 'exclude_reached_since': if (list(b).length) out.push('people this account already reached are no longer all excluded'); break
      case 'flexible_spec':
        if (!detailedNarrower(before, after)) out.push('detailed targeting loosened (an AND group dropped or an option added)')
        break
      case 'targeting_automation': {
        if (auto(after).advantage_audience === 1 && auto(before).advantage_audience !== 1) out.push('Advantage+ audience switched on (Meta may reach people beyond the ages, gender and detailed targeting named)')
        for (const s of ['age', 'gender', 'geo'] as const) if (ind(after)[s] === 1 && ind(before)[s] !== 1) out.push(`${s} used as a suggestion only (Meta may go beyond it)`)
        if (auto(after).creative_audience_pairing === 1 && auto(before).creative_audience_pairing !== 1) out.push('creative-audience pairing switched on')
        break
      }
      case 'targeting_optimization': if (a === 'expansion_all' && b !== 'expansion_all') out.push('Advantage detailed targeting switched on (Meta goes beyond the detailed targeting)'); break
      case 'targeting_relaxation_types':
        for (const s of ['lookalike', 'custom_audience'] as const) if (rel(after)[s] === 1 && rel(before)[s] !== 1) out.push(`Advantage ${s === 'lookalike' ? 'lookalike' : 'custom audience'} switched on (Meta goes beyond the ${s === 'lookalike' ? 'lookalikes' : 'custom audiences'})`)
        break
      case 'age_range': break
      default:
        // A top-level detailed list: judged with flexible_spec as one more group.
        if ((OPTION_LISTS as readonly string[]).includes(key) || (CODE_LISTS as readonly string[]).includes(key)) {
          if (!keys.includes('flexible_spec') && !detailedNarrower(before, after)) out.push('detailed targeting loosened')
          break
        }
        out.push(`${key.replace(/_/g, ' ')} changed (Nexus cannot tell whether that narrows it)`)
    }
  }
  return uniq(out)
}

/** Special ad categories that restrict targeting (special-ad-category.md; facts F1 M4-22). */
const RESTRICTED_CATEGORIES = new Set(['HOUSING', 'EMPLOYMENT', 'FINANCIAL_PRODUCTS_SERVICES', 'CREDIT'])
const SAC_REFUSED_GEO = ['zips', 'subcities', 'neighborhoods', 'metro_areas', 'small_geo_areas', 'subneighborhoods', 'electoral_districts']
const SAC_REFUSED_DETAILED = ['behaviors', 'life_events', 'industries', 'income', 'family_statuses', 'education_schools', 'education_majors', 'education_statuses', 'work_positions', 'work_employers', 'relationship_statuses', 'college_years']

/** 15 miles in km: a special ad category's least radius in the US and Canada (15 km elsewhere: special-ad-category.md). */
const SAC_MIN_KM_US_CA = 15 * 1.609344

/**
 * What a restricted special ad category refuses in the keys a change sets (Meta: hard errors 2909035). Ages are fixed to
 * 18–65+ for housing and employment everywhere, and for financial products outside the EU (review B6: "EU credit ads may
 * differ", special-ad-category.md). The least radius: 15 mi in the US and Canada, 15 km elsewhere — by the country META
 * answered for the place in the live spec (`facts`); a place Nexus cannot place takes the stricter 15 mi.
 */
function sacProblems(spec: Row, keys: readonly string[], categories: readonly string[], facts: unknown): string[] {
  const out: string[] = []
  const has = (k: string) => keys.includes(k)
  if ((has('genders') && list(spec.genders).length === 1)) out.push('no gender of its own (everyone)')
  const fixedAges = categories.some((c) => c === 'HOUSING' || c === 'EMPLOYMENT') || !mayReach(spec.geo_locations, DSA_COUNTRIES, plainObject(facts) ? facts.geo_locations : undefined).reaches
  if (fixedAges && ((has('age_min') && spec.age_min !== undefined && spec.age_min !== 18) || (has('age_max') && spec.age_max !== undefined && spec.age_max !== 65))) out.push('ages 18 to 65+ only')
  if (has('excluded_geo_locations') && plainObject(spec.excluded_geo_locations) && Object.entries(spec.excluded_geo_locations).some(([k, v]) => k !== 'location_types' && list(v).length)) out.push('no location exclusions')
  if (has('geo_locations') && plainObject(spec.geo_locations)) {
    const geo = spec.geo_locations
    const bad = SAC_REFUSED_GEO.filter((k) => list(geo[k]).length)
    if (bad.length) out.push(`no ${bad.join(', ').replace(/_/g, ' ')}`)
    const known = new Map<string, string>()
    if (plainObject(facts) && plainObject(facts.geo_locations)) {
      for (const [k, v] of Object.entries(facts.geo_locations)) for (const item of list(v)) { const id = geoIdentity(k, item); if (id && plainObject(item) && typeof item.country === 'string') known.set(`${k}:${id}`, item.country) }
    }
    const small = (['cities', 'custom_locations', 'places'] as const).some((k) => list(geo[k]).some((x) => {
      const r = radiusKm(x)
      if (r === null) return false
      const country = known.get(`${k}:${geoIdentity(k, x)}`)
      return r < (country && country !== 'US' && country !== 'CA' ? 15 : SAC_MIN_KM_US_CA) - 1e-6
    }))
    if (small) out.push('a radius of at least 15 mi in the US and Canada and 15 km elsewhere (a place Nexus cannot place takes 15 mi)')
  }
  if (has('exclusions') && spec.exclusions !== undefined) out.push('no detailed exclusions')
  const detailed = [spec, ...list(spec.flexible_spec)].some((g) => plainObject(g) && SAC_REFUSED_DETAILED.some((k) => list(g[k]).length))
  if (detailed && (has('flexible_spec') || SAC_REFUSED_DETAILED.some(has))) out.push('no behaviours or demographics (only interests Meta approved)')
  return out
}

/** targeting_automation with Meta's undocumented switches (shared_audiences, value_expression) exactly as Meta holds them now. */
function keepAutomation(value: unknown, live: unknown): Row | null {
  const out: Row = plainObject(value) ? { ...value } : {}
  const now = plainObject(live) ? live : {}
  for (const k of ['shared_audiences', 'value_expression']) {
    if (now[k] !== undefined) out[k] = now[k]
    else delete out[k]
  }
  return Object.keys(out).length ? out : null
}

/** The top-level keys a change sets from the request (null: removed), with words for what Nexus did by itself. */
function audienceSet(ask: AudienceAsk, state: TargetingAdSetState, live: TargetingLive): { set: Row; problems: string[]; notes: string[]; skipJudge: Set<string> } {
  const t = state.targeting
  const set: Row = {}
  const problems: string[] = []
  const notes: string[] = []
  const skipJudge = new Set<string>()
  const who = adSetWho(state)
  // Undo only (the tool takes it from the change's own record, never from a caller: review A1) — each key exactly as Meta
  // held it before; location_types left out only when it is Meta's only option (A3); targeting_automation's undocumented
  // switches as Meta holds them now.
  const restoring = !!ask.restore
  if (ask.restore) {
    for (const [key, value] of Object.entries(ask.restore)) {
      if (!(AUDIENCE_TARGETING_KEYS as readonly string[]).includes(key)) { problems.push(`${who}: targeting.${key} is not a key set-meta-targeting puts back (it changes ${AUDIENCE_TARGETING_KEYS.length} audience keys)`); continue }
      set[key] = (key === 'geo_locations' || key === 'excluded_geo_locations') && plainObject(value) && isDefaultLocationTypes(value.location_types)
        ? Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'location_types')) : value ?? null
    }
    if ('targeting_automation' in set) set.targeting_automation = keepAutomation(set.targeting_automation, t.targeting_automation)
  }
  if (ask.locations) { const r = applyLocations(t.geo_locations, ask.locations, `${who}'s locations`); set.geo_locations = Object.keys(r.geo).length ? r.geo : null; problems.push(...r.problems); notes.push(...r.notes) }
  if (ask.excludedLocations) {
    if (ask.excludedLocations.add?.customLocations?.length) notes.push('An excluded pin or address excludes people living or recently there (Meta).')
    const r = applyLocations(t.excluded_geo_locations, ask.excludedLocations, `${who}'s excluded locations`)
    set.excluded_geo_locations = Object.keys(r.geo).length ? r.geo : null
    problems.push(...r.problems); notes.push(...r.notes)
    const lt = plainObject(t.excluded_geo_locations) ? t.excluded_geo_locations.location_types : undefined
    if (lt !== undefined && !isDefaultLocationTypes(lt)) notes.push(`${who}: its excluded places lose location_types ${JSON.stringify(lt)} (Meta asks for it to go, 1870199): Meta then excludes people living in or recently in them — more people excluded.`)
  }
  // TG-049 (1870199, review A3) — location_types Meta holds as its only option (home AND recent) is dropped silently at
  // this change; any other value is left alone unless the change rewrites the places (then its widening is said).
  for (const k of ['geo_locations', 'excluded_geo_locations'] as const) {
    if (!(k in set) && plainObject(t[k]) && isDefaultLocationTypes((t[k] as Row).location_types)) set[k] = Object.fromEntries(Object.entries(t[k] as Row).filter(([x]) => x !== 'location_types'))
  }
  if (ask.ageMin !== undefined) set.age_min = ask.ageMin
  if (ask.ageMax !== undefined) set.age_max = ask.ageMax === 65 ? null : ask.ageMax
  if (ask.genders) set.genders = ask.genders === 'all' ? null : ask.genders === 'men' ? [1] : [2]
  if (ask.languages) set.locales = ask.languages.length ? uniq(ask.languages) : null
  if (ask.detailedTargeting) {
    const groups = ask.detailedTargeting.map(groupOf).filter((g) => Object.keys(g).length)
    set.flexible_spec = groups.length ? groups : null
    // The whole detailed targeting: options Meta holds at the top level of the spec go (they are one more OR group).
    for (const k of [...OPTION_LISTS, ...CODE_LISTS]) if (t[k] !== undefined) set[k] = null
  }
  if (ask.excludedEmployers) {
    const now = plainObject(t.exclusions) ? t.exclusions : {}
    const r = idListChange(now.work_employers, ask.excludedEmployers, `${who}'s excluded employers`, false)
    problems.push(...r.problems)
    const next: Row = { ...now }
    if (r.value) next.work_employers = r.value
    else delete next.work_employers
    set.exclusions = Object.keys(next).length ? next : null
    const added = (ask.excludedEmployers.add ?? []).filter((id) => !idsOf(now.work_employers).includes(id))
    if (added.length && live.accountExcludedEmployers !== null) {
      const missing = added.filter((id) => !live.accountExcludedEmployers!.includes(id))
      if (missing.length) notes.push(`Since v22 Meta refuses a NEW detailed exclusion unless the ad account's own controls exclude it too: employer${missing.length === 1 ? '' : 's'} ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in them (set-meta-account-controls adds ${missing.length === 1 ? 'it' : 'them'}); if Meta refuses, its own words say so.`)
    }
  }
  const ids = (key: string, change: IdChange | undefined, word: string, plain = false) => {
    if (!change) return
    const r = idListChange(t[key], change, `${who}'s ${word}`, plain)
    set[key] = r.value
    problems.push(...r.problems)
  }
  ids('custom_audiences', ask.audiences, 'custom audiences')
  ids('excluded_custom_audiences', ask.excludedAudiences, 'excluded custom audiences')
  ids('dynamic_audience_ids', ask.dynamicAudiences, 'dynamic audiences', true)
  ids('excluded_dynamic_audience_ids', ask.excludedDynamicAudiences, 'excluded dynamic audiences', true)
  ids('place_page_set_ids', ask.placePageSets, 'place page sets', true)
  // TG-059 (silent opt-in) — Advantage+ audience is said explicitly on every targeting change: as asked, else as Meta
  // holds it, else off (0).
  const autoNow = plainObject(t.targeting_automation) ? t.targeting_automation : {}
  const auto: Row = { ...autoNow }
  if (ask.advantageAudience !== undefined) auto.advantage_audience = ask.advantageAudience ? 1 : 0
  // Review A6 — an undo puts back exactly what was there (no Advantage+ audience setting at all, if so): never forced.
  else if (autoNow.advantage_audience === undefined && !restoring) {
    auto.advantage_audience = 0
    notes.push(`${who}: Advantage+ audience is sent explicitly as off (0) — Meta holds no setting on this ad set, and Meta's own default for a new ad set is on.`)
  }
  if (ask.suggestions) {
    const ind: Row = plainObject(autoNow.individual_setting) ? { ...autoNow.individual_setting } : {}
    for (const s of ['age', 'gender', 'geo'] as const) if (ask.suggestions[s] !== undefined) ind[s] = ask.suggestions[s] ? 1 : 0
    auto.individual_setting = ind
  }
  if (ask.creativeAudiencePairing !== undefined) auto.creative_audience_pairing = ask.creativeAudiencePairing ? 1 : 0
  if (!sameJson(auto, autoNow)) set.targeting_automation = auto
  if (auto.advantage_audience === 1 && autoNow.advantage_audience !== 1) {
    // advantage-audience.md: with it on, age_min only 18–25 and age_max fixed at 65; Meta sets the ages itself.
    const min = 'age_min' in set ? set.age_min : t.age_min
    if (typeof min === 'number' && (min > 25 || min < 18)) problems.push(`${who}: with Advantage+ audience on Meta takes a minimum age of 25 at most, 18 at least (18 to 25; it would be ${min}): set ageMin 18 to 25, or leave Advantage+ audience off.`)
    if (t.age_max !== undefined && t.age_max !== 65 && !('age_max' in set)) set.age_max = null
    skipJudge.add('age_min'); skipJudge.add('age_max')
    notes.push(`${who}: with Advantage+ audience on, the age range becomes a suggestion and Meta fixes the maximum age at 65+ (the minimum stays a hard limit); undo puts the old ages back.`)
  }
  if (ask.ageRange !== undefined) set.age_range = ask.ageRange
  // age_range is a suggestion for Advantage+ audience or age suggestions: when both end, it goes too (said).
  const autoNext = plainObject(set.targeting_automation) ? set.targeting_automation : autoNow
  const ageSuggested = autoNext.advantage_audience === 1 || (plainObject(autoNext.individual_setting) && autoNext.individual_setting.age === 1)
  if (!ageSuggested && t.age_range !== undefined && ask.ageRange === undefined && !restoring) {
    set.age_range = null
    notes.push(`${who}: its suggested age range goes too — it is a suggestion for Advantage+ audience or age suggestions, and neither stays on.`)
  }
  if (ask.advantageDetailedTargeting !== undefined) set.targeting_optimization = ask.advantageDetailedTargeting ? 'expansion_all' : 'none'
  if (ask.advantageLookalike !== undefined || ask.advantageCustomAudience !== undefined) {
    const rel: Row = plainObject(t.targeting_relaxation_types) ? { ...t.targeting_relaxation_types } : {}
    if (ask.advantageLookalike !== undefined) rel.lookalike = ask.advantageLookalike ? 1 : 0
    if (ask.advantageCustomAudience !== undefined) rel.custom_audience = ask.advantageCustomAudience ? 1 : 0
    set.targeting_relaxation_types = rel
  }
  if (ask.excludeReachedSince) set.exclude_reached_since = ask.excludeReachedSince.length ? uniq(ask.excludeReachedSince) : null
  if (ask.productAudiences) set.product_audience_specs = ask.productAudiences.length ? ask.productAudiences.map(productSpecOf) : null
  if (ask.excludedProductAudiences) set.excluded_product_audience_specs = ask.excludedProductAudiences.length ? ask.excludedProductAudiences.map(productSpecOf) : null
  for (const p of [...(ask.productAudiences ?? []), ...(ask.excludedProductAudiences ?? [])]) {
    for (const s of [...p.include, ...(p.exclude ?? [])]) {
      if (!(PRODUCT_EVENTS as readonly string[]).includes(s.event)) problems.push(`${who}: a product audience event is one of ${PRODUCT_EVENTS.join(', ')} (not ${s.event})`)
      if (!(s.days > 0 && s.days <= MAX_RETENTION_DAYS)) problems.push(`${who}: a product audience keeps people 1 to ${MAX_RETENTION_DAYS} days (not ${s.days})`)
    }
  }
  if (ask.devices) set.device_platforms = ask.devices.length ? uniq(ask.devices) : null
  if (ask.operatingSystems) set.user_os = ask.operatingSystems.length ? uniq(ask.operatingSystems) : null
  if (ask.phones) set.user_device = ask.phones.length ? uniq(ask.phones) : null
  if (ask.excludedPhones) set.excluded_user_device = ask.excludedPhones.length ? uniq(ask.excludedPhones) : null
  if (ask.excludedPhoneModels) set.excluded_mobile_device_model = ask.excludedPhoneModels.length ? uniq(ask.excludedPhoneModels) : null
  if (ask.wifiOnly !== undefined) set.wireless_carrier = ask.wifiOnly ? ['Wifi'] : null
  if (ask.keywords) set.keywords = ask.keywords.length ? uniq(ask.keywords) : null
  if (ask.contextualCategories) set.contextual_targeting_categories = ask.contextualCategories.length ? uniq(ask.contextualCategories).map((id) => ({ id })) : null
  if (ask.siteCategories) set.site_category = ask.siteCategories.length ? uniq(ask.siteCategories) : null
  return { set, problems, notes, skipJudge }
}

/** Every argument of an ad set's item that asks a change (a restore included). */
const ASKED: ReadonlyArray<keyof AudienceAsk> = [
  'locations', 'excludedLocations', 'ageMin', 'ageMax', 'genders', 'languages', 'detailedTargeting', 'excludedEmployers', 'audiences', 'excludedAudiences',
  'advantageAudience', 'ageRange', 'advantageDetailedTargeting', 'advantageLookalike', 'advantageCustomAudience', 'suggestions', 'creativeAudiencePairing',
  'excludeReachedSince', 'productAudiences', 'excludedProductAudiences', 'dynamicAudiences', 'excludedDynamicAudiences', 'placePageSets', 'devices',
  'operatingSystems', 'phones', 'excludedPhones', 'excludedPhoneModels', 'wifiOnly', 'keywords', 'contextualCategories', 'siteCategories', 'restore',
]

/** The whole spec as Nexus keeps it in a record (raw; read-only keys left out). */
const recordSpec = (t: Row): Row => Object.fromEntries(Object.entries(t).filter(([k]) => !isReadOnlyTargetingKey(k)))

/** TG-075 — one ad set re-tuned for a special ad category: Meta changes the targeting itself. */
function tuneRequest(state: TargetingAdSetState, category: typeof TUNE_CATEGORIES[number], step: number): { request: MetaChangeRequest; spends: ReturnType<typeof spendOf> } {
  const who = adSetWho(state)
  const spends = spendOf(state, [`Meta makes its targeting fit ${TUNE_WORDS[category]} itself (it removes location and detailed exclusions and lookalikes and opens ages and genders as the category needs), which can reach more people`])
  return {
    spends,
    request: {
      step,
      label: `Re-tune the targeting of ${who} for ${TUNE_WORDS[category]}`,
      kind: 'adset',
      objectId: state.id,
      params: { tune_for_category: category },
      check: 'none',
      raisesSpend: spends.raises,
      readBackInPost: false,
      budget: false,
      undoable: true,
      operation: 'adset.tuneForCategory',
      readBackFields: 'id,targeting',
      judge: (node) => ({ moved: [], reads: plainObject(node.targeting) ? `its targeting as Meta tuned it (${Object.keys(node.targeting).filter((k) => !isReadOnlyTargetingKey(k)).length} keys)` : 'as Meta tuned it' }),
    },
  }
}

export function targetingDraft(request: AudienceAsk[], live: TargetingLive): MetaChangeDraft | { refusal: string } {
  if (!request.length) return { refusal: 'Name at least one ad set.' }
  const seen = new Set<string>()
  for (const item of request) {
    if (seen.has(item.adSetId)) return { refusal: `Ad set ${item.adSetId} is named twice: name each ad set once.` }
    seen.add(item.adSetId)
    const asked = ASKED.filter((k) => item[k] !== undefined)
    if (!asked.length && !item.tuneForCategory) return { refusal: `Say what to change on ad set ${item.adSetId} (locations, ages, genders, languages, detailed targeting, audiences, Advantage+ switches, devices, …).` }
    if (item.tuneForCategory && asked.length) return { refusal: `Ad set ${item.adSetId}: a re-tune for a special ad category goes alone (Meta changes the targeting itself); ask the other changes after it.` }
  }
  const refusals: string[] = []
  const warnings: string[] = []
  const spendsMoney: string[] = []
  const skipped: string[] = []
  const requests: MetaChangeRequest[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const before: NonNullable<TargetingRecord['adSets']> = []
  const after: NonNullable<TargetingRecord['adSets']> = []
  const stands: unknown[] = []
  let tuned: TargetingRecord['tuned'] | undefined
  for (const item of request) {
    const state = live.adSets.get(item.adSetId)
    if (!state) { refusals.push(`Nexus could not read ad set ${item.adSetId} from Meta.`); continue }
    const who = adSetWho(state)
    if (item.tuneForCategory) {
      const { request: r, spends } = tuneRequest(state, item.tuneForCategory, requests.length + 1)
      if (spends.spends) spendsMoney.push(spends.spends)
      if (spends.warning) warnings.push(spends.warning)
      requests.push(r)
      lines.push([`${who}: re-tune for a special ad category`, (state.campaign?.specialAdCategories ?? []).join(', ') || 'none', TUNE_WORDS[item.tuneForCategory]])
      warnings.push(`Meta re-tunes ${who}'s targeting itself (special-ad-category.md: lookalikes, saved audiences, location and detailed exclusions removed; ages, genders and radius set as the category needs). The campaign's own special ad category is set with set-meta-campaign. Undo sends the old whole targeting back.`)
      const whole = recordSpec(state.targeting)
      before.push({ id: state.id, name: state.name, keys: whole })
      after.push({ id: state.id, name: state.name, keys: targetingView(whole) as Row })
      stands.push({ id: state.id, status: state.status, campaign: state.campaign?.status ?? null, targeting: targetingView(whole) })
      tuned = { id: state.id, name: state.name, category: item.tuneForCategory }
      continue
    }
    const built = audienceSet(item, state, live)
    if (built.problems.length) { refusals.push(...built.problems); continue }
    // Each value judged as the gateway judges it (Meta's own shapes too), before anything is merged.
    const judged = Object.entries(built.set).filter(([, v]) => v !== null).map(([k, v]) => targetingValueProblem(k, v)).find(Boolean)
    if (judged) { refusals.push(`${who}: ${judged}.`); continue }
    const merge = mergeTargeting(state.targeting, built.set)
    if (!merge.changed.length) { skipped.push(`${who} already has this targeting.`); continue }
    const whole = audienceWholeProblem(merge.spec)
    if (whole) { refusals.push(`${who}: ${whole}.`); continue }
    if (new URLSearchParams({ targeting: merge.sent }).toString().length > MAX_TARGETING_BODY) { refusals.push(`${who}'s targeting is too large for one Nexus change (Meta takes it only whole); change it in Ads Manager.`); continue }
    const added = targetingAddedIds(state.targeting, merge.spec)
    if (added.length > 150) { refusals.push(`${who}: this change adds ${added.length} audiences, product sets and place page sets; Nexus checks at most 150 per change (split it).`); continue }
    const keys = merge.changed.map((c) => c.key)
    // Special ad categories (M4-22): what Meta refuses, refused here in words.
    if ((state.campaign?.specialAdCategories ?? []).some((c) => RESTRICTED_CATEGORIES.has(c))) {
      const sac = sacProblems(merge.spec, keys, state.campaign!.specialAdCategories!, state.targeting)
      if (sac.length) { refusals.push(`${who}'s campaign is in a special ad category (${state.campaign!.specialAdCategories!.join(', ')}): Meta allows ${sac.join('; ')} (error 2909035). tuneForCategory makes the targeting fit at once.`); continue }
    }
    // Under 18 in the EU, the EEA and Switzerland (facts F1 M6): refused.
    const ageMin = typeof merge.spec.age_min === 'number' ? merge.spec.age_min : 18
    if (ageMin < 18) {
      const youth = mayReach(merge.spec.geo_locations, NO_YOUTH_COUNTRIES, state.targeting.geo_locations)
      if (youth.reaches) { refusals.push(`${who}: Meta allows no ads to people under 18 in the EU, the EEA and Switzerland, and this targeting may reach them (${youth.why}).`); continue }
      warnings.push(`${who}: under-18 audiences take only location, age and gender (cities or larger, no postcodes: Meta errors 1870165 / 3858064).`)
    }
    // DSA (facts F1 X7): a spec that newly reaches the EU needs the payer and beneficiary — the ad set's, or the account's
    // saved defaults (Meta fills them in on an update that adds EU targeting).
    const euNow = mayReach(state.targeting.geo_locations, DSA_COUNTRIES, state.targeting.geo_locations)
    const euNext = mayReach(merge.spec.geo_locations, DSA_COUNTRIES, state.targeting.geo_locations)
    if (euNext.reaches && !euNow.reaches && !(state.dsaPayor && state.dsaBeneficiary)) {
      if (!live.dsaDefaults) { refusals.push(`${who}: this targeting may reach the EU (${euNext.why}), and Meta needs an EU payer and beneficiary for that (DSA): the ad set has none and the ad account has no saved defaults. Set them first (set-meta-ad-set dsa, or the account's defaults in Meta), then ask again.`); continue }
      warnings.push(`${who} may now reach the EU (${euNext.why}): Meta fills in the ad account's saved EU payer and beneficiary ("${live.dsaDefaults.payor}" / "${live.dsaDefaults.beneficiary}"), shown to people in the EU.`)
    }
    // Step 18 rule: an edit that breaks an Advantage+ lever turns Advantage+ off, without a warning from Meta.
    const advOff = plainObject(merge.spec.targeting_automation) && merge.spec.targeting_automation.advantage_audience === 0
      && plainObject(state.targeting.targeting_automation) && state.targeting.targeting_automation.advantage_audience === 1
    if (advOff && state.campaign?.advantageState && state.campaign.advantageState !== 'DISABLED') warnings.push(`${who}'s campaign is ${state.campaign.advantageState}: switching Advantage+ audience off can turn Advantage+ off for the campaign (Meta does it without a warning).`)
    const wider = widerParts(state.targeting, merge.spec, keys)
    // Review B5 — placements v26 removed that an old ad set may still hold: Meta may refuse any targeting change of it.
    const retired = retiredPlacements(state.targeting)
    if (retired.length) warnings.push(`${who} still holds placement${retired.length === 1 ? '' : 's'} Meta removed in v26 (${retired.join(', ')}): Meta may refuse this change until ${retired.length === 1 ? 'it goes' : 'they go'} — set-meta-placements removes ${retired.length === 1 ? 'it' : 'them'}.`)
    const spends = spendOf(state, wider)
    if (spends.spends) spendsMoney.push(spends.spends)
    if (spends.warning) warnings.push(spends.warning)
    warnings.push(...built.notes)
    for (const c of merge.changed) lines.push([`${who}: ${c.key}`, valueWords(c.key, c.from), valueWords(c.key, c.to)])
    const setKeys = Object.fromEntries(keys.map((k) => [k, merge.spec[k] ?? null]))
    requests.push({
      step: requests.length + 1,
      label: `Targeting of ${who}`,
      kind: 'adset',
      objectKind: 'adsetaudience',
      objectId: state.id,
      params: { targeting: merge.sent },
      check: 'none',
      raisesSpend: spends.raises,
      readBackInPost: false,
      budget: false,
      undoable: true,
      operation: 'adset.targeting',
      readBackFields: 'id,targeting',
      judge: targetingJudge(setKeys, built.skipJudge),
      // Review A2 — the gateway lets only these keys differ from the live spec it reads right before the send.
      targetingKeys: keys,
    })
    before.push({ id: state.id, name: state.name, keys: Object.fromEntries(keys.map((k) => [k, state.targeting[k] ?? null])) })
    after.push({ id: state.id, name: state.name, keys: Object.fromEntries(keys.map((k) => [k, targetingView(merge.spec[k] ?? null)])) })
    stands.push({ id: state.id, status: state.status, campaign: state.campaign?.status ?? null, targeting: targetingView(recordSpec(state.targeting)) })
  }
  if (refusals.length) return { refusal: `Nothing was asked of Meta: ${refusals.join(' ')}` }
  if (!requests.length) return { refusal: `Nothing to change: ${skipped.join(' ')}` }
  warnings.push(REVIEW_SENTENCE, WHOLE_SENTENCE)
  const { changes, more } = changeLines(lines)
  return {
    summary: requests.length <= 3 ? `Meta: ${requests.map((r) => r.label).join('; ')}.` : `Meta: the targeting of ${plural(requests.length, 'ad set')} — one request per ad set.`,
    changes,
    totals: { adSets: requests.length, requests: requests.length, ...(skipped.length ? { alreadySo: skipped.length } : {}), ...(more ? { moreLines: more } : {}) },
    warnings: uniq(warnings), spendsMoney, skipped, requests,
    stands: { adSets: stands, dsaDefaults: live.dsaDefaults ? 'saved' : 'none' },
    before: { adSets: before } satisfies TargetingRecord,
    after: { adSets: after, ...(tuned ? { tuned } : {}) } satisfies TargetingRecord,
  }
}

/**
 * Undo — the restore of each ad set's keys from the record: every key whose view moved, put back as Meta held it before
 * (null: it was not set). Keys outside `allowed` cannot be put back by this tool (said in words).
 */
export function restoreArgs(before: TargetingRecord, after: TargetingRecord, allowed: readonly string[]): Array<{ adSetId: string; restore: Record<string, unknown> }> | { refusal: string } {
  const afterById = new Map((after.adSets ?? []).map((a) => [a.id, a.keys]))
  const items: Array<{ adSetId: string; restore: Record<string, unknown> }> = []
  for (const b of before.adSets ?? []) {
    const a = afterById.get(b.id)
    if (!a) continue
    const restore: Record<string, unknown> = {}
    for (const key of uniq([...Object.keys(b.keys), ...Object.keys(a)])) {
      if (sameJson(targetingView(b.keys[key] ?? null), a[key] ?? null)) continue
      if (!allowed.includes(key)) return { refusal: `Undo cannot put ad set ${b.id}'s ${key} back: it is not a key this tool sends (change it in Ads Manager).` }
      restore[key] = b.keys[key] ?? null
    }
    if (Object.keys(restore).length) items.push({ adSetId: b.id, restore })
  }
  return items.length ? items : { refusal: 'This change left every ad set as it was: nothing to put back.' }
}

// ── TG-018 / TG-019: a place page set ───────────────────────────────────────────────────────────────────────────────

export interface PlacePageSetAsk { name: string; locationTypes?: Array<'home' | 'recent'>; targetedAreaType?: 'CUSTOM_RADIUS' | 'MARKETING_AREA' | 'NONE'; background?: boolean }

export function placePageSetDraft(ask: PlacePageSetAsk, live: { adAccountId: string; pageId: string | null }): MetaChangeDraft | { refusal: string } {
  if (!live.pageId) return { refusal: 'A place page set is made under the business\'s chosen Facebook Page (its parent page), and this business has none chosen (set-meta-connection).' }
  const params: Record<string, string> = { name: ask.name, parent_page: live.pageId }
  if (ask.locationTypes?.length) params.location_types = JSON.stringify(uniq(ask.locationTypes))
  if (ask.targetedAreaType) params.targeted_area_type = ask.targetedAreaType
  const act = `act_${live.adAccountId}`
  const label = `Make the place page set "${ask.name}" under the chosen Page${ask.background ? ' (in the background)' : ''}`
  const { changes } = changeLines([
    ['place page set', null, ask.name],
    ['parent page (the chosen Page)', null, live.pageId],
    ...(ask.locationTypes?.length ? [['people it targets', null, ask.locationTypes.join(', ')] as [string, unknown, unknown]] : []),
    ...(ask.targetedAreaType ? [['targeted area type (SDK only)', null, ask.targetedAreaType] as [string, unknown, unknown]] : []),
  ])
  const base = { step: 1, label, objectKind: 'adaccount' as const, objectId: act, params, check: 'none' as const, raisesSpend: false, readBackInPost: false, budget: false, undoable: false, readBackFields: 'id,name,location_types' }
  return {
    summary: `Meta: ${label}.`,
    changes, totals: { requests: 1 },
    warnings: [
      'A place page set groups the local-business Pages under the chosen Page, for store-traffic or local ads (place_page_set_ids in an ad set\'s targeting). It spends nothing by itself.',
      'Meta documents no delete of a place page set: this cannot be undone by Nexus.',
      ...(ask.background || ask.targetedAreaType ? ['Meta documents this only in its SDK (the background edge and targeted_area_type): if Meta refuses it, its own words say why.'] : []),
    ],
    spendsMoney: [], skipped: [],
    // Each edge spelled out (never computed: meta-labels-writes.vitest.test.ts pins that only the kit passes an edge on).
    requests: [ask.background
      ? { ...base, operation: 'adaccount.placePageSetAsync', edge: 'ad_place_page_sets_async' }
      : { ...base, operation: 'adaccount.placePageSet', edge: 'ad_place_page_sets' }],
    stands: { pageId: live.pageId },
    before: { placePageSet: null } satisfies TargetingRecord,
    after: { placePageSet: { id: null, name: ask.name, background: !!ask.background } } satisfies TargetingRecord,
  }
}

/** Which GEO list keys exist (exported for the tools' zod). */
export const AREA_LISTS = GEO_KEYED_LISTS
