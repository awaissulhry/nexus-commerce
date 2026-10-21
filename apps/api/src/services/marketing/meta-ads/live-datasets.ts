/**
 * Meta ads, step 11 — the business's datasets (Meta pixels), read LIVE from Meta (GET only, through the gateway).
 * Nothing here stores or changes anything (dataset changes are step 32, events from Nexus step 33).
 *
 *   meta-datasets  the chosen ad account's pixels (datasets) and the business portfolio's, one pixel's settings and base
 *                  code, who may use it (ad accounts, partner businesses, people), its event volume (by event, source,
 *                  device, URL, match keys …), WHO SENDS its events (browser pixel or server / Conversions API, the
 *                  partner, deduplication: Owner decision D2 — `sources`), Event Match Quality and the rest of Meta's
 *                  Dataset Quality API, diagnostics, the Conversions API Gateway, custom conversions (with the 100-per-
 *                  account count), event rules and parameter extractors, legacy offline event sets and uploads.
 *
 * ALLOW-LISTS ONLY (lesson from steps 1–2): the caller never names a Graph path, field or parameter; every view sends a
 * fixed request with a fixed field list, and every answer keeps only the keys named here. Every pixel read is one of the
 * chosen ad account's (Meta: pixels live on the ad account, `/act_<id>/adspixels`); in the business portfolio's lists a
 * pixel that is not on the chosen ad account is its id only, and `{ id, takenByAnotherBusiness: true }` when it is
 * connected to an ad account another business in Nexus uses. Every custom conversion read is the chosen ad account's.
 * An ad account another business in Nexus uses is `{ adAccountId, takenByAnotherBusiness: true }` only; an ad set that
 * is not the chosen account's is its id only. Debug feeds never carry a page's query string or Meta's raw event body
 * (a buyer's data could be in them), and nothing is stored or logged.
 *
 * Checked 2026-10-21 with `curl -sL <page>.md` (developers.facebook.com/documentation/ads-commerce/…) and Meta's Python
 * Business SDK (github.com/facebook/facebook-python-business-sdk, main, facebook_business/adobjects):
 *   - marketing-api/reference/ads-pixel (v26 fields: automatic_matching_fields, can_proxy, code, config, creation_time,
 *     creator — a person: never asked —, data_use_setting, description, duplicate_entries, enable_auto_assign_to_accounts,
 *     enable_automatic_matching, event_stats, event_time_max / _min, first_party_cookie_status, has_1p_pixel_event,
 *     is_consolidated_container, is_created_by_business, is_crm, is_mta_use, is_restricted_use, is_unavailable,
 *     last_fired_time, last_upload_app, last_upload_app_changed_time, match_rate_approx, matched_entries, name,
 *     owner_business, usage, valid_entries); ad-account/adspixels (summary total_count); business/adspixels (id_filter,
 *     name_filter), owned_pixels, client_pixels (+ permitted_tasks), pending_shared_pixels (no params);
 *   - ads-pixel/stats (aggregation browser_type | custom_data_field | device_os | device_type | event (default) | host |
 *     match_keys | had_pii | pixel_fire | event_detection_method | url | event_value_count | url_by_rule |
 *     event_total_counts | event_source | event_processing_results; event; event_source WEB_ONLY | SERVER_ONLY; agent;
 *     start_time / end_time, "data up to seven days" per request — Meta's own MCP reads up to 28 days, so Nexus asks
 *     7 days at a time; SDK adspixelstatsresult.py: aggregation, data [{value, count}], start_time);
 *   - conversions-api/dataset-quality-api (GET /dataset_quality?dataset_id=&agent_name=&fields=web{event_name,
 *     event_match_quality{composite_score,match_key_feedback{identifier,coverage{percentage},potential_aly_acr_increase},
 *     diagnostics},acr,event_potential_aly_acr_increase,event_coverage{percentage,goal_percentage,description},
 *     dedupe_key_feedback{dedupe_key,browser_events_with_dedupe_key,server_events_with_dedupe_key,
 *     overall_browser_coverage_from_dedupe_key},data_freshness,event_spend{amount,currency_code} (a float in the ad
 *     account's currency units),event_ad_sets{…, spend_amount float} (≤100), value_diagnostics, event_delay}; the field
 *     table spells "dedup_key_feedback" but every example and SDK adspixelcapiintegrationquality.py say
 *     dedupe_key_feedback); dataset-quality-api/offline-events (fields=offline{event_name,composite,match_key,frequency,
 *     freshness}; beta). The CRM-events page in Meta's index does not open (it answers an error page), so Nexus asks no CRM
 *     variant;
 *   - ads-pixel/shared_accounts (business required), shared_agencies, assigned_users (business required; id, name,
 *     user_type, tasks), agencies (SDK get_agencies; the guides use it), audiences (action_source, ad_account),
 *     customconversions (ad_account), event_last_fired_time (event), domain_last_fired_time (domain_name_list required),
 *     recent_events (event and lookback_window seconds required), real_time_event_log (start_time, end_time, limit;
 *     "recent pixel fires for the logged in user"), raw_fires (event required; filter_type device_type |
 *     event_detection_method | host | url; filter), ads_signal_diagnostic_issues (ad_account_id required),
 *     pixel_delivery_recommendations, item_price_stats, microdata_stats (catalog_id required),
 *     cpas_events_debugging_info (action_source), cloudbridge_dataset_status, setup_quality (agent_name),
 *     integration_quality (agent_name, time_range), openbridge_configurations, event_rules (CalibratorExistingRule),
 *     extractors (current_domain; SignalsIWLExtractor); business/openbridge_configurations; the node fields of each from
 *     the SDK (adspixel*.py, adssignaldiagnosticissue.py, cloudbridgedatasetstatus.py, openbridgeconfiguration.py,
 *     calibratorexistingrule.py, signalsiwlextractor.py, externaleventsourcecpaseventsdebugginginfo.py);
 *   - ad-account/customconversions (no params; max 100 per ad account), business/customconversions (include_archived,
 *     default true; summary total_count), business/owned_custom_conversions, custom-conversion (fields; the rule cannot
 *     change after creation; is_unavailable = flagged) and its stats edge (SDK customconversionstatsresult.py:
 *     aggregation count | device_type | host | pixel_fire | unmatched_count | unmatched_usd_amount | url | usd_amount);
 *   - ads-pixel offline_event_uploads (SDK: start_time, end_time, order, sort_by, upload_tag), ad-account and business
 *     offline_conversion_data_sets (legacy; Meta may answer 2635 "deprecated version").
 * Event rules and parameter extractors can be read but not created, changed or deleted through Meta's public API (the
 * v26 edges say "can't perform"; the SDK has no write): only Meta's own MCP does that (RECHECK-C3 SG-098…SG-104).
 */
import { metaAdAccountId, metaObjectId } from '../../cx/connectors/meta/discovery.js'
import type { MetaQueryValue } from '../../gateway/meta.js'
import { metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { metaChosenAccount, objectKindOf, type MetaChosenAccount } from './live.js'
import { decimalToMicros, minorOf } from './money.js'
import { takenIds } from './taken.js'
import { act, bool, chosenPixelIds, num, ownPixel, part, pickRow, plain, readRows, refuse, stripQuery, text, audienceRow } from './live-audiences.js'

export const DATASET_VIEWS = [
  'list', 'portfolio', 'detail', 'access', 'stats', 'sources', 'quality', 'quality-offline', 'quality-legacy', 'diagnostics', 'gateway',
  'custom-conversions', 'event-setup', 'legacy-offline',
] as const
export type DatasetView = typeof DATASET_VIEWS[number]

export const PORTFOLIO_LISTS = ['all', 'owned', 'client', 'pending'] as const
export const STATS_AGGREGATIONS = [
  'event', 'event_total_counts', 'event_source', 'device_type', 'device_os', 'browser_type', 'host', 'url', 'url_by_rule', 'match_keys',
  'had_pii', 'pixel_fire', 'event_detection_method', 'event_value_count', 'event_processing_results', 'custom_data_field',
] as const
export const EVENT_SOURCES = ['WEB_ONLY', 'SERVER_ONLY'] as const
export const DIAGNOSTIC_CHECKS = [
  'issues', 'events-last-fired', 'domains-last-fired', 'recent-events', 'event-log', 'raw-fires', 'delivery-recommendations', 'item-prices',
  'microdata', 'collaborative-ads',
] as const
export const RAW_FIRE_FILTERS = ['device_type', 'event_detection_method', 'host', 'url'] as const
export const ACTION_SOURCES = ['WEBSITE', 'PHYSICAL_STORE'] as const
export const CONVERSION_SCOPES = ['account', 'business', 'dataset', 'one', 'stats'] as const
export const CONVERSION_STATS_AGGREGATIONS = ['count', 'device_type', 'host', 'pixel_fire', 'url', 'unmatched_count', 'usd_amount', 'unmatched_usd_amount'] as const
export const UPLOAD_SORTS = ['API_CALLS', 'CREATION_TIME', 'EVENT_TIME_MAX', 'EVENT_TIME_MIN', 'FIRST_UPLOAD_TIME', 'IS_EXCLUDED_FOR_LIFT', 'LAST_UPLOAD_TIME'] as const
export const CUSTOM_CONVERSION_LIMIT = 100

const idText = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number' ? metaObjectId(v) : null)
const idOf = (v: unknown): string | null => (v && typeof v === 'object' ? idText((v as { id?: unknown }).id) : idText(v))
const pct = (v: unknown) => num(v && typeof v === 'object' ? (v as { percentage?: unknown }).percentage : v)

// ── fields per node type (fixed) ─────────────────────────────────────────────────────────────────────────────────

export const PIXEL_LIST_FIELDS = [
  'id', 'name', 'creation_time', 'last_fired_time', 'is_unavailable', 'is_created_by_business', 'is_crm', 'is_consolidated_container',
  'owner_business{id}', 'data_use_setting', 'first_party_cookie_status', 'enable_automatic_matching', 'automatic_matching_fields',
].join(',')
export const PIXEL_DETAIL_FIELDS = `${PIXEL_LIST_FIELDS},${[
  'code', 'description', 'config', 'can_proxy', 'has_1p_pixel_event', 'enable_auto_assign_to_accounts', 'is_restricted_use', 'is_mta_use',
  'match_rate_approx', 'valid_entries', 'matched_entries', 'duplicate_entries', 'event_time_min', 'event_time_max', 'last_upload_app',
  'last_upload_app_changed_time', 'usage', 'event_stats',
].join(',')}`
const PIXEL_ROW_KEYS = [
  'name', 'creation_time', 'last_fired_time', 'is_unavailable', 'is_created_by_business', 'is_crm', 'is_consolidated_container', 'data_use_setting',
  'first_party_cookie_status', 'enable_automatic_matching', 'automatic_matching_fields', 'permitted_tasks',
] as const
const PIXEL_DETAIL_KEYS = [
  ...PIXEL_ROW_KEYS, 'code', 'description', 'config', 'can_proxy', 'has_1p_pixel_event', 'enable_auto_assign_to_accounts', 'is_restricted_use', 'is_mta_use',
  'match_rate_approx', 'valid_entries', 'matched_entries', 'duplicate_entries', 'event_time_min', 'event_time_max', 'last_upload_app',
  'last_upload_app_changed_time', 'usage', 'event_stats',
] as const
const AUDIENCE_OF_PIXEL_FIELDS = 'id,account_id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound,delivery_status,operation_status,retention_days,time_created,time_updated'
/** Every key of Meta's Dataset Quality API web block that Nexus reads (full example on the page). */
export const QUALITY_WEB_FIELDS = [
  'event_name',
  'event_match_quality{composite_score,match_key_feedback{identifier,coverage{percentage},potential_aly_acr_increase{percentage,description}},diagnostics}',
  'acr{percentage,description}', 'event_potential_aly_acr_increase{percentage,description}', 'event_coverage{percentage,goal_percentage,description}',
  'dedupe_key_feedback{dedupe_key,browser_events_with_dedupe_key{percentage},server_events_with_dedupe_key{percentage},overall_browser_coverage_from_dedupe_key{percentage}}',
  'data_freshness{upload_frequency,description}', 'event_spend{amount,currency_code}',
  'event_ad_sets{ad_set_id,ad_set_name,objective,spend_amount,spend_currency_code,event_use}',
  'value_diagnostics{issue_type,issue_count,event_count,issue_rate,issue_example}',
  'event_delay{events_delayed_over_2h,events_delayed_over_24h,total_events,pct_delayed_over_2h,pct_delayed_over_24h}',
].join(',')
/** What the D2 check reads of the quality block: coverage, deduplication, match quality and freshness, no money. */
const SOURCES_WEB_FIELDS = [
  'event_name', 'event_match_quality{composite_score}', 'event_coverage{percentage,goal_percentage}',
  'dedupe_key_feedback{dedupe_key,browser_events_with_dedupe_key{percentage},server_events_with_dedupe_key{percentage},overall_browser_coverage_from_dedupe_key{percentage}}',
  'data_freshness{upload_frequency}',
].join(',')
const OFFLINE_FIELDS = 'event_name,composite,match_key,frequency,freshness'
const LEGACY_QUALITY_FIELDS = 'event_name,event_match_quality,event_coverage,dedupe_key_feedback,data_freshness,acr'
const OPENBRIDGE_FIELDS = 'id,active,pixel_id,partner_name,capi_publishing_state,cloud_provider,cloud_region,instance_version,is_sgw_instance,blocked_event_types,blocked_websites,event_enrichment_state'
const CLOUDBRIDGE_FIELDS = 'app_redacted_event,app_sensitive_params,app_unverified_event,has_app_associated,is_app_prohibited,is_dataset'
export const CONVERSION_FIELDS = 'id,account_id,name,description,custom_event_type,event_source_type,rule,default_conversion_value,is_archived,is_unavailable,retention_days,first_fired_time,last_fired_time,creation_time,pixel{id},data_sources'
const EVENT_RULE_FIELDS = 'id,event_type,rule,rule_type,status,creation_source,creation_time,sample_urls,transforms'
const EXTRACTOR_FIELDS = 'id,event_type,extractor_type,domain_uri,extractor_config'
const UPLOAD_FIELDS = 'id,upload_tag,creation_time,first_upload_time,last_upload_time,event_time_min,event_time_max,valid_entries,matched_entries,duplicate_entries,match_rate_approx,api_calls,is_excluded_for_lift'
const OFFLINE_SET_FIELDS = 'id,name,description,creation_time,is_consolidated_container,is_unavailable,last_upload_app,valid_entries,matched_entries,duplicate_entries,match_rate_approx,event_time_min,event_time_max'
const DIAGNOSTIC_FIELDS: Record<(typeof DIAGNOSTIC_CHECKS)[number], { edge: string; fields: string }> = {
  issues: { edge: 'ads_signal_diagnostic_issues', fields: 'data_source_id,data_source_type,diagnostic_type,event_name,traffic_anomaly_drop_percentage,traffic_anomaly_drop_timestamp' },
  'events-last-fired': { edge: 'event_last_fired_time', fields: 'event,last_fired_time' },
  'domains-last-fired': { edge: 'domain_last_fired_time', fields: 'domain_name,last_fired_time' },
  'recent-events': { edge: 'recent_events', fields: 'event,count' },
  // Never data_json, dedup_data, resolved_link or the rule texts: an event's own body can carry a buyer's data.
  'event-log': { edge: 'real_time_event_log', fields: 'event,event_detection_method,device_type,url,timestamp,in_iframe,domain_control_rule_rejection,trace_id' },
  'raw-fires': { edge: 'raw_fires', fields: 'event,event_src,event_detection_method,device_type,placed_url,timestamp,user_pii_keys' },
  'delivery-recommendations': { edge: 'pixel_delivery_recommendations', fields: 'custom_event_type,optimization_goal' },
  'item-prices': { edge: 'item_price_stats', fields: 'date,item_price_coverage' },
  microdata: { edge: 'microdata_stats', fields: 'allowed_domains,errors_stats_for_time_ranges,has_valid_events,suggested_allowed_domains_count_max,suggested_trusted_domains' },
  'collaborative-ads': { edge: 'cpas_events_debugging_info', fields: 'event_name,diagnostic,counts' },
}
const URL_KEYS = new Set(['url', 'placed_url'])

/** An amount Meta gives as a decimal of a currency ("108947.38") in that currency's minor units, with the currency. */
export function currencyCents(amount: unknown, currency: unknown): { cents: number | null; currency: string | null } {
  const code = text(currency)?.toUpperCase() ?? null
  return { cents: minorOf(decimalToMicros(amount), code), currency: code }
}

// ── time windows ─────────────────────────────────────────────────────────────────────────────────────────────────

export const MAX_STATS_HOURS = 672
const WEEK = 7 * 24 * 3600

/** The last `hours` hours (≤ 28 days) as Unix-second windows of at most 7 days each, oldest first. */
export function statsWindows(hours: number, now: Date = new Date()): Array<{ start: number; end: number }> {
  const span = Math.min(MAX_STATS_HOURS, Math.max(1, Math.trunc(hours))) * 3600
  const end = Math.floor(now.getTime() / 1000)
  const out: Array<{ start: number; end: number }> = []
  for (let start = end - span; start < end; start += WEEK) out.push({ start, end: Math.min(end, start + WEEK) })
  return out
}

// ── shared reads ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A pixel row as answered: settings, owner portfolio (id only) and whether it is the chosen ad account's. */
function pixelRow(row: Record<string, unknown>, keys: readonly string[], account: MetaChosenAccount, onChosen: boolean) {
  const owner = idOf(row.owner_business)
  return {
    pixelId: idText(row.id), ...pickRow(row, keys), ownerBusinessId: owner, ownedByThisPortfolio: owner !== null && owner === account.businessId,
    onChosenAdAccount: onChosen, takenByAnotherBusiness: false,
  }
}

/** The ad accounts a pixel is connected to inside the business portfolio (shared_accounts: `business` is required). */
async function pixelAccounts(account: MetaChosenAccount, pixelId: string, maxRows = 200) {
  if (!account.businessId) refuse('The chosen ad account belongs to no business portfolio Nexus knows, and Meta reads a pixel\'s ad accounts per portfolio.')
  const read = await readRows(account.connectionId, 'datasets.sharedAccounts', `${pixelId}/shared_accounts`, { business: account.businessId, fields: 'account_id,name' }, maxRows)
  const ids = read.rows.map((r) => metaAdAccountId(r.account_id ?? r.id)).filter((id): id is string => !!id)
  const taken = await takenIds('AD_ACCOUNT', ids)
  return {
    items: read.rows.map((r) => {
      const id = metaAdAccountId(r.account_id ?? r.id)
      if (id && taken.has(id)) return { adAccountId: id, takenByAnotherBusiness: true as const }
      return { adAccountId: id, name: text(r.name), chosenHere: id === account.adAccountId, takenByAnotherBusiness: false as const }
    }),
    usedByAnotherBusiness: taken.size > 0,
    more: read.more,
  }
}

/** Is this ad set the chosen account's? Nexus's own rows, else one live account_id read. */
async function adSetOfChosen(account: MetaChosenAccount, adSetId: string): Promise<boolean> {
  if ((await objectKindOf(account, adSetId)) === 'adset') return true
  try {
    const read = await metaReadOne({ connectionId: account.connectionId }, { operation: 'datasets.adSetCheck', path: adSetId, query: { fields: 'account_id' } })
    return metaAdAccountId((read.body as { account_id?: unknown }).account_id) === account.adAccountId
  } catch (err) {
    if (err instanceof MetaReadError && !err.failure.authLost && !err.failure.throttled) return false
    throw err
  }
}

/** Meta's Dataset Quality API for one pixel (web or offline block). */
async function datasetQuality(account: MetaChosenAccount, pixelId: string, block: 'web' | 'offline', fields: string, agentName: string | null, operation: string) {
  const read = await metaReadOne({ connectionId: account.connectionId }, {
    operation, path: 'dataset_quality', query: { dataset_id: pixelId, fields: `${block}{${fields}}`, ...(agentName ? { agent_name: agentName } : {}) },
  })
  const list = (read.body as Record<string, unknown>)[block]
  return Array.isArray(list) ? list.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object') : []
}

/** One event's dedup keys as Meta reports them (percentages; Meta gives no per-event overlap count). */
function dedupKeys(row: Record<string, unknown> | undefined) {
  const list = Array.isArray(row?.dedupe_key_feedback) ? row!.dedupe_key_feedback as Array<Record<string, unknown>> : []
  return list.map((k) => ({
    key: text(k.dedupe_key),
    browserEventsWithKeyPercent: pct(k.browser_events_with_dedupe_key),
    serverEventsWithKeyPercent: pct(k.server_events_with_dedupe_key),
    browserEventsDedupedPercent: pct(k.overall_browser_coverage_from_dedupe_key),
  }))
}

/** One web event of the Dataset Quality API as Nexus answers it (money in minor units; foreign ad sets by id only). */
async function qualityEvent(account: MetaChosenAccount, row: Record<string, unknown>, checks: { left: number }) {
  const emq = row.event_match_quality && typeof row.event_match_quality === 'object' ? row.event_match_quality as Record<string, unknown> : null
  const spend = row.event_spend && typeof row.event_spend === 'object' ? row.event_spend as Record<string, unknown> : null
  const spendOf = spend ? currencyCents(spend.amount, spend.currency_code) : null
  const adSetsRaw = Array.isArray(row.event_ad_sets) ? row.event_ad_sets
    : row.event_ad_sets && typeof row.event_ad_sets === 'object' && Array.isArray((row.event_ad_sets as { data?: unknown }).data) ? (row.event_ad_sets as { data: unknown[] }).data : []
  const adSets = []
  for (const raw of adSetsRaw.slice(0, 100)) {
    const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const adSetId = idText(s.ad_set_id)
    if (!adSetId) continue
    // An ad set of another ad account the pixel serves is its id only (no name, objective or spend).
    let ofChosen: boolean | null = (await objectKindOf(account, adSetId)) === 'adset' ? true : null
    if (ofChosen === null && checks.left > 0) { checks.left--; ofChosen = await adSetOfChosen(account, adSetId) }
    if (ofChosen !== true) { adSets.push({ adSetId, ofChosenAdAccount: ofChosen }); continue }
    const money = currencyCents(s.spend_amount, s.spend_currency_code)
    adSets.push({ adSetId, ofChosenAdAccount: true, name: text(s.ad_set_name), objective: text(s.objective), eventUse: text(s.event_use), spendCents: money.cents, spendCurrency: money.currency })
  }
  return {
    eventName: text(row.event_name),
    matchQuality: emq ? {
      score: num(emq.composite_score),
      matchKeys: Array.isArray(emq.match_key_feedback) ? (emq.match_key_feedback as Array<Record<string, unknown>>).map((k) => ({
        key: text(k.identifier), coveragePercent: pct(k.coverage), potentialAcrIncreasePercent: pct(k.potential_aly_acr_increase),
        potentialAcrIncrease: text((k.potential_aly_acr_increase as { description?: unknown } | undefined)?.description),
      })) : [],
      diagnostics: plain(emq.diagnostics, 1) ?? [],
    } : null,
    additionalConversionsReported: plain(row.acr, 1) ?? null,
    potentialAdditionalConversions: plain(row.event_potential_aly_acr_increase, 1) ?? null,
    coverage: row.event_coverage ? { percent: pct(row.event_coverage), goalPercent: num((row.event_coverage as { goal_percentage?: unknown }).goal_percentage), description: text((row.event_coverage as { description?: unknown }).description) } : null,
    dedupKeys: dedupKeys(row),
    freshness: plain(row.data_freshness, 1) ?? null,
    spendCents: spendOf?.cents ?? null,
    spendCurrency: spendOf?.currency ?? null,
    adSets,
    valueDiagnostics: plain(row.value_diagnostics, 1) ?? null,
    delay: plain(row.event_delay, 1) ?? null,
  }
}

/** Totals per value of /stats over the window (7 days per request), and the hourly buckets (capped). */
async function statsOf(account: MetaChosenAccount, pixelId: string, query: Record<string, MetaQueryValue>, hours: number, now: Date, operation: string) {
  const totals = new Map<string, number>()
  const buckets: Array<{ startTime: string | null; aggregation: string | null; data: Array<{ value: string | null; count: number | null }> }> = []
  let more = false
  for (const window of statsWindows(hours, now)) {
    const read = await readRows(account.connectionId, operation, `${pixelId}/stats`, { ...query, start_time: window.start, end_time: window.end }, 400)
    more = more || read.more
    for (const result of read.rows) {
      const data = Array.isArray(result.data) ? result.data as Array<Record<string, unknown>> : []
      const values = data.map((d) => {
        const raw = typeof d.value === 'string' ? d.value : d.value === undefined || d.value === null ? (text(d.event) ?? null) : String(d.value)
        const value = query.aggregation === 'url' ? stripQuery(raw) : raw
        const count = num(d.count)
        if (value !== null && count !== null) totals.set(value, (totals.get(value) ?? 0) + count)
        return { value, count }
      })
      if (buckets.length < 200) buckets.push({ startTime: text(result.start_time), aggregation: text(result.aggregation), data: values.slice(0, 100) })
      else more = true
    }
  }
  return { totals: Object.fromEntries([...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 500)), buckets, more }
}

// ── the D2 check: who sends the events ───────────────────────────────────────────────────────────────────────────

export type YesNo = 'yes' | 'no' | 'unknown'

/**
 * The plain verdict of the D2 check for one event: browser and server counts (Meta's stats with event_source WEB_ONLY /
 * SERVER_ONLY) and the dedup keys (Dataset Quality API). Pure.
 */
export function sendersVerdict(input: { browserCount: number | null; serverCount: number | null; dedupKeys: ReturnType<typeof dedupKeys>; coveragePercent: number | null }) {
  const { browserCount, serverCount } = input
  const browser: YesNo = browserCount === null ? 'unknown' : browserCount > 0 ? 'yes' : 'no'
  const server: YesNo = serverCount === null ? 'unknown' : serverCount > 0 ? 'yes' : 'no'
  // "no" only when the event reached Meta from one side and not from the other: no event at all, or one side unread,
  // says nothing about who would send one (no sale in the window, or nobody sends it).
  const nothing = browserCount === 0 && serverCount === 0
  const both: YesNo = browser === 'yes' && server === 'yes' ? 'yes' : (browser === 'yes' && server === 'no') || (browser === 'no' && server === 'yes') ? 'no' : 'unknown'
  const eventId = input.dedupKeys.find((k) => k.key === 'event_id')
  const anyDeduped = input.dedupKeys.some((k) => (k.browserEventsDedupedPercent ?? 0) > 0)
  const deduplicated: YesNo = both !== 'yes' ? 'unknown' : input.dedupKeys.length === 0 ? 'unknown' : anyDeduped ? 'yes' : 'no'
  const gap = nothing ? 'unknown'
    : both === 'yes' ? (deduplicated === 'no' ? 'dedup' : deduplicated === 'yes' ? 'none' : 'unknown')
      : server === 'no' && browser === 'yes' ? 'server'
        : browser === 'no' && server === 'yes' ? 'browser'
          : 'unknown'
  return {
    browser, server, both, deduplicated, gap,
    eventIdOnBrowserPercent: eventId?.browserEventsWithKeyPercent ?? null,
    eventIdOnServerPercent: eventId?.serverEventsWithKeyPercent ?? null,
    serverCoveragePercent: input.coveragePercent,
  }
}

const GAP_WORDS: Record<string, string> = {
  none: 'No gap: the event reaches Meta from the browser AND from a server, and Meta deduplicates them. Nexus sending it too would add nothing (upload-meta-events stays off).',
  dedup: 'Both send it, but Meta reports no deduplication: the same purchase may be counted twice. Fix the sender\'s event_id (the shop platform\'s pixel and Conversions API must share it); Nexus sending more would not help.',
  server: 'Only the browser pixel sends it: no server copy (Conversions API) reached Meta in the window. This is the gap Nexus could fill (upload-meta-events, with the same event_id as the browser event), after the Owner\'s word.',
  browser: 'Only a server sends it: the browser pixel did not send it in the window. Check the pixel on the shop (the shop platform\'s Meta app); Nexus does not send browser events.',
  unknown: 'Unknown: Meta\'s answer does not settle it (no such event in the window, or a part of the read was refused — see each part). Widen hours (up to 672) or check the parts below.',
}

/** The D2 view: for one pixel and one event (Purchase by default), who sends it and whether Meta deduplicates it. */
async function sourcesView(account: MetaChosenAccount, pixelId: string, input: { event: string; hours: number; agentName: string | null; now: Date }) {
  const { event, hours, agentName, now } = input
  const [browser, server, bySource, quality, partnerQuality, pixel, gateways, accounts] = await Promise.all([
    part(() => statsOf(account, pixelId, { aggregation: 'event', event_source: 'WEB_ONLY' }, hours, now, 'datasets.sources.web')),
    part(() => statsOf(account, pixelId, { aggregation: 'event', event_source: 'SERVER_ONLY' }, hours, now, 'datasets.sources.server')),
    // Meta documents `event` only for the custom_data_field aggregation: the source labels are for every event.
    part(() => statsOf(account, pixelId, { aggregation: 'event_source' }, hours, now, 'datasets.sources.bySource')),
    part(() => datasetQuality(account, pixelId, 'web', SOURCES_WEB_FIELDS, null, 'datasets.sources.quality')),
    agentName ? part(() => datasetQuality(account, pixelId, 'web', SOURCES_WEB_FIELDS, agentName, 'datasets.sources.partner')) : Promise.resolve(null),
    part(async () => (await metaReadOne({ connectionId: account.connectionId }, { operation: 'datasets.sources.pixel', path: pixelId, query: { fields: 'last_fired_time,last_upload_app,last_upload_app_changed_time' } })).body as Record<string, unknown>),
    part(async () => (await readRows(account.connectionId, 'datasets.sources.gateway', `${pixelId}/openbridge_configurations`, { fields: 'id,active,partner_name,capi_publishing_state' }, 20)).rows),
    part(() => pixelAccounts(account, pixelId, 200)),
  ])
  const refused = (v: unknown): v is { refused: string } => !!v && typeof v === 'object' && 'refused' in (v as object)
  const count = (v: typeof browser) => (refused(v) ? null : v.totals[event] ?? 0)
  const eventRow = refused(quality) ? undefined : quality.find((r) => r.event_name === event)
  const partnerRow = partnerQuality && !refused(partnerQuality) ? partnerQuality.find((r) => r.event_name === event) : undefined
  const keys = dedupKeys(eventRow)
  const verdict = sendersVerdict({ browserCount: count(browser), serverCount: count(server), dedupKeys: keys, coveragePercent: eventRow ? pct(eventRow.event_coverage) : null })
  const both = verdict.both === 'yes' ? `yes — ${event} reached this pixel from the browser AND from a server`
    : verdict.both === 'no' ? `no — ${event} reached this pixel only from ${verdict.browser === 'yes' ? 'the browser' : verdict.server === 'yes' ? 'a server' : 'neither side'}`
      : 'unknown'
  return {
    pixelId, event, hours,
    answer: {
      browserAndServer: verdict.both,
      sentence: `Does ${event} come from the browser AND a server? ${both}. ${GAP_WORDS[verdict.gap]}`,
      ...verdict,
      gapWords: GAP_WORDS[verdict.gap],
    },
    counts: {
      browser: refused(browser) ? browser : { [event]: count(browser), allEvents: browser.totals },
      server: refused(server) ? server : { [event]: count(server), allEvents: server.totals },
      bySource: refused(bySource) ? bySource : { totals: bySource.totals, note: 'Every event of the pixel per source, under Meta\'s own labels (stats aggregation event_source; Meta does not document the labels).' },
    },
    deduplication: { keys, coveragePercent: verdict.serverCoveragePercent, coverageGoalPercent: eventRow?.event_coverage ? num((eventRow.event_coverage as { goal_percentage?: unknown }).goal_percentage) : null, matchQualityScore: eventRow ? num((eventRow.event_match_quality as { composite_score?: unknown } | undefined)?.composite_score) : null, freshness: plain(eventRow?.data_freshness, 1) ?? null, ...(refused(quality) ? { refused: quality.refused } : {}) },
    integrations: {
      partnerAgent: agentName ? {
        agentName,
        sendsThisEventByServer: refused(partnerQuality) ? 'unknown' : partnerRow ? 'yes' : 'not-seen',
        words: refused(partnerQuality) ? partnerQuality!.refused
          : partnerRow ? `Meta has ${event} server events sent with partner_agent "${agentName}" (Dataset Quality API filtered by agent_name).`
            : `Meta shows no ${event} server event sent with partner_agent "${agentName}" — that partner does not send it, or uses another partner_agent name (Meta documents no list of names).`,
      } : null,
      lastUploadApp: refused(pixel) ? pixel : { app: text(pixel.last_upload_app), changedTime: num(pixel.last_upload_app_changed_time), lastFiredTime: text(pixel.last_fired_time) },
      conversionsApiGateway: refused(gateways) ? gateways : gateways.map((g) => ({ id: idText(g.id), active: bool(g.active), partnerName: text(g.partner_name), publishingState: text(g.capi_publishing_state) })),
      alsoOnAnotherBusinessesAdAccount: refused(accounts) ? null : accounts.usedByAnotherBusiness,
    },
    metaDoesNotGive: [
      'which app or partner sent each BROWSER event (Meta reports only browser vs server, and its own source labels)',
      'a list of the partner_agent names that sent server events (only a filter by a name you know: agentName)',
      'the shop platform\'s own partner_agent name (not documented by Meta)',
      'how many purchases were sent twice or deduplicated as a count — only the percentages of events carrying each key and of browser events deduplicated',
    ],
    note: `Counts are Meta's, over the last ${hours} hours (7 days per request). ${refused(accounts) ? '' : accounts.usedByAnotherBusiness ? 'This pixel is also connected to an ad account another business in Nexus uses: its events can mix both businesses\' sales. ' : ''}Nexus sends no event itself until upload-meta-events (step 33) is switched on by the Owner.`,
  }
}

// ── the views ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DatasetsInput {
  connectionId?: string | null
  view: DatasetView
  pixelId?: string | null
  list?: (typeof PORTFOLIO_LISTS)[number] | null
  search?: string | null
  aggregation?: string | null
  event?: string | null
  eventSource?: string | null
  agentName?: string | null
  hours?: number | null
  check?: string | null
  domains?: string[] | null
  lookbackSeconds?: number | null
  filterType?: string | null
  filter?: string | null
  catalogId?: string | null
  actionSource?: string | null
  currentDomain?: string | null
  scope?: string | null
  customConversionId?: string | null
  conversionAggregation?: string | null
  uploadTag?: string | null
  sortBy?: string | null
  order?: 'ASCENDING' | 'DESCENDING' | null
  maxRows?: number
  now?: Date
}

const PORTFOLIO_EDGES: Record<(typeof PORTFOLIO_LISTS)[number], string> = { all: 'adspixels', owned: 'owned_pixels', client: 'client_pixels', pending: 'pending_shared_pixels' }
/** At most this many pixels of the portfolio (not on the chosen ad account) are checked against the other businesses. */
const MAX_TAKEN_CHECKS = 10
/** At most this many unknown ad sets of the quality view are checked with a live read. */
const MAX_ADSET_CHECKS = 10

/** One view of meta-datasets. */
export async function datasetsView(input: DatasetsInput) {
  const account = await metaChosenAccount(input.connectionId)
  const { connectionId, adAccountId } = account
  const maxRows = Math.min(500, Math.max(1, input.maxRows ?? 200))
  const now = input.now ?? new Date()
  const hours = Math.min(MAX_STATS_HOURS, Math.max(1, Math.trunc(input.hours ?? 168)))
  const base = { adAccountId }
  const agentName = input.agentName ?? null
  const pixel = () => ownPixel(account, input.pixelId)

  switch (input.view) {
    case 'list': {
      // SG-001 — the chosen ad account's pixels (datasets).
      const read = await readRows(connectionId, 'datasets.list', `${act(adAccountId)}/adspixels`, { fields: PIXEL_LIST_FIELDS, summary: 'total_count' }, maxRows)
      return {
        ...base, view: 'list', items: read.rows.map((r) => pixelRow(r, PIXEL_ROW_KEYS, account, true)).filter((r) => r.pixelId), more: read.more,
        note: 'The pixels (datasets) on the ad account this business chose — Meta keeps pixels on ad accounts. A pixel another business in Nexus also uses shows in view access (alsoOnAnotherBusinessesAdAccount).',
      }
    }
    case 'portfolio': {
      // SG-002 / SG-003 — the business portfolio's pixels: all, owned, client, or shared and waiting for acceptance.
      const businessId = account.businessId ?? refuse('The chosen ad account belongs to no business portfolio Nexus knows (meta-ad-accounts list chosen shows it).')
      const list = input.list ?? 'all'
      const search = input.search?.trim() || null
      if (search && list !== 'all') refuse('Meta searches pixel names only in the portfolio\'s whole list (list all).')
      const read = await readRows(connectionId, `datasets.portfolio.${list}`, `${businessId}/${PORTFOLIO_EDGES[list]}`, { fields: list === 'client' ? `${PIXEL_LIST_FIELDS},permitted_tasks` : PIXEL_LIST_FIELDS, summary: 'total_count', ...(search ? { name_filter: search } : {}) }, maxRows)
      const chosen = new Set(await chosenPixelIds(account))
      let checks = MAX_TAKEN_CHECKS
      const items: unknown[] = []
      for (const r of read.rows) {
        const id = idText(r.id)
        if (!id) continue
        if (chosen.has(id)) { items.push(pixelRow(r, PIXEL_ROW_KEYS, account, true)); continue }
        // Not on the chosen ad account: its id only — and the flag when it is connected to an ad account another
        // business in Nexus uses (shared_accounts inside this portfolio; a check per pixel, at most MAX_TAKEN_CHECKS).
        if (checks <= 0) { items.push({ pixelId: id, onChosenAdAccount: false, checked: false }); continue }
        checks--
        const accounts = await part(() => pixelAccounts(account, id, 200))
        if ('refused' in accounts) items.push({ pixelId: id, onChosenAdAccount: false, checked: false })
        else if (accounts.usedByAnotherBusiness) items.push({ pixelId: id, takenByAnotherBusiness: true })
        else items.push({ pixelId: id, onChosenAdAccount: false, checked: true })
      }
      return {
        ...base, view: 'portfolio', businessId, list, items, more: read.more,
        note: 'Pixels of the business portfolio. Only those on the ad account this business chose are shown in full; any other is its id (another business in Nexus may use it: takenByAnotherBusiness when Nexus could see that). To use one, connect it to the chosen ad account in Meta\'s Events Manager. list pending: pixels another business shared that wait for acceptance (accepting is Meta\'s screens).',
      }
    }
    case 'detail': {
      // SG-004 / SG-005 / AU-020 — settings, the base code (to check the shop installs it) and the audiences built on it.
      const pixelId = await pixel()
      const read = await metaReadOne({ connectionId }, { operation: 'datasets.detail', path: pixelId, query: { fields: PIXEL_DETAIL_FIELDS } })
      const audiences = await part(async () => {
        const rows = await readRows(connectionId, 'datasets.audiences', `${pixelId}/audiences`, { fields: AUDIENCE_OF_PIXEL_FIELDS, ad_account: adAccountId }, maxRows, 50)
        return rows.rows.map((r) => {
          const row = audienceRow(r, adAccountId, new Set())
          return { audienceId: row.audienceId, name: row.name, subtype: row.subtype, size: row.size, sizeNote: row.sizeNote, delivery: row.delivery, operation: row.operation, retentionDays: row.retentionDays }
        })
      })
      return {
        ...base, view: 'detail', pixel: pixelRow(read.body as Record<string, unknown>, PIXEL_DETAIL_KEYS, account, true), audiences,
        note: 'code is the pixel base code to compare with what the shop has installed (the shop platform\'s Meta app installs its own; Nexus never writes theme code). audiences: the chosen ad account\'s audiences built on this pixel (meta-audiences reads each).',
      }
    }
    case 'access': {
      // SG-020 / SG-023 / SG-025 — the ad accounts it is connected to, partner businesses, people and system users.
      const pixelId = await pixel()
      const people = account.businessId
        ? part(async () => (await readRows(connectionId, 'datasets.assignedUsers', `${pixelId}/assigned_users`, { business: account.businessId!, fields: 'id,name,user_type,tasks' }, maxRows)).rows.map((r) => pickRow(r, ['id', 'name', 'user_type', 'tasks'])))
        : Promise.resolve({ refused: 'The chosen ad account belongs to no business portfolio Nexus knows, and Meta lists a pixel\'s people per portfolio.' })
      const [accounts, sharedAgencies, agencies, users] = await Promise.all([
        part(() => pixelAccounts(account, pixelId, maxRows)),
        part(async () => (await readRows(connectionId, 'datasets.sharedAgencies', `${pixelId}/shared_agencies`, { fields: 'id,name' }, maxRows)).rows.map((r) => pickRow(r, ['id', 'name']))),
        part(async () => (await readRows(connectionId, 'datasets.agencies', `${pixelId}/agencies`, { fields: 'id,name' }, maxRows)).rows.map((r) => pickRow(r, ['id', 'name']))),
        people,
      ])
      return {
        ...base, view: 'access', pixelId, adAccounts: accounts, partnerBusinesses: { sharedAgencies, agencies }, people: users,
        alsoOnAnotherBusinessesAdAccount: 'refused' in accounts ? null : accounts.usedByAnotherBusiness,
        note: 'Who may use this pixel: the portfolio\'s ad accounts it is connected to (one another business in Nexus uses is its id only — then its events can mix both businesses\' sales), partner businesses it is shared with, and the people and system users assigned to it with their tasks.',
      }
    }
    case 'stats': {
      // SG-030 — event volume, broken down as asked (hourly buckets; totals per value over the window).
      const pixelId = await pixel()
      const aggregation = input.aggregation ?? 'event'
      if (aggregation === 'custom_data_field' && !input.event) refuse('aggregation custom_data_field counts the custom data of one event: name it (event).')
      const result = await statsOf(account, pixelId, {
        aggregation, ...(input.event ? { event: input.event } : {}), ...(input.eventSource ? { event_source: input.eventSource } : {}), ...(agentName ? { agent: agentName } : {}),
      }, hours, now, 'datasets.stats')
      return {
        ...base, view: 'stats', pixelId, aggregation, hours, ...(input.eventSource ? { eventSource: input.eventSource } : {}), ...(agentName ? { agentName } : {}),
        totals: result.totals, buckets: result.buckets, more: result.more,
        note: 'Meta\'s counts per hour (buckets) and summed over the window (totals), read 7 days at a time. eventSource SERVER_ONLY = sent by a server (the Conversions API), WEB_ONLY = the browser pixel. Meta strips query strings from URLs.',
      }
    }
    case 'sources': {
      const pixelId = await pixel()
      return { ...base, view: 'sources', ...(await sourcesView(account, pixelId, { event: input.event ?? 'Purchase', hours, agentName, now })) }
    }
    case 'quality': {
      // SG-045 … SG-055 — Event Match Quality and the rest of the Dataset Quality API, per event.
      const pixelId = await pixel()
      const rows = await datasetQuality(account, pixelId, 'web', QUALITY_WEB_FIELDS, agentName, 'datasets.quality')
      const checks = { left: MAX_ADSET_CHECKS }
      const events = []
      for (const row of rows.slice(0, 100)) {
        if (input.event && row.event_name !== input.event) continue
        events.push(await qualityEvent(account, row, checks))
      }
      return {
        ...base, view: 'quality', pixelId, ...(agentName ? { agentName } : {}), events,
        note: `Meta's Dataset Quality API (web events; real time, coverage a 7-day average): matchQuality.score out of 10 (Meta suggests 6 or more), its match keys and what to fix (diagnostics), additional conversions the Conversions API adds, coverage (share of browser events also sent by a server, against Meta's goal), dedupKeys, freshness, the ad spend tied to each event and the ad sets that use it (another account's ad set: its id only), value and currency problems, and how late events arrive. ${agentName ? `Only events sent with partner_agent "${agentName}".` : 'Every sender (agentName narrows it to one partner_agent; Nexus sends no event itself yet).'}`,
      }
    }
    case 'quality-offline': {
      // SG-056 — offline (physical store) events: data quality score, match keys, frequency, freshness (beta at Meta).
      const pixelId = await pixel()
      const rows = await datasetQuality(account, pixelId, 'offline', OFFLINE_FIELDS, agentName, 'datasets.qualityOffline')
      return {
        ...base, view: 'quality-offline', pixelId, events: rows.slice(0, 100).map((r) => pickRow(r, ['event_name', 'composite', 'match_key', 'frequency', 'freshness'])),
        note: 'Meta\'s data quality score for offline events (scores out of 10 over 28 days; 8.5 or more opens omnichannel ads; Meta calls it beta). CRM (conversion leads) quality: Meta\'s page for it does not open, so Nexus does not ask for it.',
      }
    }
    case 'quality-legacy': {
      // SG-036 — the older setup_quality / integration_quality edges (Meta: the Dataset Quality API replaced them).
      const pixelId = await pixel()
      const [setup, integration] = await Promise.all([
        part(async () => (await readRows(connectionId, 'datasets.setupQuality', `${pixelId}/setup_quality`, { fields: LEGACY_QUALITY_FIELDS, ...(agentName ? { agent_name: agentName } : {}) }, 100)).rows.map((r) => plain(r, 1))),
        part(async () => (await readRows(connectionId, 'datasets.integrationQuality', `${pixelId}/integration_quality`, { fields: LEGACY_QUALITY_FIELDS, ...(agentName ? { agent_name: agentName } : {}) }, 100)).rows.map((r) => plain(r, 1))),
      ])
      return { ...base, view: 'quality-legacy', pixelId, setupQuality: setup, integrationQuality: integration, note: 'The older quality edges ("based on previous events sent by the calling Partner"); Meta\'s Dataset Quality API (view quality) replaced them.' }
    }
    case 'diagnostics': {
      const pixelId = await pixel()
      const check = (input.check ?? 'issues') as (typeof DIAGNOSTIC_CHECKS)[number]
      const spec = DIAGNOSTIC_FIELDS[check] ?? refuse(`check is one of ${DIAGNOSTIC_CHECKS.join(', ')}.`)
      const query: Record<string, MetaQueryValue> = { fields: spec.fields }
      if (check === 'issues') query.ad_account_id = adAccountId
      if (check === 'events-last-fired' && input.event) query.event = input.event
      if (check === 'domains-last-fired') {
        if (!input.domains?.length) refuse('check domains-last-fired needs the domains (domains: the shop\'s host names).')
        query.domain_name_list = input.domains
      }
      if (check === 'recent-events' || check === 'raw-fires') {
        if (!input.event) refuse(`check ${check} needs the event (e.g. Purchase).`)
        query.event = input.event
      }
      if (check === 'recent-events') query.lookback_window = Math.min(7 * 24 * 3600, Math.max(60, Math.trunc(input.lookbackSeconds ?? 24 * 3600)))
      if (check === 'raw-fires' && input.filterType) {
        if (!input.filter) refuse('filterType goes with the value to filter on (filter).')
        query.filter_type = input.filterType
        query.filter = input.filter
      }
      if (check === 'event-log') {
        const [window] = statsWindows(Math.min(hours, 168), now).slice(-1)
        query.start_time = window.start
        query.end_time = window.end
      }
      if (check === 'microdata') query.catalog_id = input.catalogId ? (metaObjectId(input.catalogId) ?? refuse('catalogId is digits.')) : refuse('check microdata compares the pixel with a catalog: name it (catalogId).')
      if (check === 'collaborative-ads' && input.actionSource) query.action_source = input.actionSource
      const keys = spec.fields.split(',')
      const read = await readRows(connectionId, `datasets.diagnostics.${check}`, `${pixelId}/${spec.edge}`, query, maxRows)
      return {
        ...base, view: 'diagnostics', check, pixelId,
        items: read.rows.map((r) => {
          const row = pickRow(r, keys)
          for (const key of URL_KEYS) if (typeof r[key] === 'string') row[key === 'url' ? 'url' : 'placedUrl'] = stripQuery(r[key])
          if (Array.isArray(r.sample_urls)) row.sampleUrls = r.sample_urls.map(stripQuery)
          return row
        }),
        more: read.more,
        note: DIAGNOSTIC_NOTES[check],
      }
    }
    case 'gateway': {
      // SG-040 / SG-082 — the Conversions API Gateway: the dataset's cloud bridge status and gateway configurations.
      const pixelId = await pixel()
      const businessId = account.businessId
      const [status, configs, portfolio] = await Promise.all([
        part(async () => (await readRows(connectionId, 'datasets.cloudbridge', `${pixelId}/cloudbridge_dataset_status`, { fields: CLOUDBRIDGE_FIELDS }, 20)).rows.map((r) => pickRow(r, CLOUDBRIDGE_FIELDS.split(',')))),
        part(async () => (await readRows(connectionId, 'datasets.openbridge', `${pixelId}/openbridge_configurations`, { fields: OPENBRIDGE_FIELDS }, 50)).rows.map((r) => pickRow(r, OPENBRIDGE_FIELDS.split(',')))),
        businessId
          ? part(async () => {
            const read = await readRows(connectionId, 'datasets.openbridgePortfolio', `${businessId}/openbridge_configurations`, { fields: OPENBRIDGE_FIELDS }, 100)
            const chosen = new Set(await chosenPixelIds(account))
            // A gateway set up for a pixel that is not on the chosen ad account: its id and pixel id only.
            return read.rows.map((r) => (chosen.has(idText(r.pixel_id) ?? '') ? pickRow(r, OPENBRIDGE_FIELDS.split(',')) : { id: idText(r.id), pixelId: idText(r.pixel_id), onChosenAdAccount: false }))
          })
          : Promise.resolve({ refused: 'The chosen ad account belongs to no business portfolio Nexus knows.' }),
      ])
      return {
        ...base, view: 'gateway', pixelId, cloudBridgeStatus: status, gatewayConfigurations: configs, portfolioGatewayConfigurations: portfolio,
        note: 'The Conversions API Gateway relays server events from a gateway host (set up there, not here). An active configuration with a partner name means that partner sends this pixel\'s server events through a gateway.',
      }
    }
    case 'custom-conversions': return customConversionsView(account, input, maxRows, hours, now)
    case 'event-setup': {
      // SG-097 / SG-101 — event rules (button / URL rules that fire events) and parameter extractors.
      const pixelId = await pixel()
      const domain = input.currentDomain?.trim() || null
      if (domain && !/^https?:\/\/[a-z0-9.-]{1,253}(\/[^\s?#]{0,200})?$/i.test(domain)) refuse('currentDomain is a web address (https://shop.example).')
      const [rules, extractors] = await Promise.all([
        part(async () => (await readRows(connectionId, 'datasets.eventRules', `${pixelId}/event_rules`, { fields: EVENT_RULE_FIELDS }, maxRows)).rows.map((r) => {
          const row = pickRow(r, EVENT_RULE_FIELDS.split(',').filter((k) => k !== 'sample_urls'))
          return { ...row, sampleUrls: Array.isArray(r.sample_urls) ? r.sample_urls.slice(0, 20).map(stripQuery) : [] }
        })),
        part(async () => (await readRows(connectionId, 'datasets.extractors', `${pixelId}/extractors`, { fields: EXTRACTOR_FIELDS, ...(domain ? { current_domain: domain } : {}) }, maxRows)).rows.map((r) => pickRow(r, EXTRACTOR_FIELDS.split(',')))),
      ])
      return {
        ...base, view: 'event-setup', pixelId, eventRules: rules, parameterExtractors: extractors,
        note: 'Events set up in Meta\'s event setup tool (rules that fire an event on a button or URL) and the parameters each reads from the page (value, currency, content_ids). Meta\'s public API can read them but not create, change or delete them: Meta\'s own MCP or Events Manager does that.',
      }
    }
    case 'legacy-offline': {
      // SG-043 / SG-115 — legacy offline event uploads and offline event sets (Meta merged offline sets into datasets).
      const pixelId = input.pixelId ? await pixel() : null
      const sortBy = input.sortBy && (UPLOAD_SORTS as readonly string[]).includes(input.sortBy) ? input.sortBy : null
      const window = input.hours ? statsWindows(hours, now) : null
      const uploads = pixelId
        ? part(async () => (await readRows(connectionId, 'datasets.offlineUploads', `${pixelId}/offline_event_uploads`, {
          fields: UPLOAD_FIELDS, ...(sortBy ? { sort_by: sortBy } : {}), ...(input.order ? { order: input.order } : {}), ...(input.uploadTag ? { upload_tag: input.uploadTag } : {}),
          ...(window ? { start_time: window[0].start, end_time: window[window.length - 1].end } : {}),
        }, maxRows)).rows.map((r) => pickRow(r, UPLOAD_FIELDS.split(','))))
        : Promise.resolve(null)
      const businessId = account.businessId
      const [uploadRows, accountSets, portfolioSets] = await Promise.all([
        uploads,
        part(async () => (await readRows(connectionId, 'datasets.offlineSets', `${act(adAccountId)}/offline_conversion_data_sets`, { fields: `${OFFLINE_SET_FIELDS},auto_track_for_ads` }, maxRows)).rows.map((r) => pickRow(r, [...OFFLINE_SET_FIELDS.split(','), 'auto_track_for_ads']))),
        businessId
          ? part(async () => {
            const read = await readRows(connectionId, 'datasets.offlineSetsPortfolio', `${businessId}/offline_conversion_data_sets`, { fields: `${OFFLINE_SET_FIELDS},access_type,permitted_roles,is_assigned_to_ad_accounts_in_business` }, maxRows)
            const chosen = new Set(await chosenPixelIds(account))
            return read.rows.map((r) => (chosen.has(idText(r.id) ?? '') ? pickRow(r, [...OFFLINE_SET_FIELDS.split(','), 'access_type', 'permitted_roles', 'is_assigned_to_ad_accounts_in_business']) : { id: idText(r.id), onChosenAdAccount: false }))
          })
          : Promise.resolve({ refused: 'The chosen ad account belongs to no business portfolio Nexus knows.' }),
      ])
      return {
        ...base, view: 'legacy-offline', ...(pixelId ? { pixelId, uploads: uploadRows } : {}), accountOfflineSets: accountSets, portfolioOfflineSets: portfolioSets,
        note: 'Meta\'s legacy Offline Conversions API: offline event sets are merged into datasets, and offline events now go to the dataset itself (Conversions API, action_source physical_store). Meta may refuse these edges as a deprecated version (2635): then nothing of this kind is left to read.',
      }
    }
  }
}

const DIAGNOSTIC_NOTES: Record<(typeof DIAGNOSTIC_CHECKS)[number], string> = {
  issues: 'Meta\'s diagnostics for this pixel as seen by the chosen ad account (Events Manager "Diagnostics"): the kind of problem, the event, and traffic drops.',
  'events-last-fired': 'When each event last reached the pixel (Unix seconds).',
  'domains-last-fired': 'When the pixel last fired on each domain asked (Unix seconds).',
  'recent-events': 'How many of this event reached the pixel in the look-back window.',
  'event-log': 'Meta\'s real-time log of pixel fires — Meta answers it for the signed-in person\'s own fires, so a system user may see none. Page addresses without their query; Meta\'s raw event body is never read.',
  'raw-fires': 'Recent raw fires of one event: source (event_src), detection method, device, page address (without its query) and which customer-information KEYS were sent (never their values; Meta\'s raw event body is never read).',
  'delivery-recommendations': 'Meta\'s suggested optimisation goal per event for this pixel.',
  'item-prices': 'How many events carried an item price, per day (catalog matching).',
  microdata: 'The page microdata the pixel saw compared with the catalog named (allowed and suggested domains, errors).',
  'collaborative-ads': 'Collaborative ads: counts per event and diagnostic for recent days (Nexus runs no collaborative ads).',
}

async function customConversionsView(account: MetaChosenAccount, input: DatasetsInput, maxRows: number, hours: number, now: Date) {
  const { connectionId, adAccountId, currency } = account
  const scope = (input.scope ?? (input.customConversionId ? 'one' : 'account')) as (typeof CONVERSION_SCOPES)[number]
  const row = (r: Record<string, unknown>) => {
    const value = currencyCents(r.default_conversion_value, currency)
    return {
      customConversionId: idText(r.id), name: text(r.name), description: text(r.description), customEventType: text(r.custom_event_type), eventSourceType: text(r.event_source_type),
      rule: text(r.rule), pixelId: idOf(r.pixel), dataSources: plain(r.data_sources, 1) ?? null, defaultValueCents: value.cents, isArchived: bool(r.is_archived),
      isUnavailable: bool(r.is_unavailable), retentionDays: num(r.retention_days), firstFiredTime: text(r.first_fired_time), lastFiredTime: text(r.last_fired_time), createdTime: text(r.creation_time),
    }
  }
  const RULE_NOTE = 'A custom conversion\'s rule cannot change after it is made (only its name, description and default value can): a different rule is a new custom conversion. isUnavailable: Meta flagged it (an appeal is Meta\'s screens only).'
  const own = async () => {
    const id = metaObjectId(input.customConversionId ?? '') ?? refuse('Name the custom conversion (customConversionId from scope account).')
    const check = await metaReadOne({ connectionId }, { operation: 'datasets.conversionOwner', path: id, query: { fields: 'account_id' } })
    if (metaAdAccountId((check.body as { account_id?: unknown }).account_id) !== adAccountId) refuse('That custom conversion is not the chosen ad account\'s, so it is not read.')
    return id
  }
  switch (scope) {
    case 'account': {
      // SG-085 — every custom conversion of the chosen ad account, with Meta's 100-per-account count.
      const read = await readRows(connectionId, 'datasets.conversions', `${act(adAccountId)}/customconversions`, { fields: CONVERSION_FIELDS }, Math.max(maxRows, 200))
      const items = read.rows.map(row).filter((r) => r.customConversionId)
      const notArchived = items.filter((r) => r.isArchived !== true).length
      return {
        ...baseOf(adAccountId), view: 'custom-conversions', scope, items: items.slice(0, maxRows), more: read.more || items.length > maxRows,
        count: { total: items.length, notArchived, limitPerAdAccount: CUSTOM_CONVERSION_LIMIT, left: Math.max(0, CUSTOM_CONVERSION_LIMIT - items.length), complete: !read.more },
        note: `Meta allows at most ${CUSTOM_CONVERSION_LIMIT} custom conversions per ad account (left counts every one Meta lists; whether archived ones count is not documented). ${RULE_NOTE}`,
      }
    }
    case 'business': {
      // SG-086 — the business portfolio's custom conversions (another ad account's: its id and its account only).
      const businessId = account.businessId ?? refuse('The chosen ad account belongs to no business portfolio Nexus knows.')
      const mask = async (rows: Record<string, unknown>[]) => {
        const accounts = rows.map((r) => metaAdAccountId(r.account_id)).filter((id): id is string => !!id && id !== adAccountId)
        const taken = await takenIds('AD_ACCOUNT', accounts)
        return rows.map((r) => {
          const owner = metaAdAccountId(r.account_id)
          if (owner === adAccountId) return row(r)
          return owner && taken.has(owner)
            ? { customConversionId: idText(r.id), adAccountId: owner, takenByAnotherBusiness: true }
            : { customConversionId: idText(r.id), adAccountId: owner, onChosenAdAccount: false }
        })
      }
      const [all, owned] = await Promise.all([
        part(async () => mask((await readRows(connectionId, 'datasets.conversionsPortfolio', `${businessId}/customconversions`, { fields: CONVERSION_FIELDS, include_archived: true, summary: 'total_count' }, maxRows)).rows)),
        part(async () => mask((await readRows(connectionId, 'datasets.conversionsOwned', `${businessId}/owned_custom_conversions`, { fields: CONVERSION_FIELDS }, maxRows)).rows)),
      ])
      return { ...baseOf(adAccountId), view: 'custom-conversions', scope, businessId, all, owned, note: `The portfolio's custom conversions: those of the chosen ad account in full, any other by its id and its ad account (another business's: the flag only). ${RULE_NOTE}` }
    }
    case 'dataset': {
      // SG-087 — the custom conversions built on one pixel (of the chosen ad account).
      const pixelId = await ownPixel(account, input.pixelId)
      const read = await readRows(connectionId, 'datasets.conversionsOfPixel', `${pixelId}/customconversions`, { fields: CONVERSION_FIELDS, ad_account: adAccountId }, maxRows)
      return { ...baseOf(adAccountId), view: 'custom-conversions', scope, pixelId, items: read.rows.filter((r) => metaAdAccountId(r.account_id) === adAccountId).map(row), more: read.more, note: RULE_NOTE }
    }
    case 'one': {
      // SG-088 — one custom conversion of the chosen ad account.
      const id = await own()
      const read = await metaReadOne({ connectionId }, { operation: 'datasets.conversion', path: id, query: { fields: CONVERSION_FIELDS } })
      return { ...baseOf(adAccountId), view: 'custom-conversions', scope, customConversion: row(read.body as Record<string, unknown>), note: RULE_NOTE }
    }
    case 'stats': {
      // SG-089 — a custom conversion's volume over time (SDK aggregations; product-id breakdowns are not supported).
      const id = await own()
      const aggregation = input.conversionAggregation ?? 'count'
      const results: unknown[] = []
      let more = false
      for (const window of statsWindows(hours, now)) {
        const read = await readRows(connectionId, 'datasets.conversionStats', `${id}/stats`, { aggregation, start_time: window.start, end_time: window.end }, 400)
        more = more || read.more
        results.push(...read.rows.map((r) => plain(r, 1)))
      }
      // Amount aggregations are money (US dollars, Meta's own conversion): a restricted key.
      const money = aggregation === 'usd_amount' || aggregation === 'unmatched_usd_amount'
      return {
        ...baseOf(adAccountId), view: 'custom-conversions', scope, customConversionId: id, aggregation, hours,
        ...(money ? { usdAmounts: results } : { buckets: results }), more,
        note: 'Meta\'s counts for this custom conversion over time, read 7 days at a time. usd_amount aggregations are Meta\'s amounts in US dollars.',
      }
    }
  }
}

const baseOf = (adAccountId: string) => ({ adAccountId })
