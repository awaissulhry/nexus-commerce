/**
 * Meta step 21 (2026-10-21) — the write allow-list entries of set-meta-labels, set-meta-value-rules and
 * create-meta-reach-frequency: EXACT keys per edge and kind, every value judged, JSON in one spelling only (as Nexus writes
 * it), text only where a person types it (a label name, a value rule set's or rule's name). Every id inside a body (a label,
 * a value rule set, a reach & frequency prediction, the ad set a translation reads, a reserved campaign, the Page or
 * Instagram account a prediction names) is named to the gateway, which checks each is the chosen ad account's own (or its
 * chosen Page / Instagram account) before anything is sent (gateway.ts metaBodyIdsProblem); a label or a value rule set
 * changed by its own id is checked the same way (gateway.ts metaOwnerProblem: listed among the chosen ad account's own).
 *
 * Checked 2026-10-21 (developers.facebook.com/documentation/ads-commerce/marketing-api/…, `.md` pages, curl ≥ 3 s apart; Meta's
 * Python Business SDK facebook_business/adobjects/{adaccount,adset,campaign,adlabel,adsvalueadjustmentrulecollection,
 * reachfrequencyprediction}.py on GitHub main):
 *   - reference/ad-label.md: POST /act_{id}/adlabels `name` [required] → {id} (CMP-082); POST /{ad_label_id} `name`
 *     [required] renames it (CMP-083); DELETE /{ad_label_id}, no parameters (CMP-084); POST /{campaign_id}/adlabels
 *     `adlabels` list<Object> [required] ADDS ("adds new or reuses specified"; a name alone that matches no label creates it)
 *     (CMP-065); `adlabels` on POST /{object_id} "overrides all set of labels" (CMP-066, AS-087). The page lists no
 *     /{ad_set_id}/adlabels edge (RECHECK AS-085 CORRECTED): an ad set's labels go as the full list on POST /{ad_set_id}. At
 *     most 50 labels on one object; 100,000 per account. A label node names no account on v26: whose it is = the chosen ad
 *     account's own list (act_<id>/adlabels).
 *   - bidding/value-rules.md: POST /act_{id}/value_rule_set `name`, `rules` [{name, adjust_sign INCREASE | DECREASE,
 *     adjust_value 1–1000 | 1–90, criterias [{criteria_type, operator CONTAINS, criteria_values, criteria_value_types}]}] —
 *     ≤ 10 rules, ≤ 4 criteria per rule, two criteria of one rule never the same type (bidding-and-optimization/
 *     bid-multiplier.md "Value rules concepts"); LOCATION_DMA replaced by LOCATION_COMSCORE_MARKET from 2026-06-22 (rules
 *     with DMAs no longer active: never sent). Update: POST /{value_rule_set_id} with the whole set, each kept rule's and
 *     criterion's `id` (omitted ones are removed). Delete: POST /{value_rule_set_id}/delete_rule_set with an EMPTY body →
 *     {success: true}. Attach: POST /{ad_set_id} value_rule_set_id + value_rules_applied=true; detach: ONLY
 *     value_rules_applied=false (a valid id sent with false attaches it anyway: RECHECK AS-097). Moving an ad set off legacy
 *     bid multipliers: `bid_adjustments={}` with the attach (bid-multiplier.md "Migrate ad sets…": "only supported when
 *     attaching value rules", not reversible). Translation: POST /act_{id}/value_rule_set_translation `source`
 *     {"bid_multiplier_ad_set_id": <ad set>} → a proposed value rule set, nothing created (bid-multiplier.md "Translation
 *     API"; not on any reference page: STILL-UNVERIFIED AS-098, LIVE-PROBES). SDK create also names `product_type`
 *     (AUDIENCE | LEADGEN_ADS | OMNI_CHANNEL) and `entry_point` (an Ads Manager surface: never sent).
 *     The guides send these as a JSON body; Meta's SDK (facebook_business/api.py) sends the same parameters as form fields
 *     with list / map values JSON-encoded, which is how Nexus sends every change (LIVE-PROBES AS-093).
 *   - reference/ad-account/reachfrequencypredictions.md + reservation.md: POST /act_{id}/reachfrequencypredictions — a
 *     prediction (prediction_mode 0 = budget from reach, 1 = reach from budget; budget in cents, lifetime; start_time /
 *     stop_time Unix, stop ≤ 8 weeks ahead; frequency_cap + interval_frequency_cap_reset_period in hours, × 24; target_spec
 *     one country; destination_ids the Page (+ the Instagram account: ig_user_id since v23); objective (default REACH),
 *     optimization_goal, day_parting_schedule, num_curve_points ≤ 800, story_event_type 0 | 128 | 256 | 384,
 *     campaign_group_id, rf_prediction_id_to_share; SDK also existing_campaign_id, product_type, target_frequency +
 *     target_frequency_reset_period + is_balanced_frequency, instream_packages); `action=reserve` + rf_prediction_id (+ one
 *     point of curve_budget_reach: reach, budget AND impression; rf_prediction_id_to_release) BOOKS it ("agreeing to pay the
 *     proposed costs"); `action=cancel` + rf_prediction_id frees it. An ad set takes a reservation with rf_prediction_id on
 *     POST /{ad_set_id} and lets it go with rf_prediction_id=0 (reservation.md "Detach predictions").
 */
import type { MetaWriteBodyId, MetaWriteRule } from './meta-calls.js'
import { META_NAME_TEXT, OPTIMIZATION_GOALS, metaCanonicalJson, type MetaJudge } from './meta-settings-rules.js'

type Params = ReadonlyMap<string, string>

// ── shared limits and lists (the tools and drafts use the same) ─────────────────────────────────────────────────────────

/** Nexus's own limit on a label's or a rule's name (Meta documents none). */
export const META_LABEL_NAME_MAX = 100
/** Meta: at most 50 labels in one spec (on one object). */
export const META_LABELS_PER_OBJECT = 50

export const VALUE_RULE_CRITERIA_TYPES = ['AGE', 'GENDER', 'OS_TYPE', 'DEVICE_PLATFORM', 'LOCATION', 'PLACEMENT', 'AUDIENCE_LABEL', 'OMNI_CHANNEL'] as const
export const VALUE_RULE_PLACEMENTS = ['FB_FEED', 'FB_STORIES', 'FB_REELS', 'FB_MARKETPLACE', 'FB_SEARCH', 'FB_VIDEO', 'IG_FEED', 'IG_STORIES', 'IG_REELS', 'IG_EXPLORE', 'AUDIENCE_NETWORK'] as const
export const VALUE_RULE_AUDIENCE_LABELS = [
  'HIGH_VALUE', 'LOW_VALUE', 'OTHER_CUSTOMERS', 'NEW_USERS', 'QUALIFIED_LEADS', 'DISQUALIFIED_LEADS', 'AT_RISK', 'DISENGAGED', 'APP_INSTALLERS',
  'TRIAL_USERS', 'ENGAGED_USERS', 'OTHER_1', 'OTHER_2', 'OTHER_3',
] as const
export const VALUE_RULE_OMNI_CHANNELS = ['APP', 'INSTANT_FORM', 'PHONE_CALL', 'WEBSITE'] as const
/** LOCATION's value types (never LOCATION_DMA: replaced by Comscore markets from 2026-06-22, such rules are not active). */
export const VALUE_RULE_LOCATION_TYPES = ['LOCATION_COUNTRY', 'LOCATION_REGION', 'LOCATION_CITY', 'LOCATION_COMSCORE_MARKET'] as const
export const VALUE_RULE_PRODUCT_TYPES = ['AUDIENCE', 'LEADGEN_ADS', 'OMNI_CHANNEL'] as const
export const MAX_VALUE_RULES = 10
export const MAX_VALUE_RULE_CRITERIA = 4
/** Nexus's own: at most this many values in one criterion (keeps a set's body within the gateway's 16,000 characters). */
export const MAX_CRITERIA_VALUES = 25
export const VALUE_RULE_INCREASE_MAX = 1000
export const VALUE_RULE_DECREASE_MAX = 90

/** reference/ad-account/reachfrequencypredictions.md `objective` (MOBILE_APP_INSTALLS left out: no Nexus business promotes an app). */
export const RF_OBJECTIVES = ['REACH', 'BRAND_AWARENESS', 'VIDEO_VIEWS', 'POST_ENGAGEMENT', 'LINK_CLICKS', 'WEBSITE_CONVERSIONS'] as const
export const RF_PUBLISHER_PLATFORMS = ['facebook', 'instagram'] as const
/** reservation.md: Facebook feed and right column (and in-stream with its packages); Meta's answer decides each mix (status codes 11, 44, 45, 50, 60, 66). */
export const RF_FACEBOOK_POSITIONS = ['feed', 'right_hand_column', 'instream_video', 'marketplace', 'story'] as const
export const RF_INSTAGRAM_POSITIONS = ['stream', 'story', 'explore', 'explore_home', 'reels'] as const
export const RF_DEVICE_PLATFORMS = ['mobile', 'desktop'] as const
export const RF_STORY_EVENT_TYPES = [0, 128, 256, 384] as const
/** SDK ReachFrequencyPrediction.ProductType. */
export const RF_PRODUCT_TYPES = ['STANDARD', 'ADS_BURST', 'ADS_SUPER_BURST', 'REELS_TRENDING_ADS'] as const
/** reachfrequencypredictions.md instream_packages, without REGULAR_POLITICS (no political ads from Nexus). */
export const RF_INSTREAM_PACKAGES = [
  'NORMAL', 'PREMIUM', 'SPORTS', 'ENTERTAINMENT', 'BEAUTY', 'FOOD', 'SPANISH', 'REGULAR_ANIMALS_PETS', 'REGULAR_FOOD', 'REGULAR_GAMES',
  'REGULAR_SPORTS', 'REGULAR_STYLE', 'REGULAR_TV_MOVIES',
] as const
/** Nexus's own bounds for a prediction's numbers (far beyond any Nexus business's plan). */
export const RF_MAX_BUDGET = 100_000_000_000
export const RF_MAX_REACH = 2_000_000_000
export const RF_MAX_FREQUENCY = 90
export const RF_MAX_DAYS = 90
export const RF_MAX_CURVE_POINTS = 800

// ── small judges ────────────────────────────────────────────────────────────────────────────────────────────────────────

const isId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,20}$/.test(v)
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exactKeys = (o: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []) =>
  Object.keys(o).every((k) => allowed.includes(k)) && required.every((k) => k in o)
/** Text a person typed: trimmed, 1 to max characters, the name pattern (no control or format character). */
export const metaLabelTextOk = (v: unknown, max: number = META_LABEL_NAME_MAX): v is string =>
  typeof v === 'string' && v === v.trim() && v.length > 0 && [...v].length <= max && META_NAME_TEXT.test(v)
const json = (what: string, judge: (parsed: unknown) => string | null): MetaJudge => (value) => {
  const parsed = metaCanonicalJson(value)
  if (parsed === undefined) return `${what} is JSON in one spelling only (as Nexus writes it: no spaces, each key once)`
  return judge(parsed)
}
const whole = (min: number, max: number, what: string): MetaJudge => (value) => {
  if (!/^(0|[1-9]\d{0,14})$/.test(value)) return `${what} is a whole number`
  const n = Number(value)
  return n < min || n > max ? `${what} is between ${min} and ${max}` : null
}
const oneOf = (values: readonly string[], what: string): MetaJudge => (value) => (values.includes(value) ? null : `${what} is one of ${values.join(', ')}`)
const digits = (what: string): MetaJudge => (value) => (isId(value) ? null : `${what} is a Meta id (digits only)`)
/** Each key's judge, then the body's own rule. */
const judgedBy = (judges: Record<string, MetaJudge>, also?: (params: Params) => string | null) => (params: Params): string | null => {
  for (const [key, value] of params) {
    const judge = judges[key]
    if (!judge) return `${key} is not a key of this change`
    const problem = judge(value, params)
    if (problem) return problem
  }
  return also ? also(params) : null
}

// ── labels ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `adlabels`: 0 (a replace may clear them) or 1 to 50 entries, each {"id": "<digits>"} or {"name": "<text>"}, each once. */
function labelListProblem(value: string, min: number): string | null {
  const list = metaCanonicalJson(value)
  if (list === undefined) return 'adlabels is JSON in one spelling only (as Nexus writes it: no spaces, each key once)'
  if (!Array.isArray(list) || list.length < min || list.length > META_LABELS_PER_OBJECT) return `adlabels lists ${min} to ${META_LABELS_PER_OBJECT} labels (Meta: at most 50 on one object)`
  const seen = new Set<string>()
  for (const entry of list) {
    if (!plainObject(entry) || Object.keys(entry).length !== 1) return 'each label is {"id": "<digits>"} or {"name": "<its name>"}'
    if ('id' in entry ? !isId(entry.id) : !('name' in entry) || !metaLabelTextOk(entry.name)) {
      return `each label is {"id": "<digits>"} or {"name": "<1 to ${META_LABEL_NAME_MAX} characters of printable text>"}`
    }
    const key = 'id' in entry ? `id:${entry.id as string}` : `name:${entry.name as string}`
    if (seen.has(key)) return 'adlabels names each label once'
    seen.add(key)
  }
  return null
}
const labelIds = (params: Params): MetaWriteBodyId[] => {
  const list = metaCanonicalJson(params.get('adlabels') ?? '')
  return Array.isArray(list) ? list.filter((e) => plainObject(e) && isId(e.id)).map((e) => ({ id: (e as { id: string }).id, kind: 'adlabel' as const })) : []
}

// ── value rules ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One criterion's values judged against its type (bidding/value-rules.md, the criteria_values table). */
function criterionProblem(c: Record<string, unknown>, update: boolean): string | null {
  const keys = ['criteria_type', 'operator', 'criteria_values', 'criteria_value_types']
  if (!exactKeys(c, update ? ['id', ...keys] : keys, keys)) return `each criterion has exactly ${keys.join(', ')}${update ? ' (and the id of one it keeps)' : ''}`
  if ('id' in c && !isId(c.id)) return 'a kept criterion\'s id is a Meta id (digits, as a JSON string)'
  const type = c.criteria_type
  if (!(VALUE_RULE_CRITERIA_TYPES as readonly unknown[]).includes(type)) return `criteria_type is one of ${VALUE_RULE_CRITERIA_TYPES.join(', ')}`
  if (c.operator !== 'CONTAINS') return 'operator is CONTAINS (Meta\'s only one)'
  const values = c.criteria_values
  const types = c.criteria_value_types
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_CRITERIA_VALUES) return `criteria_values lists 1 to ${MAX_CRITERIA_VALUES} values`
  if (!Array.isArray(types) || types.length !== values.length) return 'criteria_value_types names one type per value, in the same order'
  if (new Set(values).size !== values.length) return 'criteria_values names each value once'
  for (const [i, v] of values.entries()) {
    const t = types[i]
    if (typeof v !== 'string') return 'each criteria value is text'
    if (type === 'LOCATION') {
      if (!(VALUE_RULE_LOCATION_TYPES as readonly unknown[]).includes(t)) return `a LOCATION value's type is one of ${VALUE_RULE_LOCATION_TYPES.join(', ')} (never LOCATION_DMA: Meta replaced it by Comscore markets)`
      if (t === 'LOCATION_COUNTRY' ? !/^[A-Z]{2}$/.test(v) : !/^\d{1,20}$/.test(v)) return 'a country is two capital letters; a region, city or Comscore market is Meta\'s key (digits)'
      continue
    }
    if (t !== 'NONE') return `a ${String(type)} value's type is NONE`
    if (type === 'AGE') {
      const m = /^(\d{2})(?:-(\d{2})|\+)$/.exec(v)
      if (!m || Number(m[1]) < 13 || (m[2] !== undefined && (Number(m[2]) <= Number(m[1]) || Number(m[2]) >= 65))) return 'an AGE value is a range "18-24" (the upper end under 65) or open-ended "45+"'
    } else if (type === 'GENDER') { if (v !== 'MALE' && v !== 'FEMALE') return 'a GENDER value is MALE or FEMALE' }
    else if (type === 'OS_TYPE') { if (v !== 'ANDROID' && v !== 'IOS') return 'an OS_TYPE value is ANDROID or IOS' }
    else if (type === 'DEVICE_PLATFORM') { if (v !== 'MOBILE' && v !== 'DESKTOP') return 'a DEVICE_PLATFORM value is MOBILE or DESKTOP' }
    else if (type === 'PLACEMENT') { if (!(VALUE_RULE_PLACEMENTS as readonly string[]).includes(v)) return `a PLACEMENT value is one of ${VALUE_RULE_PLACEMENTS.join(', ')}` }
    else if (type === 'AUDIENCE_LABEL') { if (!(VALUE_RULE_AUDIENCE_LABELS as readonly string[]).includes(v)) return `an AUDIENCE_LABEL value is one of ${VALUE_RULE_AUDIENCE_LABELS.join(', ')}` }
    else if (type === 'OMNI_CHANNEL') { if (!(VALUE_RULE_OMNI_CHANNELS as readonly string[]).includes(v)) return `an OMNI_CHANNEL value is one of ${VALUE_RULE_OMNI_CHANNELS.join(', ')}` }
  }
  return null
}

/** `rules`: 1 to 10 rules, each its name, sign, percentage and 1 to 4 criteria of different types; an update may keep ids. */
export function valueRulesProblem(value: string, update: boolean): string | null {
  const rules = metaCanonicalJson(value)
  if (rules === undefined) return 'rules is JSON in one spelling only (as Nexus writes it: no spaces, each key once)'
  if (!Array.isArray(rules) || rules.length < 1 || rules.length > MAX_VALUE_RULES) return `rules lists 1 to ${MAX_VALUE_RULES} rules (Meta's limit)`
  const ruleIds = new Set<string>()
  for (const r of rules) {
    const keys = ['name', 'adjust_sign', 'adjust_value', 'criterias']
    if (!plainObject(r) || !exactKeys(r, update ? ['id', 'status', ...keys] : keys, keys)) return `each rule has exactly ${keys.join(', ')}${update ? ' (and the id and status of one it keeps)' : ''}`
    if ('id' in r) {
      if (!isId(r.id)) return 'a kept rule\'s id is a Meta id (digits, as a JSON string)'
      if (ruleIds.has(r.id)) return 'rules keeps each rule once'
      ruleIds.add(r.id)
    }
    if ('status' in r && (!('id' in r) || (r.status !== 'ACTIVE' && r.status !== 'DRAFT'))) return 'a rule\'s status is sent only with its id, as ACTIVE or DRAFT (Meta\'s read of it)'
    if (!metaLabelTextOk(r.name)) return `a rule's name is 1 to ${META_LABEL_NAME_MAX} characters of printable text`
    if (r.adjust_sign !== 'INCREASE' && r.adjust_sign !== 'DECREASE') return 'adjust_sign is INCREASE or DECREASE'
    if (!isInt(r.adjust_value, 1, r.adjust_sign === 'INCREASE' ? VALUE_RULE_INCREASE_MAX : VALUE_RULE_DECREASE_MAX)) {
      return `adjust_value is a whole percentage: 1 to ${VALUE_RULE_INCREASE_MAX} to raise a bid, 1 to ${VALUE_RULE_DECREASE_MAX} to lower it`
    }
    const criteria = r.criterias
    if (!Array.isArray(criteria) || criteria.length < 1 || criteria.length > MAX_VALUE_RULE_CRITERIA) return `each rule has 1 to ${MAX_VALUE_RULE_CRITERIA} criteria (criterias)`
    const types = new Set<unknown>()
    for (const c of criteria) {
      if (!plainObject(c)) return 'each criterion is an object'
      const problem = criterionProblem(c, update)
      if (problem) return problem
      if (types.has(c.criteria_type)) return 'two criteria of one rule never have the same type (Meta)'
      types.add(c.criteria_type)
    }
  }
  return null
}

const ruleSetName: MetaJudge = (value) => (metaLabelTextOk(value) ? null : `name is 1 to ${META_LABEL_NAME_MAX} characters of printable text`)

// ── reach & frequency ───────────────────────────────────────────────────────────────────────────────────────────────────

/** target_spec of a prediction: one country, ages, genders and placements — the keys Nexus sends, each judged. */
function targetSpecProblem(value: string): string | null {
  const t = metaCanonicalJson(value)
  if (t === undefined) return 'target_spec is JSON in one spelling only (as Nexus writes it)'
  if (!plainObject(t) || !exactKeys(t, ['geo_locations', 'age_min', 'age_max', 'genders', 'publisher_platforms', 'facebook_positions', 'instagram_positions', 'device_platforms'], ['geo_locations'])) {
    return 'target_spec has geo_locations and only age_min, age_max, genders, publisher_platforms, facebook_positions, instagram_positions, device_platforms'
  }
  const geo = t.geo_locations
  if (!plainObject(geo) || !exactKeys(geo, ['countries'], ['countries']) || !Array.isArray(geo.countries) || geo.countries.length !== 1 || !/^[A-Z]{2}$/.test(String(geo.countries[0]))) {
    return 'a prediction targets exactly one country (Meta: "Specify more than one country" is not allowed): geo_locations {"countries": ["XX"]}'
  }
  if ('age_min' in t && !isInt(t.age_min, 13, 65)) return 'age_min is 13 to 65'
  if ('age_max' in t && !isInt(t.age_max, 13, 65)) return 'age_max is 13 to 65'
  if (isInt(t.age_min, 13, 65) && isInt(t.age_max, 13, 65) && t.age_max < t.age_min) return 'age_max is not below age_min'
  const list = (key: string, allowed: readonly (string | number)[]) => {
    if (!(key in t)) return null
    const v = t[key]
    return Array.isArray(v) && v.length >= 1 && v.length <= allowed.length && new Set(v).size === v.length && v.every((x) => allowed.includes(x as string | number)) ? null : `${key} lists values of ${allowed.join(', ')}, each once`
  }
  return list('genders', [1, 2]) ?? list('publisher_platforms', RF_PUBLISHER_PLATFORMS) ?? list('facebook_positions', RF_FACEBOOK_POSITIONS)
    ?? list('instagram_positions', RF_INSTAGRAM_POSITIONS) ?? list('device_platforms', RF_DEVICE_PLATFORMS)
}

/** day_parting_schedule: one block (the same hours every day it names), at least 3 hours (reachfrequencypredictions.md). */
const dayParting: MetaJudge = json('day_parting_schedule', (v) => {
  if (!Array.isArray(v) || v.length !== 1 || !plainObject(v[0]) || !exactKeys(v[0], ['start_minute', 'end_minute', 'days', 'timezone_type'], ['start_minute', 'end_minute', 'days'])) {
    return 'day_parting_schedule is ONE block {start_minute, end_minute, days[, timezone_type]} (Meta: the same hours every day)'
  }
  const b = v[0]
  if (!isInt(b.start_minute, 0, 1439) || !isInt(b.end_minute, 1, 1440) || (b.end_minute as number) - (b.start_minute as number) < 180) return 'a day part runs at least 3 hours, minutes 0–1440'
  if (!Array.isArray(b.days) || b.days.length < 1 || b.days.length > 7 || new Set(b.days).size !== b.days.length || !b.days.every((d) => isInt(d, 0, 6))) return 'days lists 0 (Sunday) to 6, each once'
  if ('timezone_type' in b && b.timezone_type !== 'USER' && b.timezone_type !== 'ADVERTISER') return 'timezone_type is USER or ADVERTISER'
  return null
})

const destinationIds: MetaJudge = json('destination_ids', (v) => (
  Array.isArray(v) && v.length >= 1 && v.length <= 2 && new Set(v).size === v.length && v.every(isId) ? null : 'destination_ids lists the chosen Page and, for Instagram placements, the chosen Instagram account (digits, as JSON strings)'))

const instreamPackages: MetaJudge = json('instream_packages', (v) => (
  Array.isArray(v) && v.length >= 1 && new Set(v).size === v.length && v.every((x) => (RF_INSTREAM_PACKAGES as readonly unknown[]).includes(x)) ? null : `instream_packages lists values of ${RF_INSTREAM_PACKAGES.join(', ')}, each once`))

const unixTime = (what: string): MetaJudge => whole(1_000_000_000, 9_999_999_999, `${what} (UTC Unix seconds)`)

const PREDICTION_JUDGES: Record<string, MetaJudge> = {
  prediction_mode: oneOf(['0', '1'], 'prediction_mode (0: the budget for a reach; 1: the reach for a budget)'),
  budget: whole(1, RF_MAX_BUDGET, 'budget (cents of the account currency, lifetime)'),
  reach: whole(1, RF_MAX_REACH, 'reach (people)'),
  start_time: unixTime('start_time'),
  stop_time: unixTime('stop_time'),
  frequency_cap: whole(1, RF_MAX_FREQUENCY, 'frequency_cap'),
  interval_frequency_cap_reset_period: (value) => (whole(24, RF_MAX_DAYS * 24, 'interval_frequency_cap_reset_period (hours)')(value, new Map()) ?? (Number(value) % 24 ? 'interval_frequency_cap_reset_period is whole days in hours (a multiple of 24)' : null)),
  target_spec: targetSpecProblem,
  destination_ids: destinationIds,
  objective: oneOf(RF_OBJECTIVES, 'objective'),
  optimization_goal: oneOf(OPTIMIZATION_GOALS, 'optimization_goal'),
  day_parting_schedule: dayParting,
  num_curve_points: whole(1, RF_MAX_CURVE_POINTS, 'num_curve_points'),
  story_event_type: oneOf(RF_STORY_EVENT_TYPES.map(String), 'story_event_type'),
  campaign_group_id: digits('campaign_group_id'),
  rf_prediction_id_to_share: digits('rf_prediction_id_to_share'),
  existing_campaign_id: digits('existing_campaign_id'),
  product_type: oneOf(RF_PRODUCT_TYPES, 'product_type'),
  target_frequency: whole(1, RF_MAX_FREQUENCY, 'target_frequency'),
  target_frequency_reset_period: (value) => (whole(24, RF_MAX_DAYS * 24, 'target_frequency_reset_period (hours)')(value, new Map()) ?? (Number(value) % 24 ? 'target_frequency_reset_period is whole days in hours (a multiple of 24)' : null)),
  is_balanced_frequency: oneOf(['true'], 'is_balanced_frequency (sent only as true, with target_frequency)'),
  instream_packages: instreamPackages,
}

function predictionWhole(params: Params): string | null {
  const mode = params.get('prediction_mode')
  if (mode === '1' ? !params.has('budget') || params.has('reach') : !params.has('reach') || params.has('budget')) {
    return 'prediction_mode 1 names a budget (and no reach); prediction_mode 0 a reach (and no budget)'
  }
  if (Number(params.get('stop_time')) <= Number(params.get('start_time'))) return 'stop_time is after start_time'
  if (Number(params.get('stop_time')) - Number(params.get('start_time')) > RF_MAX_DAYS * 86_400) return `a reach and frequency plan runs at most ${RF_MAX_DAYS} days (Meta)`
  if (params.has('interval_frequency_cap_reset_period') && !params.has('frequency_cap')) return 'interval_frequency_cap_reset_period goes with frequency_cap'
  const balanced = ['target_frequency', 'target_frequency_reset_period', 'is_balanced_frequency'].filter((k) => params.has(k))
  if (balanced.length && !(params.has('target_frequency') && params.has('is_balanced_frequency'))) return 'target_frequency goes with is_balanced_frequency=true (and optionally its reset period)'
  if (balanced.length && params.has('frequency_cap')) return 'a prediction names a frequency cap or a target frequency, not both'
  return null
}

const predictionIds = (params: Params): MetaWriteBodyId[] => {
  const out: MetaWriteBodyId[] = []
  const destinations = metaCanonicalJson(params.get('destination_ids') ?? '')
  if (Array.isArray(destinations)) for (const id of destinations) if (isId(id)) out.push({ id, kind: 'destination' })
  if (isId(params.get('campaign_group_id'))) out.push({ id: params.get('campaign_group_id')!, kind: 'campaign' })
  if (isId(params.get('rf_prediction_id_to_share'))) out.push({ id: params.get('rf_prediction_id_to_share')!, kind: 'rfprediction' })
  if (isId(params.get('existing_campaign_id'))) out.push({ id: params.get('existing_campaign_id')!, kind: 'adset' })
  return out
}

/** reserve (+ one point of the curve: reach, budget and impression together; a reservation it releases) or cancel. */
function reservationProblem(params: Params): string | null {
  const action = params.get('action')
  if (action !== 'reserve' && action !== 'cancel') return 'action is reserve or cancel (a prediction itself names no action)'
  if (!isId(params.get('rf_prediction_id'))) return 'rf_prediction_id is a Meta id (digits only)'
  const extra = [...params.keys()].filter((k) => k !== 'action' && k !== 'rf_prediction_id')
  if (action === 'cancel') return extra.length ? 'a cancel names only action and rf_prediction_id' : null
  const point = ['reach', 'budget', 'impression'].filter((k) => params.has(k))
  if (point.length && point.length !== 3) return 'a point of the prediction\'s curve names reach, budget and impression together (reservation.md)'
  if (params.has('reach') && whole(1, RF_MAX_REACH, 'reach')(params.get('reach')!, params)) return 'reach is a whole number of people'
  if (params.has('budget') && whole(1, RF_MAX_BUDGET, 'budget')(params.get('budget')!, params)) return 'budget is a whole number of cents'
  if (params.has('impression') && whole(1, RF_MAX_REACH * RF_MAX_FREQUENCY, 'impression')(params.get('impression')!, params)) return 'impression is a whole number'
  if (params.has('rf_prediction_id_to_release') && !isId(params.get('rf_prediction_id_to_release'))) return 'rf_prediction_id_to_release is a Meta id (digits only)'
  return null
}

// ── the rules ───────────────────────────────────────────────────────────────────────────────────────────────────────────

let built: readonly MetaWriteRule[] | null = null

/**
 * Step 21's rules on the write allow-list (meta-calls.ts writeRules), built once when first judged (this module sits in an
 * import cycle with meta-calls.ts, through meta-settings-rules.ts).
 */
export function metaLabelsWriteRules(): readonly MetaWriteRule[] {
  if (built) return built
  built = [
    // ── set-meta-labels ──
    {
      // POST /act_{chosen}/adlabels name=…: a new label in the chosen ad account (CMP-082).
      name: 'adlabel.create', method: 'POST', path: /^act_\d{1,25}\/adlabels$/, kinds: ['adaccount'],
      required: ['name'], optional: [], text: { name: META_NAME_TEXT }, maxBody: 1_000,
      values: (p) => (metaLabelTextOk(p.get('name')) ? null : `name is 1 to ${META_LABEL_NAME_MAX} characters of printable text`), budget: false,
    },
    {
      // POST /{ad_label_id} name=…: a label of the chosen ad account renamed (CMP-083; the gateway finds it in that account's list).
      name: 'adlabel.rename', method: 'POST', path: /^\d{1,20}$/, kinds: ['adlabel'],
      required: ['name'], optional: [], text: { name: META_NAME_TEXT }, maxBody: 1_000,
      values: (p) => (metaLabelTextOk(p.get('name')) ? null : `name is 1 to ${META_LABEL_NAME_MAX} characters of printable text`), budget: false,
    },
    {
      // DELETE /{ad_label_id}, no body: a label of the chosen ad account deleted on the person's explicit ask (CMP-084;
      // change-labels.ts labelsDraft, the one sender — meta-create-writes.vitest.test.ts pins it).
      name: 'adlabel.delete', method: 'DELETE', path: /^\d{1,20}$/, kinds: ['adlabel'], required: [], optional: [], values: () => null, budget: false,
    },
    {
      // POST /{campaign_id}/adlabels adlabels=[…]: labels ADDED to a campaign (CMP-065; a name alone creates the label).
      name: 'campaign.adlabels.add', method: 'POST', path: /^\d{1,20}\/adlabels$/, kinds: ['campaign'],
      required: ['adlabels'], optional: [], text: { adlabels: META_NAME_TEXT }, maxBody: 8_000,
      values: (p) => labelListProblem(p.get('adlabels') ?? '', 1), budget: false, ids: labelIds,
    },
    {
      // POST /{campaign_id | ad_set_id} adlabels=[…]: the WHOLE label list of a campaign or ad set (CMP-066, AS-087).
      name: 'object.adlabels', method: 'POST', path: /^\d{1,20}$/, kinds: ['campaign', 'adset'],
      required: ['adlabels'], optional: [], text: { adlabels: META_NAME_TEXT }, maxBody: 8_000,
      values: (p) => labelListProblem(p.get('adlabels') ?? '', 0), budget: false, ids: labelIds,
    },
    // ── set-meta-value-rules ──
    {
      // POST /act_{chosen}/value_rule_set name, rules[, product_type] (AS-093).
      name: 'valueruleset.create', method: 'POST', path: /^act_\d{1,25}\/value_rule_set$/, kinds: ['adaccount'],
      required: ['name', 'rules'], optional: ['product_type'], text: { name: META_NAME_TEXT, rules: META_NAME_TEXT }, maxBody: 16_000,
      values: judgedBy({ name: ruleSetName, rules: (v) => valueRulesProblem(v, false), product_type: oneOf(VALUE_RULE_PRODUCT_TYPES, 'product_type') }), budget: false,
    },
    {
      // POST /{value_rule_set_id} name, rules: the whole set, each kept rule and criterion by its id (AS-094).
      name: 'valueruleset.update', method: 'POST', path: /^\d{1,20}$/, kinds: ['valueruleset'],
      required: ['name', 'rules'], optional: [], text: { name: META_NAME_TEXT, rules: META_NAME_TEXT }, maxBody: 16_000,
      values: judgedBy({ name: ruleSetName, rules: (v) => valueRulesProblem(v, true) }), budget: false,
    },
    {
      // POST /{value_rule_set_id}/delete_rule_set with an EMPTY body (AS-095; a bare POST, meta-calls.ts).
      name: 'valueruleset.delete', method: 'POST', path: /^\d{1,20}\/delete_rule_set$/, kinds: ['valueruleset'], required: [], optional: [], values: () => null, budget: false,
    },
    {
      // POST /act_{chosen}/value_rule_set_translation source={"bid_multiplier_ad_set_id":"<ad set>"}: a proposal, nothing made (AS-098).
      name: 'valueruleset.translate', method: 'POST', path: /^act_\d{1,25}\/value_rule_set_translation$/, kinds: ['adaccount'],
      required: ['source'], optional: [], maxBody: 200,
      values: (p) => json('source', (s) => (plainObject(s) && exactKeys(s, ['bid_multiplier_ad_set_id'], ['bid_multiplier_ad_set_id']) && isId(s.bid_multiplier_ad_set_id)
        ? null : 'source is exactly {"bid_multiplier_ad_set_id": "<an ad set of the chosen ad account>"}'))(p.get('source') ?? '', p),
      budget: false,
      ids: (p) => { const s = metaCanonicalJson(p.get('source') ?? ''); return plainObject(s) && isId(s.bid_multiplier_ad_set_id) ? [{ id: s.bid_multiplier_ad_set_id, kind: 'adset' }] : [] },
    },
    {
      // POST /{ad_set_id} value_rule_set_id + value_rules_applied=true [+ bid_adjustments={} — its legacy multipliers go] (AS-096).
      name: 'adset.valueRules.attach', method: 'POST', path: /^\d{1,20}$/, kinds: ['adset'],
      required: ['value_rule_set_id', 'value_rules_applied'], optional: ['bid_adjustments'], maxBody: 200,
      values: judgedBy({
        value_rule_set_id: digits('value_rule_set_id'),
        value_rules_applied: oneOf(['true'], 'value_rules_applied (true with a value rule set: false with an id attaches it all the same, Meta)'),
        bid_adjustments: oneOf(['{}'], 'bid_adjustments (only {}: the legacy bid multipliers removed as the value rules come)'),
      }),
      budget: false,
      ids: (p) => (isId(p.get('value_rule_set_id')) ? [{ id: p.get('value_rule_set_id')!, kind: 'valueruleset' }] : []),
    },
    {
      // POST /{ad_set_id} value_rules_applied=false and NOTHING else (AS-097).
      name: 'adset.valueRules.detach', method: 'POST', path: /^\d{1,20}$/, kinds: ['adset'],
      required: ['value_rules_applied'], optional: [], maxBody: 100,
      values: (p) => (p.get('value_rules_applied') === 'false' ? null : 'a detach sends only value_rules_applied=false'), budget: false,
    },
    // ── create-meta-reach-frequency ──
    {
      // POST /act_{chosen}/reachfrequencypredictions — a prediction (AS-081; a quote: nothing booked, nothing spent).
      name: 'rf.predict', method: 'POST', path: /^act_\d{1,25}\/reachfrequencypredictions$/, kinds: ['adaccount'],
      required: ['prediction_mode', 'start_time', 'stop_time', 'target_spec'], optional: Object.keys(PREDICTION_JUDGES).filter((k) => !['prediction_mode', 'start_time', 'stop_time', 'target_spec'].includes(k)),
      maxBody: 4_000, values: judgedBy(PREDICTION_JUDGES, predictionWhole), budget: false, ids: predictionIds,
    },
    {
      // POST /act_{chosen}/reachfrequencypredictions action=reserve | cancel, rf_prediction_id (AS-082, AS-083).
      name: 'rf.reservation', method: 'POST', path: /^act_\d{1,25}\/reachfrequencypredictions$/, kinds: ['adaccount'],
      required: ['action', 'rf_prediction_id'], optional: ['reach', 'budget', 'impression', 'rf_prediction_id_to_release'], maxBody: 400,
      values: reservationProblem, budget: false,
      ids: (p) => ['rf_prediction_id', 'rf_prediction_id_to_release'].filter((k) => isId(p.get(k))).map((k) => ({ id: p.get(k)!, kind: 'rfprediction' as const })),
    },
    {
      // POST /{ad_set_id} rf_prediction_id=<a reservation> (attach) | 0 (detach) — AS-084, reservation.md.
      name: 'adset.rfPrediction', method: 'POST', path: /^\d{1,20}$/, kinds: ['adset'],
      required: ['rf_prediction_id'], optional: [], maxBody: 100,
      values: (p) => (p.get('rf_prediction_id') === '0' || isId(p.get('rf_prediction_id')) ? null : 'rf_prediction_id is a reservation\'s id, or 0 to let it go'),
      budget: false,
      ids: (p) => (isId(p.get('rf_prediction_id')) && p.get('rf_prediction_id') !== '0' ? [{ id: p.get('rf_prediction_id')!, kind: 'rfprediction' }] : []),
    },
  ]
  return built
}
