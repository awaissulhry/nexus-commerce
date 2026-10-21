/**
 * Meta ads changes, step 20 (2026-10-21) — targeting, placements and the ad account's controls. Each a Nexus change like
 * every other Meta change (meta-ads-kit.ts): a preview from the live state (Meta documents no check — validate_only — for an ad
 * set update or the account's controls: said), an approvalId, a person approves it, it runs as that person request by
 * request (one per ad set), judged by its own read-back, and undo puts back what it changed.
 *
 *   set-meta-targeting        an ad set's audience: locations in / out, ages, genders, languages, detailed targeting,
 *                             employer exclusions, custom / dynamic / product audiences in and out, place page sets,
 *                             Advantage+ audience and the other Advantage+ switches, devices, systems, phones, Wi-Fi,
 *                             contextual keys, a re-tune for a special ad category; or a new place page set (master TG-018,
 *                             TG-019, TG-040–075, TG-078, TG-091)
 *   set-meta-placements       Advantage+ placements, or platforms and positions by hand; people of unknown age; in-stream
 *                             options; limited spend on excluded placements (TG-077, TG-080–088, TG-090)
 *   set-meta-account-controls the ad account's controls — minimum age, locations in / out, employer exclusions, excluded
 *                             placements — posted whole (TG-100, TG-101)
 * The drafts are marketing/meta-ads/change-targeting.ts, change-placements.ts and change-account-controls.ts; the live reads
 * live-targeting-change.ts (and step 19's and 39's: EU defaults, chosen Page, WhatsApp onboarding, delivering campaigns);
 * the preview's estimate and option checks are step 9's meta-targeting-check (live-targeting.ts targetingCheck); the
 * gateway's rules gateway/meta-targeting-rules.ts. The ad set's targeting goes whole through step 39's
 * targeting-merge.ts.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolResult, ToolUndo } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaIdArg, metaWhyArg, META_CHANGE_RULES, recordAccount, runMetaChange, type MetaDraftBuilder } from './meta-ads-kit.js'
import { MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { MetaReadError } from '../../marketing/meta-ads/errors.js'
import { createdIdOf } from '../../marketing/meta-ads/write-client.js'
import { liveAccountControls, liveTargetingAdSet, liveSoftOptOut, type TargetingAdSetState } from '../../marketing/meta-ads/live-targeting-change.js'
import { liveChosenPage, liveDsaDefaults, liveWhatsAppMarketing } from '../../marketing/meta-ads/live-create.js'
import { accountDelivering } from '../../marketing/meta-ads/live-brand-safety.js'
import { specOptionIds, targetingCheck, TARGETING_SPEC } from '../../marketing/meta-ads/live-targeting.js'
import {
  adSetWho, placePageSetDraft, restoreArgs, targetingDraft, TUNE_WORDS, type AudienceAsk, type PlacePageSetAsk, type TargetingRecord,
} from '../../marketing/meta-ads/change-targeting.js'
import { placementRestoreArgs, placementsDraft, type PlacementsAsk } from '../../marketing/meta-ads/change-placements.js'
import { accountControlsDraft, normalPlacement, type AccountControlsAsk, type AccountControlsRecord } from '../../marketing/meta-ads/change-account-controls.js'
import prisma from '../../../db.js'
import {
  ACCOUNT_PLACEMENT_EXCLUSIONS, AUDIENCE_NETWORK_POSITIONS, AUDIENCE_TARGETING_KEYS, COUNTRY_GROUPS, DEVICE_PLATFORMS, FACEBOOK_POSITIONS, INSTAGRAM_POSITIONS,
  MAX_RETENTION_DAYS, MESSENGER_POSITIONS, PLACEMENT_TARGETING_KEYS, PRODUCT_EVENTS, PUBLISHER_PLATFORMS, THREADS_POSITIONS, TUNE_CATEGORIES, WHATSAPP_POSITIONS,
  targetingView,
} from '../../gateway/meta-targeting-rules.js'
import { isReadOnlyTargetingKey } from '../../gateway/meta-brand-safety-rules.js'
import type { MetaChangeAccount } from '../../marketing/meta-ads/change-account.js'
import type { MetaChangeDraft } from '../../marketing/meta-ads/change-draft.js'

type Row = Record<string, unknown>
const plainObject = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)

// ── undo: only from the change's own record (review A1) ──────────────────────────────────────────────────────────────

type TargetingTool = 'set-meta-targeting' | 'set-meta-placements' | 'set-meta-account-controls'
const undoArg = z.literal(true).optional().describe('ONLY the undo of an earlier change of this tool (undo-change asks for it with undoOf): puts back what that change replaced, from its own record')
const undoOfArg = z.string().trim().min(1).max(64).optional().describe('with undo: the id of the change undone (its record holds the values put back — never values a caller names)')
const UNDO_ONLY = new Set(['connectionId', 'why', 'undo', 'undoOf'])

/**
 * The record of the change an undo puts back: read in this business (row-level security), of the same tool, not undone
 * yet, made on the ad account this business uses now. The values put back come only from it (never from a caller).
 * `run` (re-review 2): when the undo RUNS, its approval must be the one undo-change tied to that change
 * (change-record.service.ts linkUndoRequest sets undoneByApprovalId) — so undo-change's "moved since" and "already
 * waiting" checks were made, and the change is marked undone after it. A preview needs no such tie.
 */
async function undoRecord(tool: TargetingTool, args: Record<string, unknown>, account: MetaChangeAccount, run?: string | null): Promise<{ before: Row; after: Row } | { refusal: string }> {
  const extra = Object.keys(args).filter((k) => args[k] !== undefined && !UNDO_ONLY.has(k))
  if (extra.length) return { refusal: `undo puts back an earlier ${tool} change from its own record and takes nothing else (${extra.join(', ')}).` }
  const changeId = typeof args.undoOf === 'string' ? args.undoOf.trim() : ''
  if (!changeId) return { refusal: `undo is only the undo of an earlier ${tool} change (undo-change asks for it with undoOf): this tool puts back no values a caller names.` }
  const row = await prisma.agentChange.findFirst({ where: { id: changeId, toolName: tool }, select: { before: true, after: true, undoneAt: true, undoneByApprovalId: true } })
  if (!row) return { refusal: `Change ${changeId} is not a ${tool} change of this business.` }
  if (row.undoneAt) return { refusal: `Change ${changeId} was undone already.` }
  if (run !== undefined && (!run || row.undoneByApprovalId !== run)) return { refusal: `an undo runs through undo-change, and this request is not the one undo-change tied to change ${changeId}.` }
  const before = (row.before ?? {}) as Row
  const after = (row.after ?? {}) as Row
  const on = (r: Row) => (typeof r.adAccountId === 'string' ? r.adAccountId : null)
  if ((on(after) ?? on(before)) !== account.adAccountId) return { refusal: `Change ${changeId} was made on another Meta ad account than the one this business uses now: Nexus puts nothing back there.` }
  return { before, after }
}

/** Review A1 — values a caller names as a "restore" are never taken (only an undo's record is). */
const callerRestore = (args: Record<string, unknown>): string | null => {
  const items = Array.isArray(args.adSets) ? args.adSets as Row[] : []
  if (items.some((i) => plainObject(i) && (i.restore !== undefined || i.restoreSoftOptOut !== undefined)) || args.restore !== undefined) {
    return 'Nexus takes no values to put back from a caller: an undo puts back what the change\'s own record holds (undo-change).'
  }
  return null
}
const refusalOf = async (work: () => Promise<MetaChangeDraft | { refusal: string }>): Promise<MetaChangeDraft | { refusal: string }> => {
  try { return await work() } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    throw err
  }
}

/**
 * At Meta's Limited access tier an ad account has about 60 points per 5 minutes (a read 1, a change 3): each ad set is
 * read at the preview (with Meta's estimate and option checks), at the gate's re-check and at the run, by the gateway once
 * more, changed and read back — about 15 points at most, so 3 ad sets stay inside one window.
 */
const MAX_AD_SETS = 3

// ── arguments ───────────────────────────────────────────────────────────────────────────────────────────────────────

const digits = z.string().trim().regex(/^\d{1,20}$/, 'a Meta id or key is digits')
const unit = z.enum(['kilometer', 'mile']).optional().describe('kilometer (default) or mile')
const keyList = (what: string, max = 250) => z.array(digits).max(max).optional().describe(`${what} (keys from meta-targeting-search kind location)`)
const locationArg = (verb: 'add' | 'remove') => z.object({
  countries: z.array(z.string().trim().regex(/^[A-Z]{2}$/, 'a country is its ISO code in capitals (IT, DE)')).max(250).optional().describe('countries by ISO code (IT, DE)'),
  countryGroups: z.array(z.enum(COUNTRY_GROUPS)).max(COUNTRY_GROUPS.length).optional().describe('Meta\'s country groups (europe, eea, worldwide, …)'),
  regions: keyList('regions'),
  zips: z.array(z.string().trim().max(20)).max(250).optional().describe('postcodes as COUNTRY:CODE (IT:20121)'),
  geoMarkets: z.array(z.string().trim().max(30)).max(250).optional().describe('US TV markets as COMSCORE_MARKET:<number>'),
  electoralDistricts: z.array(z.string().trim().max(20)).max(250).optional().describe('US electoral districts as COUNTRY:CODE'),
  cities: z.array(z.object({ key: digits.describe('the city key'), radius: z.number().positive().max(80).optional().describe('a radius around it: 17–80 km or 10–50 mi'), unit })).max(250).optional()
    .describe(verb === 'add' ? 'cities (a city already there takes the new radius)' : 'cities by key'),
  places: z.array(z.object({ key: digits.describe('the place key'), radius: z.number().positive().max(80).optional().describe('a radius: 1–80 km or 0.63–50 mi'), unit })).max(200).optional().describe('places'),
  customLocations: z.array(z.object({
    latitude: z.number().min(-90).max(90).optional().describe('the pin\'s latitude'),
    longitude: z.number().min(-180).max(180).optional().describe('the pin\'s longitude'),
    address: z.string().trim().min(3).max(300).optional().describe('or a street address (no PO box alone)'),
    radius: z.number().positive().max(80).optional().describe('the radius: 1–80 km or 0.63–50 mi (required to add)'),
    unit,
    key: z.string().trim().max(80).optional().describe('remove: Meta\'s key of the pin, when it has one'),
  })).max(200).optional().describe(verb === 'add' ? 'a pin (latitude, longitude) or an address, with a radius' : 'pins by latitude and longitude, address or key'),
  largeGeoAreas: keyList('large geo areas (SDK only: Meta\'s answer decides)'), mediumGeoAreas: keyList('medium geo areas (SDK only)'), smallGeoAreas: keyList('small geo areas (SDK only)'),
  metroAreas: keyList('metro areas (SDK only)'), subcities: keyList('subcities (SDK only)'), neighborhoods: keyList('neighborhoods (SDK only)'),
  subneighborhoods: keyList('subneighborhoods (SDK only)'), politicalDistricts: keyList('political districts (SDK only)'),
}).describe(verb === 'add' ? 'places to add' : 'places to remove (each must be there)')
const locationChange = (what: string) => z.object({ add: locationArg('add').optional(), remove: locationArg('remove').optional() }).optional()
  .describe(`${what}: add / remove places by Meta's keys (no "living in / recently in" choice: Meta reaches both)`)
const idChange = (what: string, maxAdd = 70) => z.object({
  add: z.array(digits).max(maxAdd).optional().describe(`${what} to add (each the chosen ad account's own)`),
  remove: z.array(digits).max(250).optional().describe(`${what} to remove`),
}).optional().describe(what)
const options = (what: string) => z.array(digits).max(250).optional().describe(`${what} ids (meta-targeting-search)`)
const detailedGroup = z.object({
  interests: options('interests'), behaviors: options('behaviours'), lifeEvents: options('life events'), industries: options('industries'),
  income: options('income brackets'), familyStatuses: options('family statuses'), broadCategories: options('broad categories (user_adclusters)'),
  workPositions: options('job titles'), workEmployers: options('employers'), educationSchools: options('schools'), educationMajors: options('fields of study'),
  educationStatuses: z.array(z.number().int().min(1).max(13)).max(13).optional().describe('education levels (Meta\'s codes 1–13)'),
  relationshipStatuses: z.array(z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(6)])).max(5).optional().describe('relationship statuses (1 single, 2 in a relationship, 3 married, 4 engaged, 6 not specified; never 0 or 5)'),
  collegeYears: z.array(z.number().int().min(1980).max(2100)).max(50).optional().describe('college graduation years (from 1980)'),
  customAudiences: z.array(digits).max(50).optional().describe('custom audiences inside the group (Meta may switch on Advantage custom audience for them)'),
}).describe('one group: people who match ANY of these')
const productAudience = z.object({
  productSetId: digits.describe('the product set (of the business\'s own catalog)'),
  include: z.array(z.object({ event: z.enum(PRODUCT_EVENTS).describe('the product event'), days: z.number().int().min(1).max(MAX_RETENTION_DAYS).describe('how many days back') })).min(1).max(10).describe('people who did one of these'),
  exclude: z.array(z.object({ event: z.enum(PRODUCT_EVENTS).describe('the product event'), days: z.number().int().min(1).max(MAX_RETENTION_DAYS).describe('how many days back') })).max(10).optional().describe('but not these'),
}).describe('a product audience (Advantage+ catalog ads retargeting)')
const textList = (what: string, pattern: RegExp, max = 50) => z.array(z.string().trim().regex(pattern, `${what}: Meta's values`)).max(max).optional().describe(`${what} — the whole list ([] removes it)`)

const audienceItem = z.object({
  adSetId: metaIdArg('the ad set (of the chosen ad account)'),
  locations: locationChange('where its ads run (TG-040–048)'),
  excludedLocations: locationChange('places it excludes (TG-050)'),
  ageMin: z.number().int().min(13).max(65).optional().describe('minimum age 13–65 (Meta\'s default 18; under 18 never in the EU, EEA or Switzerland)'),
  ageMax: z.number().int().min(13).max(65).optional().describe('maximum age 13–65 (65 = 65+); not with Advantage+ audience on'),
  genders: z.enum(['all', 'men', 'women']).optional().describe('all, men or women'),
  languages: z.array(z.number().int().min(1).max(100_000)).max(50).optional().describe('language ids (meta-targeting-search kind language) — the whole list ([] = every language)'),
  detailedTargeting: z.array(detailedGroup).max(25).optional().describe('the WHOLE detailed targeting: groups that must ALL match (AND), each matched by ANY of its options (OR); [] removes it. Read the ad set\'s targeting first (meta-ad-sets) and name every group it should keep'),
  excludedEmployers: idChange('employers to exclude (TG-056: Meta takes only employer exclusions, and a new one only when the account\'s controls exclude it too)', 50),
  audiences: idChange('custom audiences or lookalikes to include'),
  excludedAudiences: idChange('custom audiences to exclude (e.g. recent buyers)'),
  advantageAudience: z.boolean().optional().describe('Advantage+ audience on or off (on: Meta may reach beyond the ages, gender and detailed targeting; the minimum age stays a hard limit, ≤ 25)'),
  ageRange: z.array(z.number().int().min(18).max(65)).length(2).nullable().optional().describe('the suggested age range with Advantage+ audience or age suggestions on (null removes it)'),
  advantageDetailedTargeting: z.boolean().optional().describe('Advantage detailed targeting: Meta may go beyond the detailed targeting'),
  advantageLookalike: z.boolean().optional().describe('Advantage lookalike: Meta may go beyond the lookalikes'),
  advantageCustomAudience: z.boolean().optional().describe('Advantage custom audience: Meta may go beyond the custom audiences'),
  suggestions: z.object({
    age: z.boolean().optional().describe('use the age range as a suggestion (Sales and App promotion only)'),
    gender: z.boolean().optional().describe('use the gender as a suggestion (Sales and App promotion only)'),
    geo: z.boolean().optional().describe('also reach people interested in the chosen cities and regions'),
  }).optional().describe('age, gender and city suggestions (targeting_automation.individual_setting)'),
  creativeAudiencePairing: z.boolean().optional().describe('let Meta pair creatives with audiences (needs a persona on the ad)'),
  excludeReachedSince: z.array(z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date YYYY-MM-DD')).max(10).optional().describe('exclude people this account reached since these dates (Meta documents the field only: its answer decides); [] removes it'),
  productAudiences: z.array(productAudience).max(20).optional().describe('the whole list of product audiences to include ([] removes it)'),
  excludedProductAudiences: z.array(productAudience).max(20).optional().describe('the whole list of product audiences to exclude ([] removes it)'),
  dynamicAudiences: idChange('dynamic (product) audiences to include', 50),
  excludedDynamicAudiences: idChange('dynamic (product) audiences to exclude', 50),
  placePageSets: idChange('place page sets (local Pages under the chosen Page)', 30),
  devices: z.array(z.enum(DEVICE_PLATFORMS)).max(DEVICE_PLATFORMS.length).optional().describe('devices: mobile, desktop, connected_tv — the whole list ([] = all)'),
  operatingSystems: textList('operating systems (iOS, Android, iOS_ver_8.0_to_9.0)', /^[A-Za-z0-9_.]{1,40}$/, 20),
  phones: textList('phones to include (meta-targeting-search kind category, class user_device)', /^[A-Za-z0-9_ .+()/-]{1,80}$/, 100),
  excludedPhones: textList('phones to exclude', /^[A-Za-z0-9_ .+()/-]{1,80}$/, 100),
  excludedPhoneModels: textList('phone models to exclude', /^[A-Za-z0-9_ .+()/-]{1,80}$/, 100),
  wifiOnly: z.boolean().optional().describe('show ads only on Wi-Fi'),
  keywords: z.array(z.string().trim().min(1).max(100)).max(100).optional().describe('contextual keywords (Meta documents the field only) — the whole list ([] removes it)'),
  contextualCategories: z.array(digits).max(100).optional().describe('contextual targeting categories by id — the whole list ([] removes it)'),
  siteCategories: textList('site categories (Meta documents the field only)', /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/, 20),
  tuneForCategory: z.enum(TUNE_CATEGORIES).optional().describe('ALONE: let Meta make the targeting fit a special ad category (or NONE); Meta removes and changes options itself'),
}).describe('one ad set and what changes on it')

const placePageSetArg = z.object({
  name: z.string().trim().min(1).max(200).describe('the place page set\'s name'),
  locationTypes: z.array(z.enum(['home', 'recent'])).max(2).optional().describe('people who live near the Pages (home) and / or were recently there (recent)'),
  targetedAreaType: z.enum(['CUSTOM_RADIUS', 'MARKETING_AREA', 'NONE']).optional().describe('SDK only: the area type'),
  background: z.boolean().optional().describe('let Meta make it in the background (SDK only)'),
}).describe('instead of ad sets: make a place page set under the business\'s chosen Page (TG-018)')

// ── the preview's own checks (step 9's meta-targeting-check), never on a re-check or a run ─────────────────────────────

const GEO_ITEM_KEYS: Readonly<Record<string, readonly string[]>> = {
  regions: ['key'], zips: ['key'], geo_markets: ['key'], electoral_districts: ['key'], subcities: ['key'], neighborhoods: ['key'], large_geo_areas: ['key'],
  medium_geo_areas: ['key'], small_geo_areas: ['key'], metro_areas: ['key'], cities: ['key', 'radius', 'distance_unit'], places: ['key', 'radius', 'distance_unit'],
  custom_locations: ['latitude', 'longitude', 'radius', 'distance_unit'],
}
/** The keys step 9's estimate takes (its zod allow-list). */
const ESTIMATED_KEYS = new Set(Object.keys((TARGETING_SPEC as unknown as { shape: Row }).shape ?? {}))

/** A spec in the shape step 9's estimate takes (its allow-list), or the keys it cannot carry. */
export function estimateSpecOf(spec: Row): { spec: Row } | { cannot: string[] } {
  const out: Row = {}
  const cannot: string[] = []
  const geo = (g: unknown) => {
    if (!plainObject(g)) return undefined
    const o: Row = {}
    for (const [k, v] of Object.entries(g)) {
      if (k === 'location_types') continue
      if (k === 'countries' || k === 'country_groups') { o[k] = v; continue }
      const keep = GEO_ITEM_KEYS[k]
      if (!keep || !Array.isArray(v)) { cannot.push(`geo ${k}`); continue }
      o[k] = v.map((item) => Object.fromEntries(Object.entries(item as Row).filter(([x]) => keep.includes(x)).map(([x, y]) => [x, x === 'key' ? String(y) : x === 'radius' ? Number(y) : y])))
      if (k === 'custom_locations' && (v as Row[]).some((item) => typeof item.latitude !== 'number')) cannot.push('an address pin')
    }
    return o
  }
  const ids = (v: unknown) => (Array.isArray(v) ? v.map((x) => ({ id: String(plainObject(x) ? x.id : x) })) : v)
  const group = (g: unknown) => (plainObject(g) ? Object.fromEntries(Object.entries(g).map(([k, v]) => [k, Array.isArray(v) && v.every((x) => plainObject(x)) ? ids(v) : v])) : g)
  for (const [k, v] of Object.entries(spec)) {
    if (isReadOnlyTargetingKey(k)) continue
    if (k === 'geo_locations' || k === 'excluded_geo_locations') { out[k] = geo(v); continue }
    if (k === 'flexible_spec') { out[k] = Array.isArray(v) ? v.map(group) : v; continue }
    if (k === 'custom_audiences' || k === 'excluded_custom_audiences') { out[k] = ids(v); continue }
    if (k === 'targeting_automation') { if (plainObject(v) && (v.advantage_audience === 0 || v.advantage_audience === 1)) out[k] = { advantage_audience: v.advantage_audience }; continue }
    if (k === 'exclusions') { if (plainObject(v) && Object.keys(v).every((x) => x === 'work_employers')) out[k] = { work_employers: ids(v.work_employers) }; else cannot.push('detailed exclusions'); continue }
    if (!ESTIMATED_KEYS.has(k)) { cannot.push(k); continue }
    out[k] = (OPTION_KEYS.has(k) ? ids(v) : v)
  }
  return cannot.length ? { cannot } : { spec: out }
}
const OPTION_KEYS = new Set(['interests', 'behaviors', 'life_events', 'industries', 'income', 'family_statuses', 'user_adclusters', 'work_positions', 'work_employers', 'education_schools', 'education_majors'])

const people = (n: unknown) => (typeof n === 'number' ? n.toLocaleString('en') : '?')
const why = (err: unknown) => (err instanceof MetaLiveRefusal || err instanceof MetaReadError ? err.message : null)

/** Meta's estimate before → after, the new options checked, retired options of the ad set — in words, for the preview only. */
async function previewChecks(account: MetaChangeAccount, draft: MetaChangeDraft, states: Map<string, TargetingAdSetState>): Promise<string[]> {
  const out: string[] = []
  for (const request of draft.requests) {
    const state = states.get(request.objectId)
    if (!state || !request.params.targeting) continue
    const who = adSetWho(state)
    const spec = JSON.parse(request.params.targeting) as Row
    const shaped = estimateSpecOf(spec)
    if ('cannot' in shaped) out.push(`Meta's estimate is not shown for ${who}: its targeting holds ${shaped.cannot.join(', ')}, which Nexus's estimate does not take (meta-targeting-check adSetId estimates it as it is).`)
    else {
      try {
        const est = await targetingCheck({ connectionId: account.accountId, check: 'delivery', adSetId: state.id, targeting: shaped.spec }) as Row
        const b = plainObject(est.before) ? est.before : {}
        const a = plainObject(est.after) ? est.after : {}
        out.push(`Meta's estimate for ${who}: about ${people(b.estimateMauLowerBound)}–${people(b.estimateMauUpperBound)} monthly active people now; about ${people(a.estimateMauLowerBound)}–${people(a.estimateMauUpperBound)} with this change (an estimate, never a promise).`)
      } catch (err) {
        const words = why(err)
        if (words === null) throw err
        out.push(`Meta's estimate for ${who} could not be read: ${words}`)
      }
    }
    // The options this change adds, checked by Meta (targetingvalidation); exclusions as exclusions.
    const had = new Set(specOptionIds(state.targeting).map((o) => `${o.where.replace(/^flexible_spec\[\d+\]\./, '')}:${o.id}`))
    const added = specOptionIds(spec).filter((o) => !had.has(`${o.where.replace(/^flexible_spec\[\d+\]\./, '')}:${o.id}`))
    for (const exclusion of [false, true]) {
      const items = added.filter((o) => o.where.startsWith('exclusions.') === exclusion).slice(0, 50)
      if (!items.length) continue
      try {
        const check = await targetingCheck({ connectionId: account.accountId, check: 'options', options: items.map((o) => ({ type: o.where.split('.').pop()!, id: o.id })), isExclusion: exclusion }) as { items?: Row[] }
        const bad = (check.items ?? []).filter((i) => i.valid === false).map((i) => String(i.id ?? i.key ?? '?'))
        if (bad.length) out.push(`Meta's check says ${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not usable${exclusion ? ' to exclude people' : ''} (retired, renamed or refused): Meta will refuse this change unless ${bad.length === 1 ? 'it is' : 'they are'} removed.`)
      } catch (err) {
        const words = why(err)
        if (words === null) throw err
        out.push(`Meta could not check the new options of ${who}: ${words}`)
      }
    }
    try {
      const status = await targetingCheck({ connectionId: account.accountId, check: 'status', adSetId: state.id }) as { retiring?: number; items?: Row[] }
      // Only the retiring options the NEW spec still holds (one this change drops is fine).
      const kept = new Set(specOptionIds(spec).map((o) => o.id))
      const ids = (status.items ?? []).filter((i) => (i.currentStatus === 'DEPRECATING' || i.currentStatus === 'NON-DELIVERABLE') && kept.has(String(i.id))).map((i) => String(i.id))
      if (status.retiring && ids.length) {
        out.push(`${who} holds option${ids.length === 1 ? '' : 's'} Meta is retiring (${ids.slice(0, 10).join(', ')}): Meta rejects an edit of an ad set that still holds ${ids.length === 1 ? 'it' : 'them'} — drop ${ids.length === 1 ? 'it' : 'them'} in this change.`)
      }
    } catch (err) {
      if (why(err) === null) throw err
    }
  }
  return out
}

// ── set-meta-targeting ────────────────────────────────────────────────────────────────────────────────────────────

const audienceAsks = (args: Record<string, unknown>): AudienceAsk[] => (Array.isArray(args.adSets) ? args.adSets as AudienceAsk[] : [])

const buildTargeting = (args: Record<string, unknown>, opts: { preview: boolean; run?: string | null }): MetaDraftBuilder => (account) => refusalOf(async () => {
  const restoreByCaller = callerRestore(args)
  if (restoreByCaller) return { refusal: restoreByCaller }
  let items = audienceAsks(args)
  if (args.undo === true) {
    const record = await undoRecord('set-meta-targeting', args, account, opts.run)
    if ('refusal' in record) return record
    if (plainObject(record.after.placePageSet)) return { refusal: 'Meta documents no delete of a place page set: Nexus cannot take it back.' }
    const back = restoreArgs(record.before as TargetingRecord, record.after as TargetingRecord, AUDIENCE_TARGETING_KEYS)
    if ('refusal' in back) return back
    items = back
  }
  const pageSet = plainObject(args.createPlacePageSet) ? args.createPlacePageSet as unknown as PlacePageSetAsk : null
  if (!!items.length === !!pageSet) return { refusal: 'Name either adSets (their targeting) or createPlacePageSet (a new place page set) — one of them.' }
  if (args.undo === true && pageSet) return { refusal: 'An undo takes nothing else.' }
  if (pageSet) return placePageSetDraft(pageSet, { adAccountId: account.adAccountId, pageId: await liveChosenPage(account.target) })
  const states = new Map<string, TargetingAdSetState>()
  for (const item of items) if (!states.has(item.adSetId)) states.set(item.adSetId, await liveTargetingAdSet(account, item.adSetId))
  const dsaDefaults = await liveDsaDefaults(account.target)
  // TG-056 — the account's own employer exclusions, read only when the change adds one.
  let accountExcludedEmployers: string[] | null = null
  if (items.some((i) => i.excludedEmployers?.add?.length)) {
    try {
      const controls = await liveAccountControls(account)
      const ex = plainObject(controls.audience?.exclusions) ? controls.audience!.exclusions as Row : {}
      accountExcludedEmployers = Array.isArray(ex.work_employers) ? ex.work_employers.map((x) => String(plainObject(x) ? x.id : x)) : []
    } catch (err) {
      if (!(err instanceof MetaLiveRefusal)) throw err
    }
  }
  const draft = targetingDraft(items, { adSets: states, dsaDefaults, accountExcludedEmployers })
  if (opts.preview && !('refusal' in draft)) draft.warnings.push(...await previewChecks(account, draft, states))
  return draft
})

const targetingUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as TargetingRecord & { accountId?: string; adAccountId?: string }
    if (after.placePageSet !== undefined) return after
    const account = await recordAccount(after)
    if (!account) return null
    try {
      const adSets = []
      for (const a of after.adSets ?? []) {
        const live = (await liveTargetingAdSet(account, a.id)).targeting
        adSets.push({ id: a.id, name: a.name, keys: Object.fromEntries(Object.keys(a.keys).map((k) => [k, targetingView(live[k] ?? null)])) })
      }
      return { ...after, adSets }
    } catch (err) {
      if (err instanceof MetaLiveRefusal) return null
      throw err
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as TargetingRecord & { accountId?: string }
    const after = (change.after ?? {}) as TargetingRecord
    if (after.placePageSet !== undefined) return { refusal: 'Meta documents no delete of a place page set: Nexus cannot take it back (it targets nothing until an ad set names it).' }
    const back = restoreArgs(before, after, AUDIENCE_TARGETING_KEYS)
    if ('refusal' in back) return back
    // Review A1 — the record's id only: the tool reads what it puts back from that record itself.
    return { tool: 'set-meta-targeting', args: { ...(before.accountId ? { connectionId: before.accountId } : {}), undo: true, ...(change.id ? { undoOf: change.id } : {}), why: after.tuned ? 'undo of an earlier Meta re-tune for a special ad category (the old whole targeting)' : 'undo of an earlier Meta targeting change' } }
  },
}

/** The record after the run: each ad set's keys as Meta read them back (a tune: the whole spec Meta made). */
function targetingFinish(draft: MetaChangeDraft, done: Array<{ request: { objectId: string }; result: { node: Record<string, unknown> | null } }>) {
  const before = draft.before as TargetingRecord
  let after = draft.after as TargetingRecord
  if (before.placePageSet !== undefined) {
    const id = createdIdOf(done[0]?.result.node ?? null)
    after = { placePageSet: { ...(after.placePageSet ?? { name: '', background: false }), id } }
    return { data: { placePageSet: after.placePageSet, note: id ? 'meta-targeting-search kind place-page-sets shows it.' : 'Meta made it in the background (or named no id): meta-targeting-search kind place-page-sets shows it once made.' }, before, after }
  }
  const made = new Map(done.map((d) => [d.request.objectId, d.result.node]))
  const keep = (r: TargetingRecord) => (r.adSets ?? []).filter((a) => made.has(a.id))
  const adSets = keep(after).map((a) => {
    const t = made.get(a.id)?.targeting
    if (!plainObject(t)) return after.tuned ? { ...a, keys: {} } : a
    const keys = after.tuned
      ? Object.fromEntries([...new Set([...Object.keys(a.keys), ...Object.keys(t)])].filter((k) => !isReadOnlyTargetingKey(k)).map((k) => [k, targetingView(t[k] ?? null)]))
      : Object.fromEntries(Object.keys(a.keys).map((k) => [k, targetingView(t[k] ?? null)]))
    return { ...a, keys }
  })
  const b = { adSets: keep(before) }
  const recorded = { adSets, ...(after.tuned ? { tuned: after.tuned } : {}) }
  return { data: { adSets: adSets.map((a) => ({ id: a.id, name: a.name, changed: Object.keys(a.keys) })), ...(after.tuned ? { tuned: `${after.tuned.id}: ${TUNE_WORDS[after.tuned.category as keyof typeof TUNE_WORDS] ?? after.tuned.category}` } : {}) }, before: b, after: recorded }
}

const READ_AFTER = async () => 'meta-ad-sets and meta-ads-live show the targeting now (Nexus keeps no copy of it); meta-targeting-check describe says it in Meta\'s words.'

const setMetaTargeting: AgentTool = {
  name: 'set-meta-targeting',
  title: 'Meta ad set targeting',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // An ad set's keys are put back in full; a re-tune is put back as the old whole targeting (what Meta removed is sent
  // again); a place page set cannot be deleted (Meta documents no delete).
  reversibility: 'partial',
  consequencesFor: (args) => (plainObject(args.createPlacePageSet) ? { reversibility: 'none' }
    : Array.isArray(args.adSets) && args.adSets.length && !(args.adSets as Row[]).some((i) => i.tuneForCategory) ? { reversibility: 'full' } : null),
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: z.object({
    connectionId: metaConnectionArg,
    adSets: z.array(audienceItem).min(1).max(MAX_AD_SETS).optional().describe(`the ad sets and what changes on each (at most ${MAX_AD_SETS}: Meta's Limited access tier)`),
    createPlacePageSet: placePageSetArg.optional(),
    undo: undoArg,
    undoOf: undoOfArg,
    why: metaWhyArg,
  }),
  description:
    'The audience of ad sets of the business\'s chosen Meta ad account: locations to add or remove (countries, country '
    + 'groups, regions, cities with a radius, postcodes, places, a pin or an address with a radius, US TV markets and '
    + 'districts, Meta\'s other area keys) and places to exclude; ages, genders, languages; the WHOLE detailed targeting '
    + '(groups that must all match, each by any of its interests, behaviours, demographics, broad categories or audiences); '
    + 'employer exclusions (Meta refuses other detailed exclusions since v22: exclude a custom audience instead); custom, '
    + 'lookalike, dynamic and product audiences in and out; place page sets; Advantage+ audience (always sent explicitly: '
    + 'off unless asked), age suggestions, Advantage detailed targeting, lookalike and custom-audience expansion, age / '
    + 'gender / city suggestions, creative-audience pairing; people reached since a date; devices, operating systems, '
    + 'phones, Wi-Fi only; contextual keywords and categories; or tuneForCategory (alone: Meta makes the targeting fit a '
    + 'special ad category itself). Or createPlacePageSet: a place page set under the chosen Page (no delete exists). '
    + 'No "living in / recently in" choice: Meta reaches both. Not sent, with Meta\'s reason: connections (deprecated, '
    + '1870088), engagement_specs (shape undocumented: use an engagement custom audience), prospecting_audience and '
    + 'alternate_auto_targeting_option (one line each on Meta\'s Targeting reference), Advantage+ audience\'s '
    + 'shared_audiences and value_expression (on no page: kept exactly as Meta has them), subscriber_universe (read-only: '
    + 'the WhatsApp customer base is set in Ads Manager) and is_whatsapp_destination_ad (one line, no use documented). The ad set\'s targeting goes '
    + 'whole: every other part goes back exactly as Meta has it, and the gateway reads it again and sends nothing if '
    + 'anything else would change; every audience, product set and place page set it adds must be the account\'s own. '
    + 'The preview shows Meta\'s estimate before → after and checks new options. Reaching more people on an ad set that '
    + 'is on is SPENDS MONEY; newly reaching the EU needs the EU payer and beneficiary (the ad set\'s or the account\'s '
    + 'saved defaults); under-18s never in the EU, EEA or Switzerland; a special ad category\'s limits are kept. A '
    + 'targeting change sends the ad set\'s ads back to Meta\'s review. Placements are set-meta-placements; brand safety '
    + 'set-meta-brand-safety. Meta documents no check for this change (validate_only on an ad set update). Undo puts back '
    + 'what it changed, from the change\'s own record.'
    + META_CHANGE_RULES,
  undo: targetingUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildTargeting(args, { preview: !ctx.approvalId })),
  execute: (args, ctx) => runMetaChange(args, ctx, buildTargeting(args, { preview: false, run: ctx.approvalId ?? null }), targetingFinish, READ_AFTER),
}

// ── set-meta-placements ───────────────────────────────────────────────────────────────────────────────────────────

const positionsArg = (platform: string, values: readonly string[]) => z.array(z.enum(values as [string, ...string[]])).max(values.length).optional()
  .describe(`${platform} positions: ${values.join(', ')} — the whole list ([] = every ${platform} position)`)
const softArg = z.object({
  facebookPositions: z.array(z.enum(FACEBOOK_POSITIONS)).max(FACEBOOK_POSITIONS.length).optional().describe('excluded Facebook positions that may still take up to 5% of spend'),
  instagramPositions: z.array(z.enum(INSTAGRAM_POSITIONS)).max(INSTAGRAM_POSITIONS.length).optional().describe('excluded Instagram positions'),
  threadsPositions: z.array(z.enum(THREADS_POSITIONS)).max(THREADS_POSITIONS.length).optional().describe('excluded Threads positions'),
  messengerPositions: z.array(z.enum(MESSENGER_POSITIONS)).max(MESSENGER_POSITIONS.length).optional().describe('excluded Messenger positions'),
  audienceNetworkPositions: z.array(z.enum(AUDIENCE_NETWORK_POSITIONS)).max(AUDIENCE_NETWORK_POSITIONS.length).optional().describe('excluded Audience Network positions'),
}).nullable().optional().describe('limited spend on excluded placements: Meta may spend up to 5% on each named one (the whole setting; null clears it)')

const placementsItem = z.object({
  adSetId: metaIdArg('the ad set (of the chosen ad account)'),
  advantagePlacements: z.boolean().optional().describe('true: Advantage+ placements — every placement key removed, Meta places the ads (and may add new placements)'),
  platforms: z.array(z.enum(PUBLISHER_PLATFORMS)).max(PUBLISHER_PLATFORMS.length).optional().describe('platforms: facebook, instagram, threads, messenger, audience_network, whatsapp — the whole list ([] = every platform; Audience Network never alone)'),
  facebookPositions: positionsArg('Facebook', FACEBOOK_POSITIONS),
  instagramPositions: positionsArg('Instagram', INSTAGRAM_POSITIONS),
  threadsPositions: positionsArg('Threads', THREADS_POSITIONS),
  audienceNetworkPositions: positionsArg('Audience Network', AUDIENCE_NETWORK_POSITIONS),
  messengerPositions: positionsArg('Messenger', MESSENGER_POSITIONS),
  whatsappPositions: positionsArg('WhatsApp', WHATSAPP_POSITIONS),
  userAgeUnknown: z.boolean().optional().describe('reach people whose age is unknown (WhatsApp Status only)'),
  instreamSkippableExcluded: z.boolean().optional().describe('true: no skippable in-stream video ads'),
  instreamSponsorshipPlacements: z.array(z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/, 'Meta\'s value')).max(20).optional().describe('in-stream sponsorship placements as Meta names them (pre-roll / mid-roll; values undocumented) — [] removes them'),
  softOptOut: softArg,
}).describe('one ad set and its placements')

const placementsAsks = (args: Record<string, unknown>): PlacementsAsk[] => (Array.isArray(args.adSets) ? args.adSets as PlacementsAsk[] : [])
const needsWhatsApp = (items: PlacementsAsk[]) => items.some((i) => i.advantagePlacements || (i.whatsappPositions ?? []).includes('marketing_messages')
  || (Array.isArray(i.restore?.whatsapp_positions) && (i.restore!.whatsapp_positions as unknown[]).includes('marketing_messages')))

const buildPlacements = (args: Record<string, unknown>, run?: string | null): MetaDraftBuilder => (account) => refusalOf(async () => {
  const restoreByCaller = callerRestore(args)
  if (restoreByCaller) return { refusal: restoreByCaller }
  let items = placementsAsks(args)
  if (args.undo === true) {
    const record = await undoRecord('set-meta-placements', args, account, run)
    if ('refusal' in record) return record
    const back = placementRestoreArgs(record.before as TargetingRecord, record.after as TargetingRecord)
    if ('refusal' in back) return back
    items = back
  }
  if (!items.length) return { refusal: 'Name at least one ad set (adSets).' }
  const states = new Map<string, TargetingAdSetState>()
  for (const item of items) {
    const soft = item.softOptOut !== undefined || item.restoreSoftOptOut !== undefined
    if (!states.has(item.adSetId)) states.set(item.adSetId, await liveTargetingAdSet(account, item.adSetId, { softOptOut: soft }))
  }
  const whatsapp = needsWhatsApp(items) ? await liveWhatsAppMarketing(account.target) : { unread: 'not read (no WhatsApp marketing messages asked)' }
  return placementsDraft(items, { adSets: states, whatsapp })
})

const placementsUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as TargetingRecord & { accountId?: string; adAccountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    try {
      const adSets = []
      for (const a of after.adSets ?? []) {
        const live = (await liveTargetingAdSet(account, a.id)).targeting
        const soft = 'softOptOut' in a ? await liveSoftOptOut(account, a.id) : undefined
        adSets.push({
          id: a.id, name: a.name, keys: Object.fromEntries(Object.keys(a.keys).map((k) => [k, targetingView(live[k] ?? null)])),
          ...('softOptOut' in a ? { softOptOut: soft && plainObject(soft) && 'unread' in soft ? 'unread' : targetingView(soft && plainObject(soft) && Object.values(soft).some((v) => Array.isArray(v) && v.length) ? soft : null) } : {}),
        })
      }
      return { ...after, adSets }
    } catch (err) {
      if (err instanceof MetaLiveRefusal) return null
      throw err
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as TargetingRecord & { accountId?: string }
    const back = placementRestoreArgs(before, (change.after ?? {}) as TargetingRecord)
    if ('refusal' in back) return back
    return { tool: 'set-meta-placements', args: { ...(before.accountId ? { connectionId: before.accountId } : {}), undo: true, ...(change.id ? { undoOf: change.id } : {}), why: 'undo of an earlier Meta placements change' } }
  },
}

const setMetaPlacements: AgentTool = {
  name: 'set-meta-placements',
  title: 'Meta ad set placements',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: z.object({
    connectionId: metaConnectionArg,
    adSets: z.array(placementsItem).min(1).max(MAX_AD_SETS).optional().describe(`the ad sets and their placements (at most ${MAX_AD_SETS}: Meta's Limited access tier)`),
    undo: undoArg,
    undoOf: undoOfArg,
    why: metaWhyArg,
  }),
  description:
    'Where the ads of ad sets of the business\'s chosen Meta ad account show: advantagePlacements (every placement key '
    + 'removed — Meta places the ads and may add new positions or platforms later; with an account onboarded to WhatsApp '
    + 'marketing messages, those too), or platforms (Facebook, Instagram, Threads, Messenger, Audience Network, WhatsApp) '
    + 'and their positions by hand (Meta\'s v26 lists: Instagram Explore feed and Messenger Stories are gone; Audience '
    + 'Network never alone; Facebook story and notification never alone; Threads needs Instagram stream; WhatsApp Status '
    + 'needs Instagram story; Messenger sponsored messages go with nothing else; WhatsApp marketing messages only for an '
    + 'onboarded account); people whose age is unknown (WhatsApp Status); skippable in-stream ads out, in-stream '
    + 'sponsorship placements; and the limited spend on excluded placements (up to 5% on each named one). The targeting '
    + 'goes whole: every other part goes back exactly as Meta has it, and the gateway reads it again and sends nothing if '
    + 'anything else would change. More placements (or Advantage+ placements, or limited spend allowed) on an ad set that '
    + 'is on is SPENDS MONEY; leaving Advantage+ placements turns an Advantage+ campaign off (said). A placement change '
    + 'sends the ad set\'s ads back to Meta\'s review. Devices are set-meta-targeting\'s; the whole ad account\'s excluded '
    + 'placements set-meta-account-controls\'. Meta documents no check for this change (validate_only on an ad set '
    + 'update). Undo puts back what it changed, from the change\'s own record.'
    + META_CHANGE_RULES,
  undo: placementsUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildPlacements(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildPlacements(args, ctx.approvalId ?? null), (draft, done) => {
    const before = draft.before as TargetingRecord
    const after = draft.after as TargetingRecord
    const made = new Map(done.map((d) => [d.request.objectId, d.result.node]))
    const adSets = (after.adSets ?? []).filter((a) => made.has(a.id)).map((a) => {
      const node = made.get(a.id)
      const t = plainObject(node?.targeting) ? node!.targeting as Row : null
      const soft = node && 'placement_soft_opt_out' in node ? (plainObject(node.placement_soft_opt_out) && Object.values(node.placement_soft_opt_out).some((v) => Array.isArray(v) && v.length) ? node.placement_soft_opt_out : null) : undefined
      return {
        ...a,
        keys: t ? Object.fromEntries(Object.keys(a.keys).map((k) => [k, targetingView(t[k] ?? null)])) : a.keys,
        ...('softOptOut' in a ? { softOptOut: soft !== undefined ? targetingView(soft) : a.softOptOut } : {}),
      }
    })
    const b = { adSets: (before.adSets ?? []).filter((x) => made.has(x.id)) }
    return { data: { adSets: adSets.map((a) => ({ id: a.id, name: a.name, changed: [...Object.keys(a.keys), ...('softOptOut' in a ? ['placement_soft_opt_out'] : [])] })) }, before: b, after: { adSets } }
  }, async () => 'meta-ad-sets shows the placements now (targeting effective_* fields are Meta\'s own reading); Nexus keeps no copy.'),
}

// ── set-meta-account-controls ─────────────────────────────────────────────────────────────────────────────────────

const buildControls = (args: Record<string, unknown>, run?: string | null): MetaDraftBuilder => (account) => refusalOf(async () => {
  const restoreByCaller = callerRestore(args)
  if (restoreByCaller) return { refusal: restoreByCaller }
  let ask = args as unknown as AccountControlsAsk
  if (args.undo === true) {
    const record = await undoRecord('set-meta-account-controls', args, account, run)
    if ('refusal' in record) return record
    const before = record.before as unknown as AccountControlsRecord
    if (!before.exists || !plainObject(before.audience)) return { refusal: 'The ad account had no controls before that change, and Meta has no delete of account controls: a person loosens them in Ads Manager › Advertising settings.' }
    ask = { restore: { audienceControls: before.audience, placementControls: plainObject(before.placement) ? before.placement : null } }
  }
  return accountControlsDraft(ask, { adAccountId: account.adAccountId, controls: await liveAccountControls(account), delivering: await accountDelivering(account) })
})

const controlsUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as AccountControlsRecord & { accountId?: string; adAccountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    try {
      const now = await liveAccountControls(account)
      return { ...after, exists: now.exists, audience: targetingView(now.audience), placement: targetingView(normalPlacement(now.placement)) }
    } catch (err) {
      if (err instanceof MetaLiveRefusal) return null
      throw err
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as AccountControlsRecord & { accountId?: string }
    if (!before.exists || !plainObject(before.audience)) return { refusal: 'The ad account had no controls before this change, and Meta has no delete of account controls: a person loosens them in Ads Manager › Advertising settings.' }
    return {
      tool: 'set-meta-account-controls',
      args: { ...(before.accountId ? { connectionId: before.accountId } : {}), undo: true, ...(change.id ? { undoOf: change.id } : {}), why: 'undo of an earlier change of the Meta ad account\'s controls (the old whole controls)' },
    }
  },
}

const setMetaAccountControls: AgentTool = {
  name: 'set-meta-account-controls',
  title: 'Meta ad account controls',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // Put back by posting the old whole controls; controls made where there were none cannot be removed (no delete).
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: z.object({
    connectionId: metaConnectionArg,
    ageMin: z.number().int().min(13).max(65).optional().describe('the minimum age every campaign keeps (under 18 never in the EU, EEA or Switzerland)'),
    locations: locationChange('the places campaigns may reach (allowed locations)'),
    excludedLocations: locationChange('the places no campaign reaches'),
    excludedEmployers: idChange('employers no campaign reaches (Meta takes only employer exclusions here)', 50),
    placementExclusions: z.array(z.enum(ACCOUNT_PLACEMENT_EXCLUSIONS)).max(ACCOUNT_PLACEMENT_EXCLUSIONS.length).optional()
      .describe(`placements no campaign uses: ${ACCOUNT_PLACEMENT_EXCLUSIONS.join(', ')} — the whole list ([] clears it)`),
    campaignIdsForAdvantagePlacements: z.array(digits).max(50).optional().describe('campaign_ids_to_set_ap (campaigns of the chosen account; Meta documents only the field) — the whole list ([] removes it)'),
    undo: undoArg,
    undoOf: undoOfArg,
    why: metaWhyArg,
  }),
  description:
    'The controls of the business\'s chosen Meta ad account, which every campaign keeps: the minimum age, the places '
    + 'campaigns may reach and the places none reaches, the employers none reaches (Meta takes only employer exclusions '
    + 'here: 1870219), and the placements no campaign uses (Audience Network classic, rewarded and in-stream video, '
    + 'Facebook Marketplace, Facebook right column). Meta has no update or delete for them: Nexus posts them whole — what '
    + 'Meta holds now with only the named parts changed — and undo posts the old ones back (controls made where there were '
    + 'none cannot be removed again). Looser controls (a lower age, more places, fewer exclusions) while a campaign of the '
    + 'account delivers is SPENDS MONEY (also with none delivering: they hold for every campaign switched on later). '
    + 'Per-ad-set placements are set-meta-placements. Meta documents no check for this change (validate_only on this edge).'
    + META_CHANGE_RULES,
  undo: controlsUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildControls(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildControls(args, ctx.approvalId ?? null), (draft, done) => {
    const after = draft.after as AccountControlsRecord
    const row = done[0]?.result.node
    const read = row && Array.isArray(row.data) && plainObject(row.data[0]) ? row.data[0] as Row : null
    const recorded = read ? { exists: true, audience: targetingView(read.audience_controls ?? null), placement: targetingView(normalPlacement(plainObject(read.placement_controls) ? read.placement_controls : null)) } : after
    return { data: { controls: recorded }, before: draft.before, after: recorded }
  }, async () => 'meta-ad-account view controls shows the ad account\'s controls now.'),
}

export const META_ADS_TARGETING_CHANGE_TOOLS: AgentTool[] = [setMetaTargeting, setMetaPlacements, setMetaAccountControls]

/** For tests: the keys each tool may set. */
export const __targetingToolKeys = { audience: AUDIENCE_TARGETING_KEYS, placements: PLACEMENT_TARGETING_KEYS }
