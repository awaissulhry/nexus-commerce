/**
 * Meta step 28 (2026-10-21) — the write allow-list entries of apply-meta-recommendations, create-meta-experiment,
 * set-meta-experiment and end-meta-experiment: EXACT keys per kind of object, every value judged, JSON in Nexus's own one
 * spelling (the string judged is the string sent), text only where a person types it (a name, a description), and every id
 * inside a body named for the gateway's account checks (gateway.ts metaBodyIdsProblem, meta-optimize-owner.ts).
 *
 * Checked 2026-10-21 (developers.facebook.com/documentation/ads-commerce/marketing-api/…, `.md` pages, ≥ 3 s apart; Meta's
 * Python Business SDK facebook_business/adobjects/adstudy.py on GitHub main; docs/video-api/ab-testing):
 *   - overview/performance-recommendations "Apply via API details": `POST /act_<id>/recommendations` with
 *     `recommendation_signature` (Meta's example sends it as a JSON string, `"1234567"`) and `extra_data`, a JSON OBJECT
 *     whose values are STRINGS: `object_selection` "Comma-separated list of ad IDs" (ad set ids for
 *     PERFORMANT_CREATIVE_REELS_OPT_IN and SHOPS_ADS_SAOFF), `creative_feature_opt_in_overrides` "JSON array of creative
 *     feature opt-in overrides" {ad_id, opted_in_creative_feature_names ⊂ image_templates, image_touchups,
 *     text_optimizations, video_auto_crop, video_uncrop, standard_enhancements — "standard_enhancements must be included
 *     alongside any other feature"}, `action_type` "OPT_IN" | "OPT_OUT" (with object_selection), `adsets` / `campaigns`
 *     "JSON array of … ad_object_id (string) and additional_budget (int, in cents e.g., 6000 = $60)". Answer
 *     `{"success": true}`; "If it was not successfully applied, your ad objects will remain unchanged." No validate_only.
 *   - reference/ad-study.md: `POST /{business_id}/ad_studies` (name, start_time, end_time, cells required; type, description,
 *     cooldown_start_time, observation_end_time, objectives, creative_test_config, confidence_level, viewers,
 *     client_business) answers `{id}` with read-after-write; `POST /{ad_study_id}` (the same keys) answers `{success,
 *     cell_ids, objective_ids}`; cells {name, description, treatment_percentage / control_percentage ("float with at most
 *     two digits after decimal point"), adaccounts, campaigns, adsets, ads}; "treatment_percentage for each cell should be
 *     at least 10", "the sum … should be less or equal to 100", "Each cell must have at least one object"; once running
 *     "you cannot update start_time, treatment_percentage … cannot remove associated objects … can update end_time to the
 *     future time"; DELETE "You can't perform this operation" (a study is never deleted). The `type` enum lacks
 *     SPLIT_TEST_V2, which guides/split-testing.md "Creative testing" documents: type SPLIT_TEST_V2, creative_test_config
 *     {daily_budget | lifetime_budget_percentage}, cells each with exactly one ad, integer treatment_percentage summing to
 *     100, cooldown_start_time = start_time, observation_end_time = end_time (Unix seconds); 2–7 cells there, "2-5 cell" on
 *     the reference: Nexus sends at most 5.
 *   - guides/lift-studies.md: type LIFT, start_time "must be in the future", observation_end_time ≥ end_time (= end_time
 *     when no post-test window), cooldown_start_time deprecated (never sent), cells with treatment_percentage +
 *     control_percentage (the sums normally 100, less allowed), objectives — at least one, exactly one is_primary, type
 *     CONVERSIONS, adspixels [{id, event_names ⊂ fb_pixel_view_content … custom}] or customconversions [{id}]; "You cannot
 *     modify objectives after the study starts running"; "Conversion Lift Measurement is currently limited" (Meta's grant).
 *   - docs/video-api/ab-testing: `POST /{page_id}/ab_tests` name, description, optimization_goal (AVG_TIME_WATCHED,
 *     COMMENTS, IMPRESSIONS, IMPRESSIONS_UNIQUE, LINK_CLICKS, REACTIONS, REELS_PLAYS, SHARES, VIDEO_VIEWS_60S),
 *     experiment_video_ids (2–4), control_video_id, optional duration (1,800–604,800 s) and scheduled_experiment_timestamp
 *     (Unix); `DELETE /{ab_test_id}` "once it has concluded" (the posts stay).
 */
import type { MetaWriteBodyId, MetaWriteRule } from './meta-calls.js'
import { META_NAME_TEXT } from './meta-settings-rules.js'

type Params = ReadonlyMap<string, string>
type Judge = (value: string, params: Params) => string | null

// ── values ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const AMOUNT_MAX = 100_000_000_000
const isId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,20}$/.test(v)
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exactKeys = (o: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []) =>
  Object.keys(o).every((k) => allowed.includes(k)) && required.every((k) => k in o)
/** A JSON value in Nexus's one spelling: it parses, and written again it is the same string; else undefined. */
function canonical(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value)
    return JSON.stringify(parsed) === value ? parsed : undefined
  } catch {
    return undefined
  }
}
const whole = (min: number, max: number, what: string): Judge => (value) => {
  if (!/^(0|[1-9]\d{0,14})$/.test(value)) return `${what} is a whole number`
  const n = Number(value)
  return n < min || n > max ? `${what} is between ${min} and ${max}` : null
}
const unixTime = (what: string): Judge => whole(1_000_000_000, 9_999_999_999, `${what} (UTC Unix seconds)`)
const oneOf = (values: readonly string[], what: string): Judge => (value) => (values.includes(value) ? null : `${what} is one of ${values.join(', ')}`)
/** Text a person typed: 1 to max characters, any script, no control or format character (step 18's pattern). */
const typed = (v: unknown, max: number): v is string => typeof v === 'string' && v === v.trim() && v.length > 0 && [...v].length <= max && META_NAME_TEXT.test(v)
const textJudge = (max: number, what: string): Judge => (value) => (typed(value, max) ? null : `${what} is 1 to ${max} characters, no control or format character`)
/** A percentage Meta takes: 0–100 with at most two decimals (Meta: "float with at most two digits after decimal point"). */
const isPercent = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= 100 && Math.abs(v * 100 - Math.round(v * 100)) < 1e-9

// ── apply-meta-recommendations: POST /act_<id>/recommendations ─────────────────────────────────────────────────────────

/** A recommendation's signature as Meta answers it (digits in Meta's examples; Nexus takes a few more safe characters). */
export const RECOMMENDATION_SIGNATURE = /^[A-Za-z0-9_\-.:=+/]{1,512}$/
/** The creative features an APLUSC_STANDARD_ENHANCEMENTS_BUNDLE apply may opt an ad in to (Meta's list). */
export const CREATIVE_FEATURES = ['image_templates', 'image_touchups', 'text_optimizations', 'video_auto_crop', 'video_uncrop', 'standard_enhancements'] as const
/** The most objects one apply names (object_selection, adsets, campaigns): the gateway checks each id's account. */
export const MAX_APPLY_OBJECTS = 50
/** How Nexus writes a signature: as Meta's example does, a JSON string. */
export const signatureParam = (signature: string): string => JSON.stringify(signature)

const EXTRA_KEYS = ['object_selection', 'creative_feature_opt_in_overrides', 'action_type', 'adsets', 'campaigns'] as const
const SELECTION = new RegExp(`^\\d{1,20}(,\\d{1,20}){0,${MAX_APPLY_OBJECTS - 1}}$`)

const signatureJudge: Judge = (value) => {
  const parsed = canonical(value)
  return typeof parsed === 'string' && RECOMMENDATION_SIGNATURE.test(parsed) ? null : 'recommendation_signature is the signature Meta gave, as a JSON string'
}

/** The ids of a comma list (object_selection), or null when it is not one Nexus writes. */
function selectionIds(value: unknown): string[] | null {
  if (typeof value !== 'string' || !SELECTION.test(value)) return null
  const ids = value.split(',')
  return new Set(ids).size === ids.length ? ids : null
}

/** A budget list (adsets / campaigns of SCALE_GOOD_CAMPAIGN), or why not. */
function budgetList(value: unknown, what: string): { ids: string[] } | { problem: string } {
  const list = typeof value === 'string' ? canonical(value) : undefined
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_APPLY_OBJECTS) return { problem: `extra_data.${what} is a JSON list (as a string, in one spelling) of 1 to ${MAX_APPLY_OBJECTS} budget raises` }
  const ids: string[] = []
  for (const item of list) {
    if (!plainObject(item) || !exactKeys(item, ['ad_object_id', 'additional_budget'], ['ad_object_id', 'additional_budget'])) return { problem: `each extra_data.${what} entry is exactly {ad_object_id, additional_budget}` }
    if (!isId(item.ad_object_id)) return { problem: `extra_data.${what} ad_object_id is a Meta id (digits, as a JSON string)` }
    if (!isInt(item.additional_budget, 1, AMOUNT_MAX)) return { problem: `extra_data.${what} additional_budget is a whole number of Meta's budget unit (cents for EUR)` }
    ids.push(item.ad_object_id)
  }
  return new Set(ids).size === ids.length ? { ids } : { problem: `extra_data.${what} names each object once` }
}

const extraDataJudge: Judge = (value) => {
  const o = canonical(value)
  if (!plainObject(o)) return 'extra_data is a JSON object in one spelling (as Nexus writes it: no spaces, each key once)'
  if (!exactKeys(o, EXTRA_KEYS)) return `extra_data has only ${EXTRA_KEYS.join(', ')}`
  const selected = 'object_selection' in o ? selectionIds(o.object_selection) : []
  if (selected === null) return `extra_data.object_selection is a comma list of 1 to ${MAX_APPLY_OBJECTS} Meta ids (digits, each once)`
  const budgets = 'adsets' in o || 'campaigns' in o
  if (budgets && ('object_selection' in o || 'action_type' in o || 'creative_feature_opt_in_overrides' in o)) return 'a budget raise (adsets, campaigns) goes alone in extra_data'
  if ('action_type' in o) {
    if (o.action_type !== 'OPT_IN' && o.action_type !== 'OPT_OUT') return 'extra_data.action_type is OPT_IN or OPT_OUT'
    if (!selected.length) return 'extra_data.action_type goes with object_selection (the ads)'
    if ('creative_feature_opt_in_overrides' in o) return 'extra_data.action_type and creative_feature_opt_in_overrides never go together'
  }
  if ('creative_feature_opt_in_overrides' in o) {
    const list = typeof o.creative_feature_opt_in_overrides === 'string' ? canonical(o.creative_feature_opt_in_overrides) : undefined
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_APPLY_OBJECTS) return 'extra_data.creative_feature_opt_in_overrides is a JSON list (as a string, in one spelling) of 1 to 50 ads'
    const ads = new Set<string>()
    for (const item of list) {
      if (!plainObject(item) || !exactKeys(item, ['ad_id', 'opted_in_creative_feature_names'], ['ad_id', 'opted_in_creative_feature_names'])) return 'each creative feature override is exactly {ad_id, opted_in_creative_feature_names}'
      if (!isId(item.ad_id) || !selected.includes(item.ad_id) || ads.has(item.ad_id)) return 'each creative feature override names one ad of object_selection, once'
      ads.add(item.ad_id)
      const names = item.opted_in_creative_feature_names
      if (!Array.isArray(names) || names.length < 1 || new Set(names).size !== names.length || names.some((n) => !(CREATIVE_FEATURES as readonly unknown[]).includes(n))) return `opted_in_creative_feature_names lists ${CREATIVE_FEATURES.join(', ')}, each once`
      if (!names.includes('standard_enhancements')) return 'opted_in_creative_feature_names always includes standard_enhancements (Meta)'
    }
    if (ads.size !== selected.length) return 'every ad of object_selection has its creative feature override (Nexus names each feature it opts in to)'
  }
  let adSets: string[] = []
  for (const key of ['adsets', 'campaigns'] as const) {
    if (!(key in o)) continue
    const judged = budgetList(o[key], key)
    if ('problem' in judged) return judged.problem
    if (key === 'adsets') adSets = judged.ids
    else if (judged.ids.some((id) => adSets.includes(id))) return 'an object is an ad set or a campaign, never both'
  }
  return null
}

/** The ids inside an apply's extra_data, each checked by the gateway to be of the chosen ad account. */
function applyIds(params: Params): MetaWriteBodyId[] {
  const o = canonical(params.get('extra_data') ?? '')
  if (!plainObject(o)) return []
  const out: MetaWriteBodyId[] = []
  const selected = selectionIds(o.object_selection) ?? []
  // A creative feature list or an AI background switch names ADS; any other selection is ads or ad sets by type
  // (Reels placements and Shops ads take ad sets): each is confirmed one or the other, of the chosen account.
  const kind = 'action_type' in o || 'creative_feature_opt_in_overrides' in o ? 'ad' as const : 'adsetorad' as const
  for (const id of selected) out.push({ id, kind })
  for (const [key, kind2] of [['adsets', 'adset'], ['campaigns', 'campaign']] as const) {
    const list = typeof o[key] === 'string' ? canonical(o[key] as string) : undefined
    if (Array.isArray(list)) for (const item of list) if (plainObject(item) && isId(item.ad_object_id)) out.push({ id: item.ad_object_id, kind: kind2 })
  }
  return out
}

// ── create-meta-experiment, set-meta-experiment, end-meta-experiment: POST /{business}/ad_studies, POST /{ad_study} ──────

/** The study types Nexus makes: an A/B test, a creative test (Meta's guide), a conversion lift study (Meta's grant). */
export const STUDY_TYPES_MADE = ['SPLIT_TEST', 'SPLIT_TEST_V2', 'LIFT'] as const
/** The pixel events a lift objective measures (guides/lift-studies.md). */
export const LIFT_PIXEL_EVENTS = [
  'fb_pixel_view_content', 'fb_pixel_search', 'fb_pixel_add_to_cart', 'fb_pixel_add_to_wishlist', 'fb_pixel_initiate_checkout',
  'fb_pixel_add_payment_info', 'fb_pixel_purchase', 'fb_pixel_lead', 'fb_pixel_complete_registration', 'custom',
] as const
/** Nexus's own caps: cells per study (Meta allows 150; a creative test 5), objects per cell (Meta 100). */
export const MAX_STUDY_CELLS = 10
export const MAX_CREATIVE_TEST_CELLS = 5
export const MAX_CELL_OBJECTS = 50
export const MAX_STUDY_VIEWERS = 50
const CELL_OBJECT_KEYS = ['adsets', 'campaigns', 'ads', 'adaccounts'] as const
type CellObjectKey = typeof CELL_OBJECT_KEYS[number]
const CELL_ID_KIND: Readonly<Record<CellObjectKey, MetaWriteBodyId['kind']>> = { adsets: 'adset', campaigns: 'campaign', ads: 'ad', adaccounts: 'adaccount' }

const idList = (v: unknown, min: number, max: number): v is string[] => Array.isArray(v) && v.length >= min && v.length <= max && v.every(isId) && new Set(v).size === v.length

/**
 * The cells of a create (no `id`) or of an update (an existing cell by `id`, or a new one), judged by the study type when
 * the body names it (a create always does; an update never: the tool reads the study first).
 */
function cellsProblem(value: string, type: string | null, update: boolean): string | null {
  const list = canonical(value)
  const max = type === 'SPLIT_TEST_V2' ? MAX_CREATIVE_TEST_CELLS : MAX_STUDY_CELLS
  const min = update ? 1 : type === 'LIFT' ? 1 : 2
  if (!Array.isArray(list) || list.length < min || list.length > max) return `cells is a JSON list (in one spelling) of ${min} to ${max} cells`
  const seenObjects = new Set<string>()
  const seenCells = new Set<string>()
  const levels = new Set<string>()
  let sum = 0
  let everyPercent = true
  for (const cell of list) {
    if (!plainObject(cell)) return 'each cell is an object'
    const existing = 'id' in cell
    const allowed = ['id', 'name', 'description', 'treatment_percentage', 'control_percentage', ...CELL_OBJECT_KEYS]
    if (!exactKeys(cell, allowed)) return `a cell has only ${allowed.join(', ')}`
    if (existing) {
      if (!update) return 'a new study\'s cells have no id'
      if (!isId(cell.id) || seenCells.has(cell.id)) return 'a cell id is a Meta id (digits, as a JSON string), each once'
      seenCells.add(cell.id)
    } else if (!typed(cell.name, 100)) return 'a new cell has a name of 1 to 100 characters'
    if ('name' in cell && !typed(cell.name, 100)) return 'a cell name is 1 to 100 characters, no control or format character'
    if ('description' in cell && !typed(cell.description, 500)) return 'a cell description is 1 to 500 characters'
    if (!existing || 'treatment_percentage' in cell) {
      const integer = type === 'SPLIT_TEST_V2'
      if (!isPercent(cell.treatment_percentage, 10) || (integer && !Number.isInteger(cell.treatment_percentage))) return `each cell's treatment_percentage is ${integer ? 'a whole number' : 'a number with at most two decimals'} from 10 to 100 (Meta: at least 10)`
      sum += cell.treatment_percentage as number
    } else everyPercent = false
    if ('control_percentage' in cell) {
      if (type && type !== 'LIFT') return 'control_percentage (a holdout) is a lift study\'s only'
      if (!isPercent(cell.control_percentage)) return 'control_percentage is a number with at most two decimals from 0 to 100'
      sum += cell.control_percentage as number
    }
    const named = CELL_OBJECT_KEYS.filter((k) => k in cell)
    if (!existing && named.length !== 1) return 'a new cell names exactly one kind of object: adsets, campaigns, ads or adaccounts'
    if (named.length > 1) return 'a cell names one kind of object'
    for (const key of named) {
      const ids = cell[key]
      const max2 = type === 'SPLIT_TEST_V2' ? 1 : MAX_CELL_OBJECTS
      if (!idList(ids, 1, max2)) return `${key} in a cell lists ${max2 === 1 ? 'exactly one id' : `1 to ${max2} Meta ids`} (digits, as JSON strings, each once)`
      if (type === 'SPLIT_TEST' && key !== 'adsets' && key !== 'campaigns') return 'an A/B test compares ad sets or campaigns'
      if (type === 'SPLIT_TEST_V2' && key !== 'ads') return 'a creative test has exactly one ad per cell'
      if (type === 'LIFT' && key === 'ads') return 'a lift study measures campaigns, ad sets or the ad account'
      levels.add(key)
      for (const id of ids) {
        if (seenObjects.has(id)) return 'an object is in one cell only'
        seenObjects.add(id)
      }
    }
  }
  if (type === 'SPLIT_TEST' && levels.size > 1) return 'an A/B test compares one level: every cell names ad sets, or every cell campaigns'
  if (!update && type === 'SPLIT_TEST_V2' && Math.abs(sum - 100) > 1e-9) return 'a creative test\'s treatment percentages sum to exactly 100'
  // An update that names every cell's split is judged the same way (Meta: "provide the percentage of all existing and new
  // cells"); one that names none leaves the split as it is.
  if ((!update || everyPercent) && sum > 100 + 1e-9) return 'the percentages of all cells sum to at most 100'
  return null
}

function objectivesProblem(value: string): string | null {
  const list = canonical(value)
  if (!Array.isArray(list) || list.length < 1 || list.length > 5) return 'objectives is a JSON list (in one spelling) of 1 to 5 objectives'
  let primary = 0
  for (const o of list) {
    // Nexus sends whole objectives only (a change replaces the list): never an existing objective's id.
    if (!plainObject(o) || !exactKeys(o, ['name', 'is_primary', 'type', 'adspixels', 'customconversions'], ['name', 'is_primary', 'type'])) return 'an objective has name, is_primary, type and only adspixels, customconversions'
    if (!typed(o.name, 100)) return 'an objective name is 1 to 100 characters'
    if (o.type !== 'CONVERSIONS') return 'an objective\'s type is CONVERSIONS (the type Meta\'s lift guide documents)'
    if (typeof o.is_primary !== 'boolean') return 'is_primary is true or false'
    if (o.is_primary === true) primary += 1
    if (!('adspixels' in o) && !('customconversions' in o)) return 'an objective names its source: adspixels or customconversions'
    if ('adspixels' in o) {
      const px = o.adspixels
      if (!Array.isArray(px) || px.length < 1 || px.length > 5) return 'adspixels lists 1 to 5 pixels'
      for (const p of px) {
        if (!plainObject(p) || !exactKeys(p, ['id', 'event_names'], ['id']) || !isId(p.id)) return 'each pixel is {id, event_names}'
        if ('event_names' in p && (!Array.isArray(p.event_names) || !p.event_names.length || new Set(p.event_names).size !== p.event_names.length
          || p.event_names.some((e) => !(LIFT_PIXEL_EVENTS as readonly unknown[]).includes(e)))) return `event_names lists ${LIFT_PIXEL_EVENTS.join(', ')}, each once`
      }
    }
    if ('customconversions' in o) {
      const cc = o.customconversions
      if (!Array.isArray(cc) || cc.length < 1 || cc.length > 10 || cc.some((c) => !plainObject(c) || !exactKeys(c, ['id'], ['id']) || !isId(c.id))) return 'customconversions lists 1 to 10 {id}'
    }
  }
  return primary === 1 ? null : 'exactly one objective is the primary one (is_primary true)'
}

const creativeTestConfig: Judge = (value) => {
  const o = canonical(value)
  if (!plainObject(o) || Object.keys(o).length !== 1) return 'creative_test_config is exactly {"daily_budget": …} or {"lifetime_budget_percentage": …}'
  if ('daily_budget' in o) return isInt(o.daily_budget, 1, AMOUNT_MAX) ? null : 'creative_test_config.daily_budget is a whole number of Meta\'s budget unit'
  if ('lifetime_budget_percentage' in o) return isPercent(o.lifetime_budget_percentage, 1) ? null : 'creative_test_config.lifetime_budget_percentage is 1 to 100'
  return 'creative_test_config is exactly {"daily_budget": …} or {"lifetime_budget_percentage": …}'
}

const viewersJudge: Judge = (value) => {
  const list = canonical(value)
  return idList(list, 0, MAX_STUDY_VIEWERS) ? null : `viewers is a JSON list of 0 to ${MAX_STUDY_VIEWERS} Meta person ids (digits, as JSON strings, each once)`
}
const confidenceJudge: Judge = (value) => (/^0\.(5\d?|[6-9]\d?)$/.test(value) ? null : 'confidence_level is 0.5 to 0.99 (two decimals at most)')

const STUDY_JUDGES = (update: boolean): Record<string, Judge> => ({
  name: textJudge(200, 'name'),
  description: textJudge(1000, 'description'),
  type: oneOf(STUDY_TYPES_MADE, 'type (Nexus makes A/B tests, creative tests and conversion lift studies)'),
  start_time: unixTime('start_time'),
  end_time: unixTime('end_time'),
  cooldown_start_time: unixTime('cooldown_start_time'),
  observation_end_time: unixTime('observation_end_time'),
  cells: (value, params) => cellsProblem(value, update ? null : params.get('type') ?? null, update),
  objectives: (value) => objectivesProblem(value),
  creative_test_config: creativeTestConfig,
  confidence_level: confidenceJudge,
  ...(update ? { viewers: viewersJudge } : {}),
})

function studyJudged(update: boolean) {
  const judges = STUDY_JUDGES(update)
  return (params: Params): string | null => {
    for (const [key, value] of params) {
      const judge = judges[key]
      if (!judge) return `${key} is not a key of this change`
      const problem = judge(value, params)
      if (problem) return problem
    }
    const num = (k: string) => (params.has(k) ? Number(params.get(k)) : null)
    const start = num('start_time')
    const end = num('end_time')
    const observe = num('observation_end_time')
    const cooldown = num('cooldown_start_time')
    if (start !== null && end !== null && end <= start) return 'end_time is after start_time'
    if (end !== null && observe !== null && observe < end) return 'observation_end_time is at or after end_time'
    if (update) return null
    const type = params.get('type')!
    if (type === 'SPLIT_TEST_V2') {
      if (!params.has('creative_test_config')) return 'a creative test has its creative_test_config (its budget)'
      if (cooldown !== start || observe !== end) return 'a creative test sends cooldown_start_time = start_time and observation_end_time = end_time (Meta\'s guide)'
    } else if (params.has('creative_test_config')) return 'creative_test_config is a creative test\'s only (type SPLIT_TEST_V2)'
    if (type === 'LIFT') {
      if (!params.has('objectives')) return 'a lift study has at least one objective (Meta)'
      if (cooldown !== null) return 'cooldown_start_time is deprecated for lift studies: Nexus never sends it'
    } else {
      if (params.has('objectives')) return 'objectives are a lift study\'s'
      if (type === 'SPLIT_TEST' && (cooldown !== null || observe !== null)) return 'an A/B test takes no cooldown or observation window'
    }
    return null
  }
}

/** The ids inside a study's cells, objectives and viewers, each checked by the gateway. */
function studyIds(params: Params): MetaWriteBodyId[] {
  const out: MetaWriteBodyId[] = []
  const cells = canonical(params.get('cells') ?? '')
  if (Array.isArray(cells)) {
    for (const cell of cells) {
      if (!plainObject(cell)) continue
      // An existing cell named by id: one of THIS study's cells (the gateway reads them).
      if (isId(cell.id)) out.push({ id: cell.id, kind: 'studycell' })
      for (const key of CELL_OBJECT_KEYS) {
        const ids = cell[key]
        if (Array.isArray(ids)) for (const id of ids) if (isId(id)) out.push({ id, kind: CELL_ID_KIND[key] })
      }
    }
  }
  const objectives = canonical(params.get('objectives') ?? '')
  if (Array.isArray(objectives)) {
    for (const o of objectives) {
      if (!plainObject(o)) continue
      if (Array.isArray(o.adspixels)) for (const p of o.adspixels) if (plainObject(p) && isId(p.id)) out.push({ id: p.id, kind: 'pixel' })
      if (Array.isArray(o.customconversions)) for (const c of o.customconversions) if (plainObject(c) && isId(c.id)) out.push({ id: c.id, kind: 'customconversion' })
    }
  }
  const viewers = canonical(params.get('viewers') ?? '')
  if (Array.isArray(viewers)) for (const id of viewers) if (isId(id)) out.push({ id, kind: 'person' })
  return out
}

// ── create-meta-experiment (page-video-test), set-meta-experiment (delete one) ────────────────────────────────────────

export const VIDEO_TEST_GOALS = ['AVG_TIME_WATCHED', 'COMMENTS', 'IMPRESSIONS', 'IMPRESSIONS_UNIQUE', 'LINK_CLICKS', 'REACTIONS', 'REELS_PLAYS', 'SHARES', 'VIDEO_VIEWS_60S'] as const
export const VIDEO_TEST_MIN_SECONDS = 1800
export const VIDEO_TEST_MAX_SECONDS = 604_800

const videoIds: Judge = (value, params) => {
  const list = canonical(value)
  if (!idList(list, 2, 4)) return 'experiment_video_ids is a JSON list of 2 to 4 video ids (digits, as JSON strings, each once)'
  return list.includes(params.get('control_video_id') ?? '') ? null : 'the control video is one of experiment_video_ids'
}
const VIDEO_TEST_JUDGES: Record<string, Judge> = {
  name: textJudge(200, 'name'),
  description: textJudge(1000, 'description'),
  optimization_goal: oneOf(VIDEO_TEST_GOALS, 'optimization_goal'),
  control_video_id: (value) => (/^\d{1,20}$/.test(value) ? null : 'control_video_id is a video id (digits)'),
  experiment_video_ids: videoIds,
  duration: whole(VIDEO_TEST_MIN_SECONDS, VIDEO_TEST_MAX_SECONDS, 'duration (seconds: 30 minutes to a week)'),
  scheduled_experiment_timestamp: unixTime('scheduled_experiment_timestamp'),
}
const judgedBy = (judges: Record<string, Judge>) => (params: Params): string | null => {
  for (const [key, value] of params) {
    const judge = judges[key]
    if (!judge) return `${key} is not a key of this change`
    const problem = judge(value, params)
    if (problem) return problem
  }
  return null
}
function videoTestIds(params: Params): MetaWriteBodyId[] {
  const list = canonical(params.get('experiment_video_ids') ?? '')
  return Array.isArray(list) ? list.filter(isId).map((id) => ({ id, kind: 'pagevideo' as const })) : []
}

const STUDY_UPDATE_KEYS = ['name', 'description', 'start_time', 'end_time', 'cooldown_start_time', 'observation_end_time', 'cells', 'objectives', 'creative_test_config', 'confidence_level', 'viewers'] as const

/** Step 28 — apply-meta-recommendations, create-meta-experiment, set-meta-experiment and end-meta-experiment on the write allow-list. */
export const META_OPTIMIZE_WRITE_RULES: readonly MetaWriteRule[] = [
  {
    name: 'recommendation.apply',
    method: 'POST',
    path: /^act_\d{1,20}\/recommendations$/,
    kinds: ['adaccount'],
    required: ['recommendation_signature', 'extra_data'],
    optional: [],
    maxBody: 16_000,
    values: judgedBy({ recommendation_signature: signatureJudge, extra_data: extraDataJudge }),
    // Meta's 4-an-hour budget limit is an ad set's: the tool counts the ad sets a raise names (the account is not one).
    budget: false,
    ids: applyIds,
  },
  {
    name: 'study.create',
    method: 'POST',
    path: /^\d{1,20}\/ad_studies$/,
    kinds: ['business'],
    required: ['name', 'type', 'start_time', 'end_time', 'cells'],
    optional: ['description', 'cooldown_start_time', 'observation_end_time', 'objectives', 'creative_test_config', 'confidence_level'],
    text: { name: META_NAME_TEXT, description: META_NAME_TEXT, cells: META_NAME_TEXT, objectives: META_NAME_TEXT },
    maxBody: 16_000,
    values: studyJudged(false),
    budget: false,
    ids: studyIds,
  },
  {
    name: 'study.update',
    method: 'POST',
    path: /^\d{1,20}$/,
    kinds: ['adstudy'],
    required: [],
    optional: STUDY_UPDATE_KEYS,
    anyOf: STUDY_UPDATE_KEYS,
    text: { name: META_NAME_TEXT, description: META_NAME_TEXT, cells: META_NAME_TEXT, objectives: META_NAME_TEXT },
    maxBody: 16_000,
    values: studyJudged(true),
    budget: false,
    ids: studyIds,
  },
  {
    name: 'pageVideoTest.create',
    method: 'POST',
    path: /^\d{1,20}\/ab_tests$/,
    kinds: ['page'],
    required: ['name', 'description', 'optimization_goal', 'control_video_id', 'experiment_video_ids'],
    optional: ['duration', 'scheduled_experiment_timestamp'],
    text: { name: META_NAME_TEXT, description: META_NAME_TEXT },
    values: judgedBy(VIDEO_TEST_JUDGES),
    budget: false,
    ids: videoTestIds,
  },
  {
    name: 'pageVideoTest.delete',
    method: 'DELETE',
    path: /^\d{1,20}$/,
    kinds: ['pagevideotest'],
    required: [],
    optional: [],
    values: () => null,
    budget: false,
  },
]
