/**
 * Meta ads step 7 (2026-10-21) — the chosen ad account's NUMBERS read live from Meta's insights (meta-ads-numbers), the
 * background report runs (meta-ads-report) and the Ads Reporting artefacts (meta-ads-saved-reports). Nothing here stores
 * anything; nothing changes the account (a report run is a POST that only makes Meta compute a report: the gateway takes it
 * as a read, of the chosen ad account only — gateway/meta-calls.ts rule `insights.reportRun`, gateway.ts 3b).
 *
 * What step 2 already reads, and what this adds: meta-ads-live view insights reads spend, impressions, reach, clicks, link
 * clicks, frequency and purchases per level and day (archived and deleted objects included); meta-ads-overview the stored
 * days; meta-ad-details (step 6) the auction, overlap, fatigue and asset numbers of one object. meta-ads-numbers asks ANY
 * metric of Meta's v26 list (services/meta/meta-insights-lists.ts), every breakdown and action breakdown (their
 * combinations checked before the call, IN-047), attribution windows, every date preset, exact days, several periods and a
 * comparison computed by Nexus, rows per day / week / month, filters, one sort, Meta's own total row, the product
 * breakdown matched to Nexus SKUs, and which numbers Meta estimates.
 *
 * Only the business's chosen ad account and its own objects: a campaign, ad set or ad id a caller names (to read, or in a
 * filter) is checked to be the account's own and of that kind first (live.ts objectInAccount); a report run id too (its
 * account_id and the two fields only a report run has, services/meta/meta-kinds.ts); the business portfolio's reports only
 * when no other business in Nexus reads an ad account of that portfolio (taken.ts PORTFOLIO), and then only what names the
 * chosen account where Meta says which account a row is about.
 *
 * Meta facts (checked 2026-10-21 on developers.facebook.com/documentation/ads-commerce/marketing-api/…, `.md` pages, and
 * Meta's Python Business SDK facebook_business/adobjects/*.py; the lists and rules are in meta-insights-lists.ts):
 *   - reference/ad-account/insights — GET and POST, the parameters, the v26 fields; POST makes an AdReportRun
 *     (`{report_run_id}`); Meta documents the POST on the campaign and ad set insights edges too (ad-campaign-group/
 *     insights, ad-campaign/insights, best-practices "POST <AD_OBJECT>/insights") — Nexus sends it on the chosen account's
 *     path only, an object as a filter (one anchored path the gateway checks); errors 3018 (37 months), 2642, 105;
 *   - insights/best-practices — async jobs: poll `async_status` until "Job Completed" AND `async_percent_completion` 100,
 *     "Job Skipped" = expired (resubmit), the id expires after 30 days (never stored), a failed run carries error_code,
 *     error_message, error_subcode, error_user_title, error_user_msg since v25; results at GET /<run>/insights; the
 *     export_report convenience endpoint (www.facebook.com, "not part of our versioned Graph API … may change", it takes
 *     "Permissions granted by the logged-in user": a person signed in to Meta opens it); data-per-call 100/1487534;
 *   - insights/marketing-mix-modeling — mmm only as a CSV export (export_format=csv, level adset, impressions and spend),
 *     its file at the run's `async_report_url`, GET /<run>/insights no longer answers it, the MMM filters;
 *   - insights/error-codes — -2/2490547 report failed, -3/1504045 report too large, 2/1504041 invalid breakdowns,
 *     100/1504018 and 2/1504038 timeouts, 100/3191001 permission;
 *   - SDK adreportrun.py — AdReportRun fields (account_id, async_status, async_percent_completion, async_report_url,
 *     date_start, date_stop, time_ref, time_completed, is_running, is_async_export, error_*; `emails` is never asked);
 *   - reference/ad-account/ads_reporting_mmm_reports, ads_reporting_mmm_schedulers, ad_custom_derived_metrics, reporting,
 *     report_specs; reference/business/ads_reporting_mmm_reports, ads_reporting_mmm_schedulers, ads_reporting_exports,
 *     custom_pivots, ads_custom_pivots_preview, measurement_reports, third_party_partner_panel_requests,
 *     third_party_partner_panel_recurring_requests, third_party_partner_viewability_requests — each read only ("You can't
 *     perform this operation" for create, update, delete), node fields from the SDK (adsreportbuildermmmreport.py,
 *     adsreportbuildermmmreportscheduler.py, adsreportbuilderexportcore.py, adcustomderivedmetrics.py, adspivotrules.py,
 *     adscustompivotspreview.py, measurementreport.py, thirdpartypartnerpanelrequest.py, thirdpartypartnerpanelscheduled.py,
 *     thirdpartypartnerviewabilityrequest.py). Never asked: an export's async_report_url / link_sharing_uri and a
 *     measurement report's download_urls (links that may open without signing in), and people (creator, update_by).
 */
import prisma from '../../../db.js'
import { metaAdAccountId, metaObjectId } from '../../cx/connectors/meta/discovery.js'
import { metaReportRunCall, type MetaQueryValue } from '../../gateway/meta.js'
import type { GatewayResponse } from '../../gateway/gateway.js'
import { metaReadOne } from './read-client.js'
import { failureOfAnswer, failureOfThrow, MetaReadError } from './errors.js'
import { graphSafe, metaChosenAccount, MetaLiveRefusal, objectInAccount, objectKindOf, type MetaChosenAccount } from './live.js'
import { fieldRefused } from './live-objects.js'
import { insightStatusFilter } from './mappers.js'
import { currencyExponent, decimalToMicros, minorOf } from './money.js'
import { takenIds } from './taken.js'
import { accountToday, addDays, dayCount } from './dates.js'
import {
  ACTION_TYPES, ATTRIBUTION_WINDOWS, BREAKDOWNS_NOT_OFFERED, breakdownCombinationProblem, DATE_PRESETS, DC_ASSET_BREAKDOWNS, DC_ASSET_METRICS,
  DEAD_WINDOWS, DEFAULT_METRICS, FILTER_FIELDS, filterValueProblem, INSIGHT_LEVELS, LEVEL_IDENTITY, MAX_MONTHS_BACK, MAX_PERIODS,
  META_ACTION_BREAKDOWNS, META_INSIGHT_BREAKDOWNS, META_INSIGHT_METRICS, METRIC_GROUPS, MMM_FILTERS, MONEY_KINDS, REPORT_BUILDER_DIMENSIONS,
  REPORT_BUILDER_METRICS, REPORT_BUILDER_WINDOWS, SORTABLE_KINDS, TYPE2_ACTION_BREAKDOWNS, WINDOWS_NOT_OFFERED,
  hasKey, lookup, ownList, type InsightLevel, type MetricGroup, type MetricKind,
} from '../../meta/meta-insights-lists.js'
import { META_KIND_FIELDS, META_KIND_WORDS, withArticle } from '../../meta/meta-kinds.js'

type Row = Record<string, unknown>
const act = (id: string) => `act_${id}`
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)
const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : null }
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const rowsOf = (v: unknown): Row[] => (Array.isArray(v) ? v : Array.isArray(obj(v)?.data) ? obj(v)!.data as unknown[] : []).filter((r): r is Row => !!obj(r))

/** Meta's spec as it sent it, without paging links or tokens. */
const raw = (v: unknown): unknown => (v === undefined || v === null ? null : graphSafe(v))

// ── views and arguments ─────────────────────────────────────────────────────────────────────────────────────────────

export const NUMBERS_VIEWS = ['numbers', 'products', 'assets', 'hourly', 'catalogue', 'check', 'portfolio'] as const
export type NumbersView = typeof NUMBERS_VIEWS[number]
export const TIME_INCREMENTS = ['all_days', 'daily', 'weekly', 'monthly'] as const
export const COMPARES = ['previous-period', 'previous-year'] as const
export const SORT_ORDERS = ['descending', 'ascending'] as const
export const ATTRIBUTIONS = ['ad-set', 'account'] as const
/** The asset breakdowns view assets takes: Dynamic Creative assets and Advantage+ creative automation (IN-036, IN-037). */
export const ASSET_VIEW_BREAKDOWNS: readonly string[] = [...DC_ASSET_BREAKDOWNS, ...Object.entries(META_INSIGHT_BREAKDOWNS).filter(([, s]) => s.family === 'automation').map(([n]) => n)]
export const HOURLY_BREAKDOWNS = ['hourly_stats_aggregated_by_advertiser_time_zone', 'hourly_stats_aggregated_by_audience_time_zone'] as const

export const MAX_NUMBER_ROWS = 500
const PAGE_ROWS = 100
const MAX_FIELDS_TEXT = 3800
const MAX_ANSWER_CHARS = 350_000
/** Ids named in filters, each checked to be the account's own: at most this many in one read. */
const MAX_FILTER_IDS = 50

const PRODUCT_DEFAULTS = ['product_retailer_id', 'product_name', 'impressions', 'clicks', 'spend', 'actions', 'action_values', 'purchase_roas', 'converted_product_quantity', 'converted_product_value']
const HOURLY_DEFAULTS = ['impressions', 'clicks', 'inline_link_clicks', 'spend', 'ctr', 'cpc', 'cpm', 'actions', 'action_values']
const ASSET_DEFAULTS = [...DC_ASSET_METRICS]

export interface NumbersFilter { field: string; operator: string; value?: string | number | Array<string | number>; valueCents?: number }

export interface NumbersInput {
  connectionId?: string | null
  view: NumbersView
  level?: InsightLevel | null
  campaignId?: string | null
  adSetId?: string | null
  adId?: string | null
  metrics?: string[] | null
  groups?: MetricGroup[] | null
  breakdowns?: string[] | null
  assetBreakdown?: string | null
  audienceTime?: boolean
  actionBreakdowns?: string[] | null
  windows?: string[] | null
  attribution?: typeof ATTRIBUTIONS[number] | null
  datePreset?: string | null
  from?: string | null
  to?: string | null
  periods?: Array<{ from: string; to: string }> | null
  compare?: typeof COMPARES[number] | null
  timeIncrement?: typeof TIME_INCREMENTS[number] | number | null
  filters?: NumbersFilter[] | null
  onlyWithImpressions?: boolean
  minSpendCents?: number | null
  includeArchived?: boolean
  sortBy?: string | null
  sortAction?: string | null
  order?: typeof SORT_ORDERS[number] | null
  withTotal?: boolean
  productIdLimit?: number | null
  maxRows?: number | null
  after?: string | null
  /** The person may see ad spend: only then may a read sort or filter by an amount (the order or the cut would show it). */
  seesMoney: boolean
  /** meta-ads-report: the read goes on the account's path, its object as a filter. */
  asReportRun?: boolean
}

// ── words ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Placement words (IN-032, IN-086, IN-087, CR-242): Instagram feed / Explore / Reels / Stories, Threads feed. */
const PLACEMENT_WORDS: Readonly<Record<string, string>> = ownList<string>(Object.entries({
  feed: 'Feed', right_hand_column: 'Facebook right column', marketplace: 'Facebook Marketplace', video_feeds: 'Facebook video feeds',
  story: 'Facebook Stories', search: 'Facebook search results', instream_video: 'In-stream videos', facebook_reels: 'Facebook Reels',
  facebook_reels_overlay: 'Ads on Facebook Reels', profile_feed: 'Facebook profile feed', notification: 'Facebook notifications',
  instagram_stories: 'Instagram Stories', instagram_explore: 'Instagram Explore', instagram_explore_grid_home: 'Instagram Explore home',
  instagram_reels: 'Instagram Reels', instagram_profile_feed: 'Instagram profile feed', instagram_search: 'Instagram search results',
  ig_search: 'Instagram search results (video)', messenger_inbox: 'Messenger inbox', messenger_stories: 'Messenger Stories',
  an_classic: 'Audience Network', rewarded_video: 'Audience Network rewarded video', threads_feed: 'Threads feed',
}))

const FEATURE_NOTE = (name: string, feature: string) => `${name} may be switched off for this ad account: Meta then answers NOTHING, without an error (its insights feature "${feature}", since 2026-08-06) — no rows means switched off or no delivery, never 0. Whether it is on: meta-ad-account view insights-features (step 3); a person switches it on in Ads Manager. After that, a background report (meta-ads-report) returns its full history, min(10, number of ads) such runs per 24 hours (Meta's "ad groups" are ads).`
const TOO_MUCH = 'Meta could not answer this much at once. Ask fewer days, a lower level, fewer breakdowns or fewer metrics — or start the same read in the background: meta-ads-report action start with the same arguments (it may take up to an hour).'
export const PORTFOLIO_SENTENCE = 'Meta has no insights for a whole business portfolio (its marketing-mix-modeling page: "the Insights API works on the ad account level and below" — a portfolio is read account by account). Each business in Nexus reads its own chosen ad account only: meta-ads-numbers reads it; another ad account of the portfolio may be another business\'s, so Nexus never adds them up.'

// ── the plan of one read ────────────────────────────────────────────────────────────────────────────────────────────

export interface NumbersPlan {
  path: string
  objectKind: 'account' | 'campaign' | 'adset' | 'ad'
  objectId: string
  level: InsightLevel
  /** Fields on the v26 list (with each level's identity), and those only other Meta pages name (asked, then dropped when refused). */
  fields: string[]
  extras: string[]
  breakdowns: string[]
  actionBreakdowns: string[]
  query: Record<string, MetaQueryValue>
  periods: Array<{ from: string; to: string; label: string }> | null
  compare: typeof COMPARES[number] | null
  notes: string[]
  dropped: string[]
  estimated: string[]
  inDevelopment: string[]
  featureGated: string[]
}

const LEVEL_RANK = ownList<number>([['account', 0], ['campaign', 1], ['adset', 2], ['ad', 3]]) as Readonly<Record<InsightLevel, number>>
const KIND_WORD = ownList<string>([['account', 'the ad account'], ['campaign', 'campaign'], ['adset', 'ad set'], ['ad', 'ad']])

/** A day `months` calendar months before `day` (the 1st of a month never past its end). */
export function monthsBefore(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const total = y * 12 + (m - 1) - months
  const year = Math.floor(total / 12)
  const month = total % 12
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}

/** The earlier period of a comparison: the same number of days just before, or the same days a year before. */
export function comparisonPeriod(from: string, to: string, compare: typeof COMPARES[number]): { from: string; to: string } {
  if (compare === 'previous-period') {
    const days = dayCount({ from, to })
    return { from: addDays(from, -days), to: addDays(from, -1) }
  }
  return { from: monthsBefore(from, 12), to: monthsBefore(to, 12) }
}

const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v

/**
 * Ids named in filters: each checked to be the chosen account's own and of that kind (one stored-row lookup, else one
 * live read each), at most MAX_FILTER_IDS in one request (review A F5: the MMM export and the Report Builder too).
 */
function idBudget() {
  let used = 0
  return {
    async check(account: MetaChosenAccount, f: NumbersFilter, operation: string) {
      const spec = lookup(FILTER_FIELDS, f.field)
      if (spec?.value !== 'ids') return
      const ids = (Array.isArray(f.value) ? f.value : [f.value]) as string[]
      used += ids.length
      if (used > MAX_FILTER_IDS) throw new MetaLiveRefusal(`At most ${MAX_FILTER_IDS} ids in the filters of one read (each is checked to be this ad account's own).`)
      for (const id of ids) await objectInAccount(account, id, spec.kind!, operation)
    },
  }
}

/** One metric name from a caller: on the list, else refused with the nearest reason. */
function metricOk(name: string): void {
  if (hasKey(META_INSIGHT_METRICS, name)) return
  if (/^(auction_|deduping_|creative_fatigue|creative_diversity|wish_bid)/.test(name)) throw new MetaLiveRefusal(`"${name}" is read by meta-ad-details view diagnostics (auction, overlap, fatigue and diversity of one object), not here.`)
  if (/_ranking$/.test(name)) throw new MetaLiveRefusal(`"${name}": quality, engagement-rate and conversion-rate rankings are not in Meta's v26 insights reference; meta-ad-details view diagnostics shows them only if Meta still answers them.`)
  if (name === 'comparison_node') throw new MetaLiveRefusal('comparison_node: Meta\'s insights edge takes no comparison period (only the Report Builder does): ask compare (previous-period, previous-year) or periods here — Nexus computes the change — or meta-ads-saved-reports view report-builder with comparisonFrom / comparisonTo.')
  throw new MetaLiveRefusal(`"${name}" is not a metric Nexus asks Meta (view catalogue lists every one).`)
}

/**
 * Everything a numbers read will send, checked BEFORE any call: the object (the chosen account's own), the level, the
 * metrics and their rules, the breakdowns and their combination, the windows, the days, the filters (ids checked to be
 * the account's own), the sort, the total. A refusal says why in plain words (MetaLiveRefusal).
 */
export async function planNumbers(account: MetaChosenAccount, input: NumbersInput): Promise<NumbersPlan> {
  const notes: string[] = []
  const dropped: string[] = []
  // The object read: the ad account, or one campaign, ad set or ad of it (IN-001 … IN-004).
  const named = ([['campaign', input.campaignId], ['adset', input.adSetId], ['ad', input.adId]] as const).filter(([, id]) => !!id)
  if (named.length > 1) throw new MetaLiveRefusal('Name at most one object to read from (campaignId, adSetId or adId); a filter narrows further.')
  let objectKind: NumbersPlan['objectKind'] = 'account'
  let objectId = account.adAccountId
  if (named.length) {
    objectKind = named[0][0]
    objectId = await objectInAccount(account, String(named[0][1]), objectKind, 'numbers.ownerCheck')
  }
  const path = objectKind === 'account' ? `${act(account.adAccountId)}/insights` : `${objectId}/insights`

  // The view's own breakdowns and defaults.
  let breakdowns = [...new Set((input.breakdowns ?? []).map((x) => x.trim()))]
  let defaults: readonly string[] = DEFAULT_METRICS
  let defaultLevel: InsightLevel = objectKind === 'account' ? 'campaign' : objectKind
  if ((input.view === 'products' || input.view === 'hourly') && breakdowns.length) {
    throw new MetaLiveRefusal(input.view === 'products' ? 'View products splits by product only (product_id); brand, category or custom label: view numbers with breakdowns product_brand_breakdown, product_category_breakdown or product_custom_label_0_breakdown … 4.' : 'View hourly splits by hour only (Meta combines an hour with no other breakdown).')
  }
  if (input.view === 'products') {
    breakdowns = ['product_id']
    defaults = PRODUCT_DEFAULTS
  } else if (input.view === 'assets') {
    const asset = input.assetBreakdown ?? null
    if (!asset || !ASSET_VIEW_BREAKDOWNS.includes(asset)) throw new MetaLiveRefusal(`Name the asset breakdown (assetBreakdown: ${ASSET_VIEW_BREAKDOWNS.join(', ')}).`)
    if (breakdowns.some((x) => x !== 'age' && x !== 'gender')) throw new MetaLiveRefusal('With an asset breakdown Meta adds only age, gender or both (asset feed spec insights).')
    breakdowns = [asset, ...breakdowns]
    defaults = ASSET_DEFAULTS
    defaultLevel = objectKind === 'account' || objectKind === 'campaign' ? 'ad' : objectKind
  } else if (input.view === 'hourly') {
    breakdowns = [input.audienceTime ? HOURLY_BREAKDOWNS[1] : HOURLY_BREAKDOWNS[0]]
    defaults = HOURLY_DEFAULTS
  }
  const level: InsightLevel = input.level ?? defaultLevel
  if (!(INSIGHT_LEVELS as readonly string[]).includes(level)) throw new MetaLiveRefusal(`level is ${INSIGHT_LEVELS.join(', ')}.`)
  if (objectKind !== 'account' && LEVEL_RANK[level] < LEVEL_RANK[objectKind]) throw new MetaLiveRefusal(`A ${KIND_WORD[objectKind]}'s numbers roll down, not up: level ${objectKind} or lower (${INSIGHT_LEVELS.filter((l) => LEVEL_RANK[l] >= LEVEL_RANK[objectKind]).join(', ')}).`)

  // Breakdowns (IN-030 … IN-043) and action breakdowns (IN-046): on the lists, in a combination Meta keeps (IN-047).
  if (breakdowns.length > 4) throw new MetaLiveRefusal('At most 4 breakdowns at once (Meta keeps few combinations: view catalogue lists them).')
  for (const x of breakdowns) {
    const notOffered = lookup(BREAKDOWNS_NOT_OFFERED, x)
    if (notOffered) throw new MetaLiveRefusal(`${x}: ${notOffered}.`)
    if (!hasKey(META_INSIGHT_BREAKDOWNS, x)) throw new MetaLiveRefusal(`"${x}" is not a breakdown Nexus asks Meta (view catalogue lists every one).`)
    if (META_INSIGHT_BREAKDOWNS[x].notAtAccount && level === 'account') throw new MetaLiveRefusal(`Meta does not answer ${x} for the whole account at once (its breakdowns page / best practices): ask level campaign, adset or ad.`)
  }
  const actionBreakdowns = [...new Set((input.actionBreakdowns ?? []).map((x) => x.trim()))]
  if (actionBreakdowns.length > 4) throw new MetaLiveRefusal('At most 4 action breakdowns at once.')
  for (const x of actionBreakdowns) if (!(META_ACTION_BREAKDOWNS as readonly string[]).includes(x)) throw new MetaLiveRefusal(`"${x}" is not an action breakdown (${META_ACTION_BREAKDOWNS.join(', ')}).`)
  const combination = breakdownCombinationProblem(breakdowns, actionBreakdowns)
  if (combination) throw new MetaLiveRefusal(`${combination}.`)
  const hourly = breakdowns.some((x) => META_INSIGHT_BREAKDOWNS[x]?.family === 'hour')
  const dcAsset = breakdowns.some((x) => (DC_ASSET_BREAKDOWNS as readonly string[]).includes(x))

  // Metrics (IN-010 … IN-025, RC-007): the caller's, their groups, or the view's defaults — then Meta's rules.
  const explicit = [...(input.metrics ?? []).map((m) => m.trim()), ...(input.groups ?? []).flatMap((g) => {
    if (!(METRIC_GROUPS as readonly string[]).includes(g)) throw new MetaLiveRefusal(`"${g}" is not a metric group (${METRIC_GROUPS.join(', ')}).`)
    return Object.entries(META_INSIGHT_METRICS).filter(([, s]) => s.group === g).map(([n]) => n)
  })]
  explicit.forEach(metricOk)
  const fromCaller = explicit.length > 0
  let metrics = fromCaller ? [...new Set(explicit)] : [...defaults]
  // A sort names a metric too: it goes through the same rules (and is refused, never dropped, when Meta would not answer it).
  const askedFor = new Set(explicit)
  if (input.sortBy) {
    metricOk(input.sortBy)
    askedFor.add(input.sortBy)
    if (!metrics.includes(input.sortBy)) metrics.push(input.sortBy)
  }
  const rule = (name: string, ok: boolean, why: string) => {
    if (ok) return true
    if (askedFor.has(name)) throw new MetaLiveRefusal(`${name}: ${why}.`)
    dropped.push(`${name} (${why})`)
    return false
  }
  metrics = metrics.filter((name) => {
    const s = META_INSIGHT_METRICS[name]
    if (s.group === 'identity') return true
    return rule(name, !(hourly && (s.zeroByHour || s.unique)), 'Meta answers reach, frequency, cost per 1,000 people reached and unique counts as 0 or not at all by hour')
      && rule(name, !(hourly && name.startsWith('video_')), 'Meta answers no video_* numbers with an hourly breakdown')
      && rule(name, !(breakdowns.length && s.noBreakdowns), 'Meta answers it only without a breakdown')
      && rule(name, !(breakdowns.includes('region') && s.notWithRegion), 'Meta does not answer it by region')
      && rule(name, !(dcAsset && !DC_ASSET_METRICS.has(name)), 'with a Dynamic Creative asset breakdown Meta answers only impressions, clicks, spend, reach, actions and action_values')
      && rule(name, !(breakdowns.includes('frequency_value') && name !== 'reach'), 'Meta answers frequency_value with reach only')
      && rule(name, !(level === 'account' && s.notAtAccount), 'Meta answers it for campaigns, ad sets and ads, not for the whole account: ask level campaign or lower')
      && rule(name, !((level === 'ad' || objectKind === 'ad') && s.notOnAd), 'Meta\'s ad-level insights do not carry it: ask level adset or higher')
  })
  if (breakdowns.includes('frequency_value') && !metrics.includes('reach')) metrics.push('reach')
  if (breakdowns.includes('frequency_value') && (actionBreakdowns.length || input.sortAction)) throw new MetaLiveRefusal('Meta answers frequency_value with reach only: no actions, action breakdowns or action sort with it.')
  if (actionBreakdowns.length && !metrics.includes('actions')) {
    metrics.push('actions')
    notes.push('actions was added: Meta answers action breakdowns only inside actions.')
  }
  // Sort (IN-064): one scalar metric or one action type; an amount only for a person who may see ad spend.
  let sort: string | null = null
  if (input.sortBy && input.sortAction) throw new MetaLiveRefusal('Sort by one thing: sortBy (a metric) or sortAction (an action type), not both.')
  const order = input.order ?? 'descending'
  if (input.sortBy) {
    const s = META_INSIGHT_METRICS[input.sortBy]
    if (!SORTABLE_KINDS.has(s.kind)) throw new MetaLiveRefusal(`${input.sortBy} is not one number: Meta sorts by a count, rate or amount (or by one action type: sortAction).`)
    if (MONEY_KINDS.has(s.kind) && !input.seesMoney) throw new MetaLiveRefusal(`Sorting by ${input.sortBy} needs the ad-spend money permission (the order would show the amounts).`)
    sort = `${input.sortBy}_${order}`
  } else if (input.sortAction) {
    if (!(ACTION_TYPES as readonly string[]).includes(input.sortAction)) throw new MetaLiveRefusal(`sortAction is one of Nexus's action types (${ACTION_TYPES.slice(0, 8).join(', ')}, … view catalogue).`)
    if (!metrics.includes('actions')) metrics.push('actions')
    sort = `actions:${input.sortAction}_${order}`
  }
  const identity = [...LEVEL_IDENTITY[level]]
  const all = [...new Set([...identity, ...metrics])]
  const fields = all.filter((n) => !META_INSIGHT_METRICS[n].extra)
  const extras = all.filter((n) => META_INSIGHT_METRICS[n].extra)
  if ([...fields, ...extras].join(',').length > MAX_FIELDS_TEXT) throw new MetaLiveRefusal('That is more metrics than one read carries: ask fewer (or fewer groups).')
  if (!all.some((n) => META_INSIGHT_METRICS[n].group !== 'identity')) throw new MetaLiveRefusal('Name at least one number to read (metrics or groups).')

  // Days (IN-058 … IN-061): a preset, exact days, several periods, or a comparison Nexus computes (IN-026).
  const today = accountToday(account.timeZone ?? 'UTC')
  const oldest = monthsBefore(today, MAX_MONTHS_BACK)
  const checkDays = (from: string, to: string, what: string) => {
    if (!isDay(from) || !isDay(to)) throw new MetaLiveRefusal(`${what}: days are YYYY-MM-DD.`)
    if (to < from) throw new MetaLiveRefusal(`${what}: the first day is after the last.`)
    if (to > today) throw new MetaLiveRefusal(`${what}: the last day is after today (${today}, the ad account's time zone).`)
    if (from < oldest) throw new MetaLiveRefusal(`${what}: Meta keeps insights 37 months (error 3018): the first day may be ${oldest} at the earliest.`)
  }
  const query: Record<string, MetaQueryValue> = { level }
  let periods: NumbersPlan['periods'] = null
  const compare = input.compare ?? null
  const increment = input.timeIncrement ?? 'all_days'
  let earliest: string | null = null
  if ((input.periods?.length || compare) && increment !== 'all_days') throw new MetaLiveRefusal('Meta ignores rows per day, week or month when it reads several periods at once: ask one or the other.')
  if (input.datePreset && (input.from || input.to || input.periods?.length)) throw new MetaLiveRefusal('Name the days one way: a datePreset, or from and to, or periods.')
  if (input.periods?.length) {
    if (compare) throw new MetaLiveRefusal('Name periods, or compare with from and to — not both.')
    if (input.periods.length > MAX_PERIODS) throw new MetaLiveRefusal(`At most ${MAX_PERIODS} periods at once.`)
    input.periods.forEach((p, i) => checkDays(p.from, p.to, `period ${i + 1}`))
    periods = input.periods.map((p, i) => ({ ...p, label: `period ${i + 1}` }))
    query.time_ranges = periods.map((p) => ({ since: p.from, until: p.to }))
    earliest = periods.map((p) => p.from).sort()[0]
  } else if (compare) {
    if (!input.from || !input.to) throw new MetaLiveRefusal('compare needs from and to (the current period).')
    checkDays(input.from, input.to, 'the period')
    const before = comparisonPeriod(input.from, input.to, compare)
    checkDays(before.from, before.to, 'the earlier period')
    periods = [{ from: input.from, to: input.to, label: 'current' }, { ...before, label: 'earlier' }]
    query.time_ranges = periods.map((p) => ({ since: p.from, until: p.to }))
    earliest = before.from
  } else if (input.from || input.to) {
    const to = input.to ?? today
    const from = input.from ?? to
    checkDays(from, to, 'the days')
    query.time_range = { since: from, until: to }
    earliest = from
  } else {
    const preset = input.datePreset ?? 'last_30d'
    if (preset === 'lifetime') throw new MetaLiveRefusal('Meta disabled lifetime: maximum reads its 37 months.')
    if (!(DATE_PRESETS as readonly string[]).includes(preset)) throw new MetaLiveRefusal(`datePreset is one of ${DATE_PRESETS.join(', ')}.`)
    query.date_preset = preset
    // Review B-4 — how far back a preset reaches, where it reaches past a retention limit.
    if (preset === 'maximum' || preset === 'data_maximum') earliest = monthsBefore(today, MAX_MONTHS_BACK)
    else if (preset === 'this_year') earliest = `${today.slice(0, 4)}-01-01`
    else if (preset === 'last_year') earliest = `${Number(today.slice(0, 4)) - 1}-01-01`
    if (!input.datePreset) notes.push('No days named: the last 30 days (Meta\'s default), today included.')
  }
  if (!periods) {
    const inc = increment === 'daily' ? 1 : increment === 'weekly' ? 7 : increment
    if (typeof inc === 'number' && (!Number.isInteger(inc) || inc < 1 || inc > 90)) throw new MetaLiveRefusal('timeIncrement is daily, weekly, monthly, all_days or a number of days 1–90.')
    query.time_increment = inc
  }
  // Retention (OCC 2025): hourly and unique counts with a breakdown 13 months, frequency_value 6 months.
  if (earliest) {
    for (const x of breakdowns) {
      const months = META_INSIGHT_BREAKDOWNS[x]?.months
      if (months && earliest < monthsBefore(today, months)) {
        if (input.datePreset) notes.push(`${x}: Meta keeps it ${months} months; the older days of this preset come back empty.`)
        else throw new MetaLiveRefusal(`Meta keeps ${x} ${months} months: the first day may be ${monthsBefore(today, months)} at the earliest.`)
      }
    }
    if (breakdowns.length && earliest < monthsBefore(today, 13)) {
      const uniques = all.filter((n) => META_INSIGHT_METRICS[n].unique)
      if (uniques.length) {
        if (input.datePreset || !fromCaller) notes.push(`${uniques.join(', ')}: Meta keeps unique counts with a breakdown 13 months; older days come back without them.`)
        else throw new MetaLiveRefusal(`Meta keeps unique counts (${uniques.join(', ')}) with a breakdown 13 months: the first day may be ${monthsBefore(today, 13)} at the earliest.`)
      }
      if (all.some((n) => n === 'reach' || n === 'frequency' || n === 'cpp')) notes.push('Meta leaves reach, frequency and cost per 1,000 people reached out of a direct read with breakdowns that starts more than 13 months ago; a background report (meta-ads-report) gets them, 10 such a day per ad account.')
    }
  }
  if (breakdowns.length) query.breakdowns = breakdowns
  if (actionBreakdowns.length) query.action_breakdowns = actionBreakdowns

  // Attribution (IN-052 … IN-056): the windows that still answer; each ad set's own setting unless the account's is asked.
  const windows = [...new Set((input.windows ?? []).map((w) => w.trim()))]
  for (const w of windows) {
    if (DEAD_WINDOWS.has(w)) throw new MetaLiveRefusal(`${w}: Meta returns no data for 7-day and 28-day view windows since 2026-01-12 (out-of-cycle changes 2025). Windows that answer: ${ATTRIBUTION_WINDOWS.join(', ')}.`)
    if (WINDOWS_NOT_OFFERED.has(w)) throw new MetaLiveRefusal(`${w}: app-install postbacks or a window Meta does not document; Nexus asks ${ATTRIBUTION_WINDOWS.join(', ')}.`)
    if (!(ATTRIBUTION_WINDOWS as readonly string[]).includes(w)) throw new MetaLiveRefusal(`"${w}" is not an attribution window (${ATTRIBUTION_WINDOWS.join(', ')}).`)
  }
  if (windows.length) {
    query.action_attribution_windows = windows
    notes.push('windows: each action carries its value per window asked (default = 7-day click and 1-day view). With restricted breakdowns Meta keeps action numbers only for 1d_click, 7d_click, 1d_view and incrementality.')
  }
  if (input.attribution === 'account') {
    query.use_account_attribution_setting = true
    notes.push('attribution account: Meta documents use_account_attribution_setting; since 2025-06-10 it reports with each ad set\'s own setting (as Ads Manager) and may ignore this too — each row\'s attribution_setting says what Meta used.')
  }

  // Filters (IN-063): the caller's, the shortcuts, and every status (archived and deleted objects are left out otherwise).
  const filtering: Array<{ field: string; operator: string; value: unknown }> = []
  const ids = idBudget()
  const exponent = currencyExponent(account.currency)
  const amount = (cents: number) => (cents / 10 ** exponent).toFixed(exponent)
  for (const f of input.filters ?? []) {
    const spec = lookup(FILTER_FIELDS, f.field)
    if (!spec) throw new MetaLiveRefusal(`"${f.field}" is not a filter Nexus sends (${Object.keys(FILTER_FIELDS).join(', ')}).`)
    let value: unknown = f.value
    if (spec.value === 'money') {
      if (!input.seesMoney) throw new MetaLiveRefusal(`Filtering by ${f.field} needs the ad-spend money permission (the cut would show the amounts).`)
      if (typeof f.valueCents !== 'number' || !Number.isInteger(f.valueCents) || f.valueCents < 0) throw new MetaLiveRefusal(`${f.field} takes valueCents (minor units of the account currency).`)
      value = amount(f.valueCents)
    }
    const problem = filterValueProblem(f.field, f.operator, value)
    if (problem) throw new MetaLiveRefusal(`${problem}.`)
    await ids.check(account, { ...f, value: value as NumbersFilter['value'] }, 'numbers.filterOwnerCheck')
    if (spec.unverified) notes.push(`The filter ${f.field} is not on a Meta page in this form (DOT notation): Meta's own answer decides.`)
    if (f.operator === 'CONTAIN' || f.operator === 'STARTS_WITH' || f.operator === 'ENDS_WITH' || f.operator === 'NOT_CONTAIN') notes.push(`${f.field} ${f.operator}: Meta's total row does not follow this filter (its best practices: use IN for that).`)
    filtering.push({ field: f.field, operator: f.operator, value })
  }
  if (input.onlyWithImpressions) filtering.push({ field: `${level === 'account' ? 'ad' : level}.impressions`, operator: 'GREATER_THAN', value: 0 })
  if (typeof input.minSpendCents === 'number') {
    if (!input.seesMoney) throw new MetaLiveRefusal('minSpendCents needs the ad-spend money permission (the cut would show the amounts).')
    filtering.push({ field: `${level === 'account' ? 'ad' : level}.spend`, operator: 'GREATER_THAN_OR_EQUAL', value: amount(input.minSpendCents) })
    notes.push('minSpendCents: the spend filter is not on a Meta page in this form (DOT notation): Meta\'s own answer decides.')
  }
  const statusField = level === 'account' ? null : `${level}.effective_status`
  if (statusField && input.includeArchived !== false && !filtering.some((f) => f.field === statusField)) {
    filtering.push(...insightStatusFilter(level === 'campaign' ? 'CAMPAIGN' : level === 'adset' ? 'ADSET' : 'AD'))
  } else if (statusField && input.includeArchived === false) {
    notes.push('Without archived and deleted ones: Meta leaves them out of a level read unless a status filter names them.')
  }
  // A report run reads the account's path (meta-ads-report): the object it is about goes as one more filter, counted here.
  if (input.asReportRun && objectKind !== 'account') filtering.push({ field: `${objectKind}.id`, operator: 'IN', value: [objectId] })
  if (filtering.length > 20) throw new MetaLiveRefusal('At most 20 filters at once.')
  if (filtering.length) query.filtering = filtering
  if (sort) query.sort = [sort]
  if (input.withTotal) {
    query.default_summary = true
    if (actionBreakdowns.length) query.summary_action_breakdowns = actionBreakdowns
  }
  if (typeof input.productIdLimit === 'number') {
    if (!breakdowns.includes('product_id')) throw new MetaLiveRefusal('productIdLimit goes with the product breakdown (view products).')
    if (!Number.isInteger(input.productIdLimit) || input.productIdLimit < 1 || input.productIdLimit > 1000) throw new MetaLiveRefusal('productIdLimit is 1–1000 products per ad.')
    query.product_id_limit = input.productIdLimit
  }

  // What the person should know about these breakdowns and numbers.
  const featureGated = breakdowns.filter((x) => META_INSIGHT_BREAKDOWNS[x]?.feature)
  for (const x of featureGated) notes.push(FEATURE_NOTE(x, META_INSIGHT_BREAKDOWNS[x].feature!))
  if (breakdowns.some((x) => META_INSIGHT_BREAKDOWNS[x]?.type1)) notes.push('Region and hourly breakdowns (Meta\'s Type 1): purchases and other actions on the shop\'s website or app are not returned with them.')
  if (breakdowns.some((x) => META_INSIGHT_BREAKDOWNS[x]?.type2) || actionBreakdowns.some((x) => TYPE2_ACTION_BREAKDOWNS.has(x))) notes.push('Product, device, destination and carousel-card breakdowns (Meta\'s Type 2): website numbers come without the breakdown value, app numbers not at all.')
  const guideOnly = breakdowns.filter((x) => META_INSIGHT_BREAKDOWNS[x]?.guideOnly)
  if (guideOnly.length) notes.push(`${guideOnly.join(', ')}: on Meta's Breakdowns guide but not in its reference list of breakdowns; if Meta refuses it, its own sentence says so (a live check is pending).`)
  const namesOnly = breakdowns.filter((x) => META_INSIGHT_BREAKDOWNS[x]?.namesOnly)
  if (namesOnly.length) notes.push(`${namesOnly.join(', ')}: Meta names these breakdowns without describing them; its own answer decides what they hold.`)
  if (breakdowns.length) notes.push('Every breakdown value is estimated by Meta (its breakdowns page).')
  if (all.includes('actions') || all.includes('action_values')) notes.push('actions are nested (post_engagement includes link_click, comment, reaction): their sum is not total_actions. omni_* = website + app + offline together: pick one family per question.')
  if (all.some((n) => n === 'reach' || n === 'frequency')) notes.push('reach and frequency are people, not summable across days, periods or breakdowns: the total row (withTotal) is Meta\'s own, deduplicated.')
  const estimated = all.filter((n) => META_INSIGHT_METRICS[n].estimated || META_INSIGHT_METRICS[n].unique)
  const inDevelopment = all.filter((n) => META_INSIGHT_METRICS[n].inDevelopment)
  return { path, objectKind, objectId, level, fields, extras, breakdowns, actionBreakdowns, query, periods, compare, notes, dropped, estimated, inDevelopment, featureGated }
}

// ── the rows ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Window keys an AdsActionStats may carry (Meta's per-window values), as Nexus names them in the answer. */
const STAT_WINDOWS = [...ATTRIBUTION_WINDOWS.filter((w) => w !== 'default'), 'inline'] as const
const ACTION_KEYS = META_ACTION_BREAKDOWNS.filter((a) => a !== 'action_type')

interface MapContext { currency: string | null }

const centsOf = (v: unknown, currency: string | null): number | null => minorOf(decimalToMicros(typeof v === 'number' ? v : text(v)), currency)

/** One list<AdsActionStats>: type, value and each window's value (amounts in minor units for a money list). */
function actionStats(v: unknown, money: boolean, ctx: MapContext) {
  const conv = (x: unknown) => (money ? centsOf(x, ctx.currency) : num(x))
  const list = Array.isArray(v) ? v : obj(v) ? [v] : []
  return list.filter((a): a is Row => !!obj(a)).map((a) => {
    const windows: Record<string, number | null> = {}
    for (const w of STAT_WINDOWS) if (a[w] !== undefined) windows[w] = conv(a[w])
    const breakdown: Record<string, string | null> = {}
    for (const k of ACTION_KEYS) if (a[k] !== undefined) breakdown[k] = text(a[k])
    return { actionType: text(a.action_type), value: conv(a.value), ...(Object.keys(windows).length ? { windows } : {}), ...(Object.keys(breakdown).length ? { breakdown } : {}) }
  })
}

/** One list<AdsInsightsResult>: the indicator and its values (costs in minor units). */
function results(v: unknown, money: boolean, ctx: MapContext) {
  return rowsOf(v).map((r) => ({
    indicator: text(r.indicator),
    values: rowsOf(r.values).map((x) => ({ value: money ? centsOf(x.value, ctx.currency) : num(x.value), windows: Array.isArray(x.attribution_windows) ? x.attribution_windows.map(text) : null })),
  }))
}

export interface MappedRow {
  dateStart: string | null
  dateStop: string | null
  period?: string
  campaignId?: string | null
  campaignName?: string | null
  adSetId?: string | null
  adSetName?: string | null
  adId?: string | null
  adName?: string | null
  breakdown?: Record<string, unknown>
  info?: Record<string, string | null>
  numbers: Record<string, unknown>
  money: Record<string, unknown>
  nexusSku?: string | null
  nexusProductId?: string | null
}

const ROW_IDS = ownList<keyof MappedRow>([['campaign_id', 'campaignId'], ['campaign_name', 'campaignName'], ['adset_id', 'adSetId'], ['adset_name', 'adSetName'], ['ad_id', 'adId'], ['ad_name', 'adName']])

/**
 * One insights row → Nexus's: ids and names, the breakdown values (placements in words), the numbers, and every amount in
 * minor units of the account currency under `money` (ROAS as Meta's ratio; an amount whose unit Meta does not name as Meta
 * sent it, under money.asMeta). A key Nexus did not ask (a report run started elsewhere) is left out and named.
 */
export function mapInsightRow(row: Row, ctx: MapContext, breakdowns: readonly string[], left: Set<string>): MappedRow {
  const out: MappedRow = { dateStart: text(row.date_start), dateStop: text(row.date_stop), numbers: {}, money: {} }
  const info: Record<string, string | null> = {}
  const breakdown: Record<string, unknown> = {}
  const asMeta: Record<string, unknown> = {}
  for (const name of breakdowns) {
    if (row[name] === undefined) continue
    breakdown[name] = typeof row[name] === 'string' || typeof row[name] === 'number' ? text(row[name]) : raw(row[name])
    if (name === 'platform_position' && typeof row[name] === 'string') breakdown.placementText = PLACEMENT_WORDS[row[name] as string] ?? null
  }
  for (const [key, value] of Object.entries(row)) {
    if (key === 'date_start' || key === 'date_stop' || breakdowns.includes(key)) continue
    if (ROW_IDS[key]) { (out as unknown as Row)[ROW_IDS[key]] = text(value); continue }
    const s = META_INSIGHT_METRICS[key]
    if (!s) { left.add(key); continue }
    const kind: MetricKind = s.kind
    switch (kind) {
      case 'info': info[key] = text(value); break
      case 'count': case 'ratio': out.numbers[key] = num(value); break
      case 'money': out.money[key] = centsOf(value, ctx.currency); break
      case 'actions': case 'actionsRatio': out.numbers[key] = actionStats(value, false, ctx); break
      case 'actionsMoney': out.money[key] = actionStats(value, true, ctx); break
      case 'roas': out.money[key] = actionStats(value, false, ctx); break
      case 'results': out.numbers[key] = results(value, false, ctx); break
      case 'resultsMoney': out.money[key] = results(value, true, ctx); break
      case 'histogram': case 'raw': out.numbers[key] = raw(value); break
      case 'rawMoney': asMeta[key] = raw(value); break
    }
  }
  if (Object.keys(asMeta).length) out.money.asMeta = asMeta
  if (Object.keys(breakdown).length) out.breakdown = breakdown
  if (Object.keys(info).length) out.info = info
  return out
}

/** The scalar numbers of a row, flat: `name` for a count or amount, `name:actionType` for each action of a list. */
function flat(part: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(part)) {
    if (typeof value === 'number') out[key] = value
    else if (Array.isArray(value)) for (const a of value) {
      const r = obj(a)
      if (r && typeof r.actionType === 'string' && typeof r.value === 'number' && !r.breakdown) out[`${key}:${r.actionType}`] = r.value
    }
  }
  return out
}

const rowKey = (r: MappedRow) => JSON.stringify([r.campaignId ?? null, r.adSetId ?? null, r.adId ?? null, r.breakdown ?? null])

/** IN-026 — the change between the current and the earlier period, per object and breakdown, computed by Nexus. */
export function changesOf(rows: MappedRow[]) {
  const by = new Map<string, { current?: MappedRow; earlier?: MappedRow }>()
  for (const r of rows) {
    if (r.period !== 'current' && r.period !== 'earlier') continue
    const k = rowKey(r)
    const e = by.get(k) ?? {}
    e[r.period] = r
    by.set(k, e)
  }
  const diff = (a: Record<string, number>, b: Record<string, number>) => {
    const out: Record<string, { current: number | null; earlier: number | null; change: number | null; changePct: number | null }> = {}
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const cur = a[k] ?? null
      const ear = b[k] ?? null
      out[k] = { current: cur, earlier: ear, change: cur !== null && ear !== null ? cur - ear : null, changePct: cur !== null && ear ? (cur - ear) / ear : null }
    }
    return out
  }
  return [...by.values()].map(({ current, earlier }) => {
    const any = (current ?? earlier)!
    return {
      campaignId: any.campaignId ?? null, campaignName: any.campaignName ?? null, adSetId: any.adSetId ?? null, adSetName: any.adSetName ?? null,
      adId: any.adId ?? null, adName: any.adName ?? null, ...(any.breakdown ? { breakdown: any.breakdown } : {}),
      inCurrent: !!current, inEarlier: !!earlier,
      numbers: diff(flat(current?.numbers ?? {}), flat(earlier?.numbers ?? {})),
      money: diff(flat(current?.money ?? {}), flat(earlier?.money ?? {})),
    }
  })
}

/** Products (IN-019): Meta's retailer id is the catalog's SKU; matched to this business's Nexus products (never another's). */
async function withSkus(rows: MappedRow[]): Promise<void> {
  const ids = [...new Set(rows.map((r) => r.info?.product_retailer_id).filter((x): x is string => !!x))]
  if (!ids.length) return
  const found = await prisma.product.findMany({ where: { sku: { in: ids }, deletedAt: null }, select: { id: true, sku: true } })
  const bySku = new Map(found.map((p) => [p.sku, p.id]))
  for (const r of rows) {
    const sku = r.info?.product_retailer_id ?? null
    r.nexusSku = sku && bySku.has(sku) ? sku : null
    r.nexusProductId = sku ? bySku.get(sku) ?? null : null
  }
}

/** Re-review 2 — pages one read may cost beyond the ones its rows need (Meta may answer fewer rows a page than asked). */
const EXTRA_PAGES = 5

/**
 * Pages of an insights edge (cursor `after`; Meta's next link carries the token and is never followed), with Meta's total.
 * Review A F1 — each page asks only for the rows still missing, so the read ends exactly at maxRows with the cursor of the
 * next row; were Meta to send more than asked, the extra rows are cut and there is no exact cursor (`cut`, nextAfter null).
 * Re-review 2 — an empty page ends the read, and one read costs at most ceil(maxRows / 100) + 5 calls (then it hands back
 * the cursor: more to page on).
 */
async function readPages(connectionId: string, operation: string, path: string, query: Record<string, MetaQueryValue>, maxRows: number, after: string | null) {
  const rows: Row[] = []
  let summary: Row | null = null
  let cursor = after
  const maxPages = Math.ceil(maxRows / PAGE_ROWS) + EXTRA_PAGES
  for (let page = 0; page < maxPages; page++) {
    const { body } = await metaReadOne<Row>({ connectionId }, { operation, path, query: { ...query, limit: Math.min(PAGE_ROWS, maxRows - rows.length), ...(cursor ? { after: cursor } : {}) } })
    if (page === 0) summary = obj(body.summary)
    const got = rowsOf(body.data)
    rows.push(...got)
    const paging = obj(body.paging)
    const next = paging?.next ? text(obj(paging.cursors)?.after) : null
    if (rows.length > maxRows) return { rows: rows.slice(0, maxRows), summary, nextAfter: null as string | null, cut: true }
    if (!next || got.length === 0) return { rows, summary, nextAfter: null as string | null, cut: false }
    if (rows.length === maxRows) return { rows, summary, nextAfter: next as string | null, cut: false }
    cursor = next
  }
  return { rows, summary, nextAfter: cursor, cut: false }
}

/**
 * Review A F2 — an answer cut to fit one reply keeps fewer rows than were read, so it carries NO cursor (paging on would
 * skip the rows cut): `more` says there is more, the person asks fewer rows or metrics.
 */
function fitRows<T extends { rows: unknown[]; more: boolean; nextAfter: string | null; notes: string[] }>(answer: T): T {
  if (JSON.stringify(answer).length <= MAX_ANSWER_CHARS) return answer
  const kept = [...answer.rows]
  while (kept.length > 1 && JSON.stringify({ ...answer, rows: kept }).length > MAX_ANSWER_CHARS) kept.splice(Math.max(1, Math.floor(kept.length * 0.8)))
  return { ...answer, rows: kept, more: true, nextAfter: null, notes: [...answer.notes, `The answer was cut to ${kept.length} of ${answer.rows.length} rows to fit; ask fewer rows (maxRows), metrics or breakdowns to see the rest.`] }
}

/** Meta could not answer this much at once (its timeouts and data-per-call limit): said with the way out. */
function tooMuch(err: unknown): never {
  if (err instanceof MetaReadError && err.failure.shrink) throw new MetaLiveRefusal(`${TOO_MUCH} (Meta: ${err.failure.code})`)
  throw err
}

/** What the answer says about the account, the read and its money. */
const accountOf = (a: MetaChosenAccount) => ({ adAccountId: a.adAccountId, name: a.name, currency: a.currency, timeZone: a.timeZone })
const moneyUnit = (currency: string | null) => `Amounts under money are minor units (cents) of ${currency ?? 'the account currency'}; ROAS lists are Meta's ratio; money.asMeta holds amounts whose unit Meta does not name, as Meta sent them. Numbers are in the ad account's time zone; recent days still change as late purchases are attributed (insights refresh every 15 minutes, settle after 28 days).`

/** The catalogue (view catalogue): every list Nexus asks from, with Meta's labels — no Meta call. */
export function numbersCatalogue() {
  const groups: Record<string, Array<{ name: string; kind: MetricKind; estimated?: true; inDevelopment?: true; notOnV26List?: true }>> = {}
  for (const [name, s] of Object.entries(META_INSIGHT_METRICS)) {
    (groups[s.group] ??= []).push({ name, kind: s.kind, ...(s.estimated ? { estimated: true as const } : {}), ...(s.inDevelopment ? { inDevelopment: true as const } : {}), ...(s.extra ? { notOnV26List: true as const } : {}) })
  }
  const breakdowns: Record<string, string[]> = {}
  for (const [name, s] of Object.entries(META_INSIGHT_BREAKDOWNS)) (breakdowns[s.family] ??= []).push(name)
  return {
    metricGroups: groups,
    defaults: { numbers: DEFAULT_METRICS, products: PRODUCT_DEFAULTS, hourly: HOURLY_DEFAULTS, assets: ASSET_DEFAULTS },
    breakdowns,
    breakdownsNotAsked: BREAKDOWNS_NOT_OFFERED,
    combinations: [
      'One breakdown alone (never impression_device or platform_position alone); together only: age + gender; publisher_platform + platform_position and / or impression_device; a Dynamic Creative asset + age and / or gender.',
      'Action breakdowns: action_type (default), action_target_id, action_destination with age, gender, country, region, publisher_platform (and its combinations), product_id, hourly; action_device with publisher_platform / platform_position / impression_device; action_reaction alone (or with action_type); a carousel card with impression_device, country, age, gender or age + gender; the others alone.',
      'By hour: no reach, frequency, unique counts or video_*. frequency_value: reach only. Dynamic Creative assets: impressions, clicks, spend, reach, actions, action_values only. Region: no video_p25…p100 or average watch time. app_store_clicks and newsfeed_* never with a breakdown.',
      'Switched on per account (empty, not 0, until then): impression_device, hourly by the audience\'s time zone, frequency_value, comscore_market.',
    ],
    actionBreakdowns: META_ACTION_BREAKDOWNS,
    actionTypes: ACTION_TYPES,
    windows: { answer: ATTRIBUTION_WINDOWS, deadSince20260112: [...DEAD_WINDOWS], notAsked: [...WINDOWS_NOT_OFFERED] },
    datePresets: DATE_PRESETS,
    filters: Object.fromEntries(Object.entries(FILTER_FIELDS).map(([f, s]) => [f, { operators: s.operators, value: s.value, ...(s.values ? { values: s.values } : {}), ...(s.unverified ? { notOnAMetaPage: true } : {}) }])),
    mmmFilters: MMM_FILTERS,
    notes: [
      'Meta reports each ad set\'s own attribution setting since 2025-06-10 (as Ads Manager); action_report_time is ignored (on-Meta actions on the impression day, website purchases on the purchase day), so Nexus does not offer it.',
      'Meta keeps 37 months; unique counts with a breakdown and hourly numbers 13 months; frequency_value 6 months.',
      'Industry and auction benchmarks have no public Meta API (Meta\'s own MCP and Ads Manager only).',
    ],
  }
}

/** meta-ads-numbers — one read of the chosen ad account's insights (views numbers, products, assets, hourly, check). */
export async function metaNumbers(input: NumbersInput) {
  if (input.view === 'catalogue') return numbersCatalogue()
  if (input.view === 'portfolio') return { sentence: PORTFOLIO_SENTENCE }
  const account = await metaChosenAccount(input.connectionId)
  const plan = await planNumbers(account, input)
  const base = { account: accountOf(account), read: { from: KIND_WORD[plan.objectKind] + (plan.objectKind === 'account' ? '' : ` ${plan.objectId}`), level: plan.level, breakdowns: plan.breakdowns, actionBreakdowns: plan.actionBreakdowns, query: { ...plan.query, fields: [...plan.fields, ...plan.extras].join(',') } } }
  if (input.view === 'check') return { ...base, ok: true, sentence: 'Nexus would send this read as it stands (nothing was asked of Meta yet); Meta\'s own answer may still refuse a combination its pages do not describe.', notes: plan.notes, dropped: plan.dropped, estimated: plan.estimated, inDevelopment: plan.inDevelopment }
  const maxRows = Math.min(MAX_NUMBER_ROWS, Math.max(1, Math.trunc(input.maxRows ?? 200)))
  const missing: string[] = []
  let read: Awaited<ReturnType<typeof readPages>>
  try {
    read = await readPages(account.connectionId, `numbers.${input.view}`, plan.path, { ...plan.query, fields: [...plan.fields, ...plan.extras].join(',') }, maxRows, input.after ?? null)
  } catch (err) {
    // Review B-2 — only a refused FIELD makes the read go again without the extra fields: Meta's "too much at once" (its
    // 100/1487534 and 100/1504018 also count as #100) ends the read with the way out, never a second heavy call.
    if (!(plan.extras.length && fieldRefused(err) && !err.failure.shrink)) tooMuch(err)
    // T3 — fields only other Meta pages name: when Meta refuses them, the rows come without them, and the answer says so.
    missing.push(`Meta refused this read with ${plan.extras.join(', ')} (${(err as MetaReadError).failure.sentence}); it was read again without them.`)
    try {
      read = await readPages(account.connectionId, `numbers.${input.view}.core`, plan.path, { ...plan.query, fields: plan.fields.join(',') }, maxRows, input.after ?? null)
    } catch (again) { tooMuch(again) }
  }
  const ctx = { currency: account.currency }
  const left = new Set<string>()
  const rows = read!.rows.map((r) => mapInsightRow(r, ctx, plan.breakdowns, left))
  if (plan.periods) {
    for (const r of rows) r.period = plan.periods.find((p) => p.from === r.dateStart && p.to === r.dateStop)?.label ?? undefined
  }
  if (plan.breakdowns.includes('product_id')) await withSkus(rows)
  const total = read!.summary ? mapInsightRow(read!.summary, ctx, plan.breakdowns, left) : null
  const notes = [...plan.notes]
  if (!rows.length && plan.featureGated.length) notes.unshift(`No rows: ${plan.featureGated.join(', ')} may be switched off for this ad account (not 0) — or nothing delivered in these days; meta-ad-account view insights-features says which are on.`)
  if (plan.breakdowns.includes('product_id')) notes.push('nexusSku: Meta\'s retailer id matched to this business\'s Nexus SKUs (a catalog fed by another system, e.g. Shopify, may use other ids: then null).')
  if (left.size) notes.push(`Meta also sent ${[...left].join(', ')}, which Nexus does not show.`)
  if (read!.cut) notes.push('Meta sent more rows than asked; the extra ones were left out and there is no cursor to page on from here.')
  return fitRows({
    ...base, rows, total, more: !!read!.nextAfter || read!.cut, nextAfter: read!.nextAfter,
    ...(plan.compare ? { periods: plan.periods, changes: changesOf(rows) } : plan.periods ? { periods: plan.periods } : {}),
    estimated: plan.estimated, inDevelopment: plan.inDevelopment, missing, dropped: plan.dropped, notes, moneyUnit: moneyUnit(account.currency),
  })
}

// ── meta-ads-report: report runs (IN-067 … IN-071) ──────────────────────────────────────────────────────────────────

export const REPORT_ACTIONS = ['start', 'status', 'fetch', 'file'] as const
export const REPORT_KINDS = ['numbers', 'mmm'] as const
export const EXPORT_FORMATS = ['csv', 'xls'] as const

const STATUS_WORDS: Readonly<Record<string, string>> = ownList<string>(Object.entries({
  'Job Not Started': 'Waiting to start at Meta.', 'Job Started': 'Started at Meta, not running yet.', 'Job Running': 'Running at Meta.',
  'Job Completed': 'Finished.', 'Job Failed': 'Failed at Meta (see error); check the read and start it again.', 'Job Skipped': 'Expired at Meta: start it again.',
}))

/** IN-067 / IN-071 — start a report run of the chosen ad account (a numbers read, or Meta's MMM export). */
export async function startReportRun(input: NumbersInput & { kind: typeof REPORT_KINDS[number]; exportFormat?: typeof EXPORT_FORMATS[number] | null; exportName?: string | null }) {
  const account = await metaChosenAccount(input.connectionId)
  let params: Record<string, MetaQueryValue>
  let notes: string[] = []
  if (input.kind === 'mmm') {
    if (input.campaignId || input.adSetId || input.adId) throw new MetaLiveRefusal('An MMM export is of the whole ad account (narrow it with filters on campaign.id or adset.id).')
    params = { level: 'adset', breakdowns: ['mmm'], export_format: 'csv', fields: 'impressions,spend' }
    if (input.datePreset && (input.from || input.to)) throw new MetaLiveRefusal('Name the days one way: a datePreset, or from and to.')
    const today = accountToday(account.timeZone ?? 'UTC')
    if (input.from || input.to) {
      const to = input.to ?? today
      const from = input.from ?? to
      if (!isDay(from) || !isDay(to) || to < from || to > today || from < monthsBefore(today, MAX_MONTHS_BACK)) throw new MetaLiveRefusal(`The days are YYYY-MM-DD, first before last, not after today, and not before ${monthsBefore(today, MAX_MONTHS_BACK)} (37 months).`)
      params.time_range = { since: from, until: to }
    } else {
      const preset = input.datePreset ?? 'last_30d'
      if (!(DATE_PRESETS as readonly string[]).includes(preset)) throw new MetaLiveRefusal(`datePreset is one of ${DATE_PRESETS.join(', ')}.`)
      params.date_preset = preset
    }
    if (input.timeIncrement && input.timeIncrement !== 'daily' && input.timeIncrement !== 1 && input.timeIncrement !== 'all_days') throw new MetaLiveRefusal('An MMM export is by day (daily) or for the whole period (all_days): Meta\'s marketing-mix-modeling page.')
    params.time_increment = input.timeIncrement === 'daily' || input.timeIncrement === 1 ? 1 : 'all_days'
    const filters: Array<{ field: string; operator: string; value: unknown }> = []
    const ids = idBudget()
    for (const f of input.filters ?? []) {
      if (!lookup(MMM_FILTERS, f.field)?.includes(f.operator)) throw new MetaLiveRefusal(`An MMM export takes only these filters (Meta's page): ${Object.entries(MMM_FILTERS).map(([k, o]) => `${k} ${o.join('/')}`).join(', ')}.`)
      const problem = filterValueProblem(f.field, f.operator, f.value)
      if (problem) throw new MetaLiveRefusal(`${problem}.`)
      await ids.check(account, f, 'report.filterOwnerCheck')
      filters.push({ field: f.field, operator: f.operator, value: f.value })
    }
    if (filters.length > 20) throw new MetaLiveRefusal('At most 20 filters at once.')
    if (filters.length) params.filtering = filters
    notes = ['MMM: impressions and spend per ad set and day (spend estimated), by country, region, device, platform and placement. Meta delivers it ONLY as a CSV file: action file gives its link when the run is done (action fetch has no rows for it).', REPORT_QUOTAS]
  } else {
    if (input.view === 'catalogue' || input.view === 'portfolio' || input.view === 'check') throw new MetaLiveRefusal('A report run reads view numbers, products, assets or hourly.')
    // Meta documents the POST on the campaign and ad set insights edges too; Nexus sends it on the chosen account's path
    // only (one anchored path the gateway checks against the chosen account), the object as one more filter (planNumbers,
    // counted in its 20).
    const plan = await planNumbers(account, { ...input, asReportRun: true })
    // A report run asks only fields on Meta's v26 list: one Meta refuses would fail the whole run (a direct read drops it).
    params = { ...plan.query, fields: plan.fields.join(',') }
    if (plan.extras.length) plan.notes.push(`${plan.extras.join(', ')}: not on Meta's v26 field list, so a report run does not ask them (meta-ads-numbers tries them in a direct read).`)
    if (input.exportFormat) {
      params.export_format = input.exportFormat
      if (input.exportName) {
        if (!/^[A-Za-z0-9 _.-]{1,60}$/.test(input.exportName)) throw new MetaLiveRefusal('exportName is a plain file name (letters, digits, space, _ . -; at most 60).')
        params.export_name = input.exportName
      }
    }
    // Review B-8 — inside a background run, reach older than 13 months is not "a background report gets it": this run
    // counts against Meta's 10 such runs a day per ad account, and past that Meta leaves reach out without an error.
    notes = [...plan.notes.map((n) => (n.startsWith('Meta leaves reach, frequency and cost per 1,000 people reached out of a direct read')
      ? 'Reach, frequency and cost per 1,000 people reached with breakdowns more than 13 months back: this background run counts against Meta\'s 10 such runs a day per ad account (its best practices); past that Meta leaves them out and says "Reach-related metric breakdowns are unavailable due to rate limit threshold".'
      : n)), REPORT_QUOTAS]
  }
  let answer: GatewayResponse
  try {
    answer = await metaReportRunCall({ connectionId: account.connectionId, operation: `report.start.${input.kind}`, adAccountId: account.adAccountId, params })
  } catch (err) {
    const failure = failureOfThrow(err)
    if (failure) throw new MetaReadError(failure, 'report.start', 0)
    throw err
  }
  if (!answer.ok) throw new MetaReadError(failureOfAnswer(answer), 'report.start', 1)
  const body = answer.json<Row>() ?? {}
  const reportRunId = metaObjectId(body.report_run_id)
  if (!reportRunId) throw new MetaLiveRefusal('Meta answered without a report run id; nothing to follow. Try again in a moment.')
  return {
    account: accountOf(account), reportRunId, kind: input.kind,
    sentence: 'Meta is computing the report in the background (up to an hour for big reads). Ask action status with this reportRunId; fetch the rows when it says finished. Meta keeps the id 30 days; Nexus stores nothing.',
    notes,
  }
}

const RUN_FIELDS = 'id,account_id,async_status,async_percent_completion,time_ref,time_completed'
/** Review B-8 — Meta's quotas on background runs, said at the start. */
const REPORT_QUOTAS = 'Meta\'s quotas: a breakdown switched on per account (impression_device, hourly by the audience\'s time zone, frequency_value) returns its full history only in background runs, min(10, number of ads) per 24 hours (out-of-cycle changes 2026-05-08; Meta\'s "ad groups" are ads) — past that it answers empty; reach with breakdowns more than 13 months back, 10 runs a day per ad account (best practices) — past that Meta leaves reach (and frequency, cost per 1,000 people reached) out and says "Reach-related metric breakdowns are unavailable due to rate limit threshold".'

/**
 * The run, checked to be the chosen ad account's and a report run, with its state — in ONE read (review A F5): Nexus's
 * stored rows first (a campaign, ad set, ad or creative of the account is not a run), then `account_id` and a run's own two
 * fields (services/meta/meta-kinds.ts reportrun) with the state, from the same answer. When Meta refuses the SDK's extra
 * fields, the best-practices page's own; when it refuses a run's own fields, the id is no report run. When Meta could not
 * be asked, the refusal says so — never "does not belong".
 */
async function ownRun(account: MetaChosenAccount, reportRunId: string) {
  const id = metaObjectId(reportRunId)
  if (!id) throw new MetaLiveRefusal(`"${reportRunId}" is not a Meta report run id (digits).`)
  const stored = await objectKindOf(account, id)
  if (stored) throw new MetaLiveRefusal(`That id is ${withArticle(META_KIND_WORDS[stored])} of this ad account, not a report run.`)
  const read = async (fields: string, operation: string) => (await metaReadOne<Row>({ connectionId: account.connectionId }, { operation, path: id, query: { fields } })).body
  const unconfirmed = (err: MetaReadError) => new MetaLiveRefusal(`Nexus could not confirm that this report run is of the ad account this business chose (${err.failure.sentence}), so it is not read.`)
  let body: Row
  try {
    body = await read(`${RUN_FIELDS},date_start,date_stop,is_running`, 'report.ownerCheck')
  } catch (err) {
    if (!(err instanceof MetaReadError)) throw err
    if (!fieldRefused(err) || err.failure.shrink) throw unconfirmed(err)
    try {
      body = await read(RUN_FIELDS, 'report.coreOwnerCheck')
    } catch (again) {
      if (!(again instanceof MetaReadError)) throw again
      if (again.failure.origin === 'meta' && /nonexisting field/i.test(again.failure.sentence)) throw new MetaLiveRefusal('That id is not a report run (Meta does not know a report run\'s own fields on it), so it is not read.')
      throw unconfirmed(again)
    }
  }
  if (metaAdAccountId(body.account_id) !== account.adAccountId) throw new MetaLiveRefusal('That report run does not belong to the ad account this business chose, so it is not read.')
  if (META_KIND_FIELDS.reportrun.some((name) => { const v = body[name]; return v === undefined || v === null || v === '' })) throw new MetaLiveRefusal('That id is not a report run of this ad account, so it is not read.')
  const status = text(body.async_status)
  const percent = num(body.async_percent_completion)
  return { id, body, status, percent, done: status === 'Job Completed' && percent === 100 }
}

const unixIso = (v: unknown) => { const n = num(v); return n ? new Date(n * 1000).toISOString() : null }

/** IN-068 — a report run's progress (and, when it failed, Meta's error since v25). */
export async function reportRunStatus(input: { connectionId?: string | null; reportRunId: string }) {
  const account = await metaChosenAccount(input.connectionId)
  const run = await ownRun(account, input.reportRunId)
  let error: Record<string, unknown> | null = null
  let errorNotRead: string | null = null
  if (run.status === 'Job Failed') {
    try {
      const { body } = await metaReadOne<Row>({ connectionId: account.connectionId }, { operation: 'report.error', path: run.id, query: { fields: 'error_code,error_subcode,error_message,error_user_title,error_user_msg' } })
      error = { code: num(body.error_code), subcode: num(body.error_subcode), message: text(body.error_message), title: text(body.error_user_title), userMessage: text(body.error_user_msg) }
      const code = `${error.code ?? ''}/${error.subcode ?? ''}`
      if (code === '-3/1504045') error.meaning = 'The report was too large: fewer days, a lower level or fewer metrics.'
      if (code === '-2/2490547') error.meaning = 'Meta could not make the report: try again later.'
    } catch (err) {
      if (!(err instanceof MetaReadError)) throw err
      errorNotRead = err.failure.sentence
    }
  }
  return {
    account: accountOf(account), reportRunId: run.id, status: run.status, statusText: run.status ? STATUS_WORDS[run.status] ?? run.status : null,
    percent: run.percent, done: run.done, dateStart: text(run.body.date_start), dateStop: text(run.body.date_stop),
    startedAt: unixIso(run.body.time_ref), completedAt: unixIso(run.body.time_completed), running: typeof run.body.is_running === 'boolean' ? run.body.is_running : null,
    ...(error ? { error } : {}), ...(errorNotRead ? { errorNotRead } : {}),
    sentence: run.done ? 'Finished: action fetch reads the rows (or action file the file).' : run.status === 'Job Skipped' ? 'Expired: start it again.' : run.status === 'Job Failed' ? 'Failed: see error.' : 'Not finished yet: ask again in a minute.',
  }
}

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : JSON.stringify(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
/** IN-070 — Nexus's own CSV of the rows (`withMoney`: the amounts too, for a person who may see them). */
export function rowsCsv(rows: MappedRow[], withMoney: boolean): string {
  const lines = rows.map((r) => ({
    date_start: r.dateStart, date_stop: r.dateStop, campaign_id: r.campaignId, campaign_name: r.campaignName, adset_id: r.adSetId, adset_name: r.adSetName,
    ad_id: r.adId, ad_name: r.adName, ...Object.fromEntries(Object.entries(r.breakdown ?? {}).map(([k, v]) => [k, v])),
    ...(r.info ?? {}), ...flat(r.numbers), ...(withMoney ? Object.fromEntries(Object.entries(flat(r.money)).map(([k, v]) => [`${k} (cents)`, v])) : {}),
  } as Record<string, unknown>))
  const columns = [...new Set(lines.flatMap((l) => Object.keys(l).filter((k) => l[k] !== undefined && l[k] !== null)))]
  return [columns.map(csvCell).join(','), ...lines.map((l) => columns.map((c) => csvCell(l[c])).join(','))].join('\n')
}
const MAX_CSV_CHARS = 200_000

/** IN-069 — the rows of a finished run (cursor paging); `format: csv` — Nexus's own CSV of them. */
export async function reportRunRows(input: { connectionId?: string | null; reportRunId: string; maxRows?: number | null; after?: string | null; format?: 'rows' | 'csv' | null }) {
  const account = await metaChosenAccount(input.connectionId)
  const run = await ownRun(account, input.reportRunId)
  if (!run.done) throw new MetaLiveRefusal(`The report run is not finished (${run.status ? STATUS_WORDS[run.status] ?? run.status : 'no status'}${run.percent !== null ? `, ${run.percent} %` : ''}): ask action status again in a minute.`)
  const maxRows = Math.min(MAX_NUMBER_ROWS, Math.max(1, Math.trunc(input.maxRows ?? 200)))
  let read: Awaited<ReturnType<typeof readPages>>
  try {
    read = await readPages(account.connectionId, 'report.rows', `${run.id}/insights`, {}, maxRows, input.after ?? null)
  } catch (err) {
    if (err instanceof MetaReadError && err.failure.origin === 'meta') throw new MetaLiveRefusal(`Meta did not give this run's rows (${err.failure.sentence}). An MMM export has no rows here — Meta delivers it only as a CSV file: action file.`)
    throw err
  }
  const ctx = { currency: account.currency }
  const left = new Set<string>()
  // A run Nexus did not start may hold any breakdown: the ones on Nexus's list are shown as breakdowns.
  const breakdowns = Object.keys(META_INSIGHT_BREAKDOWNS).filter((b) => read.rows.some((r) => r[b] !== undefined))
  const rows = read.rows.map((r) => mapInsightRow(r, ctx, breakdowns, left))
  const notes = left.size ? [`Meta also sent ${[...left].join(', ')}, which Nexus does not show.`] : []
  if (input.format === 'csv') {
    let csv = rowsCsv(rows, false)
    let csvWithMoney = rowsCsv(rows, true)
    let cut = false
    if (csvWithMoney.length > MAX_CSV_CHARS) {
      const kept = [...rows]
      while (kept.length > 1 && rowsCsv(kept, true).length > MAX_CSV_CHARS) kept.splice(Math.floor(kept.length * 0.8))
      csv = rowsCsv(kept, false)
      csvWithMoney = rowsCsv(kept, true)
      cut = true
    }
    return {
      account: accountOf(account), reportRunId: run.id, rowCount: rows.length, csv, csvWithMoney, more: !!read.nextAfter || cut || read.cut, nextAfter: cut || read.cut ? null : read.nextAfter,
      notes: [...notes, 'csv: Nexus\'s own file of the rows without amounts; csvWithMoney with the amounts in minor units (cents) — for a person who may see ad spend. Excel opens either. Meta\'s own CSV / Excel: action file.', ...(cut ? ['The file was cut to fit one answer: ask fewer rows (maxRows).'] : [])],
    }
  }
  // Review A F6 — the rows are capped like meta-ads-numbers' answer (a cut answer carries no cursor).
  return fitRows({ account: accountOf(account), reportRunId: run.id, rows, more: !!read.nextAfter || read.cut, nextAfter: read.nextAfter, notes, moneyUnit: moneyUnit(account.currency) })
}

/** The documented export_report link (INSBP): it needs the viewer signed in to Meta with access to the ad account. */
const EXPORT_REPORT = 'https://www.facebook.com/ads/ads_insights/export_report/'
function exportReportLink(runId: string, format: string, name: string | null): string {
  const url = new URL(EXPORT_REPORT)
  url.searchParams.set('report_run_id', runId)
  if (name) url.searchParams.set('name', name)
  url.searchParams.set('format', format)
  return url.toString()
}
/** Meta's own file link, passed on only in the documented export_report shape (re-built from its run, name and format). */
function recognisedExportLink(raw: unknown, runId: string): string | null {
  const t = text(raw)
  if (!t) return null
  let url: URL
  try { url = new URL(t) } catch { return null }
  if (url.protocol !== 'https:' || !/^(www|business)\.facebook\.com$/.test(url.hostname) || !/^\/ads\/ads_insights\/export_report\/?$/.test(url.pathname)) return null
  if ((url.searchParams.get('report_run_id') ?? runId) !== runId) return null
  const format = url.searchParams.get('format')
  return exportReportLink(runId, format === 'xls' ? 'xls' : 'csv', url.searchParams.get('name')?.replace(/[^A-Za-z0-9 _.-]/g, '').slice(0, 60) || null)
}

/**
 * IN-070 / IN-071 — Meta's own file of a finished run: CSV or Excel through Meta's export_report endpoint (not part of the
 * versioned Graph API, its format may change: a file for a person, never parsed by Nexus), and an MMM export's CSV at the
 * run's `async_report_url`. A link is passed on ONLY in that documented shape, which opens for a person signed in to Meta
 * with access to the ad account; any other link Meta gives (it may open without signing in) is never passed on or kept.
 */
export async function reportRunFile(input: { connectionId?: string | null; reportRunId: string; format?: typeof EXPORT_FORMATS[number] | null; name?: string | null }) {
  const account = await metaChosenAccount(input.connectionId)
  const run = await ownRun(account, input.reportRunId)
  if (!run.done) throw new MetaLiveRefusal(`The report run is not finished (${run.status ? STATUS_WORDS[run.status] ?? run.status : 'no status'}): ask action status again in a minute.`)
  const name = input.name ?? null
  if (name && !/^[A-Za-z0-9 _.-]{1,60}$/.test(name)) throw new MetaLiveRefusal('name is a plain file name (letters, digits, space, _ . -; at most 60).')
  let metaLink: string | null = null
  let metaLinkNote: string | null = null
  try {
    const { body } = await metaReadOne<Row>({ connectionId: account.connectionId }, { operation: 'report.file', path: run.id, query: { fields: 'async_report_url,is_async_export' } })
    if (body.async_report_url) {
      metaLink = recognisedExportLink(body.async_report_url, run.id)
      if (!metaLink) metaLinkNote = 'Meta gave a file link Nexus does not recognise (it may open without signing in), so Nexus neither passes it on nor keeps it; download the file in Ads Manager, or use the export link below.'
    }
  } catch (err) {
    if (!(err instanceof MetaReadError) || err.failure.authLost || err.failure.throttled) throw err
    metaLinkNote = `Meta did not give the run's own file link (${err.failure.sentence}).`
  }
  const format = input.format ?? 'csv'
  return {
    account: accountOf(account), reportRunId: run.id,
    exportLink: { metaFile: metaLink, export: exportReportLink(run.id, format, name), format },
    ...(metaLinkNote ? { metaLinkNote } : {}),
    sentence: 'Open the link while signed in to Meta (Facebook) as a person with access to this ad account: Meta then downloads the file. The links hold the business\'s ad numbers — share them only with people who may see them. metaFile is the run\'s own file (an MMM export\'s CSV, or the export Meta made when the run was started with exportFormat); export is Meta\'s export_report endpoint for CSV or Excel (outside Meta\'s versioned API: its format may change). Nexus\'s own CSV of the rows: action fetch with format csv.',
  }
}

// ── meta-ads-saved-reports (IN-072 … IN-079, IN-900 … IN-902) ────────────────────────────────────────────────────────

export const SAVED_VIEWS = ['mmm-reports', 'mmm-schedules', 'exports', 'report-builder', 'custom-metrics', 'custom-pivots', 'pivot-preview', 'report-specs', 'measurement', 'partner-studies', 'partner-viewability', 'what-meta-cannot'] as const
export type SavedView = typeof SAVED_VIEWS[number]
export const SAVED_SCOPES = ['account', 'portfolio'] as const
export const MEASUREMENT_TYPES = ['third_party_mta_report', 'partner_lift_study_report', 'mmm_report_v2'] as const
export const PANEL_STATUSES = ['CREATED', 'FAILURE', 'IN_PROGRESS', 'SCHEDULED', 'SUCCESS'] as const
export const RECURRING_STATUSES = ['CANCELLED', 'CREATED', 'FINISHED', 'ONGOING'] as const
export const STUDY_TYPES = ['BRAND_LIFT', 'PANEL_SALES_ATTRIBUTION', 'REACH'] as const
export const VIEWABILITY_PLATFORMS = ['AUDIENCE_NETWORK', 'FACEBOOK', 'INSTAGRAM'] as const
export const VIEWABILITY_TYPES = ['DISPLAY_EVENT', 'IMPRESSION', 'VIDEO_EVENT'] as const

/**
 * What Meta's API cannot do around saved reports, each with the reference page that proves it ("You can't perform this
 * operation on this endpoint" for create / update / delete, or an empty Creating section) — a person does these in Ads
 * Manager › Reports (Ads Reporting).
 */
export const META_CANNOT: ReadonlyArray<{ what: string; where: string; proof: string; documented: boolean }> = [
  // documented: true — the page says "You can't perform this operation on this endpoint". documented: false — the page's
  // Creating section is empty and Meta's SDK class has only api_get: Meta documents no API for it (review B-7).
  // reference/ad-account/ads_reporting_mmm_reports, reference/business/ads_reporting_mmm_reports: Creating / Updating / Deleting "can't".
  { what: 'make, change or delete an MMM report of Ads Reporting', where: 'Ads Manager › Reports › Marketing Mix Modeling Data Export', proof: 'reference/ad-account/ads_reporting_mmm_reports', documented: true },
  // reference/ad-account/ads_reporting_mmm_schedulers: Creating / Updating / Deleting "can't".
  { what: 'schedule an MMM export or change a schedule', where: 'Ads Manager › Reports (scheduled exports)', proof: 'reference/ad-account/ads_reporting_mmm_schedulers', documented: true },
  // reference/business/ads_reporting_exports: Creating / Updating / Deleting "can't".
  { what: 'make, share or delete an Ads Reporting export', where: 'Ads Manager › Reports › Exports', proof: 'reference/business/ads_reporting_exports', documented: true },
  // reference/ad-account/ad_custom_derived_metrics: Creating empty, Updating / Deleting "can't"; SDK adcustomderivedmetrics.py api_get only.
  { what: 'create or change a custom metric (a formula column)', where: 'Ads Manager › Columns › Custom metrics', proof: 'reference/ad-account/ad_custom_derived_metrics', documented: false },
  // reference/business/custom_pivots: Creating / Updating / Deleting "can't".
  { what: 'make or change a custom breakdown (custom pivot) or a saved report', where: 'Ads Manager › Reports', proof: 'reference/business/custom_pivots', documented: true },
  // reference/ad-account/report_specs: Reading and Creating empty, Updating / Deleting "can't" (view report-specs still asks the read).
  { what: 'create or change report specs', where: 'Ads Manager › Reports', proof: 'reference/ad-account/report_specs', documented: false },
  // reference/ad-account/reporting: Creating empty, Updating / Deleting "can't"; SDK adsreportbuilder.py api_get only.
  { what: 'save a Report Builder table as a report', where: 'Ads Manager › Reports', proof: 'reference/ad-account/reporting', documented: false },
  // reference/business/third_party_partner_panel_requests (+ recurring, viewability), measurement_reports: Creating empty or "can't";
  // SDK thirdpartypartnerpanelrequest.py api_get only — studies are set up with the measurement partner.
  { what: 'create or change a measurement-partner study, brand-lift panel or viewability report', where: 'with the Meta measurement partner (and Meta)', proof: 'reference/business/third_party_partner_panel_requests', documented: false },
]

/** One plain sentence per entry: "Meta cannot …" where its page says so, "Meta documents no API to …" where it is silent. */
export const cannotSentence = (c: typeof META_CANNOT[number]) => (c.documented ? `Meta cannot ${c.what} by API (${c.proof}): ${c.where}.` : `Meta documents no API to ${c.what} (${c.proof}; its SDK only reads it): ${c.where}.`)

/** A business-level read: the chosen account's portfolio, and only when no other business in Nexus reads an ad account of it. */
async function ownPortfolio(account: MetaChosenAccount): Promise<string> {
  if (!account.businessId) throw new MetaLiveRefusal('The chosen ad account names no Meta business portfolio, so the portfolio\'s reports cannot be asked for (view mmm-reports and mmm-schedules read the ad account\'s own).')
  if ((await takenIds('PORTFOLIO', [account.businessId])).has(account.businessId)) {
    throw new MetaLiveRefusal('Another business in Nexus reads an ad account of this Meta business portfolio, so the portfolio\'s reports are not read here (they would show that business\'s reports too). The ad account\'s own: views mmm-reports and mmm-schedules with scope account, custom-metrics, report-builder.')
  }
  return account.businessId
}

/** One page of a list (cursor `after`), as Meta answers it. */
async function listPage(connectionId: string, operation: string, path: string, query: Record<string, MetaQueryValue>, maxRows: number, after: string | null) {
  const read = await readPages(connectionId, operation, path, query, maxRows, after)
  return { rows: read.rows, summary: read.summary, nextAfter: read.nextAfter, more: !!read.nextAfter || read.cut }
}

const MMM_REPORT_FIELDS = 'id,export_name,export_format,export_type,async_status,mmm_status,time_start,has_seen'
const MMM_SCHEDULE_FIELDS = 'id,report_name,schedule_frequency,ad_account_ids,filtering'
/** Never async_report_url or link_sharing_uri: links that may open without signing in. */
const EXPORT_FIELDS = 'id,export_name,export_format,export_type,async_status,async_percent_completion,time_start,time_completed,expiry_time,export_download_time,is_sharing,link_sharing_expiration_time,has_seen'
/** Never creator or deletor (people). */
const CUSTOM_METRIC_FIELDS = 'id,name,description,formula,format_type,custom_derived_metric_type,permission,scope,saved_report_id,has_attribution_windows,has_inline_attribution_window,creation_time,deletion_time,ad_account_id'
/** Never creator or update_by (people). */
const PIVOT_FIELDS = 'id,name,description,permission,scope,rules,creation_time,update_time'
const PIVOT_PREVIEW_FIELDS = 'account_id,account_name,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,custom_breakdown'
/** Never download_urls (files that may open without signing in). */
const MEASUREMENT_FIELDS = 'id,report_type,status,metadata'
const PANEL_FIELDS = 'id,description,country,status,study_type,study_start_time,study_end_time,created_time,modified_time,owner_panel_id,owner_panel_name,owner_instance_id,adentities_ids'
const RECURRING_FIELDS = 'id,description,country,status,study_type,cadence,start_time,end_time,created_time,modified_time,owner_panel_id,owner_panel_name,owner_instance_id,adentities_ids'
const VIEWABILITY_FIELDS = 'id,description,ds,hour,metric,platform,status,total_file_count,created_time,modified_time,owner_instance_id'

const pickText = (r: Row, names: string) => Object.fromEntries(names.split(',').map((n) => [n, typeof r[n] === 'object' ? raw(r[n]) : r[n] === undefined ? null : r[n]]))

export interface SavedInput {
  connectionId?: string | null
  view: SavedView
  scope?: typeof SAVED_SCOPES[number] | null
  metrics?: string[] | null
  dimensions?: string[] | null
  datePreset?: string | null
  from?: string | null
  to?: string | null
  comparisonFrom?: string | null
  comparisonTo?: string | null
  windows?: string[] | null
  filters?: NumbersFilter[] | null
  sortBy?: string | null
  order?: typeof SORT_ORDERS[number] | null
  withTotal?: boolean
  offset?: number | null
  permission?: 'private' | 'shared' | null
  savedReportId?: string | null
  groupName?: string | null
  reportType?: typeof MEASUREMENT_TYPES[number] | null
  recurring?: boolean
  statuses?: string[] | null
  studyTypes?: string[] | null
  platform?: typeof VIEWABILITY_PLATFORMS[number] | null
  type?: typeof VIEWABILITY_TYPES[number] | null
  maxRows?: number | null
  after?: string | null
}

/** meta-ads-saved-reports — the Ads Reporting artefacts and partner reports Meta lets a system user READ. */
export async function savedReports(input: SavedInput) {
  if (input.view === 'what-meta-cannot') return { items: META_CANNOT.map((c) => ({ ...c, sentence: cannotSentence(c) })), sentence: 'Meta\'s API reads these artefacts but offers (or documents) no way to make or change them: a person does it in Ads Manager › Reports (Ads Reporting) or with the measurement partner.' }
  const account = await metaChosenAccount(input.connectionId)
  const { connectionId } = account
  const maxRows = Math.min(MAX_NUMBER_ROWS, Math.max(1, Math.trunc(input.maxRows ?? 100)))
  const after = input.after ?? null
  const base = { account: accountOf(account) }
  const cannot = (proof: string) => META_CANNOT.filter((c) => c.proof === proof).map(cannotSentence)
  switch (input.view) {
    case 'mmm-reports': {
      // IN-072 — the account's (or the portfolio's) MMM reports made in Ads Reporting.
      const portfolio = input.scope === 'portfolio'
      const path = portfolio ? `${await ownPortfolio(account)}/ads_reporting_mmm_reports` : `${act(account.adAccountId)}/ads_reporting_mmm_reports`
      const read = await listPage(connectionId, `saved.mmmReports.${portfolio ? 'portfolio' : 'account'}`, path, { fields: MMM_REPORT_FIELDS }, maxRows, after)
      return { ...base, scope: portfolio ? 'portfolio' : 'account', items: read.rows.map((r) => ({ reportId: text(r.id), name: text(r.export_name), format: text(r.export_format), type: text(r.export_type), status: text(r.async_status), mmmStatus: text(r.mmm_status), startedAt: text(r.time_start), seen: typeof r.has_seen === 'boolean' ? r.has_seen : null })), more: read.more, nextAfter: read.nextAfter, notes: [...cannot('reference/ad-account/ads_reporting_mmm_reports'), 'Meta documents these nodes\' fields only in its SDK; the file itself is downloaded in Ads Reporting. Nexus\'s own MMM export: meta-ads-report action start with kind mmm.'] }
    }
    case 'mmm-schedules': {
      // IN-073 — the scheduled MMM exports; a portfolio schedule that does not name the chosen account is its id only.
      const portfolio = input.scope === 'portfolio'
      const path = portfolio ? `${await ownPortfolio(account)}/ads_reporting_mmm_schedulers` : `${act(account.adAccountId)}/ads_reporting_mmm_schedulers`
      const read = await listPage(connectionId, `saved.mmmSchedules.${portfolio ? 'portfolio' : 'account'}`, path, { fields: MMM_SCHEDULE_FIELDS }, maxRows, after)
      return {
        ...base, scope: portfolio ? 'portfolio' : 'account',
        items: read.rows.map((r) => {
          const accounts = (Array.isArray(r.ad_account_ids) ? r.ad_account_ids : []).map(metaAdAccountId).filter((x): x is string => !!x)
          if (portfolio && !accounts.includes(account.adAccountId)) return { scheduleId: text(r.id), namesThisAdAccount: false }
          return { scheduleId: text(r.id), name: text(r.report_name), frequency: text(r.schedule_frequency), namesThisAdAccount: true, otherAdAccounts: accounts.filter((x) => x !== account.adAccountId).length, filtering: raw(r.filtering) }
        }),
        more: read.more, nextAfter: read.nextAfter, notes: cannot('reference/ad-account/ads_reporting_mmm_schedulers'),
      }
    }
    case 'exports': {
      // IN-074 — the portfolio's Ads Reporting exports (never their file or sharing links).
      const read = await listPage(connectionId, 'saved.exports', `${await ownPortfolio(account)}/ads_reporting_exports`, { fields: EXPORT_FIELDS }, maxRows, after)
      return { ...base, items: read.rows.map((r) => ({ exportId: text(r.id), name: text(r.export_name), format: text(r.export_format), type: text(r.export_type), status: text(r.async_status), percent: num(r.async_percent_completion), startedAt: text(r.time_start), completedAt: text(r.time_completed), expiresAt: text(r.expiry_time), downloadedAt: text(r.export_download_time), shared: typeof r.is_sharing === 'boolean' ? r.is_sharing : null, sharingExpiresAt: text(r.link_sharing_expiration_time), seen: typeof r.has_seen === 'boolean' ? r.has_seen : null })), more: read.more, nextAfter: read.nextAfter, notes: [...cannot('reference/business/ads_reporting_exports'), 'Nexus never reads an export\'s file or sharing link (they may open without signing in): the file is downloaded in Ads Manager › Reports › Exports.'] }
    }
    case 'report-builder': {
      // IN-075 — Ads Reporting's Report Builder table (the only edge with a comparison period, IN-026).
      const metrics = [...new Set(input.metrics ?? ['spend', 'impressions', 'clicks'])]
      for (const m of metrics) if (!REPORT_BUILDER_METRICS.includes(m)) throw new MetaLiveRefusal(`"${m}" is not a metric Nexus sends the Report Builder (the scalar insights metrics, view catalogue of meta-ads-numbers).`)
      const dimensions = [...new Set(input.dimensions ?? ['campaign_name'])]
      for (const d of dimensions) if (!(REPORT_BUILDER_DIMENSIONS as readonly string[]).includes(d)) throw new MetaLiveRefusal(`"${d}" is not a dimension Nexus sends (${REPORT_BUILDER_DIMENSIONS.join(', ')}).`)
      if (metrics.length > 30 || dimensions.length > 4) throw new MetaLiveRefusal('At most 30 metrics and 4 dimensions.')
      const today = accountToday(account.timeZone ?? 'UTC')
      const query: Record<string, MetaQueryValue> = { metrics, dimensions }
      const days = (from: string | null | undefined, to: string | null | undefined, what: string) => {
        const t = to ?? today
        const f = from ?? t
        if (!isDay(f) || !isDay(t) || t < f || t > today || f < monthsBefore(today, MAX_MONTHS_BACK)) throw new MetaLiveRefusal(`${what}: YYYY-MM-DD, first before last, not after today, within 37 months.`)
        return { since: f, until: t }
      }
      if (input.datePreset && (input.from || input.to)) throw new MetaLiveRefusal('Name the days one way: a datePreset, or from and to.')
      if (input.from || input.to) query.time_range = days(input.from, input.to, 'the days')
      else query.date_preset = input.datePreset && (DATE_PRESETS as readonly string[]).includes(input.datePreset) ? input.datePreset : (() => { if (input.datePreset) throw new MetaLiveRefusal(`datePreset is one of ${DATE_PRESETS.join(', ')}.`); return 'last_30d' })()
      if (input.comparisonFrom || input.comparisonTo) query.comparison_time_range = days(input.comparisonFrom, input.comparisonTo, 'the comparison days')
      const windows = [...new Set(input.windows ?? [])]
      for (const w of windows) if (!(REPORT_BUILDER_WINDOWS as readonly string[]).includes(w)) throw new MetaLiveRefusal(`${w}: the Report Builder's windows that still answer are ${REPORT_BUILDER_WINDOWS.join(', ')} (7d_view and 28d_view return no data since 2026-01-12).`)
      if (windows.length) query.attribution_windows = windows
      const filtering: Array<{ field: string; operator: string; value: unknown }> = []
      const ids = idBudget()
      for (const f of input.filters ?? []) {
        if (lookup(FILTER_FIELDS, f.field)?.value === 'money') throw new MetaLiveRefusal('The Report Builder takes no amount filter from Nexus.')
        const problem = filterValueProblem(f.field, f.operator, f.value)
        if (problem) throw new MetaLiveRefusal(`${problem}.`)
        await ids.check(account, f, 'saved.filterOwnerCheck')
        filtering.push({ field: f.field, operator: f.operator, value: f.value })
      }
      if (filtering.length > 20) throw new MetaLiveRefusal('At most 20 filters at once.')
      if (filtering.length) query.filtering = filtering
      if (input.sortBy) {
        if (!metrics.includes(input.sortBy) && !dimensions.includes(input.sortBy)) throw new MetaLiveRefusal('sortBy is one of the metrics or dimensions asked.')
        query.sorting = [{ field: input.sortBy, direction: input.order === 'ascending' ? 'asc' : 'desc' }]
      }
      if (input.withTotal) { query.default_summary = true; query.summary_count = true }
      if (typeof input.offset === 'number') query.offset = Math.max(0, Math.trunc(input.offset))
      const read = await listPage(connectionId, 'saved.reportBuilder', `${act(account.adAccountId)}/reporting`, query, maxRows, after)
      return {
        ...base, query: { ...query }, rowSets: read.rows.length,
        tableAsMeta: { data: raw(read.rows), summary: raw(read.summary) },
        more: read.more, nextAfter: read.nextAfter,
        notes: [...cannot('reference/ad-account/reporting'), 'Meta documents this edge\'s parameters but not its metric and dimension names or its rows\' shape: tableAsMeta is Meta\'s answer as it is (amounts in Meta\'s own units), for a person who may see ad spend. When Meta refuses a name, its sentence says which. The insights numbers with Nexus\'s units: meta-ads-numbers.'],
      }
    }
    case 'custom-metrics': {
      // IN-076 — the account's custom metrics (formula columns); querying them in insights is not documented.
      const read = await listPage(connectionId, 'saved.customMetrics', `${act(account.adAccountId)}/ad_custom_derived_metrics`, { fields: CUSTOM_METRIC_FIELDS }, maxRows, after)
      return { ...base, items: read.rows.filter((r) => !r.ad_account_id || metaAdAccountId(r.ad_account_id) === account.adAccountId).map((r) => ({ metricId: text(r.id), ...pickText(r, 'name,description,formula,format_type,custom_derived_metric_type,permission,scope,saved_report_id,has_attribution_windows,has_inline_attribution_window,creation_time,deletion_time') })), more: read.more, nextAfter: read.nextAfter, notes: [...cannot('reference/ad-account/ad_custom_derived_metrics'), 'Meta answers custom metrics in Ads Manager\'s reports; how to ask one in the insights API is not documented (its error 2/1504042 "Invalid Custom Metrics" shows it exists): meta-ads-numbers asks Meta\'s own metrics, and Nexus computes a formula from them on request.'] }
    }
    case 'custom-pivots': {
      // IN-077 — the portfolio's custom breakdowns of saved reports (people's ids are never asked).
      const query: Record<string, MetaQueryValue> = { fields: PIVOT_FIELDS }
      if (input.permission) query.permission = input.permission
      if (input.savedReportId) {
        if (!/^\d{1,25}$/.test(input.savedReportId)) throw new MetaLiveRefusal('savedReportId is digits.')
        query.saved_report_id = input.savedReportId
      }
      const read = await listPage(connectionId, 'saved.customPivots', `${await ownPortfolio(account)}/custom_pivots`, query, maxRows, after)
      return { ...base, items: read.rows.map((r) => ({ pivotId: text(r.id), ...pickText(r, 'name,description,permission,scope,rules,creation_time,update_time') })), more: read.more, nextAfter: read.nextAfter, notes: [...cannot('reference/business/custom_pivots'), 'Saved reports have ids (saved_report_id) but Meta has no API to list, make or change them.'] }
    }
    case 'pivot-preview': {
      // IN-077 — which campaigns, ad sets and ads fall in each group of a custom breakdown, for the chosen ad account only.
      const query: Record<string, MetaQueryValue> = { fields: PIVOT_PREVIEW_FIELDS, ad_account_ids: [account.adAccountId] }
      if (input.groupName) {
        if (!/^[^\u0000-\u001f"\\]{1,100}$/.test(input.groupName)) throw new MetaLiveRefusal('groupName is a plain text of 1–100 characters.')
        query.group_name = input.groupName
      }
      const today = accountToday(account.timeZone ?? 'UTC')
      if (input.from || input.to) {
        const to = input.to ?? today
        const from = input.from ?? to
        if (!isDay(from) || !isDay(to) || to < from || to > today) throw new MetaLiveRefusal('The days are YYYY-MM-DD, first before last, not after today.')
        query.time_range = { since: from, until: to }
      } else if (input.datePreset) {
        if (!(DATE_PRESETS as readonly string[]).includes(input.datePreset)) throw new MetaLiveRefusal(`datePreset is one of ${DATE_PRESETS.join(', ')}.`)
        query.date_preset = input.datePreset
      }
      const read = await listPage(connectionId, 'saved.pivotPreview', `${await ownPortfolio(account)}/ads_custom_pivots_preview`, query, maxRows, after)
      return {
        ...base,
        items: read.rows.filter((r) => metaAdAccountId(r.account_id) === account.adAccountId).map((r) => ({ campaignId: text(r.campaign_id), campaignName: text(r.campaign_name), adSetId: text(r.adset_id), adSetName: text(r.adset_name), adId: text(r.ad_id), adName: text(r.ad_name), groups: Array.isArray(r.custom_breakdown) ? r.custom_breakdown.map(text) : null })),
        counts: raw(read.summary?.counts), more: read.more, nextAfter: read.nextAfter,
        notes: ['Asked about the chosen ad account only; a row of another ad account is left out. Meta does not document the preview\'s dimensions: its own answer decides.'],
      }
    }
    case 'report-specs': {
      // IN-078 — the page lists the edge with empty Reading / Creating sections: Nexus asks it plainly; Meta's answer decides.
      const read = await listPage(connectionId, 'saved.reportSpecs', `${act(account.adAccountId)}/report_specs`, {}, maxRows, after)
      return { ...base, tableAsMeta: raw(read.rows), count: read.rows.length, more: read.more, nextAfter: read.nextAfter, notes: [...cannot('reference/ad-account/report_specs'), 'Meta documents no field of a report spec: Meta\'s answer as it is (it may hold amounts), for a person who may see ad spend.'] }
    }
    case 'measurement': {
      // IN-079 — measurement-partner reports (multi-touch attribution, partner lift, MMM v2); never their download links.
      const reportType = input.reportType ?? null
      if (!reportType) throw new MetaLiveRefusal(`Name the reportType (${MEASUREMENT_TYPES.join(', ')}): Meta requires it.`)
      const read = await listPage(connectionId, 'saved.measurement', `${await ownPortfolio(account)}/measurement_reports`, { fields: MEASUREMENT_FIELDS, report_type: reportType }, maxRows, after)
      return { ...base, reportType, items: read.rows.map((r) => ({ reportId: text(r.id), type: text(r.report_type), status: text(r.status), metadataAsMeta: raw(r.metadata) })), more: read.more, nextAfter: read.nextAfter, notes: ['Only a Meta measurement partner (MTA, lift or MMM vendor) publishes these to the business; with none, the list is empty. Nexus never reads their download links (files that may open without signing in). metadataAsMeta is Meta\'s answer as it is.', ...cannot('reference/business/third_party_partner_panel_requests')] }
    }
    case 'partner-studies': {
      // IN-900 / IN-901 — third-party panel studies (brand lift, panel sales attribution, reach), one-off or recurring.
      const recurring = input.recurring === true
      const statuses = [...new Set(input.statuses ?? [])]
      const allowed: readonly string[] = recurring ? RECURRING_STATUSES : PANEL_STATUSES
      for (const s of statuses) if (!allowed.includes(s)) throw new MetaLiveRefusal(`statuses are ${allowed.join(', ')}${recurring ? ' (recurring)' : ''}.`)
      const types = [...new Set(input.studyTypes ?? [])]
      for (const t of types) if (!(STUDY_TYPES as readonly string[]).includes(t)) throw new MetaLiveRefusal(`studyTypes are ${STUDY_TYPES.join(', ')}.`)
      const query: Record<string, MetaQueryValue> = { fields: recurring ? RECURRING_FIELDS : PANEL_FIELDS, ...(statuses.length ? { status: statuses } : {}), ...(types.length ? { study_type: types } : {}) }
      const read = await listPage(connectionId, `saved.partnerStudies.${recurring ? 'recurring' : 'once'}`, `${await ownPortfolio(account)}/${recurring ? 'third_party_partner_panel_recurring_requests' : 'third_party_partner_panel_requests'}`, query, maxRows, after)
      return { ...base, recurring, items: read.rows.map((r) => ({ requestId: text(r.id), ...pickText(r, recurring ? 'description,country,status,study_type,cadence,start_time,end_time,created_time,modified_time,owner_panel_id,owner_panel_name,owner_instance_id,adentities_ids' : 'description,country,status,study_type,study_start_time,study_end_time,created_time,modified_time,owner_panel_id,owner_panel_name,owner_instance_id,adentities_ids') })), more: read.more, nextAfter: read.nextAfter, notes: ['Panel studies are run by a Meta-approved measurement partner; with none set up, the list is empty (or Meta refuses: its sentence says why).', ...cannot('reference/business/third_party_partner_panel_requests')] }
    }
    case 'partner-viewability': {
      // IN-902 — third-party viewability reports (daily: start_ds / end_ds required).
      const today = accountToday(account.timeZone ?? 'UTC')
      const to = input.to ?? today
      const from = input.from ?? addDays(to, -29)
      if (!isDay(from) || !isDay(to) || to < from) throw new MetaLiveRefusal('The days are YYYY-MM-DD, first before last.')
      const query: Record<string, MetaQueryValue> = { fields: VIEWABILITY_FIELDS, start_ds: from, end_ds: to, ...(input.platform ? { platform: input.platform } : {}), ...(input.type ? { type: input.type } : {}) }
      const read = await listPage(connectionId, 'saved.partnerViewability', `${await ownPortfolio(account)}/third_party_partner_viewability_requests`, query, maxRows, after)
      return { ...base, from, to, items: read.rows.map((r) => ({ requestId: text(r.id), ...pickText(r, 'description,ds,hour,metric,platform,status,total_file_count,created_time,modified_time,owner_instance_id') })), more: read.more, nextAfter: read.nextAfter, notes: ['Viewability reports come from a viewability partner Meta set up for the business; with none, the list is empty (or Meta refuses). Their files are not read here.'] }
    }
  }
}
