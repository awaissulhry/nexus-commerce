/**
 * Meta step 31 (2026-10-21) — the write allow-list entries of the audience tools: create-meta-audience,
 * set-meta-audience, set-meta-audience-members, set-meta-audience-sharing and remove-meta-audience. EXACT keys per path
 * and kind of object, every value judged (enums by list, JSON in Nexus's own canonical form — the string judged is the
 * string sent, every key at every depth on a list —, text only where a person types it), and every id inside a body
 * (a pixel, a Page, an Instagram account, a lead form, an Instant Experience, a video, a seed audience, a campaign or ad
 * set a lookalike learns from, a product set, an ad account a share goes to) named to the gateway, which checks each
 * before anything is sent (gateway.ts metaBodyIdsProblem).
 *
 * A customer list's people go only as SHA-256 hashes (64 lowercase hex characters, never a plain e-mail) and only in a
 * DELETE (taking people who opted out of the business's e-mail out: one list, or every customer list of the account —
 * Nexus adds nobody: Nexus's customers carry no marketing consent, Owner decision D8). Those rules are `personal`: the
 * gateway's ledger keeps neither their body nor Meta's answer to them.
 *
 * Checked 2026-10-21 (developers.facebook.com/documentation/ads-commerce/marketing-api/…, `.md` pages; Meta's Python
 * Business SDK facebook_business/adobjects/{adaccount,customaudience}.py on GitHub main):
 *   - audiences/guides/custom-audiences (#build: subtype=CUSTOM + customer_file_source USER_PROVIDED_ONLY |
 *     PARTNER_PROVIDED_ONLY | BOTH_USER_AND_PARTNER_PROVIDED; #remove: `curl -X DELETE --data-urlencode 'payload={"schema":
 *     "EMAIL_SHA256","data":[…]}' …/{audience}/users`, and `HTTP DELETE act_{id}/usersofanyaudience` with the same fields;
 *     session {session_id positive int64 unique per ad account, batch_seq from 1, last_batch_flag, estimated_num_total};
 *     at most 10,000 rows per request; #hash: EMAIL trim + lowercase, SHA-256 lowercase hex);
 *   - reference/custom-audience/users (DELETE: payload, session; answer audience_id, session_id, num_received,
 *     num_invalid_entries, invalid_entry_samples — the samples are never kept), reference/custom-audience/ad_accounts
 *     (POST adaccounts list<numeric string>, permissions targeting | targeting_and_insights, replace, relationship_type;
 *     DELETE adaccounts), reference/custom-audience (Updating: allowed_domains, claim_objective, content_type,
 *     customer_file_source, description, enable_fetch_or_create, event_source_group, event_sources, lookalike_spec, name,
 *     opt_out_link, product_set_id, rule, rule_aggregation, use_for_products, use_in_campaigns; Deleting: no params, 2656
 *     while lookalikes exist); custom-audiences guide #update-shared-labels (audience_labels); SDK customaudience.py
 *     api_update adds retention_days;
 *   - audiences/guides/website-custom-audiences, audience-rules (rule = {inclusions, exclusions?} rule sets {operator
 *     and | or, rules ≤ 10 in all}; a rule {event_sources [{id, type}], retention_seconds, filter {operator, filters
 *     [{field, operator, value}] ≤ 100 leaves}, aggregation {type, field, operator, value, method}}; operators = != > >= <
 *     <= eq neq gt gte lt lte contains not_contains i_contains i_not_contains is_any is_not_any i_is_any i_is_not_any
 *     starts_with i_starts_with regex_match; an `event` filter takes = only), engagement-custom-audiences (event_sources
 *     types page, lead, ig_lead_generation, canvas, ig_business, shopping_page, shopping_ig; retention up to 730 days),
 *     offline-custom-audiences (type offline_events), guides/videoads #remarketing (subtype ENGAGEMENT, rule [{object_id,
 *     event_name}]), lookalike-audiences (subtype LOOKALIKE, origin_audience_id, lookalike_spec {type similarity | reach,
 *     or ratio 0.01–0.20, starting_ratio, allow_international_seeds; origin_ids + conversion_type campaign_conversions;
 *     page_id + conversion_type page_like}) with marketing-api-changelog/version26.0 (country and location_spec are
 *     silently ignored: never sent), value-based-lookalike-audiences (is_value_based, type custom_ratio),
 *     dynamic-product-audiences + reference/ad-account/product_audiences (name, product_set_id, inclusions [{retention_seconds,
 *     rule}] each with one `event` eq, exclusions, description, event_sources [{id, type PIXEL}]);
 *   - advantage-shopping-campaigns ("Define your existing customers": POST act_{id} existing_customers=[ids]) and
 *     advantage-shopping-campaigns/audience-type-url-parameters (custom_audience_info {audience_type_param_name,
 *     new_customer_tag, existing_customer_tag}: letters, digits and _).
 * Meta documents no validate_only on any custom-audience edge (facts F1 §M8): no rule here takes execution_options.
 */
import type { MetaWriteBodyId, MetaWriteRule } from './meta-calls.js'
import { META_NAME_TEXT, META_STRICT_TEXT } from './meta-settings-rules.js'

type Params = ReadonlyMap<string, string>
type Judge = (value: string, params: Params) => string | null

// ── the lists Nexus sends ───────────────────────────────────────────────────────────────────────────────────────────

/** Customer-lifecycle labels of an audience (custom-audiences guide; OCC 2026-04-30). The SDK's extra labels are not documented: never sent. */
export const AUDIENCE_LABELS = [
  'QUALIFIED_LEADS', 'DISQUALIFIED_LEADS', 'APP_USERS', 'TRIAL_USERS', 'ENGAGED_USERS', 'HIGH_VALUE_CUSTOMERS', 'LOW_VALUE_CUSTOMERS', 'AT_RISK',
  'DISENGAGED', 'GENERAL_CUSTOMERS',
] as const
export const CUSTOMER_FILE_SOURCES = ['USER_PROVIDED_ONLY', 'PARTNER_PROVIDED_ONLY', 'BOTH_USER_AND_PARTNER_PROVIDED'] as const
export const RULE_SET_OPERATORS = ['and', 'or'] as const
export const FILTER_OPERATORS = [
  '=', '!=', '>', '>=', '<', '<=', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains', 'i_contains', 'i_not_contains', 'is_any',
  'is_not_any', 'i_is_any', 'i_is_not_any', 'starts_with', 'i_starts_with', 'regex_match',
] as const
/**
 * Review B4 — time_spent and last_event_time_field need a `config` Meta documents only as "required by certain types":
 * Nexus does not send them.
 */
export const AGGREGATION_TYPES = ['count', 'sum', 'avg', 'min', 'max'] as const
export const AGGREGATION_OPERATORS = ['=', '!=', '>', '>=', '<', '<=', 'in_range', 'not_in_range'] as const
/** The event sources of a rule audience Nexus builds: its pixel (website, offline), its Page, Instagram account, forms, Instant Experiences, shops. */
export const AUDIENCE_SOURCE_TYPES = ['pixel', 'offline_events', 'page', 'ig_business', 'lead', 'ig_lead_generation', 'canvas', 'shopping_page', 'shopping_ig'] as const
export type AudienceSourceType = typeof AUDIENCE_SOURCE_TYPES[number]
export const VIDEO_EVENTS = [
  'video_watched', 'video_completed', 'video_view_10s', 'video_view_15s', 'video_view_25_percent', 'video_view_50_percent', 'video_view_75_percent',
] as const
export const PRODUCT_EVENTS = ['Search', 'ViewContent', 'AddToCart', 'Purchase'] as const
export const LOOKALIKE_TYPES = ['similarity', 'reach', 'custom_ratio'] as const
export const USE_FOR_PRODUCTS = ['ADS', 'MARKETING_MESSAGES'] as const
export const SHARE_PERMISSIONS = ['targeting', 'targeting_and_insights'] as const

/** Meta: at most 10,000 rows per users request (custom-audiences guide). */
export const MEMBERS_PER_REQUEST = 10_000
/** A request of 10,000 hashes, form-encoded (each `%22<64 hex>%22%2C`). */
export const MEMBERS_MAX_BODY = 760_000
/** The longest rule retention Meta documents (engagement audiences: 730 days); a website rule's own is 365 (the tools hold it). */
export const MAX_RETENTION_SECONDS = 730 * 86_400
export const MAX_RULES = 10
export const MAX_LEAVES = 100
const SHA256_HEX = /^[0-9a-f]{64}$/
const DIGITS = /^\d{1,20}$/
/** A rule's field: url, domain, path, event, device_type or a custom-data key (letters, digits, _ and .). */
export const RULE_FIELD = /^[A-Za-z_][A-Za-z0-9_.]{0,99}$/
const TAG = /^[A-Za-z0-9_]{1,100}$/
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
/** An opt-out link: an http(s) URL, plain ASCII, no space, at most 1,000 characters. */
export const OPT_OUT_LINK = /^https?:\/\/[\x21-\x7e]{1,990}$/

// ── value judges ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A JSON value in Nexus's own canonical form (it parses and, written again, is the same string), else undefined. */
function canonical(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value)
    return JSON.stringify(parsed) === value ? parsed : undefined
  } catch {
    return undefined
  }
}
const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exactKeys = (o: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []) =>
  Object.keys(o).every((k) => allowed.includes(k)) && required.every((k) => k in o)
const isId = (v: unknown): v is string => typeof v === 'string' && DIGITS.test(v)
const unique = (list: unknown[]) => new Set(list.map((v) => JSON.stringify(v))).size === list.length

const json = (what: string, judge: (parsed: unknown) => string | null): Judge => (value) => {
  const parsed = canonical(value)
  if (parsed === undefined) return `${what} is JSON in one spelling only (as Nexus writes it: no spaces, each key once)`
  return judge(parsed)
}
const oneOf = (values: readonly string[], what: string): Judge => (value) => (values.includes(value) ? null : `${what} is one of ${values.join(', ')}`)
const whole = (min: number, max: number, what: string): Judge => (value) => {
  if (!/^(0|[1-9]\d{0,14})$/.test(value)) return `${what} is a whole number`
  const n = Number(value)
  return n < min || n > max ? `${what} is between ${min} and ${max}` : null
}
const text = (max: number, pattern: RegExp, what: string): Judge => (value) =>
  (value.trim() === value && value.length > 0 && [...value].length <= max && pattern.test(value) ? null : `${what} is text of 1 to ${max} characters (no control or format character)`)
const digits = (what: string): Judge => (value) => (DIGITS.test(value) ? null : `${what} is a Meta id (digits)`)
const idList = (what: string, min: number, max: number) => json(what, (list) => (
  Array.isArray(list) && list.length >= min && list.length <= max && list.every(isId) && unique(list) ? null : `${what} is a list of ${min} to ${max} Meta ids (digits, as JSON strings), each once`))
const enumList = (values: readonly string[], what: string, max: number) => json(what, (list) => (
  Array.isArray(list) && list.length >= 1 && list.length <= max && list.every((v) => typeof v === 'string' && values.includes(v)) && unique(list) ? null : `${what} is a list of ${values.join(', ')}, each once`))

/** A filter's or aggregation's value: text (at most 1,000 characters), a number, or a list of at most 100 of them. */
function valueProblem(v: unknown): boolean {
  const scalar = (x: unknown) => (typeof x === 'string' && x.length <= 1000) || (typeof x === 'number' && Number.isFinite(x))
  return !(scalar(v) || (Array.isArray(v) && v.length >= 1 && v.length <= 100 && v.every(scalar)))
}

/** A leaf of a rule's filter: {field, operator, value}; an `event` filter takes = (or eq) only. */
function conditionProblem(c: unknown): string | null {
  if (!plainObject(c) || !exactKeys(c, ['field', 'operator', 'value'], ['field', 'operator', 'value'])) return 'a filter is {field, operator, value}'
  if (typeof c.field !== 'string' || !RULE_FIELD.test(c.field)) return 'a filter field is url, domain, path, event, device_type or a custom-data key'
  if (!(FILTER_OPERATORS as readonly string[]).includes(c.operator as string)) return `a filter operator is one of ${FILTER_OPERATORS.join(' ')}`
  if (c.field === 'event' && c.operator !== '=' && c.operator !== 'eq') return 'an event filter takes = only (audience-rules)'
  return valueProblem(c.value) ? 'a filter value is text, a number, or a list of at most 100 of them' : null
}

/** A filter {operator, filters}: its leaves, or a filter of leaves (two levels at most), at most 100 leaves in all. */
function filterProblem(f: unknown, depth: number, leaves: { n: number }): string | null {
  if (!plainObject(f) || !exactKeys(f, ['operator', 'filters'], ['operator', 'filters'])) return 'a filter set is {operator, filters}'
  if (!(RULE_SET_OPERATORS as readonly string[]).includes(f.operator as string)) return 'a filter set\'s operator is and or or'
  if (!Array.isArray(f.filters) || f.filters.length < 1 || f.filters.length > MAX_LEAVES) return `a filter set holds 1 to ${MAX_LEAVES} filters`
  for (const item of f.filters) {
    if (plainObject(item) && 'filters' in item) {
      if (depth >= 2) return 'a filter set nests at most two levels'
      const problem = filterProblem(item, depth + 1, leaves)
      if (problem) return problem
    } else {
      const problem = conditionProblem(item)
      if (problem) return problem
      leaves.n += 1
    }
  }
  return leaves.n > MAX_LEAVES ? `a rule has at most ${MAX_LEAVES} filters (audience-rules)` : null
}

function aggregationProblem(a: unknown): string | null {
  if (!plainObject(a) || !exactKeys(a, ['type', 'field', 'operator', 'value', 'method'], ['type', 'operator', 'value'])) return 'an aggregation is {type, field, operator, value, method}'
  if (!(AGGREGATION_TYPES as readonly string[]).includes(a.type as string)) return `an aggregation type is one of ${AGGREGATION_TYPES.join(', ')}`
  if (a.type !== 'count' && (typeof a.field !== 'string' || !RULE_FIELD.test(a.field))) return 'an aggregation other than count names its field'
  if ('field' in a && (typeof a.field !== 'string' || !RULE_FIELD.test(a.field))) return 'an aggregation field is a custom-data key'
  if (!(AGGREGATION_OPERATORS as readonly string[]).includes(a.operator as string)) return `an aggregation operator is one of ${AGGREGATION_OPERATORS.join(' ')}`
  if ('method' in a && a.method !== 'absolute' && a.method !== 'percentile') return 'an aggregation method is absolute or percentile'
  if (a.method === 'percentile' && a.operator !== 'in_range' && a.operator !== 'not_in_range') return 'a percentile aggregation takes in_range or not_in_range (audience-rules)'
  return valueProblem(a.value) ? 'an aggregation value is text, a number, or a list of them' : null
}

function ruleItemProblem(r: unknown): string | null {
  // Review B4 — filter is required (audience-rules: "Required"); every visitor is {"field":"url","operator":"i_contains","value":""}.
  if (!plainObject(r) || !exactKeys(r, ['event_sources', 'retention_seconds', 'filter', 'aggregation'], ['event_sources', 'retention_seconds', 'filter'])) {
    return 'a rule is {event_sources, retention_seconds, filter, aggregation?} (filter is required: every visitor is url i_contains "")'
  }
  if (!Array.isArray(r.event_sources) || r.event_sources.length < 1 || r.event_sources.length > 10) return 'a rule names 1 to 10 event sources'
  for (const s of r.event_sources) {
    if (!plainObject(s) || !exactKeys(s, ['id', 'type'], ['id', 'type']) || !isId(s.id) || !(AUDIENCE_SOURCE_TYPES as readonly string[]).includes(s.type as string)) {
      return `an event source is {id (digits, as a JSON string), type: ${AUDIENCE_SOURCE_TYPES.join(' | ')}}`
    }
  }
  if (typeof r.retention_seconds !== 'number' || !Number.isInteger(r.retention_seconds) || r.retention_seconds < 0 || r.retention_seconds > MAX_RETENTION_SECONDS) {
    return `retention_seconds is a whole number from 0 to ${MAX_RETENTION_SECONDS}`
  }
  const filter = filterProblem(r.filter, 1, { n: 0 })
  if (filter) return filter
  return 'aggregation' in r ? aggregationProblem(r.aggregation) : null
}

function ruleSetProblem(s: unknown, what: string): string | null {
  if (!plainObject(s) || !exactKeys(s, ['operator', 'rules'], ['operator', 'rules'])) return `${what} is {operator, rules}`
  if (!(RULE_SET_OPERATORS as readonly string[]).includes(s.operator as string)) return `${what}'s operator is and or or`
  if (!Array.isArray(s.rules) || s.rules.length < 1 || s.rules.length > MAX_RULES) return `${what} holds 1 to ${MAX_RULES} rules`
  for (const r of s.rules) {
    const problem = ruleItemProblem(r)
    if (problem) return problem
  }
  return null
}

/**
 * Why an audience rule (Meta's syntax, as a parsed object) is not one Nexus sends, or null: {inclusions, exclusions?},
 * at most 10 rules in all (audience-rules "Limitations").
 */
export function audienceRuleProblem(rule: unknown): string | null {
  if (!plainObject(rule) || !exactKeys(rule, ['inclusions', 'exclusions'], ['inclusions'])) return 'an audience rule is {inclusions, exclusions}'
  const problem = ruleSetProblem(rule.inclusions, 'inclusions') ?? ('exclusions' in rule ? ruleSetProblem(rule.exclusions, 'exclusions') : null)
  if (problem) return problem
  const count = (rule.inclusions as { rules: unknown[] }).rules.length + ('exclusions' in rule ? (rule.exclusions as { rules: unknown[] }).rules.length : 0)
  return count > MAX_RULES ? `an audience rule holds at most ${MAX_RULES} rules, inclusions and exclusions together` : null
}

/** The body-id kind of each event source type: the gateway checks each id is the business's own. */
export const SOURCE_ID_KIND: Readonly<Record<AudienceSourceType, MetaWriteBodyId['kind']>> = {
  pixel: 'pixel', offline_events: 'pixel', page: 'page', shopping_page: 'page', ig_business: 'instagram', shopping_ig: 'instagram',
  lead: 'leadform', ig_lead_generation: 'leadform', canvas: 'canvas',
}

/** The ids an audience rule names (its event sources), each with its kind. */
export function audienceRuleIds(rule: unknown): MetaWriteBodyId[] {
  const out: MetaWriteBodyId[] = []
  if (!plainObject(rule)) return out
  for (const set of [rule.inclusions, rule.exclusions]) {
    if (!plainObject(set) || !Array.isArray(set.rules)) continue
    for (const r of set.rules) {
      if (!plainObject(r) || !Array.isArray(r.event_sources)) continue
      for (const s of r.event_sources) {
        if (plainObject(s) && isId(s.id) && (AUDIENCE_SOURCE_TYPES as readonly string[]).includes(s.type as string)) out.push({ id: s.id, kind: SOURCE_ID_KIND[s.type as AudienceSourceType] })
      }
    }
  }
  return dedupe(out)
}

const dedupe = (ids: MetaWriteBodyId[]) => [...new Map(ids.map((i) => [`${i.kind}:${i.id}`, i])).values()]

/** A video audience's rule: [{object_id, event_name}] (videoads guide, the legacy array format), 1 to 20 videos. */
export function videoRuleProblem(rule: unknown): string | null {
  if (!Array.isArray(rule) || rule.length < 1 || rule.length > 20) return 'a video audience\'s rule is a list of 1 to 20 {object_id, event_name}'
  for (const r of rule) {
    if (!plainObject(r) || !exactKeys(r, ['object_id', 'event_name'], ['object_id', 'event_name']) || !isId(r.object_id) || !(VIDEO_EVENTS as readonly string[]).includes(r.event_name as string)) {
      return `a video rule is {object_id (a video id), event_name: ${VIDEO_EVENTS.join(' | ')}}`
    }
  }
  return unique(rule) ? null : 'a video rule names each video and event once'
}

/** A ratio Meta takes: 0.01 to 0.20 in steps of 0.01 (lookalike-audiences). */
export const lookalikeRatioOk = (v: unknown, min = 0.01): v is number =>
  typeof v === 'number' && v >= min && v <= 0.2 && Math.abs(v * 100 - Math.round(v * 100)) < 1e-9

/**
 * A lookalike spec: type (similarity | reach | custom_ratio) or ratio, starting_ratio below it, allow_international_seeds,
 * and its source when it is not a seed audience — campaign or ad set conversions (origin_ids) or a Page's fans (page_id).
 * Never country or location_spec (v26 ignores them). `update`: only the size keys (its source never changes).
 * Review B3 (re-checked 2026-10-21, lookalike-audiences.md): the table types origin_ids "array of integers" and page_id
 * "int", while its own examples send them quoted ("origin_ids": "<CAMPAIGN_ID>", "page_id": "<PAGE_ID>"). Nexus sends
 * numeric STRINGS: Meta's 15–18-digit ids are past JSON's safe integers (a parse would change them), and Graph takes a
 * numeric string for an id. LIVE-PROBES AU-050r1 settles it.
 */
export function lookalikeSpecProblem(spec: unknown, update = false): string | null {
  const keys = update ? ['type', 'ratio', 'starting_ratio', 'allow_international_seeds'] : ['type', 'ratio', 'starting_ratio', 'allow_international_seeds', 'origin_ids', 'conversion_type', 'page_id']
  if (!plainObject(spec) || !exactKeys(spec, keys) || Object.keys(spec).length === 0) return `a lookalike spec takes ${keys.join(', ')} only (never country or location_spec: Meta ignores them since v26)`
  if ('type' in spec && !(LOOKALIKE_TYPES as readonly string[]).includes(spec.type as string)) return `a lookalike type is one of ${LOOKALIKE_TYPES.join(', ')}`
  if ('ratio' in spec && !lookalikeRatioOk(spec.ratio)) return 'a lookalike ratio is 0.01 to 0.20 in steps of 0.01'
  if ('starting_ratio' in spec && (!lookalikeRatioOk(spec.starting_ratio, 0) || !('ratio' in spec) || (spec.starting_ratio as number) >= (spec.ratio as number))) return 'starting_ratio is 0 to 0.19 in steps of 0.01, below ratio'
  if ('allow_international_seeds' in spec && typeof spec.allow_international_seeds !== 'boolean') return 'allow_international_seeds is true or false'
  if (!update && !('type' in spec) && !('ratio' in spec)) return 'a lookalike names its type or its ratio'
  if (spec.type === 'custom_ratio' && !('ratio' in spec)) return 'a custom_ratio lookalike names its ratio'
  if (update) return null
  if ('conversion_type' in spec && spec.conversion_type !== 'campaign_conversions' && spec.conversion_type !== 'page_like') return 'conversion_type is campaign_conversions or page_like'
  // Review B3 — the converter and Page-fan lookalikes are documented with a ratio only (lookalike-audiences #campaign, #page_fan).
  if ('conversion_type' in spec && !('ratio' in spec)) return 'a campaign-conversion or Page-fan lookalike names its ratio (Meta documents no type there)'
  if (spec.conversion_type === 'campaign_conversions') {
    if (!Array.isArray(spec.origin_ids) || spec.origin_ids.length < 1 || spec.origin_ids.length > 50 || !spec.origin_ids.every(isId) || !unique(spec.origin_ids) || 'page_id' in spec) {
      return 'a campaign-conversion lookalike names 1 to 50 campaigns or ad sets (origin_ids, digits), each once, and no Page'
    }
  } else if (spec.conversion_type === 'page_like') {
    if (!isId(spec.page_id) || 'origin_ids' in spec) return 'a Page-fan lookalike names its Page (page_id, digits) and no campaign'
  } else if ('origin_ids' in spec || 'page_id' in spec) {
    return 'origin_ids go with conversion_type campaign_conversions, page_id with page_like'
  }
  return null
}

/** The ids a lookalike spec names: campaigns or ad sets it learns from, or its Page. */
export function lookalikeSpecIds(spec: unknown): MetaWriteBodyId[] {
  if (!plainObject(spec)) return []
  if (Array.isArray(spec.origin_ids)) return spec.origin_ids.filter(isId).map((id) => ({ id, kind: 'campaignOrAdset' as const }))
  return isId(spec.page_id) ? [{ id: spec.page_id, kind: 'page' }] : []
}

/** A product audience's inclusions or exclusions: [{retention_seconds, rule}] with ONE event (eq) per rule, 1 to 10. */
function productRulesProblem(list: unknown, what: string): string | null {
  if (!Array.isArray(list) || list.length < 1 || list.length > 10) return `${what} is a list of 1 to 10 {retention_seconds, rule}`
  for (const item of list) {
    if (!plainObject(item) || !exactKeys(item, ['retention_seconds', 'rule'], ['retention_seconds', 'rule'])) return `${what}: each is {retention_seconds, rule}`
    if (typeof item.retention_seconds !== 'number' || !Number.isInteger(item.retention_seconds) || item.retention_seconds < 1 || item.retention_seconds > 365 * 86_400) {
      return `${what}: retention_seconds is a whole number from 1 to ${365 * 86_400}`
    }
    if (!productRuleOk(item.rule)) return `${what}: a rule is {"event":{"eq":<${PRODUCT_EVENTS.join(' | ')}>}}, or {"and":[that, {<field>:{<operator>:<value>}} …]} (at most 10)`
  }
  return null
}
const eventRule = (r: unknown) => plainObject(r) && exactKeys(r, ['event'], ['event']) && plainObject(r.event) && exactKeys(r.event, ['eq'], ['eq'])
  && (PRODUCT_EVENTS as readonly string[]).includes(r.event.eq as string)
const fieldRule = (r: unknown) => {
  if (!plainObject(r) || Object.keys(r).length !== 1) return false
  const [field] = Object.keys(r)
  const cond = r[field]
  if (!RULE_FIELD.test(field) || field === 'event' || !plainObject(cond) || Object.keys(cond).length !== 1) return false
  const [op] = Object.keys(cond)
  return (FILTER_OPERATORS as readonly string[]).includes(op) && !valueProblem(cond[op])
}
function productRuleOk(rule: unknown): boolean {
  if (eventRule(rule)) return true
  if (!plainObject(rule) || !exactKeys(rule, ['and'], ['and']) || !Array.isArray(rule.and) || rule.and.length < 2 || rule.and.length > 10) return false
  return rule.and.filter(eventRule).length === 1 && rule.and.every((r) => eventRule(r) || fieldRule(r))
}

/** The pixels a product audience names as its event sources: [{id, type: "PIXEL"}] (the account's own pixel only). */
function productSourcesProblem(list: unknown): string | null {
  return Array.isArray(list) && list.length >= 1 && list.length <= 5 && list.every((s) => plainObject(s) && exactKeys(s, ['id', 'type'], ['id', 'type']) && isId(s.id) && s.type === 'PIXEL') && unique(list)
    ? null : 'event_sources is a list of 1 to 5 {id (a pixel of the ad account, digits), type: "PIXEL"}'
}

/** {"schema":"EMAIL_SHA256","data":[<64 lowercase hex>, …]}: 1 to 10,000 hashed e-mails, never a plain one. */
function payloadProblem(payload: unknown): string | null {
  if (!plainObject(payload) || Object.keys(payload).join(',') !== 'schema,data' || payload.schema !== 'EMAIL_SHA256') return 'the payload is {"schema":"EMAIL_SHA256","data":[…]} (Nexus sends hashed e-mails only)'
  const data = payload.data
  if (!Array.isArray(data) || data.length < 1 || data.length > MEMBERS_PER_REQUEST) return `the payload holds 1 to ${MEMBERS_PER_REQUEST} hashed e-mails (Meta's limit per request)`
  return data.every((h) => typeof h === 'string' && SHA256_HEX.test(h)) ? null : 'every entry is a SHA-256 hash (64 lowercase hex characters): Nexus never sends a plain e-mail'
}

// ── the rules ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every key of a body judged by its own judge, then the body as a whole. */
const judged = (judges: Record<string, Judge>, whole?: (params: Params) => string | null) => (params: Params): string | null => {
  for (const [key, value] of params) {
    const judge = judges[key]
    if (!judge) return `"${key}" is not a key Nexus sends here`
    const problem = judge(value, params)
    if (problem) return problem
  }
  return whole ? whole(params) : null
}

const NAME = text(200, META_NAME_TEXT, 'name')
const DESCRIPTION = text(1000, META_STRICT_TEXT, 'description')
const LABELS = enumList(AUDIENCE_LABELS, 'audience_labels', AUDIENCE_LABELS.length)
const RULE = json('rule', audienceRuleProblem)
const parsedOf = (params: Params, key: string): unknown => canonical(params.get(key) ?? '')

const CREATE_JUDGES: Record<string, Judge> = {
  name: NAME,
  description: DESCRIPTION,
  subtype: oneOf(['CUSTOM', 'ENGAGEMENT', 'LOOKALIKE'], 'subtype'),
  customer_file_source: oneOf(CUSTOMER_FILE_SOURCES, 'customer_file_source'),
  audience_labels: LABELS,
  retention_days: whole(1, 180, 'retention_days'),
  opt_out_link: (value) => (OPT_OUT_LINK.test(value) ? null : 'opt_out_link is an http(s) link of at most 1,000 characters'),
  is_value_based: oneOf(['true'], 'is_value_based'),
  prefill: oneOf(['true', 'false'], 'prefill'),
  rule: (value, params) => (params.get('subtype') === 'ENGAGEMENT' ? json('rule', videoRuleProblem)(value, params) : RULE(value, params)),
  origin_audience_id: digits('origin_audience_id'),
  lookalike_spec: json('lookalike_spec', (spec) => lookalikeSpecProblem(spec)),
  product_set_id: digits('product_set_id'),
  inclusions: json('inclusions', (list) => productRulesProblem(list, 'inclusions')),
  exclusions: json('exclusions', (list) => productRulesProblem(list, 'exclusions')),
  event_sources: json('event_sources', productSourcesProblem),
}

const UPDATE_KEYS = [
  'name', 'description', 'rule', 'opt_out_link', 'lookalike_spec', 'customer_file_source', 'audience_labels', 'retention_days', 'product_set_id',
  'allowed_domains', 'use_in_campaigns', 'use_for_products',
] as const
const UPDATE_JUDGES: Record<string, Judge> = {
  name: NAME,
  description: DESCRIPTION,
  rule: RULE,
  opt_out_link: CREATE_JUDGES.opt_out_link,
  lookalike_spec: json('lookalike_spec', (spec) => lookalikeSpecProblem(spec, true)),
  customer_file_source: CREATE_JUDGES.customer_file_source,
  audience_labels: LABELS,
  retention_days: CREATE_JUDGES.retention_days,
  product_set_id: digits('product_set_id'),
  allowed_domains: json('allowed_domains', (list) => (Array.isArray(list) && list.length >= 1 && list.length <= 50 && list.every((d) => typeof d === 'string' && DOMAIN.test(d)) && unique(list)
    ? null : 'allowed_domains is a list of 1 to 50 domains (lower case), each once')),
  use_in_campaigns: oneOf(['true', 'false'], 'use_in_campaigns'),
  use_for_products: enumList(USE_FOR_PRODUCTS, 'use_for_products', USE_FOR_PRODUCTS.length),
}

const ACCOUNT_JUDGES: Record<string, Judge> = {
  existing_customers: idList('existing_customers', 0, 100),
  custom_audience_info: json('custom_audience_info', (o) => (plainObject(o) && exactKeys(o, ['audience_type_param_name', 'new_customer_tag', 'existing_customer_tag'], ['audience_type_param_name'])
    && Object.values(o).every((v) => typeof v === 'string' && TAG.test(v)) && ('new_customer_tag' in o || 'existing_customer_tag' in o)
    ? null : 'custom_audience_info is {audience_type_param_name, new_customer_tag and / or existing_customer_tag}: letters, digits and _ only')),
}

// Review B1 — no `session` on these DELETEs (optional in the users reference; the guide's DELETE examples send the payload
// only): a session id repeated for the same people would be one Meta already closed.
const MEMBER_JUDGES: Record<string, Judge> = {
  payload: json('payload', payloadProblem),
}

const SHARE_JUDGES: Record<string, Judge> = {
  adaccounts: idList('adaccounts', 1, 50),
  permissions: oneOf(SHARE_PERMISSIONS, 'permissions'),
}

const ruleIds = (params: Params): MetaWriteBodyId[] => {
  const ids: MetaWriteBodyId[] = []
  if (params.get('subtype') === 'ENGAGEMENT') {
    const rule = parsedOf(params, 'rule')
    if (Array.isArray(rule)) for (const r of rule) if (plainObject(r) && isId(r.object_id)) ids.push({ id: r.object_id, kind: 'video' })
  } else if (params.has('rule')) {
    ids.push(...audienceRuleIds(parsedOf(params, 'rule')))
  }
  const origin = params.get('origin_audience_id')
  if (origin && DIGITS.test(origin)) ids.push({ id: origin, kind: 'customaudience' })
  if (params.has('lookalike_spec')) ids.push(...lookalikeSpecIds(parsedOf(params, 'lookalike_spec')))
  const productSet = params.get('product_set_id')
  if (productSet && DIGITS.test(productSet)) ids.push({ id: productSet, kind: 'productset' })
  const sources = parsedOf(params, 'event_sources')
  if (Array.isArray(sources)) for (const s of sources) if (plainObject(s) && isId(s.id)) ids.push({ id: s.id, kind: 'pixel' })
  const existing = parsedOf(params, 'existing_customers')
  if (Array.isArray(existing)) for (const id of existing) if (isId(id)) ids.push({ id, kind: 'customaudience' })
  const accounts = parsedOf(params, 'adaccounts')
  if (Array.isArray(accounts)) for (const id of accounts) if (isId(id)) ids.push({ id, kind: 'adaccount' })
  return dedupe(ids)
}

const ACCOUNT_EDGE = (edge: string) => new RegExp(`^act_\\d{1,20}\\/${edge}$`)

/** Step 31 — the audience tools on the write allow-list. */
export const META_AUDIENCE_WRITE_RULES: readonly MetaWriteRule[] = [
  {
    // create-meta-audience kind customer_list / value_seed: an EMPTY customer list (Nexus adds nobody to it — D8).
    name: 'audience.create.customerList',
    method: 'POST',
    path: ACCOUNT_EDGE('customaudiences'),
    kinds: ['adaccount'],
    required: ['name', 'subtype', 'customer_file_source'],
    optional: ['description', 'audience_labels', 'retention_days', 'opt_out_link', 'is_value_based'],
    text: { name: META_NAME_TEXT, description: META_STRICT_TEXT },
    values: judged(CREATE_JUDGES, (params) => (params.get('subtype') === 'CUSTOM' ? null : 'a customer list is subtype CUSTOM')),
    budget: false,
  },
  {
    // create-meta-audience kind website / engagement / offline: a rule over the account's own pixel, Page, Instagram account,
    // forms or Instant Experiences — no subtype (Meta: subtype only for a customer list, a lookalike and a video audience).
    name: 'audience.create.rule',
    method: 'POST',
    path: ACCOUNT_EDGE('customaudiences'),
    kinds: ['adaccount'],
    required: ['name', 'rule'],
    optional: ['description', 'audience_labels', 'prefill', 'retention_days'],
    text: { name: META_NAME_TEXT, description: META_STRICT_TEXT, rule: META_STRICT_TEXT },
    maxBody: 40_000,
    values: judged(CREATE_JUDGES),
    budget: false,
    ids: ruleIds,
  },
  {
    // create-meta-audience kind video: subtype ENGAGEMENT with the legacy array rule of video ids and view events.
    name: 'audience.create.video',
    method: 'POST',
    path: ACCOUNT_EDGE('customaudiences'),
    kinds: ['adaccount'],
    required: ['name', 'subtype', 'rule'],
    optional: ['description', 'prefill'],
    text: { name: META_NAME_TEXT, description: META_STRICT_TEXT },
    maxBody: 8_000,
    values: judged(CREATE_JUDGES, (params) => (params.get('subtype') === 'ENGAGEMENT' ? null : 'a video audience is subtype ENGAGEMENT')),
    budget: false,
    ids: ruleIds,
  },
  {
    // create-meta-audience kind lookalike (each tier one request): a seed audience of the account, or its campaigns' or ad
    // sets' converters, or its Page's fans.
    name: 'audience.create.lookalike',
    method: 'POST',
    path: ACCOUNT_EDGE('customaudiences'),
    kinds: ['adaccount'],
    required: ['name', 'subtype', 'lookalike_spec'],
    optional: ['origin_audience_id', 'description'],
    text: { name: META_NAME_TEXT, description: META_STRICT_TEXT },
    values: judged(CREATE_JUDGES, (params) => {
      if (params.get('subtype') !== 'LOOKALIKE') return 'a lookalike is subtype LOOKALIKE'
      const spec = parsedOf(params, 'lookalike_spec') as { conversion_type?: unknown } | undefined
      const fromSeed = params.has('origin_audience_id')
      if (fromSeed === !!spec?.conversion_type) return 'a lookalike learns from ONE source: a seed audience (origin_audience_id) or campaign conversions / a Page\'s fans (lookalike_spec conversion_type)'
      return null
    }),
    budget: false,
    ids: ruleIds,
  },
  {
    // create-meta-audience kind catalog: people who viewed, carted or bought products of a product set.
    name: 'audience.create.product',
    method: 'POST',
    path: ACCOUNT_EDGE('product_audiences'),
    kinds: ['adaccount'],
    required: ['name', 'product_set_id', 'inclusions'],
    optional: ['exclusions', 'description', 'event_sources'],
    text: { name: META_NAME_TEXT, description: META_STRICT_TEXT },
    maxBody: 12_000,
    values: judged(CREATE_JUDGES),
    budget: false,
    ids: ruleIds,
  },
  {
    // set-meta-audience: one audience of the account (its own; a shared-in audience is never changed).
    name: 'audience.update',
    method: 'POST',
    path: /^\d{1,20}$/,
    kinds: ['customaudience'],
    required: [],
    optional: UPDATE_KEYS,
    anyOf: UPDATE_KEYS,
    text: { name: META_NAME_TEXT, description: META_STRICT_TEXT, rule: META_STRICT_TEXT },
    maxBody: 40_000,
    values: judged(UPDATE_JUDGES),
    budget: false,
    ids: ruleIds,
  },
  {
    // set-meta-audience: the ad account's existing-customer audiences (the WHOLE list) and its audience-type URL tags.
    name: 'adaccount.audiences',
    method: 'POST',
    path: /^act_\d{1,20}$/,
    kinds: ['adaccount'],
    required: [],
    optional: ['existing_customers', 'custom_audience_info'],
    anyOf: ['existing_customers', 'custom_audience_info'],
    maxBody: 4_000,
    values: judged(ACCOUNT_JUDGES),
    budget: false,
    ids: ruleIds,
  },
  {
    // set-meta-audience-members mode remove: people who opted out of the business's e-mail, hashed, out of ONE list.
    name: 'audience.users.remove',
    method: 'DELETE',
    deleteBody: true,
    personal: true,
    path: /^\d{1,20}\/users$/,
    kinds: ['customaudience'],
    required: ['payload'],
    optional: [],
    maxBody: MEMBERS_MAX_BODY,
    values: judged(MEMBER_JUDGES),
    budget: false,
  },
  {
    // set-meta-audience-members mode opt_out_everywhere: the same people out of EVERY customer list of the account.
    name: 'adaccount.usersofanyaudience',
    method: 'DELETE',
    deleteBody: true,
    personal: true,
    path: ACCOUNT_EDGE('usersofanyaudience'),
    kinds: ['adaccount'],
    required: ['payload'],
    optional: [],
    maxBody: MEMBERS_MAX_BODY,
    values: judged(MEMBER_JUDGES),
    budget: false,
  },
  {
    // set-meta-audience-sharing share: with ad accounts no other Nexus business uses (never `replace`: unsharing is its own).
    name: 'audience.share',
    method: 'POST',
    path: /^\d{1,20}\/ad_accounts$/,
    kinds: ['customaudience'],
    required: ['adaccounts'],
    optional: ['permissions'],
    values: judged(SHARE_JUDGES),
    budget: false,
    ids: ruleIds,
  },
  {
    // set-meta-audience-sharing unshare: the recipients' ads using it stop for good.
    name: 'audience.unshare',
    method: 'DELETE',
    deleteBody: true,
    path: /^\d{1,20}\/ad_accounts$/,
    kinds: ['customaudience'],
    required: ['adaccounts'],
    optional: [],
    values: judged(SHARE_JUDGES),
    budget: false,
    // Review A1 — taking access away needs no recipient check (it is how a share with another business's account ends).
  },
  {
    // remove-meta-audience: DELETE /{audience} (no body); its lookalikes first, each its own request.
    name: 'audience.delete',
    method: 'DELETE',
    path: /^\d{1,20}$/,
    kinds: ['customaudience'],
    required: [],
    optional: [],
    values: () => null,
    budget: false,
  },
]
