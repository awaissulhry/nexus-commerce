/**
 * Meta step 29 (2026-10-21) — the write allow-list entries of set-meta-ad-rule and remove-meta-ad-rule (Meta's automated
 * rules): EXACT keys per kind of call, and every value judged — the three specs as JSON in Nexus's own canonical form (the
 * string judged is the string sent: one spelling only, every key at every depth on a list, every field name of Meta's
 * grammar, every operator and value shape Meta documents), a rule's name only where a person types it. The ids inside an
 * evaluation spec (the objects a rule is scoped to, the labels it reads) are handed to the gateway, which checks each is
 * of the chosen ad account before anything is sent (gateway.ts metaRuleOwnerProblem).
 *
 *   adRule.create   POST /act_<id>/adrules_library   name, evaluation_spec, execution_spec, status (always named: a rule
 *                                                     Nexus makes is DISABLED unless the request said enable), schedule_spec
 *   adRule.update   POST /<rule id>                  name and / or the WHOLE rule: evaluation_spec + execution_spec (+
 *                                                     schedule_spec for a schedule rule) — Meta: "provide all fields,
 *                                                     including those that are unchanged" (RU-026)
 *   adRule.status   POST /<rule id>                  status ENABLED | DISABLED, alone (RU-027)
 *   adRule.run      POST /<rule id>/execute          no body (RU-032)
 *   adRule.preview  POST /<rule id>/preview          no body; a POST that only reads (RU-031): it goes as a read and
 *                                                     changes nothing
 *   adRule.delete   DELETE /<rule id>                no body (RU-028)
 *
 * Checked 2026-10-21 (developers.facebook.com/documentation/ads-commerce/marketing-api/…, `.md` pages, ≥ 4 s apart; the
 * legacy page developers.facebook.com/docs/marketing-api/reference/ad-rule/; Meta's Python Business SDK
 * facebook_business/adobjects/adrule.py on GitHub main):
 *   - reference/ad-account/adrules_library.md "Creating": account_id (from the path), evaluation_spec {evaluation_type
 *     SCHEDULE | TRIGGER, filters [{field, value, operator}], trigger {type, field, value, operator}}, execution_spec
 *     {execution_type, is_once_off, execution_options [{field, value, operator EQUAL | IN}]}, name (required),
 *     schedule_spec {schedule_type DAILY | HOURLY | SEMI_HOURLY | CUSTOM, schedule [{start_minute, end_minute, days}]},
 *     status ENABLED | DISABLED | DELETED | HAS_ISSUES; read-after-write {id}; errors 200, 100, 368 (abusive), 2703 ("Rules
 *     that turn off ads can't have cost conditions"), 190. The legacy page adds `recommended_rule_key` (no values anywhere:
 *     RECHECK-C3 RU-024 — never sent). Updating (legacy page, SDK AdRule.api_update): evaluation_spec, execution_spec,
 *     name, schedule_spec, status → {success}; DELETE /<rule id> → {success}; SDK create_execute and create_preview are
 *     POST with no parameter.
 *   - ad-rules/guides/api-calls.md: update "provide all fields, including those that are unchanged" (entity_type,
 *     time_preset); a status change needs no spec; "Preview the evaluation of a Schedule Based Rule by sending a POST";
 *     "Manually execute a Schedule Based Rule by sending a POST".
 *   - ad-rules/overview/evaluation-spec.md: the 13 operators and their value shapes; time_preset (EQUAL only, the values
 *     below), attribution_window (EQUAL, only ACCOUNT_DEFAULT — "Whether specified or not, the only allowed value"; the
 *     ROAS guide's samples send 7D_CLICK and 1D_VIEW_1D_CLICK there, which this page rules out: a window per filter is its
 *     prefix, `7d_click:`), entity_type (EQUAL, AD | ADSET | CAMPAIGN), id (EQUAL, IN, NOT_IN), adlabel_ids (ANY, ALL,
 *     NONE); "you must specify either an entity_type or id filter".
 *   - ad-rules/guides/evaluation-spec-filters.md: prefixes in the order object level (ad. adset. campaign.) → attribution
 *     window (`7d_click:` …) → time preset (`yesterday_` …, part of the name here); aggregate(field) with aggregation_id
 *     (IN, ids of one level); formula fields — fields or constants separated by spaces with + - * /, parentheses allowed,
 *     at most 6 non-constant fields.
 *   - ad-rules/overview/execution-spec.md: the nine execution types Meta documents (NOTIFICATION, PAUSE, UNPAUSE,
 *     CHANGE_BUDGET, CHANGE_CAMPAIGN_BUDGET, CHANGE_BID, ROTATE, REBALANCE_BUDGET, PING_ENDPOINT — the enum's other ten have
 *     no guide: RU-022, never sent, and is_once_off neither); options user_ids, change_spec, rebalance_spec,
 *     execution_count_limit, action_frequency, "the only supported operator for all options is EQUAL".
 *   - ad-rules/overview/change-spec.md: amount (required), limit (a currency amount, a [low, high] range with
 *     target_field), unit ACCOUNT_CURRENCY | PERCENTAGE (required unless target_field), target_field (an insights field).
 *   - ad-rules/guides/rebalance-budget.md: rebalance_spec type EVEN | PROPORTIONAL | NO_PAUSE_PROPORTIONAL |
 *     MATCHED_ONLY_PROPORTIONAL (target_field required unless EVEN, and with target_count), target_count, is_cross_campaign,
 *     is_inverse (the guide's own sample sends INVERSE_PROPORTIONAL, which its table does not list: not sent).
 *   - ad-rules/guides/scheduled-based-rules.md + advanced-scheduling.md: CUSTOM entries need start_minute or days;
 *     minutes are multiples of 30, end_minute after (or equal to) start_minute; days 0 (Sunday) … 6.
 *   - ad-rules/guides/trigger-based-rules.md: one trigger; METADATA_CREATION has no field; METADATA_UPDATE a field, value
 *     and operator optional; STATS_MILESTONE operator EQUAL; STATS_CHANGE GREATER_THAN, LESS_THAN, IN_RANGE, NOT_IN_RANGE;
 *     DELIVERY_INSIGHTS_CHANGE is beta (no fields documented); no schedule_spec.
 * Ids inside a spec are sent as JSON strings of digits: a Meta id has up to 20 digits, and a JSON number past 2^53 cannot
 * be written exactly (Meta's samples show numbers; LIVE-PROBES RU-010 settles that Meta takes the strings).
 */
import type { MetaWriteRule } from './meta-calls.js'
import { META_NAME_TEXT } from './meta-settings-rules.js'

type Params = ReadonlyMap<string, string>
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

// ── Meta's words ────────────────────────────────────────────────────────────────────────────────────────────────────

export const RULE_OPERATORS = ['GREATER_THAN', 'LESS_THAN', 'EQUAL', 'NOT_EQUAL', 'IN_RANGE', 'NOT_IN_RANGE', 'IN', 'NOT_IN', 'CONTAIN', 'NOT_CONTAIN', 'ANY', 'ALL', 'NONE'] as const
export type RuleOperator = typeof RULE_OPERATORS[number]
export const RULE_EVALUATION_KINDS = ['SCHEDULE', 'TRIGGER'] as const
export const RULE_TRIGGER_TYPES = ['METADATA_CREATION', 'METADATA_UPDATE', 'STATS_MILESTONE', 'STATS_CHANGE', 'DELIVERY_INSIGHTS_CHANGE'] as const
/** The nine execution types Meta's guides document (RU-013 … RU-021); the reference enum's other ten are RU-022 (not sent). */
export const RULE_EXECUTION_TYPES = ['NOTIFICATION', 'PAUSE', 'UNPAUSE', 'CHANGE_BUDGET', 'CHANGE_CAMPAIGN_BUDGET', 'CHANGE_BID', 'ROTATE', 'REBALANCE_BUDGET', 'PING_ENDPOINT'] as const
export type RuleExecutionType = typeof RULE_EXECUTION_TYPES[number]
/** Execution types a trigger rule takes (execution-spec.md "Supported Evaluation Types"); a schedule rule takes all but PING_ENDPOINT. */
export const TRIGGER_EXECUTION_TYPES: ReadonlySet<string> = new Set(['NOTIFICATION', 'PAUSE', 'UNPAUSE', 'PING_ENDPOINT'])
export const CHANGE_EXECUTION_TYPES: ReadonlySet<string> = new Set(['CHANGE_BUDGET', 'CHANGE_CAMPAIGN_BUDGET', 'CHANGE_BID'])
export const RULE_SCHEDULE_TYPES = ['DAILY', 'HOURLY', 'SEMI_HOURLY', 'CUSTOM'] as const
export const REBALANCE_TYPES = ['EVEN', 'PROPORTIONAL', 'NO_PAUSE_PROPORTIONAL', 'MATCHED_ONLY_PROPORTIONAL'] as const
export const CHANGE_UNITS = ['ACCOUNT_CURRENCY', 'PERCENTAGE'] as const
export const RULE_ENTITY_TYPES = ['AD', 'ADSET', 'CAMPAIGN'] as const
/** Time presets that include today (evaluation-spec.md): the only ones a trigger rule takes. */
export const TODAY_TIME_PRESETS = ['LIFETIME', 'TODAY', 'LAST_2_DAYS', 'LAST_3_DAYS', 'LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_28_DAYS', 'LAST_30_DAYS', 'THIS_MONTH', 'THIS_WEEK_MON_TODAY', 'THIS_WEEK_SUN_TODAY'] as const
export const RULE_TIME_PRESETS = [
  ...TODAY_TIME_PRESETS, 'YESTERDAY', 'LAST_2D', 'LAST_3D', 'LAST_7D', 'LAST_14D', 'LAST_28D', 'LAST_30D',
  'LAST_ND_14_8', 'LAST_ND_30_8', 'LAST_ND_60_8', 'LAST_ND_120_8', 'LAST_ND_180_8', 'LAST_ND_LIFETIME_8', 'LAST_ND_60_29', 'LAST_ND_120_29', 'LAST_ND_180_29', 'LAST_ND_LIFETIME_29',
] as const
/** Attribution window prefixes (evaluation-spec-filters.md); 7d_view and 28d_view windows return no data since 2026-01-12 (F2 T1). */
export const RULE_ATTRIBUTION_PREFIXES = [
  'account_default', 'default', 'inline', '1d_view', '7d_view', '28d_view', '1d_click', '7d_click', '28d_click', '1d_view_1d_click', '7d_view_1d_click',
  '28d_view_1d_click', '1d_view_7d_click', '7d_view_7d_click', '28d_view_7d_click', '7d_view_28d_click', '28d_view_28d_click',
] as const

/** At most this many filters, ids in one list, people to notify, custom schedule entries. */
export const MAX_RULE_FILTERS = 50
export const MAX_RULE_IDS = 250
export const MAX_RULE_PEOPLE = 50
export const MAX_SCHEDULE_ENTRIES = 50
const MAX_TEXT = 400
const MAX_FIELD = 200

// ── field names ─────────────────────────────────────────────────────────────────────────────────────────────────────

// A name never starts with a level word (one level prefix only: `ad.adset.spent` is not a field).
const NAME = '(?!(?:ad|adset|campaign)\\.)[a-z][a-z0-9_]{0,79}(?:\\.[a-z][a-z0-9_]{0,79})?'
const ATTR = `(?:(?:${RULE_ATTRIBUTION_PREFIXES.join('|')}):)?`
const SIMPLE_FIELD = new RegExp(`^(?:(?:ad|adset|campaign)\\.)?${ATTR}${NAME}$`)
const AGGREGATE_FIELD = new RegExp(`^aggregate\\(${ATTR}${NAME}\\)$`)
const CONSTANT = /^\d{1,9}(?:\.\d{1,6})?$/

/** The id fields of an evaluation spec, and the kind of object each names (an unprefixed id: a campaign, ad set or ad). */
export const ID_FIELDS: Readonly<Record<string, 'adobject' | 'campaign' | 'adset' | 'ad'>> = { id: 'adobject', 'ad.id': 'ad', 'adset.id': 'adset', 'campaign.id': 'campaign', aggregation_id: 'adobject' }
const LABEL_FIELD = /^(?:(?:ad|adset|campaign)\.)?adlabel_ids$/

/**
 * Why a rule field name is not one of Meta's grammar, or null: a field with its optional level and attribution prefixes,
 * aggregate(field), or a formula of such fields and constants separated by single spaces with + - * / (parentheses
 * balanced, at most 6 fields). Lower-case ASCII only.
 */
export function ruleFieldProblem(field: unknown): string | null {
  if (typeof field !== 'string' || !field) return 'a rule field is a name (lower-case letters, digits, _ . :)'
  if (field.length > MAX_FIELD) return `a rule field is at most ${MAX_FIELD} characters`
  if (SIMPLE_FIELD.test(field) || AGGREGATE_FIELD.test(field)) return null
  if (!field.includes(' ')) return `"${field.slice(0, 60)}" is not a rule field Meta documents (a field, its ad. / adset. / campaign. and attribution prefixes, aggregate(…) or a formula)`
  const parts = field.split(' ')
  if (parts.length % 2 === 0) return 'a formula alternates fields (or numbers) and + - * /, separated by single spaces'
  let depth = 0
  let fields = 0
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (i % 2 === 1) {
      if (!['+', '-', '*', '/'].includes(part)) return `"${part.slice(0, 10)}" is not a formula operator (+ - * /)`
      continue
    }
    const open = /^\(*/.exec(part)![0].length
    const close = /\)*$/.exec(part)![0].length
    const term = part.slice(open, part.length - close)
    depth += open
    if (CONSTANT.test(term)) { /* a constant */ } else if (SIMPLE_FIELD.test(term) || AGGREGATE_FIELD.test(term)) fields++
    else return `"${term.slice(0, 60)}" in the formula is not a rule field or a number`
    depth -= close
    if (depth < 0) return 'a formula closes a parenthesis it did not open'
  }
  if (depth !== 0) return 'a formula\'s parentheses are balanced'
  if (fields === 0) return 'a formula names at least one field'
  return fields > 6 ? 'a formula names at most 6 fields (Meta)' : null
}

// ── values ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const plainObject = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v)
const exactKeys = (o: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []) =>
  Object.keys(o).every((k) => allowed.includes(k)) && required.every((k) => k in o)
/** A number Meta reads as written: finite, at most 1e15 (an integer within JS's exact range). */
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e15
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && [...v].length <= MAX_TEXT
const isScalar = (v: unknown) => isNumber(v) || isText(v) || typeof v === 'boolean'
/** A Meta id inside a spec: digits, as a JSON string. */
export const isRuleId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,20}$/.test(v)
const idList = (v: unknown, what: string): string | null =>
  Array.isArray(v) && v.length >= 1 && v.length <= MAX_RULE_IDS && v.every(isRuleId) && new Set(v).size === v.length
    ? null
    : `${what} lists 1 to ${MAX_RULE_IDS} Meta ids (digits, as JSON strings), each once`

/** Why a value does not fit its operator (evaluation-spec.md "Logical Operator" table), or null. */
export function ruleValueProblem(operator: unknown, value: unknown, where: string): string | null {
  switch (operator) {
    case 'GREATER_THAN': case 'LESS_THAN':
      return isNumber(value) ? null : `${where}: ${operator} compares a number`
    case 'EQUAL': case 'NOT_EQUAL':
      return isScalar(value) ? null : `${where}: ${operator} compares one number, text or true / false`
    case 'IN_RANGE': case 'NOT_IN_RANGE':
      return Array.isArray(value) && value.length === 2 && value.every(isNumber) && (value[0] as number) <= (value[1] as number) ? null : `${where}: ${operator} takes [low, high], two numbers`
    case 'IN': case 'NOT_IN': case 'ANY': case 'ALL': case 'NONE':
      return Array.isArray(value) && value.length >= 1 && value.length <= MAX_RULE_IDS && value.every(isScalar) ? null : `${where}: ${operator} takes a list of 1 to ${MAX_RULE_IDS} values`
    case 'CONTAIN': case 'NOT_CONTAIN':
      return isText(value) ? null : `${where}: ${operator} takes text`
    default:
      return `${where}: the operator is one of ${RULE_OPERATORS.join(', ')}`
  }
}

/** Why one filter is refused, or null: exact keys, Meta's field grammar, its operator's value, the special fields' own rules. */
function filterProblem(f: unknown, where: string): string | null {
  if (!plainObject(f) || !exactKeys(f, ['field', 'value', 'operator'], ['field', 'value', 'operator'])) return `${where} is {field, value, operator}`
  const field = f.field as string
  const fieldProblem = ruleFieldProblem(field)
  if (fieldProblem) return `${where}: ${fieldProblem}`
  const named = `${where} (${field})`
  if (field === 'entity_type') return f.operator === 'EQUAL' && (RULE_ENTITY_TYPES as readonly unknown[]).includes(f.value) ? null : `${named}: entity_type EQUAL AD, ADSET or CAMPAIGN`
  if (field === 'time_preset') return f.operator === 'EQUAL' && (RULE_TIME_PRESETS as readonly unknown[]).includes(f.value) ? null : `${named}: time_preset EQUAL one of Meta's presets`
  if (field === 'attribution_window') return f.operator === 'EQUAL' && f.value === 'ACCOUNT_DEFAULT' ? null : `${named}: attribution_window is only EQUAL ACCOUNT_DEFAULT (Meta)`
  if (field in ID_FIELDS) {
    if (field === 'aggregation_id') return f.operator === 'IN' ? idList(f.value, named) : `${named}: aggregation_id takes IN only`
    if (f.operator === 'EQUAL') return isRuleId(f.value) ? null : `${named}: EQUAL one Meta id (digits, as a JSON string)`
    return f.operator === 'IN' || f.operator === 'NOT_IN' ? idList(f.value, named) : `${named}: an id filter takes EQUAL, IN or NOT_IN`
  }
  if (LABEL_FIELD.test(field)) return ['ANY', 'ALL', 'NONE'].includes(f.operator as string) ? idList(f.value, named) : `${named}: adlabel_ids takes ANY, ALL or NONE`
  return ruleValueProblem(f.operator, f.value, named)
}

/** Why a trigger is refused, or null (trigger-based-rules.md). */
function triggerProblem(t: unknown): string | null {
  if (!plainObject(t) || !exactKeys(t, ['type', 'field', 'value', 'operator'], ['type'])) return 'the trigger is {type, field, value, operator}'
  const type = t.type
  if (!(RULE_TRIGGER_TYPES as readonly unknown[]).includes(type)) return `the trigger type is one of ${RULE_TRIGGER_TYPES.join(', ')}`
  if (type === 'METADATA_CREATION') return Object.keys(t).length === 1 ? null : 'a METADATA_CREATION trigger has a type only (no field, value or operator)'
  if ('field' in t) { const problem = ruleFieldProblem(t.field); if (problem) return `the trigger: ${problem}` }
  if (('value' in t) !== ('operator' in t)) return 'a trigger names its value and operator together'
  if ((type === 'METADATA_UPDATE' || type === 'STATS_MILESTONE' || type === 'STATS_CHANGE') && !('field' in t)) return `a ${type} trigger names its field`
  if (type === 'STATS_MILESTONE' && !(t.operator === 'EQUAL' && isNumber(t.value) && t.value > 0)) return 'a STATS_MILESTONE trigger is EQUAL a positive number (Meta)'
  if (type === 'STATS_CHANGE' && !['GREATER_THAN', 'LESS_THAN', 'IN_RANGE', 'NOT_IN_RANGE'].includes(t.operator as string)) return 'a STATS_CHANGE trigger is GREATER_THAN, LESS_THAN, IN_RANGE or NOT_IN_RANGE (Meta)'
  return 'operator' in t ? ruleValueProblem(t.operator, t.value, 'the trigger') : null
}

/** Why an evaluation spec is refused, or null. */
export function evaluationSpecProblem(spec: unknown): string | null {
  if (!plainObject(spec) || !exactKeys(spec, ['evaluation_type', 'filters', 'trigger'], ['evaluation_type', 'filters'])) return 'evaluation_spec is {evaluation_type, filters, trigger}'
  if (!(RULE_EVALUATION_KINDS as readonly unknown[]).includes(spec.evaluation_type)) return 'evaluation_type is SCHEDULE or TRIGGER'
  const filters = spec.filters
  if (!Array.isArray(filters) || filters.length < 1 || filters.length > MAX_RULE_FILTERS) return `filters lists 1 to ${MAX_RULE_FILTERS} filters`
  for (let i = 0; i < filters.length; i++) { const problem = filterProblem(filters[i], `filter ${i + 1}`); if (problem) return problem }
  const fields = filters.map((f) => (f as Record<string, unknown>).field as string)
  for (const once of ['time_preset', 'attribution_window', 'entity_type']) if (fields.filter((f) => f === once).length > 1) return `a rule has at most one ${once} filter (Meta)`
  if (!fields.includes('entity_type') && !fields.includes('id')) return 'a rule has an entity_type or an id filter (Meta)'
  if (spec.evaluation_type === 'SCHEDULE') return 'trigger' in spec ? 'a schedule rule has no trigger' : null
  if (!('trigger' in spec)) return 'a trigger rule has its trigger'
  if (fields.includes('attribution_window')) return 'attribution_window is for schedule rules only (Meta)'
  const preset = filters.find((f) => (f as Record<string, unknown>).field === 'time_preset') as Record<string, unknown> | undefined
  if (preset && !(TODAY_TIME_PRESETS as readonly unknown[]).includes(preset.value)) return 'a trigger rule takes only a time_preset that includes today (Meta)'
  return triggerProblem(spec.trigger)
}

/** Why a change_spec is refused, or null (change-spec.md). */
function changeSpecProblem(v: unknown): string | null {
  if (!plainObject(v) || !exactKeys(v, ['amount', 'limit', 'unit', 'target_field'], ['amount'])) return 'change_spec is {amount, limit, unit, target_field}'
  if (!isNumber(v.amount) || v.amount === 0) return 'change_spec.amount is a number other than 0'
  if ('target_field' in v) {
    const problem = ruleFieldProblem(v.target_field)
    if (problem) return `change_spec.target_field: ${problem}`
    if ('unit' in v) return 'with target_field, change_spec has no unit (amount is the target value)'
    if (!(v.amount > 0)) return 'with target_field, change_spec.amount is the target value (above 0)'
    if ('limit' in v && !(Array.isArray(v.limit) && v.limit.length === 2 && v.limit.every((n) => isInt(n, 1, 1e15)) && (v.limit[0] as number) <= (v.limit[1] as number))) return 'with target_field, change_spec.limit is [low, high], whole amounts in the currency\'s base unit'
    return null
  }
  if (!(CHANGE_UNITS as readonly unknown[]).includes(v.unit)) return 'change_spec.unit is ACCOUNT_CURRENCY or PERCENTAGE'
  if (v.unit === 'ACCOUNT_CURRENCY' && !Number.isInteger(v.amount)) return 'change_spec.amount in ACCOUNT_CURRENCY is a whole amount in the currency\'s base unit'
  if (v.unit === 'PERCENTAGE' && !(v.amount >= -100 && v.amount <= 1000)) return 'change_spec.amount in PERCENTAGE is between -100 and 1000'
  if ('limit' in v && !isInt(v.limit, 1, 1e15)) return 'change_spec.limit is a whole amount in the currency\'s base unit'
  return null
}

/** Why a rebalance_spec is refused, or null (rebalance-budget.md). */
function rebalanceSpecProblem(v: unknown): string | null {
  if (!plainObject(v) || !exactKeys(v, ['type', 'target_field', 'target_count', 'is_cross_campaign', 'is_inverse'], ['type'])) return 'rebalance_spec is {type, target_field, target_count, is_cross_campaign, is_inverse}'
  if (!(REBALANCE_TYPES as readonly unknown[]).includes(v.type)) return `rebalance_spec.type is one of ${REBALANCE_TYPES.join(', ')}`
  if ('target_field' in v) { const problem = ruleFieldProblem(v.target_field); if (problem) return `rebalance_spec.target_field: ${problem}` }
  if ((v.type !== 'EVEN' || 'target_count' in v) && !('target_field' in v)) return 'rebalance_spec names its target_field (Meta: needed unless EVEN, and with target_count)'
  if ('target_count' in v && !isInt(v.target_count, 1, 1000)) return 'rebalance_spec.target_count is a whole number from 1 to 1000'
  for (const flag of ['is_cross_campaign', 'is_inverse']) if (flag in v && typeof v[flag] !== 'boolean') return `rebalance_spec.${flag} is true or false`
  return null
}

const OPTION_FIELDS = ['user_ids', 'change_spec', 'rebalance_spec', 'execution_count_limit', 'action_frequency'] as const

/** Why an execution spec is refused, or null. */
export function executionSpecProblem(spec: unknown): string | null {
  if (!plainObject(spec) || !exactKeys(spec, ['execution_type', 'execution_options'], ['execution_type'])) return 'execution_spec is {execution_type, execution_options} (Nexus sends no is_once_off: RU-022)'
  const type = spec.execution_type as string
  if (!(RULE_EXECUTION_TYPES as readonly string[]).includes(type)) return `execution_type is one of the nine Meta documents (${RULE_EXECUTION_TYPES.join(', ')})`
  const options = spec.execution_options ?? []
  if (!Array.isArray(options) || options.length > OPTION_FIELDS.length) return 'execution_options lists at most one of each option'
  const seen = new Set<string>()
  for (const o of options) {
    if (!plainObject(o) || !exactKeys(o, ['field', 'value', 'operator'], ['field', 'value', 'operator'])) return 'each execution option is {field, value, operator}'
    if (o.operator !== 'EQUAL') return 'an execution option\'s operator is EQUAL (Meta: the only one supported)'
    const field = o.field as string
    if (!(OPTION_FIELDS as readonly string[]).includes(field)) return `an execution option is one of ${OPTION_FIELDS.join(', ')}`
    if (seen.has(field)) return `execution_options names ${field} once`
    seen.add(field)
    const problem = field === 'user_ids'
      ? (Array.isArray(o.value) && o.value.length >= 1 && o.value.length <= MAX_RULE_PEOPLE && o.value.every(isRuleId) && new Set(o.value).size === o.value.length ? null : `user_ids lists 1 to ${MAX_RULE_PEOPLE} Facebook user ids (digits, as JSON strings), each once`)
      : field === 'change_spec' ? changeSpecProblem(o.value)
        : field === 'rebalance_spec' ? rebalanceSpecProblem(o.value)
          : field === 'execution_count_limit' ? (isInt(o.value, 1, 100_000) ? null : 'execution_count_limit is a whole number from 1 to 100,000')
            : (isInt(o.value, 1, 525_600) ? null : 'action_frequency is a whole number of minutes from 1 to 525,600 (a year)')
    if (problem) return problem
  }
  const change = CHANGE_EXECUTION_TYPES.has(type)
  if (change !== seen.has('change_spec')) return change ? `${type} names its change_spec` : `only a budget or bid change takes a change_spec (not ${type})`
  if ((type === 'REBALANCE_BUDGET') !== seen.has('rebalance_spec')) return type === 'REBALANCE_BUDGET' ? 'REBALANCE_BUDGET names its rebalance_spec' : `only REBALANCE_BUDGET takes a rebalance_spec (not ${type})`
  if (!change && (seen.has('execution_count_limit') || seen.has('action_frequency'))) return 'execution_count_limit and action_frequency go with a budget or bid change only (Meta)'
  if (type === 'PING_ENDPOINT' && seen.size) return 'PING_ENDPOINT takes no execution option (Meta: trigger rules need none)'
  return null
}

/** Why a schedule spec is refused, or null (scheduled-based-rules.md, advanced-scheduling.md). */
export function scheduleSpecProblem(spec: unknown): string | null {
  if (!plainObject(spec) || !exactKeys(spec, ['schedule_type', 'schedule'], ['schedule_type'])) return 'schedule_spec is {schedule_type, schedule}'
  if (!(RULE_SCHEDULE_TYPES as readonly unknown[]).includes(spec.schedule_type)) return `schedule_type is one of ${RULE_SCHEDULE_TYPES.join(', ')}`
  if (spec.schedule_type !== 'CUSTOM') return 'schedule' in spec ? 'only a CUSTOM schedule lists its times' : null
  const entries = spec.schedule
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_SCHEDULE_ENTRIES) return `a CUSTOM schedule lists 1 to ${MAX_SCHEDULE_ENTRIES} times`
  for (const e of entries) {
    if (!plainObject(e) || !exactKeys(e, ['start_minute', 'end_minute', 'days']) || !('start_minute' in e || 'days' in e)) return 'each schedule time is {start_minute, end_minute, days} with start_minute or days (Meta)'
    const minute = (v: unknown) => isInt(v, 0, 1440) && (v as number) % 30 === 0
    if ('start_minute' in e && !minute(e.start_minute)) return 'start_minute is minutes after midnight, a multiple of 30 (0 … 1440)'
    if ('end_minute' in e && (!('start_minute' in e) || !minute(e.end_minute) || (e.end_minute as number) < (e.start_minute as number))) return 'end_minute goes with start_minute, a multiple of 30, not before it'
    if ('days' in e && !(Array.isArray(e.days) && e.days.length >= 1 && e.days.length <= 7 && e.days.every((d) => isInt(d, 0, 6)) && new Set(e.days).size === e.days.length)) return 'days lists 0 (Sunday) … 6 (Saturday), each once'
  }
  return null
}

/** A JSON value in Nexus's own canonical form (it parses, and written again it is the same string), or undefined. */
function canonicalJson(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value)
    return JSON.stringify(parsed) === value ? parsed : undefined
  } catch {
    return undefined
  }
}

type Judge = (value: string, params: Params) => string | null
const jsonJudge = (what: string, judge: (parsed: unknown) => string | null): Judge => (value) => {
  const parsed = canonicalJson(value)
  if (parsed === undefined) return `${what} is JSON in one spelling only (as Nexus writes it: no spaces, each key once)`
  return judge(parsed)
}
const nameJudge: Judge = (value) => (value.trim() && [...value].length <= MAX_TEXT ? null : `a rule's name is 1 to ${MAX_TEXT} characters`)
const statusJudge: Judge = (value) => (value === 'ENABLED' || value === 'DISABLED' ? null : 'a rule\'s status is ENABLED or DISABLED (deleting is remove-meta-ad-rule; HAS_ISSUES is Meta\'s own)')
const JUDGES: Record<string, Judge> = {
  name: nameJudge,
  status: statusJudge,
  evaluation_spec: jsonJudge('evaluation_spec', evaluationSpecProblem),
  execution_spec: jsonJudge('execution_spec', executionSpecProblem),
  schedule_spec: jsonJudge('schedule_spec', scheduleSpecProblem),
}
function judged(also: (params: Params) => string | null) {
  return (params: Params): string | null => {
    for (const [key, value] of params) {
      const judge = JUDGES[key]
      if (!judge) return `${key} is not a key of this change`
      const problem = judge(value, params)
      if (problem) return problem
    }
    return also(params)
  }
}

/**
 * The rule as a whole: each spec judged, and the three agree with each other (a schedule rule has its schedule_spec, a
 * trigger rule none; the execution types each kind takes). `schedule` undefined: the rule has none.
 */
export function wholeRuleSpecsProblem(evaluation: unknown, execution: unknown, schedule: unknown): string | null {
  const problem = evaluationSpecProblem(evaluation) ?? executionSpecProblem(execution) ?? (schedule === undefined ? null : scheduleSpecProblem(schedule))
  if (problem) return problem
  const e = evaluation as Record<string, unknown>
  const x = execution as Record<string, unknown>
  const trigger = e.evaluation_type === 'TRIGGER'
  if (trigger && schedule !== undefined) return 'a trigger rule has no schedule_spec (Meta checks it in real time)'
  if (!trigger && schedule === undefined) return 'a schedule rule names its schedule_spec'
  const type = x.execution_type as string
  if (trigger && !TRIGGER_EXECUTION_TYPES.has(type)) return `a trigger rule takes ${[...TRIGGER_EXECUTION_TYPES].join(', ')} (not ${type})`
  if (!trigger && type === 'PING_ENDPOINT') return 'PING_ENDPOINT is for trigger rules only (Meta)'
  if (trigger && Array.isArray(x.execution_options) && x.execution_options.length && type !== 'NOTIFICATION') return 'a trigger rule takes no execution option but the people a NOTIFICATION goes to (Meta)'
  return null
}

/** The rule as a whole in a body (create, or an update of its specs): Meta's "the whole rule, unchanged parts too". */
function wholeRuleProblem(params: Params): string | null {
  const evaluation = canonicalJson(params.get('evaluation_spec') ?? '')
  const execution = canonicalJson(params.get('execution_spec') ?? '')
  if (evaluation === undefined || execution === undefined) return 'a rule\'s specs go together: evaluation_spec and execution_spec (Meta: an update sends the whole rule, unchanged parts too)'
  return wholeRuleSpecsProblem(evaluation, execution, params.has('schedule_spec') ? canonicalJson(params.get('schedule_spec')!) : undefined)
}

/**
 * The ids inside a rule change's body, each with the kind of object it names: the objects its filters are scoped to
 * (id, ad.id, adset.id, campaign.id, aggregation_id — an unprefixed id or an aggregation id is a campaign, ad set or ad:
 * `adobject`) and the ad labels it reads (adlabel_ids). The gateway checks each is of the chosen ad account.
 */
export function ruleBodyIds(body: string): Array<{ id: string; kind: 'adobject' | 'campaign' | 'adset' | 'ad' | 'adlabel' }> {
  const spec = canonicalJson(new URLSearchParams(body).get('evaluation_spec') ?? '')
  if (!plainObject(spec) || !Array.isArray(spec.filters)) return []
  const out: Array<{ id: string; kind: 'adobject' | 'campaign' | 'adset' | 'ad' | 'adlabel' }> = []
  for (const f of spec.filters) {
    if (!plainObject(f) || typeof f.field !== 'string') continue
    const kind = Object.prototype.hasOwnProperty.call(ID_FIELDS, f.field) ? ID_FIELDS[f.field] : LABEL_FIELD.test(f.field) ? 'adlabel' : null
    if (!kind) continue
    for (const id of Array.isArray(f.value) ? f.value : [f.value]) if (isRuleId(id)) out.push({ id, kind })
  }
  return out
}

/** The fields a rule change reads back (a GET of the rule; the create reads back the new one). */
export const AD_RULE_READ_BACK = 'id,account_id,name,status,evaluation_spec,execution_spec,schedule_spec,updated_time'

let built: readonly MetaWriteRule[] | null = null
/**
 * Step 29 — set-meta-ad-rule and remove-meta-ad-rule on the write allow-list (meta-calls.ts writeRules reads them when it
 * judges, never at load: this module and meta-calls.ts import each other's names).
 */
export function metaAdRuleWriteRules(): readonly MetaWriteRule[] {
  if (built) return built
  // A rule's name, and its filters (a name filter's value is the text of a campaign's name), are text a person types.
  const text = { name: META_NAME_TEXT, evaluation_spec: META_NAME_TEXT }
  built = [
    {
      name: 'adRule.create',
      method: 'POST',
      path: /^act_\d{1,25}\/adrules_library$/,
      kinds: ['adaccount'],
      // The status is ALWAYS named: Meta documents no default, and a rule Nexus makes is DISABLED unless asked.
      required: ['name', 'evaluation_spec', 'execution_spec', 'status'],
      optional: ['schedule_spec'],
      text,
      maxBody: 16_000,
      values: judged(wholeRuleProblem),
      budget: false,
    },
    {
      name: 'adRule.update',
      method: 'POST',
      path: /^\d{1,20}$/,
      kinds: ['adrule'],
      required: [],
      optional: ['name', 'evaluation_spec', 'execution_spec', 'schedule_spec', 'status'],
      anyOf: ['name', 'evaluation_spec', 'execution_spec', 'schedule_spec', 'status'],
      text,
      maxBody: 16_000,
      values: judged((params) => {
        if (params.has('status')) return params.size === 1 ? null : 'a rule\'s status change goes on its own (Meta: it needs no spec)'
        return params.has('evaluation_spec') || params.has('execution_spec') || params.has('schedule_spec') ? wholeRuleProblem(params) : null
      }),
      budget: false,
    },
    {
      name: 'adRule.run',
      method: 'POST',
      path: /^\d{1,20}\/execute$/,
      kinds: ['adrule'],
      required: [],
      optional: [],
      emptyBody: true,
      values: () => null,
      budget: false,
    },
    {
      // A POST that only reads (RU-031): it goes as a read, under Meta changes' switch like Meta's check.
      name: 'adRule.preview',
      method: 'POST',
      path: /^\d{1,20}\/preview$/,
      kinds: ['adrule'],
      required: [],
      optional: [],
      emptyBody: true,
      readOnly: true,
      values: () => null,
      budget: false,
    },
    {
      name: 'adRule.delete',
      method: 'DELETE',
      path: /^\d{1,20}$/,
      kinds: ['adrule'],
      required: [],
      optional: [],
      values: () => null,
      budget: false,
    },
  ]
  return built
}
