/**
 * Meta step 19 (2026-10-21) — the write allow-list entries of create-meta-campaign, create-meta-ad-set and copy-meta-ads,
 * and the DELETE their undo sends: EXACT keys per edge, every value judged (step 18's judges for the same fields —
 * meta-settings-rules.ts META_SETTINGS_JUDGES — and new ones for what only a create or a copy sends), JSON in one spelling
 * only, text only where a person types it (a name, a rename prefix or suffix, the EU payer and beneficiary). Every id inside
 * a body (the campaign of a new ad set, the target of a copy, custom audiences, the pixel, a catalog or product set, the
 * Page, a custom conversion, the source campaign) is named to the gateway, which checks each is of the chosen ad account
 * (or its chosen Page) before anything is sent (gateway.ts metaBodyIdsProblem). A create names the chosen ad account itself
 * (`act_<id>`, kind `adaccount`): the gateway sends it only to that one.
 *
 * Checked 2026-10-21 (developers.facebook.com/documentation/ads-commerce/marketing-api/…, `.md` pages; Meta's Python Business
 * SDK facebook_business/adobjects/{adaccount,campaign,adset,ad}.py on GitHub main):
 *   - reference/ad-campaign-group.md "Creating" (POST /act_{id}/campaigns): name (emoji), objective, special_ad_categories
 *     [required] (enum NONE, EMPLOYMENT, HOUSING, CREDIT, ISSUES_ELECTIONS_POLITICS, ONLINE_GAMBLING_AND_GAMING,
 *     FINANCIAL_PRODUCTS_SERVICES), special_ad_category_country, status ("Only ACTIVE and PAUSED are valid during creation"),
 *     bid_strategy, buying_type AUCTION | RESERVED, daily_budget / lifetime_budget ("not both" with ad sets), spend_cap,
 *     promoted_object, budget_schedule_specs (time_start, time_end, budget_value, budget_value_type), source_campaign_id,
 *     execution_options [validate_only, include_recommendations — "cannot be used by itself"]; is_adset_budget_sharing_enabled
 *     is required without a campaign budget since v24 (bidding/guides/adset-budget-sharing.md, error 4834011 — it is in
 *     Meta's own cURL example, not in the table). out-of-cycle-changes/occ-2026.md (entry dated 2026-10-22, all versions):
 *     is_pca_unified, OUTCOME_SALES only, immutable after creation — accepted only from 2026-10-22T00:00Z.
 *   - reference/ad-campaign.md "Creating" (POST /act_{id}/adsets): name (≤ 400, emoji), campaign_id, optimization_goal,
 *     billing_event, targeting ("countries is required"), status (ACTIVE | PAUSED), daily_budget / lifetime_budget (lifetime
 *     needs end_time; end_time=0 = ongoing with a daily budget), bid_strategy, bid_amount, bid_constraints, start_time,
 *     end_time, attribution_spec, promoted_object, destination_type (enum below), is_dynamic_creative, budget_schedule_specs,
 *     dsa_payor / dsa_beneficiary (≤ 512), daily_/lifetime_min_spend_target, daily_/lifetime_spend_cap, execution_options.
 *     audiences/reference/basic-targeting.md + targeting-expansion/advantage-audience.md: geo_locations countries | regions
 *     [{key}] (≤ 200) | cities [{key, radius 17–80 km, distance_unit}] (≤ 250); age_min ≥ 13 (default 18), age_max ≤ 65;
 *     genders [1 | 2]; custom_audiences / excluded_custom_audiences [{id}] (≤ 500); targeting_automation.advantage_audience
 *     0 | 1 — explicit on create (v23+; v26 HEF rule from 2026-10-27, changelog 26.0); with 1, age_min only 18–25 and no
 *     age_max; location_types is never sent (1870199).
 *   - reference/ad-campaign-group/copies.md, reference/ad-campaign/copies.md, graph-api/reference/adgroup/copies.md:
 *     deep_copy (≤ 3 child ads in one request, ≤ 51 asynchronously), status_option ACTIVE | PAUSED (default) |
 *     INHERITED_FROM_SOURCE, rename_options {rename_strategy DEEP_RENAME | ONLY_TOP_LEVEL_RENAME | NO_RENAME, rename_prefix,
 *     rename_suffix}, start_time / end_time (a campaign's: for its copied ad sets, deep copy), parameter_overrides ("Campaign
 *     spec", keys not documented — STILL-UNVERIFIED CMP-055: Nexus sends a daily or lifetime budget only, Meta's answer
 *     decides), an ad set's campaign_id (the copy "inherits all campaign settings, such as budget"), an ad's adset_id and
 *     creative_parameters (top-level overwrite of the creative spec: Nexus sends its name and url_tags only).
 *   - reference/ad-account/async_batch_requests.md: name + adbatch [{name, relative_url, body}] (≤ 1,000; Nexus: ≤ 8 copies
 *     of campaigns or ad sets, one per part, each judged exactly like the copy it is). reference/ad-account/asyncadcopies.md:
 *     the edge exists, its "Creating" section is empty (STILL-UNVERIFIED AD-048): Nexus sends the ad copy's own keys with the
 *     ads' ids (ad_ids) and Meta's answer decides (LIVE-PROBES AD-048).
 *   - best-practices/manage-your-ad-object-status.md: DELETE /{id} = status DELETED, final. Until step 22
 *     (remove-meta-ads-items) builds on it, ONLY the undo of a create or a copy sends `object.delete` (the tools take the ids
 *     from the change's own record, never from a caller).
 */
import type { MetaWriteBodyId, MetaWriteRule } from './meta-calls.js'
import {
  BID_STRATEGIES, META_NAME_TEXT, META_SETTINGS_JUDGES, META_STRICT_TEXT, MIN_PERIOD_SECONDS, OUTCOME_OBJECTIVES, metaCanonicalJson, metaJudged,
  metaOneOfJudge, metaPromotedIds, metaWholeJudge, type MetaJudge,
} from './meta-settings-rules.js'

type Params = ReadonlyMap<string, string>

/**
 * CMP-087 — is_pca_unified is accepted from this moment on (OCC 2026 entry dated 2026-10-22, "Applies to all versions").
 * Before it, the tool and the gateway refuse it in words.
 */
export const META_PCA_UNIFIED_FROM = Date.UTC(2026, 9, 22, 0, 0, 0)

/** The special ad categories a create declares (never ISSUES_ELECTIONS_POLITICS: banned in the EU since 2025-10-06; CREDIT replaced). */
export const CREATE_SPECIAL_AD_CATEGORIES = ['EMPLOYMENT', 'HOUSING', 'FINANCIAL_PRODUCTS_SERVICES', 'ONLINE_GAMBLING_AND_GAMING'] as const

/** destination_type (reference/ad-campaign.md create table; Meta's SDK adset.py DestinationType). */
export const DESTINATION_TYPES = [
  'WEBSITE', 'APP', 'MESSENGER', 'APPLINKS_AUTOMATIC', 'WHATSAPP', 'INSTAGRAM_DIRECT', 'FACEBOOK', 'MESSAGING_MESSENGER_WHATSAPP',
  'MESSAGING_INSTAGRAM_DIRECT_MESSENGER', 'MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP', 'MESSAGING_INSTAGRAM_DIRECT_WHATSAPP', 'SHOP_AUTOMATIC',
  'ON_AD', 'ON_POST', 'ON_EVENT', 'ON_VIDEO', 'ON_PAGE', 'INSTAGRAM_PROFILE', 'FACEBOOK_PAGE', 'INSTAGRAM_PROFILE_AND_FACEBOOK_PAGE',
  'INSTAGRAM_LIVE', 'FACEBOOK_LIVE', 'IMAGINE',
] as const

export const RENAME_STRATEGIES = ['DEEP_RENAME', 'ONLY_TOP_LEVEL_RENAME', 'NO_RENAME'] as const
export const COPY_STATUS_OPTIONS = ['PAUSED', 'ACTIVE', 'INHERITED_FROM_SOURCE'] as const
/** The two values of execution_options a create may carry: Meta's check, alone or with its recommendations (CMP-031). */
export const CREATE_CHECK_VALUES = ['["validate_only"]', '["validate_only","include_recommendations"]'] as const
/** Nexus's own limits: the most copies one background request holds, ads one async ad copy names, parts of a schedule. */
export const MAX_BACKGROUND_COPIES = 8
export const MAX_ASYNC_AD_COPIES = 50
const MAX_PERIODS = 50
const AMOUNT_MAX = 100_000_000_000

const isId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,20}$/.test(v)
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exactKeys = (o: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []) =>
  Object.keys(o).every((k) => allowed.includes(k)) && required.every((k) => k in o)
const json = (what: string, judge: (parsed: unknown) => string | null): MetaJudge => (value) => {
  const parsed = metaCanonicalJson(value)
  if (parsed === undefined) return `${what} is JSON in one spelling only (as Nexus writes it: no spaces, each key once)`
  return judge(parsed)
}
const digits: MetaJudge = (value) => (/^\d{1,20}$/.test(value) ? null : 'a Meta id is digits only')
const typedOk = (v: unknown, max: number, pattern: RegExp) => typeof v === 'string' && v === v.trim() && v.length > 0 && [...v].length <= max && pattern.test(v)

// ── shared judges (built when first judged: this module sits in an import cycle with meta-calls.ts) ────────────────────

/** budget_schedule_specs at create (CMP-058, AS-089): 1–50 one-time increases, each its four keys, at least 3 hours. */
const budgetScheduleSpecs: MetaJudge = json('budget_schedule_specs', (list) => {
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_PERIODS) return `budget_schedule_specs lists 1 to ${MAX_PERIODS} scheduled increases`
  for (const p of list) {
    if (!plainObject(p) || !exactKeys(p, ['time_start', 'time_end', 'budget_value', 'budget_value_type'], ['time_start', 'time_end', 'budget_value', 'budget_value_type'])) {
      return 'each scheduled increase has exactly time_start, time_end, budget_value and budget_value_type'
    }
    if (!isInt(p.time_start, 1_000_000_000, 9_999_999_999) || !isInt(p.time_end, 1_000_000_000, 9_999_999_999)) return 'a scheduled increase starts and ends at UTC Unix seconds'
    if ((p.time_end as number) - (p.time_start as number) < MIN_PERIOD_SECONDS) return 'a scheduled increase lasts at least 3 hours'
    if (p.budget_value_type !== 'ABSOLUTE' && p.budget_value_type !== 'MULTIPLIER') return 'budget_value_type is ABSOLUTE or MULTIPLIER'
    if (!isInt(p.budget_value, 1, p.budget_value_type === 'MULTIPLIER' ? 700 : AMOUNT_MAX)) return 'budget_value is a whole number (a percentage at most 700)'
  }
  return null
})

const checkJudge: MetaJudge = (value, params) => {
  if (!(CREATE_CHECK_VALUES as readonly string[]).includes(value)) return `the only execution_options Nexus sends on a create is exactly ${CREATE_CHECK_VALUES.join(' or ')} (Meta's check, which changes nothing)`
  return params.has('fields') ? 'Meta\'s check changes nothing, so it reads nothing back' : null
}

const renameOptions: MetaJudge = json('rename_options', (o) => {
  if (!plainObject(o) || !exactKeys(o, ['rename_strategy', 'rename_prefix', 'rename_suffix'], ['rename_strategy'])) return 'rename_options has rename_strategy and only rename_prefix, rename_suffix'
  if (!(RENAME_STRATEGIES as readonly unknown[]).includes(o.rename_strategy)) return `rename_strategy is one of ${RENAME_STRATEGIES.join(', ')}`
  for (const k of ['rename_prefix', 'rename_suffix'] as const) if (k in o && !typedOk(o[k], 100, META_NAME_TEXT)) return `${k} is 1 to 100 characters of printable text`
  return null
})

/** A form body inside an async batch part, in ONE spelling (URLSearchParams writes it again the same), each key once. */
function partParams(body: unknown): Map<string, string> | null {
  if (typeof body !== 'string' || !body || body.length > 4000) return null
  const params = new Map<string, string>()
  for (const [k, v] of new URLSearchParams(body)) {
    if (!/^[a-z_][a-z0-9_]*$/.test(k) || params.has(k)) return null
    params.set(k, v)
  }
  return new URLSearchParams([...params]).toString() === body ? params : null
}

// ── the rules ───────────────────────────────────────────────────────────────────────────────────────────────────────

let built: readonly MetaWriteRule[] | null = null

/** Step 19's rules on the write allow-list (meta-calls.ts writeRules), built once, when first judged. */
export function metaCreateWriteRules(): readonly MetaWriteRule[] {
  if (built) return built
  const C = META_SETTINGS_JUDGES.campaign
  const A = META_SETTINGS_JUDGES.adset
  const status = metaOneOfJudge(['PAUSED', 'ACTIVE'], 'status (a create is PAUSED, or ACTIVE when the person asked)')
  const bool = (what: string) => metaOneOfJudge(['true', 'false'], what)

  // ── create-meta-campaign: POST /act_{id}/campaigns ──
  const specialCategories: MetaJudge = json('special_ad_categories', (list) => (
    Array.isArray(list) && list.length <= CREATE_SPECIAL_AD_CATEGORIES.length && list.every((c) => (CREATE_SPECIAL_AD_CATEGORIES as readonly unknown[]).includes(c)) && new Set(list).size === list.length
      ? null : `special_ad_categories lists ${CREATE_SPECIAL_AD_CATEGORIES.join(', ')}, each once ([] for none; never political or social-issue ads)`))
  const campaignJudges: Record<string, MetaJudge> = {
    name: C.name,
    objective: metaOneOfJudge(OUTCOME_OBJECTIVES, 'objective (legacy objectives are refused: deprecated since v17)'),
    special_ad_categories: specialCategories,
    special_ad_category_country: C.special_ad_category_country,
    status,
    bid_strategy: metaOneOfJudge(BID_STRATEGIES, 'bid_strategy'),
    is_adset_budget_sharing_enabled: bool('is_adset_budget_sharing_enabled'),
    daily_budget: C.daily_budget,
    lifetime_budget: C.lifetime_budget,
    buying_type: metaOneOfJudge(['AUCTION', 'RESERVED'], 'buying_type'),
    spend_cap: metaWholeJudge(1, AMOUNT_MAX, 'spend_cap (minor units; a create sets a cap, never "no cap")'),
    promoted_object: C.promoted_object,
    budget_schedule_specs: budgetScheduleSpecs,
    source_campaign_id: digits,
    is_pca_unified: metaOneOfJudge(['true'], 'is_pca_unified (Nexus sends it only as true)'),
    execution_options: checkJudge,
  }
  const campaignWhole = (p: Params): string | null => {
    const budget = p.has('daily_budget') || p.has('lifetime_budget')
    if (p.has('daily_budget') && p.has('lifetime_budget')) return 'a campaign has a daily or a lifetime budget, not both'
    if (budget && p.get('is_adset_budget_sharing_enabled') === 'true') return 'ad set budget sharing is for a campaign WITHOUT a campaign budget'
    if (!budget && !p.has('is_adset_budget_sharing_enabled')) return 'without a campaign budget, Nexus says is_adset_budget_sharing_enabled explicitly (Meta requires it since v24, 4834011)'
    const categories = metaCanonicalJson(p.get('special_ad_categories') ?? '[]')
    if (Array.isArray(categories) && categories.length && !p.has('special_ad_category_country')) return 'a special ad category goes with its countries (special_ad_category_country)'
    if (p.get('buying_type') === 'RESERVED' && (p.has('spend_cap') || (Array.isArray(categories) && categories.length))) return 'reach and frequency (RESERVED) takes no spend cap and no special ad category (Meta)'
    if (p.has('budget_schedule_specs') && !p.has('daily_budget')) return 'scheduled budget increases are for a campaign daily budget only'
    if (p.has('is_pca_unified')) {
      if (Date.now() < META_PCA_UNIFIED_FROM) return 'is_pca_unified is available from 2026-10-22 (Meta\'s out-of-cycle change): not before'
      if (p.get('objective') !== 'OUTCOME_SALES') return 'is_pca_unified goes with the OUTCOME_SALES objective only'
    }
    return null
  }
  const campaignIds = (p: Params): MetaWriteBodyId[] => [
    ...(isId(p.get('source_campaign_id')) ? [{ id: p.get('source_campaign_id')!, kind: 'campaign' as const }] : []),
    ...metaPromotedIds(p),
  ]

  // ── create-meta-ad-set: POST /act_{id}/adsets ──
  /** The minimal targeting a create sends (full targeting edits: step 20). */
  const targeting: MetaJudge = json('targeting', (t) => {
    const keys = ['geo_locations', 'age_min', 'age_max', 'genders', 'custom_audiences', 'excluded_custom_audiences', 'targeting_automation']
    if (!plainObject(t) || !exactKeys(t, keys, ['geo_locations', 'targeting_automation'])) return `targeting has geo_locations and targeting_automation, and only ${keys.slice(1, -1).join(', ')} besides (location_types is never sent)`
    const geo = t.geo_locations
    if (!plainObject(geo) || !exactKeys(geo, ['countries', 'regions', 'cities']) || !Object.keys(geo).length) return 'geo_locations has countries, regions or cities, and nothing else'
    if ('countries' in geo && !(Array.isArray(geo.countries) && geo.countries.length >= 1 && geo.countries.length <= 250 && geo.countries.every((c) => typeof c === 'string' && /^[A-Z]{2}$/.test(c)) && new Set(geo.countries).size === geo.countries.length)) {
      return 'countries lists two-letter country codes, each once'
    }
    if ('regions' in geo && !(Array.isArray(geo.regions) && geo.regions.length >= 1 && geo.regions.length <= 200 && geo.regions.every((r) => plainObject(r) && exactKeys(r, ['key'], ['key']) && isId(r.key)))) return 'regions lists up to 200 {key} (digits, from meta-targeting-search)'
    if ('cities' in geo && !(Array.isArray(geo.cities) && geo.cities.length >= 1 && geo.cities.length <= 250 && geo.cities.every((c) => plainObject(c) && isId(c.key)
      && (exactKeys(c, ['key'], ['key']) || (exactKeys(c, ['key', 'radius', 'distance_unit'], ['key', 'radius', 'distance_unit']) && c.distance_unit === 'kilometer' && isInt(c.radius, 17, 80)))))) {
      return 'cities lists up to 250 {key} or {key, radius 17–80, distance_unit "kilometer"}'
    }
    const auto = t.targeting_automation
    if (!plainObject(auto) || !exactKeys(auto, ['advantage_audience'], ['advantage_audience']) || (auto.advantage_audience !== 0 && auto.advantage_audience !== 1)) return 'targeting_automation is exactly {"advantage_audience": 0 or 1}'
    if ('age_min' in t && !isInt(t.age_min, 13, 65)) return 'age_min is 13 to 65'
    if ('age_max' in t && !isInt(t.age_max, 13, 65)) return 'age_max is 13 to 65'
    if ('age_min' in t && 'age_max' in t && (t.age_max as number) < (t.age_min as number)) return 'age_max is at least age_min'
    if (auto.advantage_audience === 1 && (('age_max' in t) || ('age_min' in t && (t.age_min as number) > 25))) return 'with Advantage+ audience Meta takes an age_min of 25 at most and no age_max'
    if ('genders' in t && !(Array.isArray(t.genders) && t.genders.length === 1 && (t.genders[0] === 1 || t.genders[0] === 2))) return 'genders is [1] (men) or [2] (women); left out: everyone'
    for (const k of ['custom_audiences', 'excluded_custom_audiences'] as const) {
      if (k in t && !(Array.isArray(t[k]) && (t[k] as unknown[]).length >= 1 && (t[k] as unknown[]).length <= 500 && (t[k] as unknown[]).every((a) => plainObject(a) && exactKeys(a, ['id'], ['id']) && isId(a.id))
        && new Set((t[k] as Array<{ id: string }>).map((a) => a.id)).size === (t[k] as unknown[]).length)) return `${k} lists up to 500 {id} (the account's own audiences), each once`
    }
    return null
  })
  /** Step 18's promoted object judge for its keys; the keys only a create sends judged here (their owners: gateway ids). */
  const CREATE_ONLY_PROMOTED = ['page_id', 'custom_conversion_id', 'boosted_product_set_id'] as const
  const adSetPromoted: MetaJudge = json('promoted_object', (o) => {
    if (!plainObject(o) || !Object.keys(o).length) return 'promoted_object is an object with at least one key'
    for (const k of CREATE_ONLY_PROMOTED) if (k in o && !isId(o[k])) return `promoted_object.${k} is a Meta id (digits, as a JSON string)`
    if ('boosted_product_set_id' in o && !('product_set_id' in o)) return 'promoted_object.boosted_product_set_id goes with the catalog\'s product_set_id'
    const rest = Object.fromEntries(Object.entries(o).filter(([k]) => !(CREATE_ONLY_PROMOTED as readonly string[]).includes(k)))
    return Object.keys(rest).length ? A.promoted_object(JSON.stringify(rest), new Map()) : null
  })
  const adSetJudges: Record<string, MetaJudge> = {
    name: A.name,
    campaign_id: digits,
    optimization_goal: A.optimization_goal,
    optimization_sub_event: A.optimization_sub_event,
    billing_event: A.billing_event,
    targeting,
    status,
    destination_type: metaOneOfJudge(DESTINATION_TYPES, 'destination_type'),
    daily_budget: A.daily_budget,
    lifetime_budget: A.lifetime_budget,
    daily_min_spend_target: A.daily_min_spend_target,
    lifetime_min_spend_target: A.lifetime_min_spend_target,
    daily_spend_cap: A.daily_spend_cap,
    lifetime_spend_cap: A.lifetime_spend_cap,
    bid_strategy: A.bid_strategy,
    bid_amount: A.bid_amount,
    bid_constraints: A.bid_constraints,
    start_time: A.start_time,
    end_time: A.end_time,
    attribution_spec: A.attribution_spec,
    promoted_object: adSetPromoted,
    is_dynamic_creative: bool('is_dynamic_creative'),
    budget_schedule_specs: budgetScheduleSpecs,
    dsa_payor: A.dsa_payor,
    dsa_beneficiary: A.dsa_beneficiary,
    execution_options: checkJudge,
  }
  const adSetWhole = (p: Params): string | null => {
    if (p.has('daily_budget') && p.has('lifetime_budget')) return 'an ad set has a daily or a lifetime budget, not both'
    if (p.has('lifetime_budget') && (!p.has('end_time') || p.get('end_time') === '0')) return 'a lifetime budget needs an end time'
    if (p.has('dsa_payor') !== p.has('dsa_beneficiary')) return 'dsa_payor and dsa_beneficiary go together (Meta fills a missing one from the account default, not from the other)'
    if (p.get('bid_strategy') === 'LOWEST_COST_WITH_MIN_ROAS' && p.has('bid_amount')) return 'a ROAS goal takes no bid_amount'
    // Under a campaign budget the ROAS goal strategy is the campaign's: an ad set then sends its floor alone.
    if (p.has('bid_constraints') && p.has('bid_strategy') && p.get('bid_strategy') !== 'LOWEST_COST_WITH_MIN_ROAS') return 'bid_constraints go with the LOWEST_COST_WITH_MIN_ROAS strategy'
    if (p.has('budget_schedule_specs') && !p.has('daily_budget')) return 'scheduled budget increases are for an ad set daily budget only'
    return null
  }
  const adSetIds = (p: Params): MetaWriteBodyId[] => {
    const out: MetaWriteBodyId[] = []
    if (isId(p.get('campaign_id'))) out.push({ id: p.get('campaign_id')!, kind: 'campaign' })
    const t = metaCanonicalJson(p.get('targeting') ?? '')
    if (plainObject(t)) {
      for (const k of ['custom_audiences', 'excluded_custom_audiences']) {
        const list = t[k]
        if (Array.isArray(list)) for (const a of list) if (plainObject(a) && isId(a.id)) out.push({ id: a.id, kind: 'customaudience' })
      }
    }
    const o = metaCanonicalJson(p.get('promoted_object') ?? '')
    if (plainObject(o)) {
      if (isId(o.page_id)) out.push({ id: o.page_id, kind: 'page' })
      if (isId(o.custom_conversion_id)) out.push({ id: o.custom_conversion_id, kind: 'customconversion' })
      if (isId(o.boosted_product_set_id)) out.push({ id: o.boosted_product_set_id, kind: 'productset' })
    }
    return [...out, ...metaPromotedIds(p)]
  }

  // ── copy-meta-ads: POST /{campaign | ad set | ad id}/copies ──
  const copyStatus = metaOneOfJudge(COPY_STATUS_OPTIONS, 'status_option')
  const overrides: MetaJudge = json('parameter_overrides', (o) => {
    if (!plainObject(o) || Object.keys(o).length !== 1 || !exactKeys(o, ['daily_budget', 'lifetime_budget'])) return 'parameter_overrides is exactly one of {"daily_budget": N} or {"lifetime_budget": N} (Meta documents no other key)'
    return Object.values(o).every((v) => isInt(v, 1, AMOUNT_MAX)) ? null : 'an overridden budget is a whole number of minor units'
  })
  const creativeParameters: MetaJudge = json('creative_parameters', (o) => {
    if (!plainObject(o) || !Object.keys(o).length || !exactKeys(o, ['name', 'url_tags'])) return 'creative_parameters has name and / or url_tags only (other creative changes: their own tools)'
    if ('name' in o && !typedOk(o.name, 100, META_NAME_TEXT)) return 'creative_parameters.name is 1 to 100 characters of printable text'
    if ('url_tags' in o && !(typeof o.url_tags === 'string' && /^[A-Za-z0-9_.~%+\-]+=[^\s&#]*(&[A-Za-z0-9_.~%+\-]+=[^\s&#]*){0,19}$/.test(o.url_tags) && o.url_tags.length <= 1024 && /^[\x21-\x7e]*$/.test(o.url_tags))) {
      return 'creative_parameters.url_tags is key=value pairs joined by & (printable ASCII, no spaces, at most 20, 1024 characters)'
    }
    return null
  })
  const campaignCopyJudges: Record<string, MetaJudge> = {
    status_option: copyStatus, deep_copy: bool('deep_copy'), rename_options: renameOptions, start_time: A.start_time, end_time: A.end_time, parameter_overrides: overrides,
  }
  const adSetCopyJudges: Record<string, MetaJudge> = {
    status_option: copyStatus, campaign_id: digits, deep_copy: bool('deep_copy'), rename_options: renameOptions, start_time: A.start_time, end_time: A.end_time,
  }
  const adCopyJudges: Record<string, MetaJudge> = { status_option: copyStatus, adset_id: digits, rename_options: renameOptions, creative_parameters: creativeParameters }
  const campaignCopyWhole = (p: Params) => ((p.has('start_time') || p.has('end_time')) && p.get('deep_copy') !== 'true' ? 'a campaign copy\'s start and end times are its copied ad sets\': with deep_copy=true only' : null)

  // ── copy-meta-ads in the background (CMP-054): POST /act_{id}/async_batch_requests, each part one copy ──
  const PART_NAME = /^(campaign|adset)_copy_([1-9]\d?)$/
  const adbatchParts = (raw: string): Array<{ kind: 'campaign' | 'adset'; id: string; params: Map<string, string> }> | string => {
    const list = metaCanonicalJson(raw)
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_BACKGROUND_COPIES) return `adbatch lists 1 to ${MAX_BACKGROUND_COPIES} copies, in one spelling`
    const out: Array<{ kind: 'campaign' | 'adset'; id: string; params: Map<string, string> }> = []
    for (const [i, part] of list.entries()) {
      const where = `adbatch part ${i + 1}`
      if (!plainObject(part) || !exactKeys(part, ['name', 'relative_url', 'body'], ['name', 'relative_url', 'body'])) return `${where} has exactly name, relative_url and body`
      const name = typeof part.name === 'string' ? PART_NAME.exec(part.name) : null
      if (!name || Number(name[2]) !== i + 1) return `${where} is named campaign_copy_${i + 1} or adset_copy_${i + 1} (the kind of what it copies)`
      const url = typeof part.relative_url === 'string' ? /^(\d{1,20})\/copies$/.exec(part.relative_url) : null
      if (!url) return `${where}'s relative_url is <id>/copies (a copy, nothing else)`
      const params = partParams(part.body)
      if (!params) return `${where}'s body is a form body in one spelling, each key once`
      const kind = name[1] as 'campaign' | 'adset'
      const judges = kind === 'campaign' ? campaignCopyJudges : adSetCopyJudges
      if (!params.has('status_option') || params.get('deep_copy') !== 'true') return `${where} is a deep copy (deep_copy=true) with its status_option: a background copy is for copies with their ads`
      const problem = metaJudged(judges, kind === 'campaign' ? campaignCopyWhole : undefined)(params)
      if (problem) return `${where}: ${problem}`
      out.push({ kind, id: url[1], params })
    }
    return new Set(out.map((p) => p.id)).size === out.length ? out : 'adbatch copies each object once'
  }

  built = [
    {
      name: 'campaign.create',
      method: 'POST',
      path: /^act_\d{1,25}\/campaigns$/,
      kinds: ['adaccount'],
      required: ['name', 'objective', 'special_ad_categories', 'status', 'bid_strategy'],
      optional: ['special_ad_category_country', 'is_adset_budget_sharing_enabled', 'daily_budget', 'lifetime_budget', 'buying_type', 'spend_cap', 'promoted_object', 'budget_schedule_specs', 'source_campaign_id', 'is_pca_unified', 'execution_options'],
      text: { name: META_NAME_TEXT },
      maxBody: 8_000,
      values: metaJudged(campaignJudges, campaignWhole),
      budget: false,
      ids: campaignIds,
    },
    {
      name: 'adset.create',
      method: 'POST',
      path: /^act_\d{1,25}\/adsets$/,
      kinds: ['adaccount'],
      required: ['name', 'campaign_id', 'optimization_goal', 'billing_event', 'targeting', 'status'],
      optional: [
        'optimization_sub_event', 'destination_type', 'daily_budget', 'lifetime_budget', 'daily_min_spend_target', 'lifetime_min_spend_target', 'daily_spend_cap', 'lifetime_spend_cap',
        'bid_strategy', 'bid_amount', 'bid_constraints', 'start_time', 'end_time', 'attribution_spec', 'promoted_object', 'is_dynamic_creative', 'budget_schedule_specs',
        'dsa_payor', 'dsa_beneficiary', 'execution_options',
      ],
      text: { name: META_NAME_TEXT, dsa_payor: META_STRICT_TEXT, dsa_beneficiary: META_STRICT_TEXT },
      maxBody: 16_000,
      values: metaJudged(adSetJudges, adSetWhole),
      // A new ad set's first budget is not a change of an ad set's budget (Meta's 4-an-hour limit counts changes).
      budget: false,
      ids: adSetIds,
    },
    {
      name: 'campaign.copy',
      method: 'POST',
      path: /^\d{1,20}\/copies$/,
      kinds: ['campaign'],
      required: ['status_option'],
      optional: ['deep_copy', 'rename_options', 'start_time', 'end_time', 'parameter_overrides'],
      text: { rename_options: META_NAME_TEXT },
      values: metaJudged(campaignCopyJudges, campaignCopyWhole),
      budget: false,
    },
    {
      name: 'adset.copy',
      method: 'POST',
      path: /^\d{1,20}\/copies$/,
      kinds: ['adset'],
      required: ['status_option'],
      optional: ['campaign_id', 'deep_copy', 'rename_options', 'start_time', 'end_time'],
      text: { rename_options: META_NAME_TEXT },
      values: metaJudged(adSetCopyJudges),
      budget: false,
      ids: (p) => (isId(p.get('campaign_id')) ? [{ id: p.get('campaign_id')!, kind: 'campaign' }] : []),
    },
    {
      name: 'ad.copy',
      method: 'POST',
      path: /^\d{1,20}\/copies$/,
      kinds: ['ad'],
      required: ['status_option'],
      optional: ['adset_id', 'rename_options', 'creative_parameters'],
      text: { rename_options: META_NAME_TEXT, creative_parameters: META_NAME_TEXT },
      values: metaJudged(adCopyJudges),
      budget: false,
      ids: (p) => (isId(p.get('adset_id')) ? [{ id: p.get('adset_id')!, kind: 'adset' }] : []),
    },
    {
      name: 'copy.background',
      method: 'POST',
      path: /^act_\d{1,25}\/async_batch_requests$/,
      kinds: ['adaccount'],
      required: ['name', 'adbatch'],
      optional: [],
      text: { name: META_NAME_TEXT, adbatch: META_NAME_TEXT },
      maxBody: 16_000,
      values: (p) => {
        if (!typedOk(p.get('name'), 100, META_NAME_TEXT)) return 'name (of the background request) is 1 to 100 characters of printable text'
        const parts = adbatchParts(p.get('adbatch') ?? '')
        return typeof parts === 'string' ? parts : null
      },
      budget: false,
      ids: (p) => {
        const parts = adbatchParts(p.get('adbatch') ?? '')
        if (typeof parts === 'string') return []
        return parts.flatMap((part) => [{ id: part.id, kind: part.kind }, ...(isId(part.params.get('campaign_id')) ? [{ id: part.params.get('campaign_id')!, kind: 'campaign' as const }] : [])])
      },
    },
    {
      // AD-048 — STILL-UNVERIFIED: Meta documents the edge, not its parameters (LIVE-PROBES AD-048).
      name: 'ad.copy.background',
      method: 'POST',
      path: /^act_\d{1,25}\/asyncadcopies$/,
      kinds: ['adaccount'],
      required: ['ad_ids', 'status_option'],
      optional: ['adset_id', 'rename_options'],
      text: { rename_options: META_NAME_TEXT },
      values: metaJudged({
        ad_ids: json('ad_ids', (list) => (Array.isArray(list) && list.length >= 1 && list.length <= MAX_ASYNC_AD_COPIES && list.every(isId) && new Set(list).size === list.length
          ? null : `ad_ids lists 1 to ${MAX_ASYNC_AD_COPIES} ad ids (digits, as JSON strings), each once`)),
        status_option: copyStatus,
        adset_id: digits,
        rename_options: renameOptions,
      }),
      budget: false,
      ids: (p) => {
        const list = metaCanonicalJson(p.get('ad_ids') ?? '')
        return [
          ...(Array.isArray(list) ? list.filter(isId).map((id) => ({ id, kind: 'ad' as const })) : []),
          ...(isId(p.get('adset_id')) ? [{ id: p.get('adset_id')!, kind: 'adset' as const }] : []),
        ]
      },
    },
    {
      // DELETE /{campaign | ad set | ad id}, no body. Until step 22 (remove-meta-ads-items) ONLY the undo of a create or a
      // copy sends it, and only for the objects that change's own record says it made.
      name: 'object.delete',
      method: 'DELETE',
      path: /^\d{1,20}$/,
      kinds: ['campaign', 'adset', 'ad'],
      required: [],
      optional: [],
      values: () => null,
      budget: false,
    },
  ]
  return built
}
