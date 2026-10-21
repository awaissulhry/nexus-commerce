/**
 * Meta step 32 (2026-10-21) — the write allow-list entries of create-meta-dataset, set-meta-dataset,
 * set-meta-dataset-access, set-meta-custom-conversion and remove-meta-signal-items: EXACT keys per kind of object, every
 * value judged (enums by list, ids as digits, JSON lists in Nexus's one spelling, a custom conversion's rule in one exact
 * shape, text only where a person types it). The object of each change and every id inside its body are checked by the
 * gateway to be the chosen ad account's, its business portfolio's or its own people, and never another Nexus business's
 * (marketing/meta-ads/signals-rule.ts, asked by gateway.ts before anything is sent).
 *
 * Checked 2026-10-21 (`curl -sL` of developers.facebook.com/documentation/ads-commerce/marketing-api/reference/….md, the
 * older Graph pages and Meta's Python Business SDK facebook_business/adobjects on GitHub main, ≥ 4 s apart):
 *   - ad-account/adspixels.md "Creating": POST /act_{id}/adspixels, `name` only → {id} (read-after-write); errors 6200 "A
 *     pixel already exists for this account", 6202 "More than one pixel exist for this account".
 *   - business/adspixels.md: Creating "can't perform"; SDK business.py create_ads_pixel (name, is_crm) — SDK only
 *     (RECHECK-C3 SG-007: probe first). Nexus never sends is_crm (a CRM dataset is not something Nexus sets up).
 *   - conversions-api/business-messaging.md: POST /{page_id}/dataset and POST /{ig_user_id}/dataset ("If there is already an
 *     existing dataset_id associated with the page, it will return that id"; permissions page_events /
 *     instagram_manage_events); SDK page.py / iguser.py create_dataset (dataset_name).
 *   - ads-pixel.md "Updating": automatic_matching_fields (em, fn, ln, ph, ge, zp, ct, st, country, db, external_id),
 *     data_use_setting (EMPTY, ADVERTISING_AND_ANALYTICS, ANALYTICS_ONLY), enable_automatic_matching, first_party_cookie_status
 *     (EMPTY, FIRST_PARTY_COOKIE_ENABLED, FIRST_PARTY_COOKIE_DISABLED), name, server_events_business_ids (array of numeric
 *     strings) → {success}; "Deleting" is empty (a pixel cannot be deleted, SG-017). SDK adspixel.py api_update adds
 *     server_events_business_ids_add / _remove: never sent (the documented whole list is).
 *   - ads-pixel/shared_accounts.md: POST and DELETE, account_id + business both required → {success}.
 *   - ads-pixel/agencies.md: Creating "can't perform", Deleting empty — stale: the Pixel Agency Sharing guide
 *     (docs/marketing-api/business-asset-management/guides/business-pixel-sharing) documents POST /{pixel}/agencies with
 *     business + permitted_tasks (ANALYZE, UPLOAD, ADVERTISE, EDIT — "EDIT access is currently limited"), answering
 *     {success} or {success, pending_request_id}, and DELETE /{pixel}/agencies with business ("requires an admin USER access
 *     token from the pixel-owning business"); SDK adspixel.py create_agency / delete_agencies.
 *   - ads-pixel/assigned_users.md: Creating "can't perform"; SDK adspixel.py create_assigned_user (user int, tasks
 *     ADVERTISE | ANALYZE | EDIT | UPLOAD | AA_ANALYZE) and the Ads CLI `dataset assign-user` — built, LIVE-PROBE SG-024.
 *   - business/event_source_groups.md: POST, event_sources (list of ids) + name both required → {id}; SDK
 *     eventsourcegroup.py api_update (event_sources, name) and create_shared_account (accounts) — SDK only (BM-057).
 *   - ad-account/customconversions.md + docs/marketing-api/reference/custom-conversion (older page, its create table and
 *     rule operators): name (required), event_source_id, rule, custom_event_type (SDK enum), default_conversion_value
 *     (float, currency units, default 0), description, action_source_type (SDK enum), advanced_rule (its shape is not
 *     documented: never sent) → {id, is_custom_event_type_predicted}; rule operators i_contains, i_not_contains, contains,
 *     not_contains, eq, neq, lt, lte, gt, gte, regex_match on url, event or a custom-data key; updating only name,
 *     description, default_conversion_value; DELETE /{custom_conversion_id} → {success}; at most 100 per ad account.
 *   - business/claim_custom_conversions.md: POST custom_conversion_id (required) → {success}.
 * Event rules, parameter extractors and traffic permissions have NO write here: Meta's public API has none (ads-pixel/
 * event_rules.md, extractors.md, domain_control_rule.md: "can't perform"; the SDK classes CalibratorExistingRule,
 * SignalsIWLExtractor and AdsPixelDomainControlRule have no create, update or delete) — RECHECK-C3 SG-041, SG-098…SG-104.
 */
import type { MetaWriteRule } from './meta-calls.js'
import { META_NAME_TEXT, META_STRICT_TEXT } from './meta-settings-rules.js'

/** The kinds of object a step 32 change names (the gateway confirms each: signals-rule.ts). */
export const META_SIGNALS_KINDS = ['adaccount', 'business', 'pixel', 'customconversion', 'eventsourcegroup', 'page', 'instagram'] as const
export type MetaSignalsKind = typeof META_SIGNALS_KINDS[number]
export const isMetaSignalsKind = (kind: unknown): kind is MetaSignalsKind => typeof kind === 'string' && (META_SIGNALS_KINDS as readonly string[]).includes(kind)
/** The edges a step 32 change posts to (`POST /<object>/<edge>`). */
export type MetaSignalsEdge = 'adspixels' | 'dataset' | 'customconversions' | 'shared_accounts' | 'agencies' | 'assigned_users' | 'event_source_groups' | 'claim_custom_conversions'

export const AUTOMATIC_MATCHING_FIELDS = ['em', 'fn', 'ln', 'ph', 'ge', 'zp', 'ct', 'st', 'country', 'db', 'external_id'] as const
export const FIRST_PARTY_COOKIE_STATUSES = ['FIRST_PARTY_COOKIE_ENABLED', 'FIRST_PARTY_COOKIE_DISABLED', 'EMPTY'] as const
export const DATA_USE_SETTINGS = ['ADVERTISING_AND_ANALYTICS', 'ANALYTICS_ONLY', 'EMPTY'] as const
export const PARTNER_TASKS = ['ADVERTISE', 'ANALYZE', 'UPLOAD', 'EDIT'] as const
export const PERSON_TASKS = ['ADVERTISE', 'ANALYZE', 'UPLOAD', 'EDIT', 'AA_ANALYZE'] as const
/** SDK customconversion.py CustomEventType (the older reference page lists the same 20). */
export const CONVERSION_EVENT_TYPES = [
  'ADD_PAYMENT_INFO', 'ADD_TO_CART', 'ADD_TO_WISHLIST', 'COMPLETE_REGISTRATION', 'CONTACT', 'CONTENT_VIEW', 'CUSTOMIZE_PRODUCT', 'DONATE',
  'FACEBOOK_SELECTED', 'FIND_LOCATION', 'INITIATED_CHECKOUT', 'LEAD', 'LISTING_INTERACTION', 'OTHER', 'PURCHASE', 'SCHEDULE', 'SEARCH',
  'START_TRIAL', 'SUBMIT_APPLICATION', 'SUBSCRIBE',
] as const
/** SDK customconversion.py ActionSourceType. */
export const CONVERSION_ACTION_SOURCES = ['website', 'app', 'chat', 'email', 'phone_call', 'physical_store', 'system_generated', 'business_messaging', 'other'] as const
/** The custom conversion rule operators (docs/marketing-api/reference/custom-conversion, "Creating"). */
export const CONVERSION_RULE_OPERATORS = ['i_contains', 'i_not_contains', 'contains', 'not_contains', 'eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'regex_match'] as const
/** Meta: at most 100 custom conversions per ad account. */
export const MAX_CUSTOM_CONVERSIONS = 100
/** The most pixels an event source group is sent with, partners a pixel's server events list, conditions of a rule. */
export const MAX_GROUP_SOURCES = 50
export const MAX_SERVER_EVENT_BUSINESSES = 50
export const MAX_RULE_CONDITIONS = 10

type Params = ReadonlyMap<string, string>
type Judge = (value: string, params: Params) => string | null

const isId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,20}$/.test(v)
const digits = (what: string): Judge => (value) => (/^\d{1,20}$/.test(value) ? null : `${what} is a Meta id (digits)`)
const oneOf = (values: readonly string[], what: string): Judge => (value) => (values.includes(value) ? null : `${what} is one of ${values.join(', ')}`)
const textOf = (max: number, what: string): Judge => (value) => (!value.trim() || value !== value.trim() || [...value].length > max ? `${what} is 1 to ${max} characters, with no space at either end` : null)
const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A JSON value in Nexus's own canonical form (it parses and, written again, is the same string), else undefined. */
export function canonicalJson(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value)
    return JSON.stringify(parsed) === value ? parsed : undefined
  } catch {
    return undefined
  }
}

/** A JSON list of strings, each once, each passing `ok`, `min` to `max` long — in one spelling. */
const jsonList = (what: string, ok: (v: string) => boolean, min: number, max: number, words: string): Judge => (value) => {
  const list = canonicalJson(value)
  if (!Array.isArray(list)) return `${what} is a JSON list in one spelling (as Nexus writes it)`
  if (list.length < min || list.length > max) return `${what} lists ${min} to ${max} ${words}`
  if (list.some((v) => typeof v !== 'string' || !ok(v))) return `${what} lists ${words}`
  return new Set(list).size === list.length ? null : `${what} names each once`
}

/** A custom conversion's default value: a decimal of the account currency written plainly (no sign, no trailing zero). */
const conversionValue: Judge = (value) => {
  if (!/^(0|[1-9]\d{0,11})(\.\d{0,2}[1-9])?$/.test(value)) return 'default_conversion_value is a plain decimal of the account currency (e.g. 12.5)'
  return null
}

const RULE_FIELD = /^(url|event|[a-z][a-z0-9_]{0,39})$/
/**
 * A custom conversion's rule in ONE exact shape: `{"and": [rule…]}`, `{"or": [rule…]}` or `{"<field>": {"<operator>":
 * value}}`; at most 3 levels and 10 conditions; a field is url, event or a custom-data key; a value is printable text
 * (≤ 200) or a number (lt, lte, gt, gte: a number only).
 */
export function conversionRuleProblem(rule: unknown, depth = 1, count = { conditions: 0 }): string | null {
  if (depth > 3) return 'a custom conversion rule is at most 3 levels deep'
  if (!plainObject(rule) || Object.keys(rule).length !== 1) return 'each part of a custom conversion rule is an object with exactly one key'
  const [key, value] = Object.entries(rule)[0]
  if (key === 'and' || key === 'or') {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_RULE_CONDITIONS) return `${key} lists 1 to ${MAX_RULE_CONDITIONS} rules`
    for (const part of value) { const problem = conversionRuleProblem(part, depth + 1, count); if (problem) return problem }
    return null
  }
  if (!RULE_FIELD.test(key)) return `"${key.slice(0, 40)}" is not a rule field (url, event or a custom-data key)`
  if (!plainObject(value) || Object.keys(value).length !== 1) return `the condition on ${key} is one operator`
  const [op, operand] = Object.entries(value)[0]
  if (!(CONVERSION_RULE_OPERATORS as readonly string[]).includes(op)) return `${op.slice(0, 20)} is not a custom conversion operator (${CONVERSION_RULE_OPERATORS.join(', ')})`
  const numeric = ['lt', 'lte', 'gt', 'gte'].includes(op)
  const ok = numeric ? typeof operand === 'number' && Number.isFinite(operand) : (typeof operand === 'string' && /^[\x20-\x7e]{1,200}$/.test(operand)) || (typeof operand === 'number' && Number.isFinite(operand))
  if (!ok) return numeric ? `${key} ${op} compares with a number` : `the value of ${key} ${op} is printable text (1 to 200 characters) or a number`
  count.conditions += 1
  return count.conditions > MAX_RULE_CONDITIONS ? `a custom conversion rule has at most ${MAX_RULE_CONDITIONS} conditions` : null
}
const conversionRule: Judge = (value) => {
  if (value.length > 2000) return 'rule is at most 2000 characters'
  const rule = canonicalJson(value)
  if (rule === undefined) return 'rule is JSON in one spelling only (as Nexus writes it)'
  return conversionRuleProblem(rule)
}

/** Each key's judge; every key of a rule has one. */
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

const PIXEL_JUDGES: Record<string, Judge> = {
  name: textOf(100, 'name'),
  enable_automatic_matching: oneOf(['true', 'false'], 'enable_automatic_matching'),
  automatic_matching_fields: jsonList('automatic_matching_fields', (v) => (AUTOMATIC_MATCHING_FIELDS as readonly string[]).includes(v), 1, AUTOMATIC_MATCHING_FIELDS.length, `of ${AUTOMATIC_MATCHING_FIELDS.join(', ')}`),
  first_party_cookie_status: oneOf(FIRST_PARTY_COOKIE_STATUSES, 'first_party_cookie_status'),
  data_use_setting: oneOf(DATA_USE_SETTINGS, 'data_use_setting'),
  server_events_business_ids: jsonList('server_events_business_ids', isId, 0, MAX_SERVER_EVENT_BUSINESSES, 'business portfolio ids (digits)'),
}
export const PIXEL_SETTING_KEYS = Object.keys(PIXEL_JUDGES)

const CONVERSION_JUDGES: Record<string, Judge> = {
  name: textOf(100, 'name'),
  event_source_id: digits('event_source_id'),
  rule: conversionRule,
  custom_event_type: oneOf(CONVERSION_EVENT_TYPES, 'custom_event_type'),
  default_conversion_value: conversionValue,
  description: textOf(500, 'description'),
  action_source_type: oneOf(CONVERSION_ACTION_SOURCES, 'action_source_type'),
}
export const CONVERSION_UPDATE_KEYS = ['name', 'description', 'default_conversion_value'] as const

const GROUP_JUDGES: Record<string, Judge> = {
  name: textOf(100, 'name'),
  event_sources: jsonList('event_sources', isId, 1, MAX_GROUP_SOURCES, 'dataset ids (digits)'),
}

/** Step 32 — the dataset, custom conversion and event source group changes on the write allow-list. */
export const META_SIGNALS_WRITE_RULES: readonly MetaWriteRule[] = [
  {
    // create-meta-dataset level adAccount (SG-006).
    name: 'dataset.create', method: 'POST', path: /^act_\d{1,20}\/adspixels$/, kinds: ['adaccount'],
    required: ['name'], optional: [], text: { name: META_NAME_TEXT }, values: judged({ name: textOf(100, 'name') }), budget: false,
  },
  {
    // create-meta-dataset level business (SG-007, SDK only).
    name: 'dataset.createInBusiness', method: 'POST', path: /^\d{1,20}\/adspixels$/, kinds: ['business'],
    required: ['name'], optional: [], text: { name: META_NAME_TEXT }, values: judged({ name: textOf(100, 'name') }), budget: false,
  },
  {
    // create-meta-dataset level page / instagram (SG-008, SG-009: messaging events).
    name: 'dataset.createForMessaging', method: 'POST', path: /^\d{1,20}\/dataset$/, kinds: ['page', 'instagram'],
    required: ['dataset_name'], optional: [], text: { dataset_name: META_NAME_TEXT }, values: judged({ dataset_name: textOf(100, 'dataset_name') }), budget: false,
  },
  {
    // set-meta-dataset (SG-010–013) and set-meta-dataset-access server-event partners (SG-014).
    name: 'dataset.settings', method: 'POST', path: /^\d{1,20}$/, kinds: ['pixel'],
    required: [], optional: PIXEL_SETTING_KEYS, anyOf: PIXEL_SETTING_KEYS, text: { name: META_NAME_TEXT }, values: judged(PIXEL_JUDGES), budget: false,
  },
  {
    // set-meta-dataset-access connect-ad-account (SG-018).
    name: 'dataset.connectAccount', method: 'POST', path: /^\d{1,20}\/shared_accounts$/, kinds: ['pixel'],
    required: ['account_id', 'business'], optional: [], values: judged({ account_id: digits('account_id'), business: digits('business') }), budget: false,
  },
  {
    // set-meta-dataset-access disconnect-ad-account (SG-019): Meta's DELETE with its two keys in the form body.
    name: 'dataset.disconnectAccount', method: 'DELETE', path: /^\d{1,20}\/shared_accounts$/, kinds: ['pixel'],
    required: ['account_id', 'business'], optional: [], values: judged({ account_id: digits('account_id'), business: digits('business') }), budget: false,
  },
  {
    // set-meta-dataset-access share-with-partner (SG-021).
    name: 'dataset.sharePartner', method: 'POST', path: /^\d{1,20}\/agencies$/, kinds: ['pixel'],
    required: ['business', 'permitted_tasks'], optional: [],
    values: judged({ business: digits('business'), permitted_tasks: jsonList('permitted_tasks', (v) => (PARTNER_TASKS as readonly string[]).includes(v), 1, PARTNER_TASKS.length, `of ${PARTNER_TASKS.join(', ')}`) }),
    budget: false,
  },
  {
    // set-meta-dataset-access remove-partner (SG-022).
    name: 'dataset.removePartner', method: 'DELETE', path: /^\d{1,20}\/agencies$/, kinds: ['pixel'],
    required: ['business'], optional: [], values: judged({ business: digits('business') }), budget: false,
  },
  {
    // set-meta-dataset-access assign-person (SG-024).
    name: 'dataset.assignPerson', method: 'POST', path: /^\d{1,20}\/assigned_users$/, kinds: ['pixel'],
    required: ['user', 'tasks'], optional: [],
    values: judged({ user: digits('user'), tasks: jsonList('tasks', (v) => (PERSON_TASKS as readonly string[]).includes(v), 1, PERSON_TASKS.length, `of ${PERSON_TASKS.join(', ')}`) }),
    budget: false,
  },
  {
    // set-meta-dataset event source group create (BM-057).
    name: 'eventSourceGroup.create', method: 'POST', path: /^\d{1,20}\/event_source_groups$/, kinds: ['business'],
    required: ['event_sources', 'name'], optional: [], text: { name: META_NAME_TEXT }, values: judged(GROUP_JUDGES), budget: false,
  },
  {
    // set-meta-dataset event source group update (BM-057, SDK only).
    name: 'eventSourceGroup.update', method: 'POST', path: /^\d{1,20}$/, kinds: ['eventsourcegroup'],
    required: [], optional: ['event_sources', 'name'], anyOf: ['event_sources', 'name'], text: { name: META_NAME_TEXT }, values: judged(GROUP_JUDGES), budget: false,
  },
  {
    // set-meta-dataset event source group share with the chosen ad account (BM-057, SDK only).
    name: 'eventSourceGroup.share', method: 'POST', path: /^\d{1,20}\/shared_accounts$/, kinds: ['eventsourcegroup'],
    required: ['accounts'], optional: [], values: judged({ accounts: jsonList('accounts', isId, 1, 1, 'ad account (digits)') }), budget: false,
  },
  {
    // set-meta-custom-conversion create (SG-090).
    name: 'customConversion.create', method: 'POST', path: /^act_\d{1,20}\/customconversions$/, kinds: ['adaccount'],
    required: ['name', 'event_source_id', 'rule', 'custom_event_type'], optional: ['default_conversion_value', 'description', 'action_source_type'],
    text: { name: META_NAME_TEXT, description: META_STRICT_TEXT }, maxBody: 4_000, values: judged(CONVERSION_JUDGES), budget: false,
  },
  {
    // set-meta-custom-conversion update (SG-092): only these three — Meta never changes a rule.
    name: 'customConversion.update', method: 'POST', path: /^\d{1,20}$/, kinds: ['customconversion'],
    required: [], optional: [...CONVERSION_UPDATE_KEYS], anyOf: [...CONVERSION_UPDATE_KEYS], text: { name: META_NAME_TEXT, description: META_STRICT_TEXT },
    values: judged({ name: CONVERSION_JUDGES.name, description: CONVERSION_JUDGES.description, default_conversion_value: conversionValue }), budget: false,
  },
  {
    // remove-meta-signal-items (SG-093): only a custom conversion Nexus made (signals-rule.ts).
    name: 'customConversion.delete', method: 'DELETE', path: /^\d{1,20}$/, kinds: ['customconversion'],
    required: [], optional: [], values: () => null, budget: false,
  },
  {
    // set-meta-custom-conversion claim (SG-094).
    name: 'customConversion.claim', method: 'POST', path: /^\d{1,20}\/claim_custom_conversions$/, kinds: ['business'],
    required: ['custom_conversion_id'], optional: [], values: judged({ custom_conversion_id: digits('custom_conversion_id') }), budget: false,
  },
]
