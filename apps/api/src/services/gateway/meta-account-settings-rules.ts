/**
 * Meta step 40 (2026-10-21) — the chosen ad account's OWN settings on the write allow-list: what set-meta-account-settings,
 * set-meta-spend-cap and set-meta-insights-features send, ONE rule per kind of change, each with its EXACT keys and every
 * value judged (JSON in one spelling only: the string judged is the string sent; text only where a person types it). The
 * path is the account itself (`act_<id>`, no leading zero) or one of its two edges; the gateway then checks the account is
 * the one this business chose through this connection (gateway.ts metaOwnerProblem, kind `adaccount`) and every Page or
 * pixel inside a body is the chosen Page or one of the chosen ad account's own pixels (metaBodyIdsProblem).
 *
 * Checked 2026-10-21 (developers.facebook.com/documentation/ads-commerce/marketing-api/…, `.md` pages; Meta's Python
 * Business SDK facebook_business/adobjects/{adaccount,adaccounttrackingdata,conversionactionquery}.py on GitHub main):
 *   - reference/ad-account.md "Updating" (POST /act_{id}; read-after-write; Struct {success}): agency_client_declaration
 *     (dictionary {string: string}, "Requires Business Manager Admin"), attribution_spec ("Deprecated due to iOS 14
 *     changes" — never sent, AS-108), business_info (dictionary {string: string}, "Business Info": its keys are not
 *     documented — Nexus sends only the seven the Reading table has as business_* fields, AA-041 LIVE-PROBES),
 *     custom_audience_info (legacy Automated Shopping Ads — not sent), default_dsa_payor + default_dsa_beneficiary ("both
 *     of them or none of them"; "To unset the values: pass two empty strings at the same time"), end_advertiser ("a
 *     Facebook Page Alias, Facebook Page ID or an Facebook App ID"), is_notifications_enabled (boolean), media_agency and
 *     partner ("Once it is set to any values other than NONE or UNFOUND, it cannot be modified any more"), name,
 *     spend_cap (float, "Value specified in standard denomination of the currency, e.g. 23.50 for USD $23.50"; "A value of
 *     0 signifies no spending-cap"), spend_cap_action ("reset sets the amount_spent back to 0", "delete removes the
 *     spend_cap"). The SDK's api_update adds currency, existing_customers, is_ba_skip_delayed_eligible, timezone_id,
 *     tos_accepted: none is sent (currency and time zone are Ads Manager's own — PLAN.md; terms a person accepts).
 *   - reference/ad-account/tracking.md: POST /act_{id}/tracking tracking_specs (Object, required, "Tracking specs to add to
 *     the account level"; no update, no delete); SDK AdAccountTrackingData.tracking_specs is a ConversionActionQuery
 *     (action.type, fb_pixel, page, object, …); marketing-api/tracking-specs.md gives the shapes Nexus sends:
 *     {"action.type":["offsite_conversion"],"fb_pixel":[<pixel>]}, {"action.type":["page_engagement"],"page":[<page>]},
 *     {"action.type":["like"],"page":[<page>]}, {"action.type":["link_click"],"object":[<page>]}. Whether a POST adds to
 *     the specs there or replaces them is not documented (AA-054 STILL-UNVERIFIED, LIVE-PROBES): Nexus never sends [].
 *   - insights/breakdowns.md "Insights feature settings": POST /act_{id}/insights/feature-settings feature_name =
 *     comscore | impression_device | time_of_day_viewer_tz | frequency_value; "there is no API to disable features";
 *     answers {"id": "act_<id>"} (IN-051).
 */
import type { MetaWriteBodyId, MetaWriteRule } from './meta-calls.js'
import { META_NAME_TEXT, META_STRICT_TEXT } from './meta-write-text.js'

type Params = ReadonlyMap<string, string>
type Judge = (value: string, params: Params) => string | null

/** The chosen ad account itself and its two edges: `act_` and digits with no leading zero (as #733's report run). */
const ACCOUNT_PATH = /^act_[1-9]\d{0,24}$/
const TRACKING_PATH = /^act_[1-9]\d{0,24}\/tracking$/
const FEATURE_PATH = /^act_[1-9]\d{0,24}\/insights\/feature-settings$/

/** AA-041 — the business_info keys Nexus sends: exactly the seven business_* fields Meta's Reading table lists. */
export const META_BUSINESS_INFO_KEYS = ['business_name', 'business_street', 'business_street2', 'business_city', 'business_state', 'business_zip', 'business_country_code'] as const
/**
 * AA-048 — the agency declaration's keys (step 3's read, reference/agency-client-declaration): never the client's e-mail
 * address (Nexus passes no e-mail on). The flags Meta reads as 0 / 1 are written "0" / "1" (a {string: string} dictionary).
 */
export const META_AGENCY_TEXT_KEYS = ['client_name', 'client_street', 'client_street2', 'client_city', 'client_province', 'client_postal_code', 'client_country_code'] as const
export const META_AGENCY_FLAG_KEYS = ['agency_representing_client', 'client_based_in_france', 'has_written_mandate_from_advertiser', 'is_client_paying_invoices'] as const
/** AA-047 — the values an end advertiser, media agency or partner takes from Nexus: Meta's two words, or a Page by id. */
export const META_PARTY_WORDS = ['NONE', 'UNFOUND'] as const
/** IN-051 — the insights features Meta lets an API switch on (insights/breakdowns.md). */
export const META_INSIGHTS_FEATURES = ['comscore', 'impression_device', 'time_of_day_viewer_tz', 'frequency_value'] as const
/** AA-054 — the tracking specs Nexus sends: each action and the one key that names what it counts (tracking-specs.md). */
export const META_TRACKING_ACTIONS: Readonly<Record<string, 'fb_pixel' | 'page' | 'object'>> = {
  offsite_conversion: 'fb_pixel', page_engagement: 'page', like: 'page', link_click: 'object',
}
export const MAX_TRACKING_SPECS = 20

/** What a settings change of the account reads back in the same POST (read-after-write is documented on the update). */
export const ACCOUNT_SETTINGS_READ_BACK: ReadonlySet<string> = new Set([
  'id', 'account_status', 'name', ...META_BUSINESS_INFO_KEYS, 'default_dsa_payor', 'default_dsa_beneficiary', 'is_notifications_enabled',
  'end_advertiser', 'media_agency', 'partner',
])
/** What a spending-limit change reads back: the cap (Meta READS it in offset units), the amount spent, the currency. */
export const SPEND_CAP_READ_BACK: ReadonlySet<string> = new Set(['id', 'spend_cap', 'amount_spent', 'currency'])

// ── values ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** A JSON value in Nexus's own canonical form (it parses, and written again it is the same string), else undefined. */
function canonical(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value)
    return JSON.stringify(parsed) === value ? parsed : undefined
  } catch {
    return undefined
  }
}
const oneOf = (values: readonly string[], what: string): Judge => (value) => (values.includes(value) ? null : `${what} is one of ${values.join(', ')}`)
/** Text a person types, 1 to max characters, no control or format character (the gateway's strict pattern). */
const typed = (value: unknown, max: number, pattern: RegExp = META_STRICT_TEXT): boolean =>
  typeof value === 'string' && value === value.trim() && value.length > 0 && [...value].length <= max && pattern.test(value)
const nameJudge: Judge = (value) => (typed(value, 200, META_NAME_TEXT) ? null : 'name is 1 to 200 characters of printable text')
const dsaJudge = (what: string): Judge => (value) => (value === '' || typed(value, 512) ? null : `${what} is 1 to 512 characters of printable text, or empty (with the other one: clears both)`)
const partyJudge = (what: string): Judge => (value) => ((META_PARTY_WORDS as readonly string[]).includes(value) || /^[1-9]\d{0,19}$/.test(value) ? null : `${what} is NONE, UNFOUND or a Page id (digits)`)
const readBack = (allowed: ReadonlySet<string>): Judge => (value) => {
  const names = value.split(',')
  if (names.some((name) => !allowed.has(name))) return `this change reads back only ${[...allowed].join(', ')}`
  return new Set(names).size === names.length ? null : 'fields names each field once'
}

/** AA-041 — {"business_<x>": text | "" (clears it)}, at least one of the seven keys, each value judged. */
const businessInfoJudge: Judge = (value) => {
  const o = canonical(value)
  if (!plainObject(o) || !Object.keys(o).length) return 'business_info is a JSON object of at least one business_* key, in one spelling only (no spaces, each key once)'
  for (const [key, v] of Object.entries(o)) {
    if (!(META_BUSINESS_INFO_KEYS as readonly string[]).includes(key)) return `business_info has only ${META_BUSINESS_INFO_KEYS.join(', ')}`
    if (v === '') continue
    if (key === 'business_country_code' ? !(typeof v === 'string' && /^[A-Z]{2}$/.test(v)) : !typed(v, 200)) {
      return key === 'business_country_code' ? 'business_info.business_country_code is two capital letters, or empty' : `business_info.${key} is 1 to 200 characters of printable text, or empty (clears it)`
    }
  }
  return null
}

/** AA-048 — the declaration: its text keys as text (the country two capital letters), its flags "0" or "1"; no e-mail. */
const agencyJudge: Judge = (value) => {
  const o = canonical(value)
  if (!plainObject(o) || !Object.keys(o).length) return 'agency_client_declaration is a JSON object of at least one of its keys, in one spelling only'
  for (const [key, v] of Object.entries(o)) {
    if ((META_AGENCY_FLAG_KEYS as readonly string[]).includes(key)) { if (v !== '0' && v !== '1') return `agency_client_declaration.${key} is "0" or "1"`; continue }
    if (!(META_AGENCY_TEXT_KEYS as readonly string[]).includes(key)) return `agency_client_declaration has only ${[...META_AGENCY_FLAG_KEYS, ...META_AGENCY_TEXT_KEYS].join(', ')} (never the client's e-mail address)`
    if (key === 'client_country_code' ? !(typeof v === 'string' && /^[A-Z]{2}$/.test(v)) : !typed(v, 200)) return `agency_client_declaration.${key} is ${key === 'client_country_code' ? 'two capital letters' : '1 to 200 characters of printable text'}`
  }
  return null
}

/** AA-054 — the whole list (1 to 20 specs), each {"action.type":[<one action>],"<its key>":[<one id>]} exactly. */
const trackingJudge: Judge = (value) => {
  const list = canonical(value)
  if (!Array.isArray(list) || list.length > MAX_TRACKING_SPECS) return `tracking_specs is a JSON list of at most ${MAX_TRACKING_SPECS} specs, in one spelling only`
  // Fix round 1 (B-3) — never an empty list: Meta has the edge "to add" specs, no update, no delete (reference/ad-account/
  // tracking); whether [] removes anything is not documented (LIVE-PROBES AA-054).
  if (!list.length) return 'tracking_specs names at least one spec (Nexus never sends an empty list: Meta documents no way to remove account-level specs)'
  const seen = new Set<string>()
  for (const spec of list) {
    if (!plainObject(spec)) return 'each tracking spec is an object'
    const actions = spec['action.type']
    const action = Array.isArray(actions) && actions.length === 1 && typeof actions[0] === 'string' ? actions[0] : null
    const key = action && Object.prototype.hasOwnProperty.call(META_TRACKING_ACTIONS, action) ? META_TRACKING_ACTIONS[action] : null
    if (!key) return `a tracking spec's action.type is a list of one of ${Object.keys(META_TRACKING_ACTIONS).join(', ')}`
    if (Object.keys(spec).length !== 2 || !(key in spec)) return `a ${action} tracking spec has exactly action.type and ${key}`
    const ids = spec[key]
    if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== 'string' || !/^[1-9]\d{0,19}$/.test(ids[0])) return `a tracking spec's ${key} is a list of one Meta id (digits, as a JSON string)`
    const id = JSON.stringify(spec)
    if (seen.has(id)) return 'tracking_specs names each spec once'
    seen.add(id)
  }
  return null
}

/** Each key's judge; a key without one is not of this change. */
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

/**
 * A spending limit as Meta WRITES it: a positive amount in the currency's standard units, two decimals or none (money.ts
 * minorToMetaStandard writes it: "500.00", "1250"). 0 — Meta's "no spending-cap" — is never one: removing is its own action.
 */
const spendCapJudge: Judge = (value) => {
  if (!/^(0|[1-9]\d{0,14})(\.\d{2})?$/.test(value)) return 'spend_cap is the spending limit in the currency\'s standard units (e.g. 500.00), as Nexus writes it'
  return /^0(\.00)?$/.test(value) ? 'spend_cap 0 means "no spending limit" to Meta: removing the limit is spend_cap_action=delete (its own change, SPENDS MONEY)' : null
}

const SETTINGS_JUDGES: Record<string, Judge> = {
  name: nameJudge,
  business_info: businessInfoJudge,
  default_dsa_payor: dsaJudge('default_dsa_payor'),
  default_dsa_beneficiary: dsaJudge('default_dsa_beneficiary'),
  is_notifications_enabled: oneOf(['true', 'false'], 'is_notifications_enabled'),
  end_advertiser: partyJudge('end_advertiser'),
  media_agency: partyJudge('media_agency'),
  partner: partyJudge('partner'),
  agency_client_declaration: agencyJudge,
  fields: readBack(ACCOUNT_SETTINGS_READ_BACK),
}
const SETTINGS_KEYS = Object.keys(SETTINGS_JUDGES).filter((k) => k !== 'fields')

/** AA-042 — the EU payer and beneficiary go together: both set, or both empty (which clears both). */
const dsaPair = (params: Params): string | null => {
  const payor = params.get('default_dsa_payor')
  const beneficiary = params.get('default_dsa_beneficiary')
  if ((payor === undefined) !== (beneficiary === undefined)) return 'default_dsa_payor and default_dsa_beneficiary go together (Meta keeps both or neither)'
  if (payor !== undefined && (payor === '') !== (beneficiary === '')) return 'default_dsa_payor and default_dsa_beneficiary are both set, or both empty (which clears both): Meta keeps both or neither'
  return null
}

/** AA-047 — a Page named as end advertiser, media agency or partner: the gateway checks it is the chosen Page. */
const partyPages = (params: Params): MetaWriteBodyId[] => ['end_advertiser', 'media_agency', 'partner']
  .map((k) => params.get(k))
  .filter((v): v is string => !!v && /^\d{1,20}$/.test(v))
  .map((id) => ({ id, kind: 'page' as const }))

/** AA-054 — the pixels and Pages a tracking list names: the account's own pixels, the chosen Page. */
const trackingIds = (params: Params): MetaWriteBodyId[] => {
  const list = canonical(params.get('tracking_specs') ?? '')
  if (!Array.isArray(list)) return []
  const out: MetaWriteBodyId[] = []
  for (const spec of list) {
    if (!plainObject(spec)) continue
    for (const key of ['fb_pixel', 'page', 'object'] as const) {
      const ids = spec[key]
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string' && /^\d{1,20}$/.test(id)) out.push({ id, kind: key === 'fb_pixel' ? 'pixel' : 'page' })
    }
  }
  return out
}

/** Step 40 — set-meta-account-settings, set-meta-spend-cap and set-meta-insights-features on the write allow-list. */
export const META_ACCOUNT_SETTINGS_WRITE_RULES: readonly MetaWriteRule[] = [
  {
    // AA-040–042, AA-046–048: POST /act_{id} with the settings that change (never currency, timezone_id, attribution_spec,
    // custom_audience_info, tos_accepted, existing_customers; the spending limit is its own rule below).
    name: 'adaccount.settings',
    method: 'POST',
    path: ACCOUNT_PATH,
    kinds: ['adaccount'],
    required: [],
    optional: [...SETTINGS_KEYS, 'fields'],
    anyOf: SETTINGS_KEYS,
    text: { name: META_NAME_TEXT, default_dsa_payor: META_STRICT_TEXT, default_dsa_beneficiary: META_STRICT_TEXT, business_info: META_STRICT_TEXT, agency_client_declaration: META_STRICT_TEXT },
    maxBody: 6_000,
    values: judged(SETTINGS_JUDGES, dsaPair),
    budget: false,
    ids: partyPages,
  },
  {
    // AA-043–045: POST /act_{id} with spend_cap (a new limit, standard units) OR spend_cap_action (reset | delete), never both.
    name: 'adaccount.spend_cap',
    method: 'POST',
    path: ACCOUNT_PATH,
    kinds: ['adaccount'],
    required: [],
    optional: ['spend_cap', 'spend_cap_action', 'fields'],
    anyOf: ['spend_cap', 'spend_cap_action'],
    values: judged({ spend_cap: spendCapJudge, spend_cap_action: oneOf(['reset', 'delete'], 'spend_cap_action'), fields: readBack(SPEND_CAP_READ_BACK) }, (params) => (
      params.has('spend_cap') && params.has('spend_cap_action') ? 'a spending-limit change is a new limit (spend_cap) or one action (spend_cap_action reset | delete), never both in one request' : null)),
    budget: false,
  },
  {
    // AA-054: POST /act_{id}/tracking tracking_specs (the whole list the account should hold).
    name: 'adaccount.tracking',
    method: 'POST',
    path: TRACKING_PATH,
    kinds: ['adaccount'],
    required: ['tracking_specs'],
    optional: [],
    maxBody: 4_000,
    values: judged({ tracking_specs: trackingJudge }),
    budget: false,
    ids: trackingIds,
  },
  {
    // IN-051: POST /act_{id}/insights/feature-settings feature_name (one-way: Meta has no API to switch it off).
    name: 'adaccount.insights_feature',
    method: 'POST',
    path: FEATURE_PATH,
    kinds: ['adaccount'],
    required: ['feature_name'],
    optional: [],
    values: judged({ feature_name: oneOf(META_INSIGHTS_FEATURES, 'feature_name') }),
    budget: false,
  },
]
