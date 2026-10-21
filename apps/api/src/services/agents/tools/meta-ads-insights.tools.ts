/**
 * Meta ads step 7 (2026-10-21) — Claude's reads of the chosen Meta ad account's numbers (marketing/meta-ads/live-insights.ts
 * has the Meta facts and where they were read; the allow-lists are services/meta/meta-insights-lists.ts). Read only: no
 * tool here changes the account.
 *
 *   meta-ads-numbers        insights at every level, live: any metric of Meta's v26 list, breakdowns and action
 *                           breakdowns (checked before the call), attribution windows, presets, exact days, several periods
 *                           and a comparison Nexus computes, per day / week / month, filters, one sort, Meta's total row;
 *                           views products (matched to Nexus SKUs), assets, hourly; catalogue and check need no Meta call
 *                           (CR-242, IN-001…005, IN-010…022, IN-024…043, IN-046, IN-047, IN-052…061, IN-063…066, IN-086,
 *                           IN-087, IN-089, IN-094, IN-106, IN-107, RC-007)
 *   meta-ads-report         background report runs of the chosen ad account: start (a numbers read, or Meta's MMM
 *                           export), status, fetch (rows, or Nexus's own CSV), file (Meta's own CSV / Excel link) (IN-067…071)
 *   meta-ads-saved-reports  Ads Reporting's MMM reports and schedules, exports, the Report Builder table, custom metrics,
 *                           custom breakdowns and their preview, report specs, measurement-partner reports, panel studies
 *                           and viewability reports, and what Meta's API cannot do there (IN-072…079, IN-900…902)
 * Money: every amount of the answers sits under a restricted key (money, csvWithMoney, exportLink, tableAsMeta,
 * metadataAsMeta) for the ad-spend money permission; a person without it gets the same answer without them, and may not
 * sort or filter by an amount.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolContext, ToolResult } from '../tool-types.js'
import { connectionArg, dayArg, guarded, lower, metaIdArg } from './meta-ads-read.tools.js'
import {
  ASSET_VIEW_BREAKDOWNS, ATTRIBUTIONS, COMPARES, EXPORT_FORMATS, MAX_NUMBER_ROWS, MEASUREMENT_TYPES, metaNumbers, NUMBERS_VIEWS, REPORT_ACTIONS,
  REPORT_KINDS, reportRunFile, reportRunRows, reportRunStatus, SAVED_SCOPES, SAVED_VIEWS, savedReports, SORT_ORDERS, startReportRun,
  STUDY_TYPES, TIME_INCREMENTS, VIEWABILITY_PLATFORMS, VIEWABILITY_TYPES,
  type NumbersFilter, type NumbersInput, type NumbersView, type SavedInput,
} from '../../marketing/meta-ads/live-insights.js'
import { INSIGHT_LEVELS, MAX_PERIODS, META_ACTION_BREAKDOWNS, METRIC_GROUPS, type InsightLevel, type MetricGroup } from '../../meta/meta-insights-lists.js'
import { MetaLiveRefusal } from '../../marketing/meta-ads/live.js'

const ADSPEND = FIELDS.financialsAdspendView
/** Each tool's money keys (every amount sits under one of them). */
export const NUMBERS_MONEY = { money: ADSPEND } as const
export const REPORT_MONEY = { money: ADSPEND, csvWithMoney: ADSPEND, exportLink: ADSPEND } as const
export const SAVED_MONEY = { tableAsMeta: ADSPEND, metadataAsMeta: ADSPEND } as const

const seesMoney = (ctx: ToolContext) => ctx.can(ADSPEND) || ctx.can(FIELDS.financialsView)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const strs = (v: unknown): string[] | null => (Array.isArray(v) ? v as string[] : null)
const DAY = /^\d{4}-\d{2}-\d{2}$/
const FILTER_OPERATORS = ['IN', 'NOT_IN', 'EQUAL', 'NOT_EQUAL', 'CONTAIN', 'NOT_CONTAIN', 'STARTS_WITH', 'ENDS_WITH', 'GREATER_THAN', 'GREATER_THAN_OR_EQUAL', 'LESS_THAN', 'LESS_THAN_OR_EQUAL'] as const

const filterArg = z.array(z.object({
  field: z.string().trim().min(1).max(60).describe('the filter field (DOT notation): campaign.id | adset.id | ad.id | campaign.name | adset.name | ad.name | <level>.effective_status | <level>.impressions | <level>.spend | publisher_platform | platform_position | device_platform | country | region | action_type'),
  operator: z.enum(FILTER_OPERATORS).describe('IN / NOT_IN (a list), EQUAL / NOT_EQUAL, CONTAIN / NOT_CONTAIN / STARTS_WITH / ENDS_WITH (names), GREATER_THAN … LESS_THAN_OR_EQUAL (numbers)'),
  value: z.union([z.string().max(100), z.number(), z.array(z.union([z.string().max(100), z.number()])).max(50)]).optional().describe('the value, or a list for IN / NOT_IN (ids are this ad account\'s own: each is checked)'),
  valueCents: z.number().int().min(0).optional().describe('<level>.spend: the amount in minor units (cents) of the account currency (needs the ad-spend money permission)'),
})).max(20)

/** The arguments of one numbers read (meta-ads-numbers, and meta-ads-report action start). */
const numbersArgs = {
  level: z.preprocess(lower, z.enum(INSIGHT_LEVELS)).optional().describe('what one row is: account | campaign | adset | ad (default: campaign for the account, else the object\'s own kind)'),
  campaignId: metaIdArg('read from this campaign of the chosen ad account (its numbers, or its ad sets\' / ads\' with level)'),
  adSetId: metaIdArg('read from this ad set of the chosen ad account'),
  adId: metaIdArg('read from this ad of the chosen ad account'),
  metrics: z.array(z.string().trim().regex(/^[a-z0-9_]{1,80}$/)).max(100).optional().describe('Meta\'s metric names (view catalogue lists them), e.g. spend, impressions, reach, ctr, cpc, actions, action_values, purchase_roas, results, cost_per_result, video_p75_watched_actions; default: spend, impressions, reach, frequency, clicks, link clicks, CTR, CPC, CPM, actions, action values, purchase ROAS, results, cost per result'),
  groups: z.array(z.preprocess(lower, z.enum(METRIC_GROUPS))).max(METRIC_GROUPS.length).optional().describe(`whole groups of metrics: ${METRIC_GROUPS.join(', ')}`),
  breakdowns: z.array(z.string().trim().regex(/^[a-z0-9_]{1,60}$/)).max(4).optional().describe('split the rows by, e.g. age, gender, country, region, publisher_platform, platform_position (Instagram feed / Explore / Reels / Stories, Threads feed), device_platform, impression_device, comscore_market, user_segment_key (new vs existing customers), frequency_value; only Meta\'s combinations (view catalogue)'),
  assetBreakdown: z.enum(ASSET_VIEW_BREAKDOWNS as [string, ...string[]]).optional().describe('view assets: the asset breakdown (body_asset, title_asset, image_asset, video_asset … or an Advantage+ creative one: creative_automation_asset_id, gen_ai_asset_type, media_type …)'),
  audienceTime: z.boolean().optional().describe('view hourly: by the audience\'s time zone (default: the ad account\'s)'),
  actionBreakdowns: z.array(z.enum(META_ACTION_BREAKDOWNS)).max(4).optional().describe('split the actions by, e.g. action_type (default), action_device, action_destination, action_reaction, action_video_sound, action_carousel_card_name'),
  windows: z.array(z.string().trim().regex(/^[a-z0-9_]{1,40}$/)).max(8).optional().describe('attribution windows to report each action in: 1d_click, 7d_click, 28d_click, 1d_view, 1d_ev, dda, incrementality, default (7d_view and 28d_view return no data since 2026-01-12)'),
  attribution: z.preprocess(lower, z.enum(ATTRIBUTIONS)).optional().describe('ad-set (default: each ad set\'s own setting, as Ads Manager) | account (the ad account\'s setting)'),
  datePreset: z.string().trim().regex(/^[a-z0-9_]{1,30}$/).optional().describe('a ready range: today, yesterday, last_7d, last_14d, last_28d, last_30d (default), last_90d, this_month, last_month, this_quarter, last_quarter, this_year, last_year, this_week_mon_today, last_week_mon_sun, maximum (37 months) …'),
  from: dayArg('first day'),
  to: dayArg('last day (today allowed; default today)'),
  periods: z.array(z.object({ from: z.string().trim().regex(DAY).describe('first day'), to: z.string().trim().regex(DAY).describe('last day') })).max(MAX_PERIODS).optional().describe(`several periods at once, one set of rows each (may overlap, e.g. cumulative), at most ${MAX_PERIODS}`),
  compare: z.preprocess(lower, z.enum(COMPARES)).optional().describe('with from and to: also the same number of days just before (previous-period) or the same days a year before (previous-year); Nexus computes each change'),
  timeIncrement: z.union([z.preprocess(lower, z.enum(TIME_INCREMENTS)), z.number().int().min(1).max(90)]).optional().describe('rows per day (daily), week (weekly = 7), month (monthly), N days (1–90), or one for the whole period (all_days, default)'),
  filters: filterArg.optional().describe('Meta-side filters (at most 20), e.g. {field:"campaign.name", operator:"CONTAIN", value:"IT"}, {field:"publisher_platform", operator:"IN", value:["instagram"]}'),
  onlyWithImpressions: z.boolean().optional().describe('only rows with impressions (Meta\'s own filter)'),
  minSpendCents: z.number().int().min(0).optional().describe('only rows that spent at least this, in minor units (needs the ad-spend money permission)'),
  includeArchived: z.boolean().optional().describe('archived and deleted campaigns, ad sets and ads too (default true; Meta leaves them out otherwise)'),
  sortBy: z.string().trim().regex(/^[a-z0-9_]{1,80}$/).optional().describe('sort by one number (e.g. spend, impressions, ctr; an amount needs the ad-spend money permission)'),
  sortAction: z.string().trim().min(1).max(80).optional().describe('or sort by one action type, e.g. omni_purchase, link_click'),
  order: z.preprocess(lower, z.enum(SORT_ORDERS)).optional().describe('descending (default) | ascending'),
  withTotal: z.boolean().optional().describe('also Meta\'s own total row (its reach deduplicated)'),
  productIdLimit: z.number().int().min(1).max(1000).optional().describe('view products: at most this many products per ad'),
}

function numbersInputOf(args: Record<string, unknown>, ctx: ToolContext, view: NumbersView): NumbersInput {
  return {
    connectionId: str(args.connectionId), view,
    level: (args.level ?? null) as InsightLevel | null,
    campaignId: str(args.campaignId), adSetId: str(args.adSetId), adId: str(args.adId),
    metrics: strs(args.metrics), groups: (strs(args.groups) as MetricGroup[] | null),
    breakdowns: strs(args.breakdowns), assetBreakdown: str(args.assetBreakdown), audienceTime: args.audienceTime === true,
    actionBreakdowns: strs(args.actionBreakdowns), windows: strs(args.windows),
    attribution: (args.attribution ?? null) as NumbersInput['attribution'],
    datePreset: str(args.datePreset), from: str(args.from), to: str(args.to),
    periods: Array.isArray(args.periods) ? args.periods as Array<{ from: string; to: string }> : null,
    compare: (args.compare ?? null) as NumbersInput['compare'],
    timeIncrement: (args.timeIncrement ?? null) as NumbersInput['timeIncrement'],
    filters: Array.isArray(args.filters) ? args.filters as NumbersFilter[] : null,
    onlyWithImpressions: args.onlyWithImpressions === true,
    minSpendCents: typeof args.minSpendCents === 'number' ? args.minSpendCents : null,
    includeArchived: args.includeArchived !== false,
    sortBy: str(args.sortBy), sortAction: str(args.sortAction), order: (args.order ?? null) as NumbersInput['order'],
    withTotal: args.withTotal === true,
    productIdLimit: typeof args.productIdLimit === 'number' ? args.productIdLimit : null,
    maxRows: typeof args.maxRows === 'number' ? args.maxRows : null, after: str(args.after),
    seesMoney: seesMoney(ctx),
  }
}

// ── meta-ads-numbers ─────────────────────────────────────────────────────────────────────────────────────────────

const metaAdsNumbers: AgentTool = {
  name: 'meta-ads-numbers',
  title: 'Meta ads numbers, live',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  restrictedFields: NUMBERS_MONEY,
  input: z.object({
    view: z.preprocess(lower, z.enum(NUMBERS_VIEWS)).default('numbers')
      .describe('numbers (default) | products (by catalog product, matched to Nexus SKUs) | assets (by creative asset; assetBreakdown) | hourly | catalogue (every metric, breakdown, window and filter Nexus asks, with Meta\'s labels; no Meta call) | check (what Nexus would send; no Meta call) | portfolio'),
    ...numbersArgs,
    maxRows: z.number().int().min(1).max(MAX_NUMBER_ROWS).optional().describe(`at most this many rows (default 200, at most ${MAX_NUMBER_ROWS}); more: page with after`),
    after: z.string().trim().min(1).max(500).optional().describe('the nextAfter of the answer before'),
    connectionId: connectionArg,
  }),
  description:
    'The chosen Meta (Facebook + Instagram + Threads) ad account\'s numbers read LIVE from Meta\'s insights, for any '
    + 'question meta-ads-live and meta-ads-overview do not answer: the whole account, or one campaign, ad set or ad, rolled '
    + 'to level account, campaign, adset or ad. Any metric of Meta\'s v26 list (delivery, clicks, special formats, results '
    + 'by the campaign\'s own goal, conversions, values and ROAS, standard events, video, catalog, messaging, Instagram '
    + 'profile visits, research fields — view catalogue lists every one, and which Meta ESTIMATES or still develops), split '
    + 'by breakdowns (age, gender, country, region, placements incl. Instagram Reels / Stories / Explore and Threads feed, '
    + 'device, hour, frequency, new vs existing customers, assets, Advantage+ creative, products …) and action breakdowns '
    + '— only in the combinations Meta keeps, checked before the call. Attribution windows (7-day and 28-day view return no '
    + 'data since 2026-01-12; Meta reports each ad set\'s own setting, as Ads Manager), presets or exact days (37 months '
    + 'back), several periods or a comparison with the period before or a year before (Nexus computes the change; Meta\'s '
    + 'insights take no comparison period), rows per day, week or month, filters, one sort, Meta\'s total row. Archived and '
    + 'deleted objects are included unless asked otherwise. Some breakdowns answer NOTHING until the account switches them '
    + 'on (impression_device, hourly by the audience\'s time zone, frequency_value, comscore_market): the answer says so, '
    + 'never 0. Too much for one read: meta-ads-report runs it in the background. A whole business portfolio: Meta has no '
    + 'such insights — each business reads its own ad account. An ad\'s conversion tracking specs: meta-ad-details; a boosted '
    + 'Instagram post\'s past boosts: meta-instagram-media. Read only; amounts in minor units (cents) of the account '
    + 'currency under money (a person without the ad-spend money permission gets the rest).',
  async handler(args, ctx): Promise<ToolResult> {
    return guarded(() => metaNumbers(numbersInputOf(args, ctx, (args.view ?? 'numbers') as NumbersView)))
  },
}

// ── meta-ads-report ──────────────────────────────────────────────────────────────────────────────────────────────

const metaAdsReport: AgentTool = {
  name: 'meta-ads-report',
  title: 'Meta ads report runs',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  restrictedFields: REPORT_MONEY,
  input: z.object({
    action: z.preprocess(lower, z.enum(REPORT_ACTIONS)).describe('start (a new background report) | status | fetch (its rows, or Nexus\'s CSV) | file (Meta\'s own CSV / Excel link)'),
    reportRunId: metaIdArg('status, fetch, file: the report run (from action start; Meta keeps it 30 days)'),
    kind: z.preprocess(lower, z.enum(REPORT_KINDS)).default('numbers').describe('start: numbers (default: the same read as meta-ads-numbers) | mmm (Meta\'s Marketing Mix Modeling export: impressions and spend per ad set and day by country, region, device and placement — a CSV file only)'),
    view: z.preprocess(lower, z.enum(['numbers', 'products', 'assets', 'hourly'])).default('numbers').describe('start, kind numbers: as meta-ads-numbers'),
    ...numbersArgs,
    exportFormat: z.preprocess(lower, z.enum(EXPORT_FORMATS)).optional().describe('start: also have Meta prepare its own file (csv or xls) for action file'),
    exportName: z.string().trim().regex(/^[A-Za-z0-9 _.-]{1,60}$/).optional().describe('start / file: the file name Meta gives it'),
    format: z.preprocess(lower, z.enum(['rows', 'csv'])).optional().describe('fetch: rows (default) or Nexus\'s own CSV of them'),
    fileFormat: z.preprocess(lower, z.enum(EXPORT_FORMATS)).optional().describe('file: csv (default) or xls (Excel)'),
    maxRows: z.number().int().min(1).max(MAX_NUMBER_ROWS).optional().describe(`fetch: at most this many rows (default 200, at most ${MAX_NUMBER_ROWS})`),
    after: z.string().trim().min(1).max(500).optional().describe('fetch: the nextAfter of the answer before'),
    connectionId: connectionArg,
  }),
  description:
    'Big reads of the chosen Meta ad account in the background (Meta\'s async report runs), when meta-ads-numbers is too '
    + 'much at once: action start takes the same arguments as meta-ads-numbers (or kind mmm: Meta\'s Marketing Mix '
    + 'Modeling export) and answers a reportRunId — starting one changes nothing on the account (Meta only computes a '
    + 'report; no approval needed). status: waiting, running, finished (finished means Meta says completed AND 100 %), '
    + 'failed (Meta\'s error and what it means) or expired (start again). fetch: the rows when finished, as meta-ads-numbers '
    + 'answers them, or format csv for Nexus\'s own CSV (Excel opens it). file: Meta\'s own CSV or Excel — a link a person '
    + 'opens while signed in to Meta with access to the ad account (an MMM export comes ONLY this way; Meta answers no rows '
    + 'for it). Nexus passes on only links in Meta\'s documented export shape and never keeps them. Meta keeps a run 30 days; '
    + 'Nexus stores nothing (ask status with the id). Only the chosen ad account\'s runs are read. Read only; amounts in '
    + 'minor units (cents) of the account currency under money; csvWithMoney and the file link need the ad-spend money permission.',
  async handler(args, ctx): Promise<ToolResult> {
    const connectionId = str(args.connectionId)
    const runId = str(args.reportRunId)
    const action = args.action as typeof REPORT_ACTIONS[number]
    const needRun = (): string => { if (!runId) throw new MetaLiveRefusal(`Name the report run (reportRunId, from action start) to ask its ${action}.`); return runId }
    return guarded(async () => {
      switch (action) {
        case 'start': return startReportRun({ ...numbersInputOf(args, ctx, (args.view ?? 'numbers') as NumbersView), kind: (args.kind ?? 'numbers') as typeof REPORT_KINDS[number], exportFormat: (args.exportFormat ?? null) as typeof EXPORT_FORMATS[number] | null, exportName: str(args.exportName) })
        case 'status': return reportRunStatus({ connectionId, reportRunId: needRun() })
        case 'fetch': return reportRunRows({ connectionId, reportRunId: needRun(), maxRows: typeof args.maxRows === 'number' ? args.maxRows : null, after: str(args.after), format: (args.format ?? null) as 'rows' | 'csv' | null })
        case 'file': return reportRunFile({ connectionId, reportRunId: needRun(), format: (args.fileFormat ?? null) as typeof EXPORT_FORMATS[number] | null, name: str(args.exportName) })
      }
    })
  },
}

// ── meta-ads-saved-reports ───────────────────────────────────────────────────────────────────────────────────────

const metaAdsSavedReports: AgentTool = {
  name: 'meta-ads-saved-reports',
  title: 'Meta saved reports and partner reports',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  restrictedFields: SAVED_MONEY,
  input: z.object({
    view: z.preprocess(lower, z.enum(SAVED_VIEWS)).describe(SAVED_VIEWS.join(' | ')),
    scope: z.preprocess(lower, z.enum(SAVED_SCOPES)).optional().describe('mmm-reports, mmm-schedules: the ad account\'s (default) or the business portfolio\'s'),
    metrics: z.array(z.string().trim().regex(/^[a-z0-9_]{1,80}$/)).max(30).optional().describe('report-builder: metrics (Meta\'s insights names, e.g. spend, impressions, clicks, ctr; default spend, impressions, clicks)'),
    dimensions: z.array(z.string().trim().regex(/^[a-z0-9_]{1,60}$/)).max(4).optional().describe('report-builder: dimensions, e.g. campaign_name (default), adset_name, ad_name, age, gender, country, publisher_platform, platform_position'),
    datePreset: z.string().trim().regex(/^[a-z0-9_]{1,30}$/).optional().describe('report-builder, pivot-preview: a ready range (last_30d default for the Report Builder)'),
    from: dayArg('report-builder, pivot-preview, partner-viewability: first day'),
    to: dayArg('report-builder, pivot-preview, partner-viewability: last day'),
    comparisonFrom: dayArg('report-builder: first day of the period to compare with (Meta\'s own comparison)'),
    comparisonTo: dayArg('report-builder: last day of the period to compare with'),
    windows: z.array(z.string().trim().regex(/^[a-z0-9_]{1,40}$/)).max(7).optional().describe('report-builder: attribution windows (1d_click, 7d_click, 28d_click, 1d_view, 1d_ev, dda, default)'),
    filters: filterArg.optional().describe('report-builder: filters as meta-ads-numbers takes them (no amount)'),
    sortBy: z.string().trim().regex(/^[a-z0-9_]{1,80}$/).optional().describe('report-builder: sort by one of its metrics or dimensions'),
    order: z.preprocess(lower, z.enum(SORT_ORDERS)).optional().describe('report-builder: descending (default) | ascending'),
    withTotal: z.boolean().optional().describe('report-builder: Meta\'s summary row and row count'),
    offset: z.number().int().min(0).max(100000).optional().describe('report-builder: skip this many rows'),
    permission: z.preprocess(lower, z.enum(['private', 'shared'])).optional().describe('custom-pivots: only private or shared ones'),
    savedReportId: metaIdArg('custom-pivots: only those of this saved report'),
    groupName: z.string().trim().min(1).max(100).optional().describe('pivot-preview: the custom breakdown (pivot) group'),
    reportType: z.preprocess(lower, z.enum(MEASUREMENT_TYPES)).optional().describe('measurement: third_party_mta_report | partner_lift_study_report | mmm_report_v2 (required)'),
    recurring: z.boolean().optional().describe('partner-studies: the recurring ones (default: the one-off ones)'),
    statuses: z.array(z.string().trim().regex(/^[A-Z_]{2,20}$/)).max(5).optional().describe('partner-studies: only these statuses (one-off: CREATED, FAILURE, IN_PROGRESS, SCHEDULED, SUCCESS; recurring: CANCELLED, CREATED, FINISHED, ONGOING)'),
    studyTypes: z.array(z.enum(STUDY_TYPES)).max(3).optional().describe('partner-studies: BRAND_LIFT, PANEL_SALES_ATTRIBUTION, REACH'),
    platform: z.enum(VIEWABILITY_PLATFORMS).optional().describe('partner-viewability: AUDIENCE_NETWORK | FACEBOOK | INSTAGRAM'),
    type: z.enum(VIEWABILITY_TYPES).optional().describe('partner-viewability: DISPLAY_EVENT | IMPRESSION | VIDEO_EVENT'),
    maxRows: z.number().int().min(1).max(MAX_NUMBER_ROWS).optional().describe('at most this many rows (default 100)'),
    after: z.string().trim().min(1).max(500).optional().describe('the nextAfter of the answer before'),
    connectionId: connectionArg,
  }),
  description:
    'What Ads Reporting and Meta\'s measurement partners hold for the chosen Meta ad account, read LIVE (Meta lets an app '
    + 'READ these, never make or change them). mmm-reports and mmm-schedules: Marketing Mix Modeling reports made in Ads '
    + 'Reporting and their schedules (the ad account\'s, or the business portfolio\'s: a schedule that does not name the '
    + 'chosen account is its id only). exports: the portfolio\'s Ads Reporting exports (never their file or sharing links). '
    + 'report-builder: Ads Reporting\'s Report Builder table — metrics by dimensions, with Meta\'s own comparison period '
    + '(the only Meta edge that has one), as Meta answers it. custom-metrics: the account\'s formula columns. custom-pivots '
    + 'and pivot-preview: saved reports\' custom breakdowns and which of the chosen account\'s campaigns, ad sets and ads '
    + 'fall in each group. report-specs. measurement: reports a measurement partner published (multi-touch attribution, '
    + 'partner lift, MMM v2; reportType). partner-studies: brand-lift, panel-sales and reach studies (recurring too); '
    + 'partner-viewability: viewability reports — both exist only when Meta set up a measurement partner. The portfolio\'s '
    + 'views are read only when no other business in Nexus reads an ad account of that portfolio. what-meta-cannot: '
    + 'making, changing, sharing or scheduling reports, custom metrics and custom breakdowns has no API — a person does it '
    + 'in Ads Manager › Reports. Read only; Meta\'s raw tables and metadata (tableAsMeta, metadataAsMeta: amounts in '
    + 'Meta\'s own units) need the ad-spend money permission.',
  async handler(args): Promise<ToolResult> {
    const input: SavedInput = {
      connectionId: str(args.connectionId), view: args.view as SavedInput['view'], scope: (args.scope ?? null) as SavedInput['scope'],
      metrics: strs(args.metrics), dimensions: strs(args.dimensions), datePreset: str(args.datePreset), from: str(args.from), to: str(args.to),
      comparisonFrom: str(args.comparisonFrom), comparisonTo: str(args.comparisonTo), windows: strs(args.windows),
      filters: Array.isArray(args.filters) ? args.filters as NumbersFilter[] : null, sortBy: str(args.sortBy), order: (args.order ?? null) as SavedInput['order'],
      withTotal: args.withTotal === true, offset: typeof args.offset === 'number' ? args.offset : null,
      permission: (args.permission ?? null) as SavedInput['permission'], savedReportId: str(args.savedReportId), groupName: str(args.groupName),
      reportType: (args.reportType ?? null) as SavedInput['reportType'], recurring: args.recurring === true,
      statuses: strs(args.statuses), studyTypes: strs(args.studyTypes), platform: (args.platform ?? null) as SavedInput['platform'], type: (args.type ?? null) as SavedInput['type'],
      maxRows: typeof args.maxRows === 'number' ? args.maxRows : null, after: str(args.after),
    }
    return guarded(() => savedReports(input))
  },
}

export const META_ADS_INSIGHTS_TOOLS: AgentTool[] = [metaAdsNumbers, metaAdsReport, metaAdsSavedReports]
