/**
 * Meta step 18 (2026-10-21) — the write allow-list entries of set-meta-campaign, set-meta-ad-set and
 * set-meta-budget-schedule: EXACT keys per kind of object, and every value judged — enums by list, amounts as whole
 * numbers, JSON values in Nexus's own canonical form (the string judged is the string sent: one spelling only, every key
 * at every depth on a list), text only where a person types it (a name, the EU payer and beneficiary). The ids inside a
 * body (child ad sets, ads, custom audiences, the pixel) are named to the gateway, which checks each is of the chosen ad
 * account before anything is sent (gateway.ts metaBodyIdsProblem).
 *
 * Checked 2026-10-21 (developers.facebook.com/documentation/ads-commerce/marketing-api/…, `.md` pages; Meta's Python
 * Business SDK facebook_business/adobjects/{campaign,adset,highdemandperiod}.py on GitHub main):
 *   - reference/ad-campaign-group.md "Updating" (campaign): name (emoji ok), daily_budget, lifetime_budget, bid_strategy,
 *     adset_bid_amounts (map ad set id → bid, "required in the process of toggling campaign from autobid to manual bid"),
 *     adset_budgets (every non-deleted child ad set with daily_budget or lifetime_budget), spend_cap (subunit, remove with
 *     922337203685478), is_adset_budget_sharing_enabled, special_ad_category + special_ad_category_country, promoted_object
 *     (keys listed there), objective, is_reels_trending_ads_enabled, execution_options; SDK campaign.py api_update adds
 *     pacing_type, frequency_control_specs, is_budget_schedule_enabled. start_time / stop_time are read only on a campaign
 *     (RECHECK CMP-064), frequency caps are an ad set's (CMP-072), budget_rebalance_flag is deprecated since v7 (CMP-075),
 *     smart_promotion_type and iterative_split_test_configs are not sent (CMP-068, CMP-067): none of them is here.
 *   - reference/ad-campaign.md (ad set; no update table, the create table and SDK adset.py api_update): adset_schedule
 *     {start_minute, end_minute, days 0–6, timezone_type USER|ADVERTISER}; frequency_control_specs {event IMPRESSIONS |
 *     VIDEO_VIEWS | VIDEO_VIEWS_2S | VIDEO_VIEWS_15S — "only IMPRESSIONS currently", so Nexus sends IMPRESSIONS —, interval_days
 *     1–90, max_frequency 1–90}; brand_safety_config
 *     {comment_moderation_filter AD_DISABLED|DEFAULT}; contextual_bundling_spec {status OPT_IN|OPT_OUT}; ad_set_goal
 *     {type 0|1|2, existing_customers_exclusions, engaged_audiences_exclusions, the two label lists}; dsa_payor /
 *     dsa_beneficiary (≤ 512); regional_regulated_categories + regional_regulation_identities (keys listed there);
 *     creative_sequence; time_based_ad_rotation_id_blocks (list<list<integer>>) + _intervals; start_time / end_time (UTC
 *     UNIX timestamp; end_time=0 = ongoing with a daily budget); min/max_budget_spend_percentage; automatic_manual_state;
 *     SDK only: full_funnel_exploration_mode, is_incremental_attribution_enabled, is_budget_schedule_enabled,
 *     creative_sequence_repetition_pattern.
 *   - bidding/overview/bid-strategy.md: bid_constraints {"roas_average_floor": ROAS × 10,000}, 100–10,000,000.
 *   - bidding/overview/pacing-and-scheduling.md: pacing_type ["standard"] | ["no_pacing"] | ["day_parting"].
 *   - reference/ad-campaign-group.md attribution_spec table: 1-day click, 7-day click, 1-day click + 1-day view, 7-day
 *     click + 1-day view (CLICK_THROUGH / VIEW_THROUGH, window_days 1 | 7).
 *   - reference/ad-campaign(-group)/budget_schedules.md: POST budget_value (int64), budget_value_type ABSOLUTE |
 *     MULTIPLIER, time_start, time_end (int64), read-after-write of the new id; high-demand-period.md: ≥ 3 hours.
 *     Updating and deleting a high-demand period is SDK only (highdemandperiod.py api_update: budget_value,
 *     budget_value_type, time_start, time_end; api_delete) — STILL-UNVERIFIED (LIVE-PROBES CMP-059 / CMP-060).
 */
import type { MetaWriteBodyId, MetaWriteRule } from './meta-calls.js'
import { META_VALIDATE_ONLY } from './meta-calls.js'

/**
 * Text a person types (review A8, round 2): any script, never a control or format character (U+202E turns text around,
 * U+200C, tag characters U+E0020–E007F, a soft hyphen hide or reorder it). STRICT for the EU payer and beneficiary (shown
 * to people as the advertiser's identity). A NAME also takes U+200D (zero-width joiner) only BETWEEN two emoji, as a
 * family or job emoji is written; anywhere else it is refused. One pattern each, used by the tools' zod and this gateway.
 */
export const META_STRICT_TEXT = /^[^\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]*$/u
export const META_NAME_TEXT = /^(?:[^\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]|(?<=\p{Extended_Pictographic}[\u{FE0F}\u{1F3FB}-\u{1F3FF}]?)\u200D(?=\p{Extended_Pictographic}))*$/u
/** Does a text pass the same check as a new one of the tools (trimmed, 1 to max characters, its pattern)? Undo uses it. */
export const typedTextOk = (value: string | null | undefined, pattern: RegExp, max: number): value is string =>
  typeof value === 'string' && value === value.trim() && value.length > 0 && [...value].length <= max && pattern.test(value)

/** Meta's "no cap" value for a campaign spend cap and an ad set's spend caps (reference/ad-campaign-group.md spend_cap). */
export const META_NO_CAP = '922337203685478'

/**
 * Review A5 — Meta documents validate_only on a campaign UPDATE (reference/ad-campaign-group.md "Updating"), but ST17-01
 * proves it only for a status change. A SETTINGS change (a budget, a bid strategy, a name) is checked by Meta only once
 * LIVE-PROBE ST18-03 shows Meta honours validate_only on one (a name change of a paused test campaign, read back
 * unchanged). THE LEADER FLIPS THIS TO true after ST18-03; until then the preview says "Meta's check is not used for this
 * change yet". Separate from step 17's META_UPDATE_CHECK_PROVEN on purpose.
 */
export const META_SETTINGS_CHECK_PROVEN = false

/** May Nexus ask Meta's check (validate_only) of a campaign settings change? (Both states are tested.) */
export const metaSettingsCheckAllowed = (proven: boolean = META_SETTINGS_CHECK_PROVEN): boolean => proven

type Params = ReadonlyMap<string, string>
type Judge = (value: string, params: Params) => string | null

// ── values ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A whole number written plainly (no sign, no leading zero), within [min, max]. */
const whole = (min: number, max: number, what: string): Judge => (value) => {
  if (!/^(0|[1-9]\d{0,14})$/.test(value)) return `${what} is a whole number`
  const n = Number(value)
  return n < min || n > max ? `${what} is between ${min} and ${max}` : null
}
const AMOUNT_MAX = 100_000_000_000 // 1e11 minor units: far above any budget a Nexus business sets
const amount = (what: string): Judge => whole(1, AMOUNT_MAX, `${what} (minor units of the account currency)`)
const capAmount = (what: string): Judge => (value) => (value === META_NO_CAP ? null : amount(what)(value, new Map()))
const oneOf = (values: readonly string[], what: string): Judge => (value) => (values.includes(value) ? null : `${what} is one of ${values.join(', ')}`)
const bool = (what: string): Judge => oneOf(['true', 'false'], what)
const unixTime = (what: string): Judge => whole(1_000_000_000, 9_999_999_999, `${what} (UTC Unix seconds)`)
/** Meta ids inside a body are written as JSON strings of digits (Meta: "numeric string"). */
const isId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,20}$/.test(v)
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
const exactKeys = (o: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []) =>
  Object.keys(o).every((k) => allowed.includes(k)) && required.every((k) => k in o)

/**
 * A JSON value in Nexus's own canonical form: it parses, and written again it is the same string (one spelling only — no
 * spaces, no duplicate key, no number Meta would read otherwise). Null when it is not.
 */
function canonical(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value)
    return JSON.stringify(parsed) === value ? parsed : undefined
  } catch {
    return undefined
  }
}
const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const json = (what: string, judge: (parsed: unknown) => string | null): Judge => (value) => {
  const parsed = canonical(value)
  if (parsed === undefined) return `${what} is JSON in one spelling only (as Nexus writes it: no spaces, each key once)`
  return judge(parsed)
}

export const PACING_VALUES = ['["standard"]', '["no_pacing"]', '["day_parting"]'] as const
export const BID_STRATEGIES = ['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP', 'LOWEST_COST_WITH_MIN_ROAS'] as const
/** Political / social-issue ads are not run from Nexus (banned in the EU since 2025-10-06; PLAN.md): never a category here. */
export const SPECIAL_AD_CATEGORIES = ['NONE', 'EMPLOYMENT', 'HOUSING', 'FINANCIAL_PRODUCTS_SERVICES', 'ONLINE_GAMBLING_AND_GAMING'] as const
export const OUTCOME_OBJECTIVES = ['OUTCOME_SALES', 'OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT', 'OUTCOME_LEADS', 'OUTCOME_AWARENESS', 'OUTCOME_APP_PROMOTION'] as const
/** promoted_object custom_event_type (reference/ad-campaign-group.md, promoted_object). */
export const CUSTOM_EVENT_TYPES = [
  'AD_IMPRESSION', 'RATE', 'TUTORIAL_COMPLETION', 'CONTACT', 'CUSTOMIZE_PRODUCT', 'DONATE', 'FIND_LOCATION', 'SCHEDULE', 'START_TRIAL',
  'SUBMIT_APPLICATION', 'SUBSCRIBE', 'ADD_TO_CART', 'ADD_TO_WISHLIST', 'INITIATED_CHECKOUT', 'ADD_PAYMENT_INFO', 'PURCHASE', 'LEAD',
  'COMPLETE_REGISTRATION', 'CONTENT_VIEW', 'SEARCH', 'SERVICE_BOOKING_REQUEST', 'MESSAGING_CONVERSATION_STARTED_7D', 'LEVEL_ACHIEVED',
  'ACHIEVEMENT_UNLOCKED', 'SPENT_CREDITS', 'LISTING_INTERACTION', 'D2_RETENTION', 'D7_RETENTION', 'OTHER',
] as const
/**
 * The promoted-object keys Nexus sends: a pixel and its event, a catalog and product set (the ad set's: Meta uses
 * product_set_id at the ad set level), the value semantic. Pages, apps, offers and the rest are never sent (no Nexus
 * business promotes an app; a Page goes with step 19's creates). pixel_rule is an AD SET's only (review B3: the campaign
 * update table does not list it).
 */
export const PROMOTED_OBJECT_KEYS = ['pixel_id', 'pixel_rule', 'custom_event_type', 'custom_event_str', 'product_catalog_id', 'product_set_id', 'value_semantic_type'] as const
export const CAMPAIGN_PROMOTED_OBJECT_KEYS = PROMOTED_OBJECT_KEYS.filter((k) => k !== 'pixel_rule')

/**
 * Review A8 — a pixel rule in ONE exact shape (Meta's custom-conversion rule language): a rule is `{"and": [rule…]}`,
 * `{"or": [rule…]}` or `{"<field>": {"<operator>": value}}`; at most 3 levels deep and 10 conditions; a field is url,
 * event or a custom-data key (lower snake case); the operators are these; a value is plain text (≤ 200), a number, or a
 * list of up to 20 of them.
 */
export const PIXEL_RULE_OPERATORS = ['eq', 'neq', 'contains', 'not_contains', 'i_contains', 'i_not_contains', 'starts_with', 'i_starts_with', 'lt', 'lte', 'gt', 'gte', 'is_any', 'is_not_any'] as const
const PIXEL_RULE_FIELD = /^(url|event|[a-z][a-z0-9_]{0,39})$/
function pixelRuleProblem(rule: unknown, depth = 1, count = { conditions: 0 }): string | null {
  if (depth > 3) return 'a pixel rule is at most 3 levels deep'
  if (!plainObject(rule) || Object.keys(rule).length !== 1) return 'each part of a pixel rule is an object with exactly one key'
  const [key, value] = Object.entries(rule)[0]
  if (key === 'and' || key === 'or') {
    if (!Array.isArray(value) || value.length < 1 || value.length > 10) return `${key} lists 1 to 10 rules`
    for (const part of value) { const problem = pixelRuleProblem(part, depth + 1, count); if (problem) return problem }
    return null
  }
  if (!PIXEL_RULE_FIELD.test(key) || key === 'and' || key === 'or') return `"${key.slice(0, 40)}" is not a pixel rule field (url, event or a custom-data key)`
  if (!plainObject(value) || Object.keys(value).length !== 1) return `the condition on ${key} is one operator`
  const [op, operand] = Object.entries(value)[0]
  if (!(PIXEL_RULE_OPERATORS as readonly string[]).includes(op)) return `${op.slice(0, 20)} is not a pixel rule operator (${PIXEL_RULE_OPERATORS.join(', ')})`
  const scalar = (v: unknown) => (typeof v === 'string' && /^[\x20-\x7e]{0,200}$/.test(v)) || (typeof v === 'number' && Number.isFinite(v))
  if (!(scalar(operand) || (Array.isArray(operand) && operand.length >= 1 && operand.length <= 20 && operand.every(scalar)))) return `the value of ${key} ${op} is plain text, a number or a short list of them`
  count.conditions += 1
  return count.conditions > 10 ? 'a pixel rule has at most 10 conditions' : null
}

const promotedJudge = (keys: readonly string[]): Judge => json('promoted_object', (o) => {
  if (!plainObject(o) || !Object.keys(o).length) return 'promoted_object is an object with at least one key'
  if (!exactKeys(o, keys)) return `promoted_object has only ${keys.join(', ')}`
  for (const key of ['pixel_id', 'product_catalog_id', 'product_set_id'] as const) if (key in o && !isId(o[key])) return `promoted_object.${key} is a Meta id (digits, as a JSON string)`
  if ('custom_event_type' in o && !(CUSTOM_EVENT_TYPES as readonly unknown[]).includes(o.custom_event_type)) return 'promoted_object.custom_event_type is one of Meta\'s event types'
  if ('custom_event_str' in o && !(typeof o.custom_event_str === 'string' && /^[\x20-\x7e]{1,100}$/.test(o.custom_event_str))) return 'promoted_object.custom_event_str is plain text, at most 100 characters'
  if ('value_semantic_type' in o && !['VALUE', 'MARGIN', 'LIFETIME_VALUE'].includes(o.value_semantic_type as string)) return 'promoted_object.value_semantic_type is VALUE, MARGIN or LIFETIME_VALUE'
  if ('pixel_rule' in o) {
    const rule = typeof o.pixel_rule === 'string' && o.pixel_rule.length <= 2000 ? canonical(o.pixel_rule) : undefined
    if (rule === undefined) return 'promoted_object.pixel_rule is a JSON rule as a string, in one spelling, at most 2000 characters'
    const problem = pixelRuleProblem(rule)
    if (problem) return `promoted_object.pixel_rule: ${problem}`
  }
  return null
})
const campaignPromotedObject = promotedJudge(CAMPAIGN_PROMOTED_OBJECT_KEYS)
const adSetPromotedObject = promotedJudge(PROMOTED_OBJECT_KEYS)
/** Review A4 — the pixel, the catalog and the product set a promoted object names, for the gateway's account checks. */
const promotedIds = (params: Params): MetaWriteBodyId[] => {
  const o = canonical(params.get('promoted_object') ?? '')
  if (!plainObject(o)) return []
  return [
    ...(isId(o.pixel_id) ? [{ id: o.pixel_id, kind: 'pixel' as const }] : []),
    ...(isId(o.product_catalog_id) ? [{ id: o.product_catalog_id, kind: 'catalog' as const }] : []),
    ...(isId(o.product_set_id) ? [{ id: o.product_set_id, kind: 'productset' as const }] : []),
  ]
}

const textOf = (max: number, what: string): Judge => (value) => {
  const length = [...value].length
  if (!value.trim() || length > max) return `${what} is 1 to ${max} characters`
  return null
}

// ── read-backs (fields on the POST: read-after-write of a campaign update and of a budget schedule create) ─────────────

const READ_BACK_BASE = ['id', 'status', 'configured_status', 'effective_status', 'updated_time']
export const CAMPAIGN_SETTINGS_READ_BACK: ReadonlySet<string> = new Set([
  ...READ_BACK_BASE, 'name', 'daily_budget', 'lifetime_budget', 'bid_strategy', 'spend_cap', 'objective', 'special_ad_category',
  'special_ad_category_country', 'pacing_type', 'promoted_object', 'is_adset_budget_sharing_enabled', 'is_reels_trending_ads_enabled',
  'is_budget_schedule_enabled',
])
export const BUDGET_SCHEDULE_READ_BACK: ReadonlySet<string> = new Set(['id', 'budget_value', 'budget_value_type', 'recurrence_type', 'time_start', 'time_end'])

const readBack = (allowed: ReadonlySet<string>): Judge => (value) => {
  const names = value.split(',')
  if (names.some((name) => !allowed.has(name))) return `a change reads back only ${[...allowed].join(', ')}`
  if (new Set(names).size !== names.length) return 'fields names each field once'
  return null
}

/** Each key's judge; every key of a rule has one. A rule's own whole-body rules come after (`also`). */
function judged(judges: Record<string, Judge>, also?: (params: Params) => string | null) {
  return (params: Params): string | null => {
    for (const [key, value] of params) {
      const judge = judges[key]
      if (!judge) return `${key} is not a key of this change`
      const problem = judge(value, params)
      if (problem) return problem
    }
    return also ? also(params) : null
  }
}

/** Meta's check (validate_only) of a campaign settings change: only once LIVE-PROBE ST17-01 proved Meta honours it. */
const settingsCheck: Judge = (value, params) => {
  if (value !== META_VALIDATE_ONLY) return `the only execution_options Nexus sends is exactly ${META_VALIDATE_ONLY} (Meta's check, which changes nothing)`
  if (params.has('fields')) return 'Meta\'s check (validate_only) changes nothing, so it reads nothing back (no fields)'
  return metaSettingsCheckAllowed() ? null : 'Nexus does not use Meta\'s check for a campaign settings change yet (until LIVE-PROBE ST18-03 shows Meta honours validate_only on a settings update)'
}

// ── set-meta-campaign: POST /{campaign_id} ─────────────────────────────────────────────────────────────────────────────

const MAX_CHILDREN = 70 // a campaign with more than 70 ad sets cannot leave campaign budget or change bid strategy (CBO guide)

const adSetBudgets: Judge = json('adset_budgets', (list) => {
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_CHILDREN) return `adset_budgets lists 1 to ${MAX_CHILDREN} ad sets`
  const kinds = new Set<string>()
  const ids = new Set<string>()
  for (const item of list) {
    if (!plainObject(item) || !isId(item.adset_id)) return 'each adset_budgets entry names its adset_id (digits, as a JSON string)'
    const keys = Object.keys(item).filter((k) => k !== 'adset_id')
    if (keys.length !== 1 || !['daily_budget', 'lifetime_budget'].includes(keys[0])) return 'each adset_budgets entry has exactly one of daily_budget, lifetime_budget'
    if (!isInt(item[keys[0]], 1, AMOUNT_MAX)) return 'an ad set budget is a whole number of minor units'
    kinds.add(keys[0])
    if (ids.has(item.adset_id)) return 'adset_budgets names each ad set once'
    ids.add(item.adset_id)
  }
  return kinds.size === 1 ? null : 'adset_budgets gives every ad set the same kind of budget (daily or lifetime)'
})
const adSetBidAmounts: Judge = json('adset_bid_amounts', (map) => {
  if (!plainObject(map)) return 'adset_bid_amounts is an object of ad set id → bid'
  const entries = Object.entries(map)
  if (entries.length < 1 || entries.length > MAX_CHILDREN) return `adset_bid_amounts names 1 to ${MAX_CHILDREN} ad sets`
  if (entries.some(([id, bid]) => !/^\d{1,20}$/.test(id) || !isInt(bid, 1, AMOUNT_MAX))) return 'adset_bid_amounts maps an ad set id (digits) to a whole number of minor units'
  return null
})
const countries: Judge = json('special_ad_category_country', (list) => {
  if (!Array.isArray(list) || list.length > 250) return 'special_ad_category_country is a list of at most 250 countries'
  if (list.some((c) => typeof c !== 'string' || !/^[A-Z]{2}$/.test(c)) || new Set(list).size !== list.length) return 'special_ad_category_country lists two-letter country codes, each once'
  return null
})

const CAMPAIGN_JUDGES: Record<string, Judge> = {
  name: textOf(400, 'name'),
  daily_budget: amount('daily_budget'),
  lifetime_budget: amount('lifetime_budget'),
  bid_strategy: oneOf(BID_STRATEGIES, 'bid_strategy'),
  adset_bid_amounts: adSetBidAmounts,
  adset_budgets: adSetBudgets,
  spend_cap: capAmount('spend_cap'),
  // CMP-041: only off — Meta refuses switching it on for a running campaign (3858418).
  is_adset_budget_sharing_enabled: oneOf(['false'], 'is_adset_budget_sharing_enabled (Nexus only switches it off)'),
  special_ad_category: oneOf(SPECIAL_AD_CATEGORIES, 'special_ad_category'),
  special_ad_category_country: countries,
  promoted_object: campaignPromotedObject,
  objective: oneOf(OUTCOME_OBJECTIVES, 'objective'),
  pacing_type: oneOf(PACING_VALUES, 'pacing_type'),
  is_reels_trending_ads_enabled: bool('is_reels_trending_ads_enabled'),
  is_budget_schedule_enabled: bool('is_budget_schedule_enabled'),
  execution_options: settingsCheck,
  fields: readBack(CAMPAIGN_SETTINGS_READ_BACK),
}
const CAMPAIGN_SETTINGS_KEYS = Object.keys(CAMPAIGN_JUDGES).filter((k) => k !== 'execution_options' && k !== 'fields')

const campaignIds = (params: Params): MetaWriteBodyId[] => {
  const out: MetaWriteBodyId[] = []
  const budgets = canonical(params.get('adset_budgets') ?? '')
  if (Array.isArray(budgets)) for (const item of budgets) if (plainObject(item) && isId(item.adset_id)) out.push({ id: item.adset_id, kind: 'adset' })
  const bids = canonical(params.get('adset_bid_amounts') ?? '')
  if (plainObject(bids)) for (const id of Object.keys(bids)) if (/^\d{1,20}$/.test(id)) out.push({ id, kind: 'adset' })
  return [...out, ...promotedIds(params)]
}

// ── set-meta-ad-set: POST /{ad_set_id} ─────────────────────────────────────────────────────────────────────────────────

export const OPTIMIZATION_GOALS = [
  'ADVERTISER_SILOED_VALUE', 'AD_RECALL_LIFT', 'APP_INSTALLS', 'APP_INSTALLS_AND_OFFSITE_CONVERSIONS', 'AUTOMATIC_OBJECTIVE', 'CONVERSATIONS',
  'DERIVED_EVENTS', 'ENGAGED_PAGE_VIEWS', 'ENGAGED_USERS', 'EVENT_RESPONSES', 'IMPRESSIONS', 'IN_APP_VALUE', 'LANDING_PAGE_VIEWS', 'LEAD_GENERATION',
  'LINK_CLICKS', 'MEANINGFUL_CALL_ATTEMPT', 'MESSAGING_APPOINTMENT_CONVERSION', 'MESSAGING_DEEP_CONVERSATION_AND_FOLLOW',
  'MESSAGING_PURCHASE_CONVERSION', 'OFFSITE_CONVERSIONS', 'PAGE_LIKES', 'POST_ENGAGEMENT', 'PROFILE_AND_PAGE_ENGAGEMENT', 'PROFILE_VISIT',
  'QUALITY_CALL', 'QUALITY_LEAD', 'REACH', 'REMINDERS_SET', 'SUBSCRIBERS', 'THRUPLAY', 'VALUE', 'VISIT_INSTAGRAM_PROFILE',
] as const
export const OPTIMIZATION_SUB_EVENTS = [
  'NONE', 'POST_INTERACTION', 'TRAVEL_INTENT', 'TRAVEL_INTENT_BUCKET_01', 'TRAVEL_INTENT_BUCKET_02', 'TRAVEL_INTENT_BUCKET_03',
  'TRAVEL_INTENT_BUCKET_04', 'TRAVEL_INTENT_BUCKET_05', 'TRAVEL_INTENT_NO_DESTINATION_INTENT', 'TRIP_CONSIDERATION', 'VIDEO_SOUND_ON',
] as const
/** CLICKS is deprecated and NONE is not a billing choice: neither is sent. */
export const BILLING_EVENTS = ['IMPRESSIONS', 'LINK_CLICKS', 'THRUPLAY', 'POST_ENGAGEMENT', 'PAGE_LIKES', 'OFFER_CLAIMS', 'PURCHASE', 'LISTING_INTERACTION', 'APP_INSTALLS'] as const
/** Review B9 — Meta lists VIDEO_VIEWS* too, but says "only IMPRESSIONS currently" (reference/ad-campaign.md). */
export const FREQUENCY_EVENTS = ['IMPRESSIONS'] as const
export const REGIONAL_CATEGORIES = ['TAIWAN_FINSERV', 'AUSTRALIA_FINSERV', 'INDIA_FINSERV', 'TAIWAN_UNIVERSAL', 'SINGAPORE_UNIVERSAL', 'THAILAND_UNIVERSAL', 'AUSTRALIA_UNIVERSAL', 'MALAYSIA_UNIVERSAL', 'BRAZIL_REGULATION'] as const
export const REGIONAL_IDENTITY_KEYS = [
  'taiwan_finserv_beneficiary', 'taiwan_finserv_payer', 'australia_finserv_beneficiary', 'australia_finserv_payer', 'india_finserv_beneficiary',
  'india_finserv_payer', 'taiwan_universal_beneficiary', 'taiwan_universal_payer', 'singapore_universal_beneficiary', 'singapore_universal_payer',
  'universal_beneficiary', 'universal_payer',
] as const
export const CUSTOMER_LABELS = ['high_value_customers', 'low_value_customers', 'at_risk', 'disengaged', 'general_customers'] as const
export const ENGAGED_LABELS = ['qualified_leads', 'disqualified_leads', 'app_users', 'trial_users', 'engaged_users'] as const
/** attribution_spec: the four combinations of Meta's table (CLICK_THROUGH 1 | 7 days, optionally VIEW_THROUGH 1 day). */
export const ATTRIBUTION_SPECS = [
  '[{"event_type":"CLICK_THROUGH","window_days":1}]',
  '[{"event_type":"CLICK_THROUGH","window_days":7}]',
  '[{"event_type":"CLICK_THROUGH","window_days":1},{"event_type":"VIEW_THROUGH","window_days":1}]',
  '[{"event_type":"CLICK_THROUGH","window_days":7},{"event_type":"VIEW_THROUGH","window_days":1}]',
] as const

const bidConstraints: Judge = (value) => {
  if (value === '{}') return null
  const o = canonical(value)
  if (!plainObject(o) || !exactKeys(o, ['roas_average_floor'], ['roas_average_floor']) || !isInt(o.roas_average_floor, 100, 10_000_000)) {
    return 'bid_constraints is {} or {"roas_average_floor": ROAS × 10,000 between 100 and 10,000,000}'
  }
  return null
}
const adSetSchedule: Judge = json('adset_schedule', (list) => {
  if (!Array.isArray(list) || list.length > 168) return 'adset_schedule is a list of at most 168 blocks'
  for (const block of list) {
    if (!plainObject(block) || !exactKeys(block, ['start_minute', 'end_minute', 'days', 'timezone_type'], ['start_minute', 'end_minute', 'days', 'timezone_type'])) {
      return 'each adset_schedule block has exactly start_minute, end_minute, days and timezone_type'
    }
    // Meta: on the hour, at least an hour long (bidding/overview/pacing-and-scheduling.md).
    if (!isInt(block.start_minute, 0, 1380) || !isInt(block.end_minute, 60, 1440) || (block.start_minute as number) % 60 || (block.end_minute as number) % 60
      || (block.end_minute as number) - (block.start_minute as number) < 60) return 'a schedule block starts and ends on the hour, at least an hour long, within the day'
    if (!Array.isArray(block.days) || !block.days.length || block.days.some((d) => !isInt(d, 0, 6)) || new Set(block.days).size !== block.days.length) return 'a schedule block\'s days are 0 (Sunday) to 6 (Saturday), each once'
    if (block.timezone_type !== 'USER' && block.timezone_type !== 'ADVERTISER') return 'timezone_type is USER or ADVERTISER'
  }
  return null
})
const frequencySpecs: Judge = json('frequency_control_specs', (list) => {
  if (!Array.isArray(list) || list.length > 4) return 'frequency_control_specs is a list of at most 4 caps'
  for (const spec of list) {
    if (!plainObject(spec) || !exactKeys(spec, ['event', 'interval_days', 'max_frequency'], ['event', 'interval_days', 'max_frequency'])) return 'a frequency cap has exactly event, interval_days and max_frequency'
    if (!(FREQUENCY_EVENTS as readonly unknown[]).includes(spec.event)) return `a frequency cap's event is one of ${FREQUENCY_EVENTS.join(', ')}`
    if (!isInt(spec.interval_days, 1, 90) || !isInt(spec.max_frequency, 1, 90)) return 'interval_days and max_frequency are 1 to 90'
  }
  return null
})
const idList = (what: string, max: number) => (v: unknown) => Array.isArray(v) && v.length <= max && v.every(isId) && new Set(v).size === v.length ? null : `${what} lists Meta ids (digits, as JSON strings), each once, at most ${max}`
const labelList = (labels: readonly string[], what: string) => (v: unknown) => Array.isArray(v) && v.every((l) => labels.includes(l as string)) && new Set(v).size === v.length ? null : `${what} lists ${labels.join(', ')}, each once`
const adSetGoal: Judge = json('ad_set_goal', (o) => {
  const keys = ['type', 'existing_customers_exclusions', 'engaged_audiences_exclusions', 'existing_customers_audience_label_exclusions', 'engaged_audiences_audience_label_exclusions']
  if (!plainObject(o) || !exactKeys(o, keys, ['type'])) return `ad_set_goal has type and only ${keys.slice(1).join(', ')}`
  if (o.type !== 0 && o.type !== 1 && o.type !== 2) return 'ad_set_goal.type is 0 (broad), 2 (exclude existing customers) or 1 (exclude existing and engaged customers)'
  return idList('existing_customers_exclusions', 100)(o.existing_customers_exclusions ?? [])
    ?? idList('engaged_audiences_exclusions', 100)(o.engaged_audiences_exclusions ?? [])
    ?? labelList(CUSTOMER_LABELS, 'existing_customers_audience_label_exclusions')(o.existing_customers_audience_label_exclusions ?? [])
    ?? labelList(ENGAGED_LABELS, 'engaged_audiences_audience_label_exclusions')(o.engaged_audiences_audience_label_exclusions ?? [])
})
const creativeSequence: Judge = json('creative_sequence', (list) => idList('creative_sequence', 50)(list))
/** Ad ids may pass 2^53: the blocks are judged as text (digits only), never through a JS number. */
const ROTATION_BLOCKS = /^\[\[\d{1,20}(,\d{1,20}){0,49}\](,\[\d{1,20}(,\d{1,20}){0,49}\]){1,49}\]$/
const rotationIds = (value: string) => [...value.matchAll(/\d{1,20}/g)].map((m) => m[0])
const rotationBlocks: Judge = (value) => (ROTATION_BLOCKS.test(value) ? null : 'time_based_ad_rotation_id_blocks is 2 to 50 lists of ad ids, e.g. [[1],[2,3]]')
const rotationIntervals: Judge = json('time_based_ad_rotation_intervals', (list) => {
  if (!Array.isArray(list) || list.length < 2 || list.length > 50 || list.some((t) => !isInt(t, 1_000_000_000, 9_999_999_999))) return 'time_based_ad_rotation_intervals is 2 to 50 UTC Unix start times'
  return list.every((t, i) => i === 0 || (t as number) > (list[i - 1] as number)) ? null : 'time_based_ad_rotation_intervals rise'
})
const regionalCategories: Judge = json('regional_regulated_categories', (list) => (
  Array.isArray(list) && list.every((c) => (REGIONAL_CATEGORIES as readonly unknown[]).includes(c)) && new Set(list).size === list.length ? null : `regional_regulated_categories lists ${REGIONAL_CATEGORIES.join(', ')}, each once`))
const regionalIdentities: Judge = json('regional_regulation_identities', (o) => (
  plainObject(o) && Object.keys(o).length > 0 && exactKeys(o, REGIONAL_IDENTITY_KEYS) && Object.values(o).every(isId) ? null : 'regional_regulation_identities maps Meta\'s documented keys to verified identity ids (digits, as JSON strings)'))

const ADSET_JUDGES: Record<string, Judge> = {
  name: textOf(400, 'name'),
  optimization_goal: oneOf(OPTIMIZATION_GOALS, 'optimization_goal'),
  optimization_sub_event: oneOf(OPTIMIZATION_SUB_EVENTS, 'optimization_sub_event'),
  billing_event: oneOf(BILLING_EVENTS, 'billing_event'),
  daily_budget: amount('daily_budget'),
  lifetime_budget: amount('lifetime_budget'),
  daily_min_spend_target: whole(0, AMOUNT_MAX, 'daily_min_spend_target (minor units; 0 removes it)'),
  lifetime_min_spend_target: whole(0, AMOUNT_MAX, 'lifetime_min_spend_target (minor units; 0 removes it)'),
  daily_spend_cap: capAmount('daily_spend_cap'),
  lifetime_spend_cap: capAmount('lifetime_spend_cap'),
  min_budget_spend_percentage: whole(0, 100, 'min_budget_spend_percentage'),
  max_budget_spend_percentage: whole(0, 100, 'max_budget_spend_percentage'),
  bid_strategy: oneOf(BID_STRATEGIES, 'bid_strategy'),
  bid_amount: amount('bid_amount'),
  bid_constraints: bidConstraints,
  start_time: unixTime('start_time'),
  end_time: (value) => (value === '0' ? null : unixTime('end_time')(value, new Map())),
  pacing_type: oneOf(PACING_VALUES, 'pacing_type'),
  adset_schedule: adSetSchedule,
  frequency_control_specs: frequencySpecs,
  attribution_spec: oneOf(ATTRIBUTION_SPECS, 'attribution_spec (one of Meta\'s four combinations, as Nexus writes them)'),
  is_incremental_attribution_enabled: bool('is_incremental_attribution_enabled'),
  promoted_object: adSetPromotedObject,
  dsa_payor: textOf(512, 'dsa_payor'),
  dsa_beneficiary: textOf(512, 'dsa_beneficiary'),
  regional_regulated_categories: regionalCategories,
  regional_regulation_identities: regionalIdentities,
  ad_set_goal: adSetGoal,
  creative_sequence: creativeSequence,
  creative_sequence_repetition_pattern: oneOf(['FULL_SEQUENCE', 'LAST_AD'], 'creative_sequence_repetition_pattern'),
  time_based_ad_rotation_id_blocks: rotationBlocks,
  time_based_ad_rotation_intervals: rotationIntervals,
  brand_safety_config: oneOf(['{"comment_moderation_filter":"AD_DISABLED"}', '{"comment_moderation_filter":"DEFAULT"}'], 'brand_safety_config'),
  contextual_bundling_spec: oneOf(['{"status":"OPT_IN"}', '{"status":"OPT_OUT"}'], 'contextual_bundling_spec'),
  full_funnel_exploration_mode: oneOf(['NONE_EXPLORATION', 'LIMITED_EXPLORATION', 'EXTENDED_EXPLORATION'], 'full_funnel_exploration_mode'),
  automatic_manual_state: oneOf(['UNSET', 'AUTOMATIC', 'MANUAL'], 'automatic_manual_state'),
  is_budget_schedule_enabled: bool('is_budget_schedule_enabled'),
}
const ADSET_SETTINGS_KEYS = Object.keys(ADSET_JUDGES)

const adSetIds = (params: Params): MetaWriteBodyId[] => {
  const out: MetaWriteBodyId[] = []
  const goal = canonical(params.get('ad_set_goal') ?? '')
  if (plainObject(goal)) {
    for (const key of ['existing_customers_exclusions', 'engaged_audiences_exclusions']) {
      const list = goal[key]
      if (Array.isArray(list)) for (const id of list) if (isId(id)) out.push({ id, kind: 'customaudience' })
    }
  }
  const sequence = canonical(params.get('creative_sequence') ?? '')
  if (Array.isArray(sequence)) for (const id of sequence) if (isId(id)) out.push({ id, kind: 'ad' })
  const blocks = params.get('time_based_ad_rotation_id_blocks')
  if (blocks && ROTATION_BLOCKS.test(blocks)) for (const id of new Set(rotationIds(blocks))) out.push({ id, kind: 'ad' })
  return [...out, ...promotedIds(params)]
}

// ── set-meta-budget-schedule: POST /{campaign | ad set}/budget_schedules, POST and DELETE /{high_demand_period_id} ──────

/** Meta: a high-demand period lasts at least 3 hours (reference/high-demand-period.md). */
export const MIN_PERIOD_SECONDS = 3 * 3600
const SCHEDULE_JUDGES: Record<string, Judge> = {
  budget_value: whole(1, AMOUNT_MAX, 'budget_value'),
  budget_value_type: oneOf(['ABSOLUTE', 'MULTIPLIER'], 'budget_value_type'),
  time_start: unixTime('time_start'),
  time_end: unixTime('time_end'),
  fields: readBack(BUDGET_SCHEDULE_READ_BACK),
}
const periodLength = (params: Params): string | null => {
  if (!params.has('time_start') || !params.has('time_end')) return null
  return Number(params.get('time_end')) - Number(params.get('time_start')) >= MIN_PERIOD_SECONDS ? null : 'a scheduled budget increase lasts at least 3 hours (time_end ≥ time_start + 10,800 s)'
}

/** Step 18 — set-meta-campaign, set-meta-ad-set and set-meta-budget-schedule on the write allow-list. */
export const META_SETTINGS_WRITE_RULES: readonly MetaWriteRule[] = [
  {
    name: 'campaign.settings',
    method: 'POST',
    path: /^\d{1,20}$/,
    kinds: ['campaign'],
    required: [],
    optional: [...CAMPAIGN_SETTINGS_KEYS, 'execution_options', 'fields'],
    anyOf: CAMPAIGN_SETTINGS_KEYS,
    text: { name: META_NAME_TEXT },
    maxBody: 12_000,
    values: judged(CAMPAIGN_JUDGES, (params) => (params.has('adset_budgets') && (params.has('daily_budget') || params.has('lifetime_budget'))
      ? 'a campaign budget and adset_budgets never go together (one moves budgets to the ad sets, the other sets the campaign\'s)' : null)),
    // Meta documents its 4-an-hour budget limit for ad sets only (rate-limiting.md); a campaign's budget has none.
    budget: false,
    ids: campaignIds,
  },
  {
    name: 'adset.settings',
    method: 'POST',
    path: /^\d{1,20}$/,
    kinds: ['adset'],
    required: [],
    optional: ADSET_SETTINGS_KEYS,
    anyOf: ADSET_SETTINGS_KEYS,
    text: { name: META_NAME_TEXT, dsa_payor: META_STRICT_TEXT, dsa_beneficiary: META_STRICT_TEXT },
    maxBody: 8_000,
    values: judged(ADSET_JUDGES, (params) => {
      if (params.has('daily_budget') && params.has('lifetime_budget')) return 'an ad set has a daily or a lifetime budget, not both in one change'
      if (params.has('time_based_ad_rotation_id_blocks') !== params.has('time_based_ad_rotation_intervals')) return 'time_based_ad_rotation_id_blocks and _intervals go together'
      const blocks = params.get('time_based_ad_rotation_id_blocks')
      const intervals = canonical(params.get('time_based_ad_rotation_intervals') ?? '')
      if (blocks && Array.isArray(intervals) && (blocks.match(/\[/g)?.length ?? 0) - 1 !== intervals.length) return 'one rotation interval per block of ads'
      if (params.has('dsa_payor') !== params.has('dsa_beneficiary')) return 'dsa_payor and dsa_beneficiary go together (Meta fills a missing one from the account default, not from the other)'
      return null
    }),
    // Meta: an ad set's daily_budget / lifetime_budget may change 4 times an hour (rate-limiting.md, 613/1487632).
    budget: (params) => params.has('daily_budget') || params.has('lifetime_budget'),
    ids: adSetIds,
  },
  {
    name: 'budget_schedule.create',
    method: 'POST',
    path: /^\d{1,20}\/budget_schedules$/,
    kinds: ['campaign', 'adset'],
    required: ['budget_value', 'budget_value_type', 'time_start', 'time_end'],
    optional: ['fields'],
    values: judged(SCHEDULE_JUDGES, periodLength),
    budget: false,
  },
  {
    name: 'budget_schedule.update',
    method: 'POST',
    path: /^\d{1,20}$/,
    kinds: ['highdemandperiod'],
    required: [],
    optional: ['budget_value', 'budget_value_type', 'time_start', 'time_end'],
    anyOf: ['budget_value', 'budget_value_type', 'time_start', 'time_end'],
    values: judged(SCHEDULE_JUDGES, periodLength),
    budget: false,
  },
  {
    name: 'budget_schedule.delete',
    method: 'DELETE',
    path: /^\d{1,20}$/,
    kinds: ['highdemandperiod'],
    required: [],
    optional: [],
    values: () => null,
    budget: false,
  },
]
