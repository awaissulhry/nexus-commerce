/**
 * Google Ads steps 1a and 1b — one read of one Google Ads account, in the CURRENT business (PLAN.md L9, L10; plan-2 §4;
 * plan-1b-backend §2–§4). Read-only: every call is a GoogleAdsService.Search through the gateway, which refuses
 * anything else.
 *
 *   0. one read of a business's account at a time (read-guard.ts): a read that finds another one running is skipped in
 *      words (ALREADY_RUNNING) — no call, no allowance, no row written
 *   1. reserve the run's operations BEFORE the first call (sync-plan.ts: core 4 + spare 1 + the step 1b tiers; 22 on a
 *      regular day). Short of allowance, the run drops tier 5, then 4, 3 and 2; the core is never dropped — when even it
 *      does not fit, no call at all (SKIPPED_BUDGET). A query the plan did not count (a safety-net query sent again
 *      without the field Google refused, a shorter first read) is sent only within what the run reserved — the spare,
 *      or what a read that ended early left unspent — or after one more reservation; refused, that read fails in words.
 *      So a run never spends more than it reserved on them (a restart after an expired page token is Google's doing:
 *      counted as spent)
 *   2. the account (`customer`): a MANAGER account holds no campaigns of its own — the run stops there (MANAGER)
 *   3. campaigns with their budgets; after a full read, campaigns no longer returned get `removedAt`
 *   4. daily campaign numbers: never read → the last 400 account days (BACKFILL; over the row cap, read once more over
 *      the last 200, all or nothing, and the run's `note` says so); otherwise the last 14 days (35 on the account's
 *      Sundays), reaching back to the day after the last day read when the account missed runs (over the row cap, read
 *      once more over the oldest half of those days, all or nothing; the next read goes on from there)
 *   5. Google's change history: never read → its whole 30 days; otherwise from where the last read stopped
 *   6. step 1b, tier by tier (2 safety, 3 numbers, 4 structure, 5 slow): each step records its own GoogleAdsReadState
 *      (SUCCESS | FAILED | SKIPPED_BUDGET, in words); a dropped tier is SKIPPED_BUDGET and moves nothing
 *   7. the retention prune (search terms 180 days, the other grains below the campaign 400; campaign days forever)
 *   8. the account's read state — `lastSuccessAt` (the data's "as of") when the four core steps succeeded; SUCCESS only
 *      when every step did, else PARTIAL — and `campaign.metrics.refreshed` (channel GOOGLE) when campaign numbers were
 *      stored; then the alerts are evaluated over what is stored (no Google call; never fails the run)
 *
 * A step that fails is recorded in words and the next one still runs — unless the failure means nothing else can
 * work (sign-in lost, the day's allowance used up, the Nexus app not approved, the gateway refusing; for the core also
 * access refused): the run stops, and the step 1b reads it did not reach say why. A failed step deletes nothing: stored
 * days are replaced only by a complete read of them, and a grain's first read is stored all or nothing. A first read
 * Google answers with more than the row cap is read once more over half its window (never shorter than the daily one),
 * still all or nothing; its read state says so.
 *
 * The queries with a fallback twin are a safety net: every field behind them is verified valid in v25
 * (https://developers.google.com/google-ads/api/fields/v25/<resource>, gaql.ts). Should Google refuse one anyway, the
 * refusal is remembered for 7 days per business, account and read (read-guard.ts): meanwhile the read sends the twin
 * without that field at once.
 */
import { logger } from '../../../utils/logger.js'
import { publishMarketingEvent } from '../../marketing-events.service.js'
import { accountYesterday, addDays, backfillWindow, changeHistoryWindow, dailyWindow, dateToDay, dayCount, type DayWindow } from './dates.js'
import { GoogleAdsReadError, localFailure, type GoogleAdsFailure } from './errors.js'
import {
  ACCOUNT_NEGATIVE_LIST_LINKS_QUERY, AD_GROUPS_QUERY, AD_GROUP_KEYWORDS_QUERY, AD_POLICY_QUERY, ASSET_GROUPS_QUERY, AUTO_APPLY_QUERY, CAMPAIGNS_QUERY, CAMPAIGN_FLAGS_QUERY,
  CAMPAIGN_FLAGS_QUERY_WITHOUT_ASSET_AUTOMATION, CAMPAIGN_NEGATIVES_QUERY, CHANGE_EVENT_LIMIT, CUSTOMER_QUERY, NEGATIVE_LIST_ATTACHMENTS_QUERY,
  NEGATIVE_LIST_ATTACHMENTS_QUERY_WITHOUT_SET, NEGATIVE_LIST_KEYWORDS_QUERY, NEGATIVE_LIST_KEYWORDS_QUERY_WITHOUT_SET, RECOMMENDATIONS_QUERY,
  RECOMMENDATIONS_QUERY_WITHOUT_IMPACT, SHOPPING_PRODUCTS_QUERY, adGroupDailyMetricsQuery, assetGroupDailyMetricsQuery, campaignDailyMetricsQuery,
  changeEventsQuery, keywordDailyMetricsQuery, productDailyMetricsQuery, searchTermDailyMetricsQuery,
} from './gaql.js'
import {
  mapAccountListLink, mapAdGroup, mapAdGroupKeyword, mapAdPolicyIssue, mapAssetGroup, mapAutoApply, mapCampaign, mapCampaignDay, mapCampaignFlags, mapCampaignNegative,
  mapChangeEvent, mapCustomer, mapGrainDay, mapListAttachment, mapListKeyword, mapRecommendation, mapShoppingProductIssue,
} from './mappers.js'
import { addSpentOps, releaseOps, reserveOps, type OpsReservation } from './ops-budget.js'
import { searchAll, searchRows } from './read-client.js'
import { fallbackRemembered, rememberFallback, takeReadLock } from './read-guard.js'
import {
  ensureGoogleAdsCustomer, markUnseenCampaignsRemoved, recordSyncOutcome, replaceDailyMetrics, saveCustomerDetails, storeChangeEvents,
  upsertCampaigns, type GoogleAdsSyncStatus,
} from './store.js'
import {
  RESOLVED_ISSUE_DAYS, activeNegativeListIds, pruneDailyMetrics, pruneResolvedPolicyIssues, readStatesOf, recordReadState, recordReadStates,
  replaceRecommendations, saveAdGroups, saveAssetGroups, saveAutoApply, saveCampaignFlags, saveKeywords, saveNegativeLists, savePolicyIssues,
} from './store-detail.js'
import {
  DETAIL_STEPS, GRAINS, READ_RESOURCE_TEXT, RUN_OPS, TIER_CANDIDATES, detailOps, knownTimeZone, planDetailRead, retentionKeepFrom, runOps,
  shorterBackfill, shorterCatchUp, shorterFirstRead, type GoogleAdsTier, type GrainRead, type GrainSpec, type PlannedStep,
} from './sync-plan.js'
import { readTargetFor } from './targets.js'
import type {
  GoogleAdsAdGroupCriterionRow, GoogleAdsAdGroupRow, GoogleAdsAdPolicyRow, GoogleAdsAssetGroupRow, GoogleAdsCampaignCriterionRow,
  GoogleAdsCampaignData, GoogleAdsCampaignDayRow, GoogleAdsCampaignFlagsRow, GoogleAdsCampaignRow, GoogleAdsCampaignSharedSetRow,
  GoogleAdsChangeEventData, GoogleAdsChangeEventRow, GoogleAdsCustomerNegativeCriterionRow, GoogleAdsCustomerRow, GoogleAdsDailyMetricData,
  GoogleAdsDayResource, GoogleAdsGrainDayRow, GoogleAdsKeywordData, GoogleAdsNegativeListData, GoogleAdsReadResource, GoogleAdsReadStatus, GoogleAdsRecommendationRow,
  GoogleAdsRecommendationSubscriptionRow, GoogleAdsSharedCriterionRow, GoogleAdsShoppingProductRow, GoogleAdsTarget,
} from './types.js'

export type GoogleAdsSyncKind = 'BACKFILL' | 'DAILY' | 'MANUAL'

/** Operations a regular run reserves before its first call (sync-plan.ts: core 4 + step 1b 17 + a spare). */
export { RUN_OPS }
/** A change history read that hits Google's LIMIT continues at most this many times (one more operation each). */
export const CHANGE_HISTORY_CONTINUATIONS = 2
/** More daily rows than this in one read of one grain is not kept (memory); the read says so. */
export const MAX_METRIC_ROWS = 200_000
let maxMetricRows = MAX_METRIC_ROWS

/** Tests: a lower row cap (undefined = MAX_METRIC_ROWS again). */
export function setMaxMetricRowsForTests(rows: number | undefined): void {
  maxMetricRows = rows ?? MAX_METRIC_ROWS
}

const MANAGER_SENTENCE = 'This is a Google Ads manager account: it has no campaigns of its own. Choose one of the accounts under it in Settings, Channels, Google.'
const NO_ACCOUNT_SENTENCE = 'Google Ads sent no details for this account, so Nexus read nothing.'
/** A step 1b read left out for want of allowance (its read state). */
const SHORT_BUDGET_SENTENCE = 'Not read in this run: the Google Ads allowance ran short, so Nexus read the more urgent parts first. It reads this at the next read.'
/** The same for the run as a whole. */
const SHORT_BUDGET_RUN_SENTENCE = 'Some parts were not read in this run: the Google Ads allowance ran short, so Nexus read the more urgent parts first. It reads them at the next read.'
const NOT_REACHED_PREFIX = 'Not read in this run:'
/** The read lock was held (read-guard.ts). */
const ALREADY_RUNNING_SENTENCE = 'Another read of this Google Ads account is running, so this one was skipped. The running read records what it finds.'
/** A refused query that could not be sent again for want of allowance (it is sent without the field at the next read). */
const FALLBACK_SHORT_SENTENCE = 'Google Ads refused this query, and the Google Ads allowance ran short to send it again without the field Google refused. Nexus sends that shorter query at the next read.'

const ALL_DETAIL_RESOURCES: readonly GoogleAdsReadResource[] = DETAIL_STEPS.map((step) => step.resource)

/** How one step 1b read ended in this run. */
export interface GoogleAdsDetailOutcome {
  resource: GoogleAdsReadResource
  status: GoogleAdsReadStatus
  rows: number
  error: string | null
  /** SUCCESS only: what the read did other than planned (a shorter first read), in words. */
  note?: string
}

export interface GoogleAdsSyncResult {
  customerId: string
  /** What was asked. */
  kind: GoogleAdsSyncKind
  /** What was read: the 400-day first read, or the daily window. Null when no number was asked for. */
  mode: 'BACKFILL' | 'DAILY' | null
  /** ALREADY_RUNNING: another read of the account held its lock; this one made no call and wrote nothing. */
  status: GoogleAdsSyncStatus | 'NOT_LINKED' | 'ALREADY_RUNNING'
  /** The first failure in words, or null. */
  error: string | null
  /**
   * What the core read did other than planned, in words, or null: the campaign numbers' first read was over the row cap,
   * so Nexus read the last 200 days instead of 400; or their catch-up after missed runs was, so Nexus read the oldest
   * half of those days first. On a SUCCESS run it is also the account's `lastSyncError` (as a step 1b read state keeps
   * its note), and Settings shows it.
   */
  note: string | null
  ops: number
  /** Every operation the run reserved (its first reservation and any later one); 0 when it reserved none. */
  opsReserved: number
  campaigns: number
  campaignsRemoved: number
  removalBreaker: boolean
  metricRows: number
  window: DayWindow | null
  changeEvents: number
  /** Step 1b: each read's end, in run order (empty when the run never got that far). */
  details: GoogleAdsDetailOutcome[]
  /** Step 1b tiers left out for want of allowance. */
  tiersDropped: GoogleAdsTier[]
  /** Alerts the run raised (null when they were not evaluated). */
  alertsRaised: number | null
}

/** The daily window, reaching back to the day after the last day read when runs were missed (never past 400 days). */
export function dailyReadWindow(timeZone: string, now: Date, readThrough: string | null): DayWindow {
  const daily = dailyWindow(timeZone, now)
  const window = { from: daily.from, to: daily.to }
  if (!readThrough) return window
  const next = addDays(readThrough, 1)
  if (next >= window.from) return window
  const oldest = backfillWindow(timeZone, now).from
  return { from: next > oldest ? next : oldest, to: window.to }
}

/** A failure after which no other step of this run can work. */
function stopsTheRun(failure: GoogleAdsFailure): boolean {
  return failure.authLost || failure.quotaExhausted || failure.notApprovedForProduction || failure.permissionDenied || failure.origin === 'gateway'
}

/**
 * The same for a step 1b read: access refused to one resource (a Merchant Center link, a recommendation type) stops
 * only that read — the account itself was reached by the core steps.
 */
function stopsTheDetail(failure: GoogleAdsFailure): boolean {
  return failure.authLost || failure.quotaExhausted || failure.notApprovedForProduction || failure.origin === 'gateway'
}

/**
 * Google refused the query itself (an unknown or unselectable field). The fields behind the fallback twins are verified
 * valid in v25 (https://developers.google.com/google-ads/api/fields/v25/<resource>): the twin is a safety net, not a guess.
 */
export function isRefusedQuery(failure: GoogleAdsFailure): boolean {
  return failure.origin === 'google' && failure.httpStatus === 400 && !failure.retryable && !failure.pageTokenExpired && !failure.authLost &&
    !failure.quotaExhausted && !failure.permissionDenied && !failure.notApprovedForProduction
}

interface StepFailure { step: string; failure: GoogleAdsFailure; detail?: GoogleAdsReadResource }

/**
 * Reserve what the run may spend: everything, else without tier 5, then 4, 3, 2; the core alone last. A refusal that a
 * smaller run cannot fix either (Redis down, Google's day used up) stops at once.
 */
async function reserveRun(customerId: string, steps: readonly PlannedStep[], now: Date): Promise<{ reservation: OpsReservation; tiers: readonly GoogleAdsTier[] }> {
  let refused: OpsReservation | null = null
  for (const tiers of TIER_CANDIDATES) {
    const reservation = await reserveOps(customerId, runOps(steps, tiers), now)
    if (reservation.ok) return { reservation, tiers }
    refused = reservation
    if (reservation.reason !== 'account_cap' && reservation.reason !== 'global_cap') break
  }
  return { reservation: refused!, tiers: [] }
}

/** What a step 1b read needs to call Google and count what it spends. */
interface DetailContext {
  target: GoogleAdsTarget
  customerId: string
  currencyCode: string
  timeZone: string
  /** The run's clock (the memory of refused queries counts its 7 days from it). */
  now: Date
  /** Adds operations the moment a query returns. */
  spend: (ops: number) => void
  /**
   * Before `ops` queries the plan did not count: true when they fit in what the run reserved and has neither spent nor
   * planned (`stillPlanned` = queries of this read the plan counted and it has not sent yet), else after one more
   * reservation; false when the allowance refuses it (then nothing may be sent).
   */
  extra: (ops: number, stillPlanned: number) => Promise<boolean>
}

/** What a step 1b read stored: rows, and what it did other than planned (a shorter first read), in words. */
interface DetailRead { rows: number; note: string | null }
const rowsRead = (rows: number): DetailRead => ({ rows, note: null })

const tooManyRows = (err: unknown): err is GoogleAdsReadError => err instanceof GoogleAdsReadError && err.failure.code === 'TOO_MANY_ROWS'

/**
 * Every row of one query, mapped (rows the mapper refuses are dropped). `raw` counts every row Google returned. More
 * than `limit` mapped rows stops the read in words (the query's operation is spent).
 */
async function collect<Row, Out>(
  ctx: DetailContext,
  query: string,
  operation: string,
  map: (row: Row) => Out | null,
  limit = Number.POSITIVE_INFINITY,
): Promise<{ out: Out[]; raw: number }> {
  let out: Out[] = []
  let raw = 0
  const read = await searchAll<Row>(ctx.target, query, (rows) => {
    raw += rows.length
    for (const row of rows) {
      const mapped = map(row)
      if (mapped !== null) out.push(mapped)
    }
    if (out.length > limit) {
      throw new GoogleAdsReadError(localFailure(`Google sent more than ${limit.toLocaleString('en-US')} rows for this part of the account; Nexus kept none of this read.`, 'TOO_MANY_ROWS'), operation, 1)
    }
  }, { operation, onRestart: () => { out = []; raw = 0 } })
  ctx.spend(read.ops)
  return { out, raw }
}

/**
 * `collect`, and when Google refuses the query itself, once more with `fallback` (the same query without one field — a
 * safety net: the field is verified valid in v25, https://developers.google.com/google-ads/api/fields/v25/<resource>;
 * what the twin leaves out is then not read). The refused attempt's operation is counted; the fallback is sent only
 * within the run's reservation (`ctx.extra`). The refusal is remembered for 7 days (read-guard.ts): meanwhile `fallback`
 * is sent at once. `stillPlanned` = queries of this read the plan counted after this one.
 */
async function collectWithFallback<Row, Out>(
  ctx: DetailContext,
  primary: string,
  fallback: string,
  operation: string,
  map: (row: Row, fellBack: boolean) => Out | null,
  limit?: number,
  stillPlanned = 0,
): Promise<{ out: Out[]; raw: number; fellBack: boolean }> {
  if (await fallbackRemembered(ctx.customerId, operation, ctx.now)) {
    return { ...(await collect<Row, Out>(ctx, fallback, operation, (row) => map(row, true), limit)), fellBack: true }
  }
  try {
    return { ...(await collect<Row, Out>(ctx, primary, operation, (row) => map(row, false), limit)), fellBack: false }
  } catch (err) {
    if (!(err instanceof GoogleAdsReadError) || !isRefusedQuery(err.failure)) throw err
    ctx.spend(err.opsSpent)
    await rememberFallback(ctx.customerId, operation, ctx.now)
    if (!(await ctx.extra(1, stillPlanned))) {
      logger.warn('[google-ads-sync] Google refused a query; no allowance left to send it again without the field it refused', {
        customerId: ctx.customerId, operation, code: err.failure.code,
      })
      throw new GoogleAdsReadError(localFailure(FALLBACK_SHORT_SENTENCE, 'SKIPPED_BUDGET'), operation)
    }
    logger.warn('[google-ads-sync] Google refused a query; sending it once more without the field it refused', {
      customerId: ctx.customerId, operation, code: err.failure.code,
    })
    return { ...(await collect<Row, Out>(ctx, fallback, operation, (row) => map(row, true), limit)), fellBack: true }
  }
}

const DAY_QUERY: Readonly<Record<GoogleAdsDayResource, (window: DayWindow) => string>> = {
  AD_GROUP_DAYS: adGroupDailyMetricsQuery,
  KEYWORD_DAYS: keywordDailyMetricsQuery,
  ASSET_GROUP_DAYS: assetGroupDailyMetricsQuery,
  PRODUCT_DAYS: productDailyMetricsQuery,
  SEARCH_TERM_DAYS: (window) => searchTermDailyMetricsQuery(window, true),
}

const grainOperation = (resource: GoogleAdsDayResource) => `ads.search.${resource.toLowerCase().replace(/_(\w)/g, (_, c: string) => c.toUpperCase())}`
const rowCap = () => maxMetricRows.toLocaleString('en-US')

/**
 * Every piece of one window of a grain, read before anything is stored. More than the row cap stops the read at the page
 * that crossed it (TOO_MANY_ROWS; the pages after it are never asked for). `search.clicksFilter`: search terms only —
 * once Google refused `metrics.clicks > 0` (a safety net: verified valid in v25,
 * https://developers.google.com/google-ads/api/fields/v25/campaign_search_term_view), the rest of the run reads without it.
 */
async function readGrainWindow(ctx: DetailContext, spec: GrainSpec, read: GrainRead, search: { clicksFilter: boolean }): Promise<GoogleAdsDailyMetricData[]> {
  const resource = spec.resource
  const operation = grainOperation(resource)
  const tooMany = (opsSpent: number) => new GoogleAdsReadError(localFailure(
    `Google sent more than ${rowCap()} rows of daily numbers for ${dayCount(read.window)} days of this part of the account; Nexus kept none of this read.`, 'TOO_MANY_ROWS'), operation, opsSpent)
  const map = (row: GoogleAdsGrainDayRow) => mapGrainDay(spec.entityType, row, ctx)
  const days: GoogleAdsDailyMetricData[] = []
  for (const [index, chunk] of read.chunks.entries()) {
    const limit = maxMetricRows - days.length
    let out: GoogleAdsDailyMetricData[]
    try {
      if (resource === 'SEARCH_TERM_DAYS' && search.clicksFilter) {
        const both = await collectWithFallback<GoogleAdsGrainDayRow, GoogleAdsDailyMetricData>(ctx, searchTermDailyMetricsQuery(chunk, true),
          searchTermDailyMetricsQuery(chunk, false), operation, (row) => map(row), limit, read.chunks.length - index - 1)
        if (both.fellBack) search.clicksFilter = false
        out = both.out
      } else {
        const query = resource === 'SEARCH_TERM_DAYS' ? searchTermDailyMetricsQuery(chunk, false) : DAY_QUERY[resource](chunk)
        out = (await collect<GoogleAdsGrainDayRow, GoogleAdsDailyMetricData>(ctx, query, operation, map, limit)).out
      }
    } catch (err) {
      throw tooManyRows(err) ? tooMany(err.opsSpent) : err
    }
    if (days.length + out.length > maxMetricRows) throw tooMany(0)
    for (const day of out) days.push(day)
  }
  return days
}

/**
 * One grain's days: every piece of its window read first, then stored in ONE transaction with the grain's range of days
 * read (a first read is all or nothing). A FIRST read over the row cap is read once more over half its window (never
 * shorter than the daily window; sync-plan.ts `shorterFirstRead`), still all or nothing, and the read state says so —
 * once: a second refusal fails the read in words.
 */
async function readGrainDays(ctx: DetailContext, step: PlannedStep): Promise<DetailRead> {
  const grain = step.grain!
  const { spec } = grain
  const operation = grainOperation(spec.resource)
  const search = { clicksFilter: true }
  const store = async (window: DayWindow, days: GoogleAdsDailyMetricData[]) =>
    (await replaceDailyMetrics(ctx.customerId, spec.entityType, window, days, new Date())).rows
  let days: GoogleAdsDailyMetricData[]
  try {
    days = await readGrainWindow(ctx, spec, grain, search)
  } catch (err) {
    const shorter = tooManyRows(err) ? shorterFirstRead(spec, grain) : null
    if (!shorter) throw err
    // The first attempt's operations are counted here (the run's step counts only what the retry throws).
    ctx.spend((err as GoogleAdsReadError).opsSpent)
    const why = `Google sent more than ${rowCap()} rows of daily numbers for the first ${dayCount(grain.window)} days`
    const shorterDays = dayCount(shorter.window)
    if (!(await ctx.extra(shorter.chunks.length, 0))) {
      throw new GoogleAdsReadError(localFailure(`${why}, and the Google Ads allowance ran short to read the last ${shorterDays} days instead. Nexus kept none of this read and tries again at the next read.`, 'SKIPPED_BUDGET'), operation)
    }
    logger.warn('[google-ads-sync] a first read had too many rows; reading a shorter first window once', { customerId: ctx.customerId, operation, days: shorterDays })
    try {
      days = await readGrainWindow(ctx, spec, shorter, search)
    } catch (retryErr) {
      if (!tooManyRows(retryErr)) throw retryErr
      throw new GoogleAdsReadError(localFailure(`${why}, and more than ${rowCap()} even for the last ${shorterDays} days. Nexus kept none of this read and tries again at the next read.`, 'TOO_MANY_ROWS'), operation, retryErr.opsSpent)
    }
    return { rows: await store(shorter.window, days), note: `${why}, so Nexus read the last ${shorterDays} days instead. Older days are not read.` }
  }
  return rowsRead(await store(grain.window, days))
}

/** One step 1b read: ask Google, store what it answered. Returns the rows stored. */
async function readDetail(ctx: DetailContext, step: PlannedStep, seenAt: Date): Promise<DetailRead> {
  const { customerId, timeZone } = ctx
  const askedAt = new Date()
  switch (step.resource) {
    case 'CAMPAIGN_SETTINGS': {
      const read = await collectWithFallback<GoogleAdsCampaignFlagsRow, ReturnType<typeof mapCampaignFlags>>(ctx, CAMPAIGN_FLAGS_QUERY,
        CAMPAIGN_FLAGS_QUERY_WITHOUT_ASSET_AUTOMATION, 'ads.search.campaignSettings', (row, fellBack) => mapCampaignFlags(row, { timeZone, assetAutomationRead: !fellBack }))
      return rowsRead(await saveCampaignFlags(customerId, read.out.filter((flags) => flags !== null), askedAt))
    }
    case 'AD_POLICY': {
      const read = await collect<GoogleAdsAdPolicyRow, ReturnType<typeof mapAdPolicyIssue>>(ctx, AD_POLICY_QUERY, 'ads.search.adPolicy', (row) => mapAdPolicyIssue(row, ctx))
      const saved = await savePolicyIssues(customerId, 'AD', read.out.filter((issue) => issue !== null), seenAt, read.raw)
      return rowsRead(saved.open)
    }
    case 'PRODUCT_STATUS': {
      const read = await collect<GoogleAdsShoppingProductRow, ReturnType<typeof mapShoppingProductIssue>>(ctx, SHOPPING_PRODUCTS_QUERY, 'ads.search.productStatus',
        (row) => mapShoppingProductIssue(row, ctx))
      const saved = await savePolicyIssues(customerId, 'PRODUCT', read.out.filter((issue) => issue !== null), seenAt, read.raw)
      return rowsRead(saved.open)
    }
    case 'AUTO_APPLY': {
      const read = await collect<GoogleAdsRecommendationSubscriptionRow, ReturnType<typeof mapAutoApply>>(ctx, AUTO_APPLY_QUERY, 'ads.search.autoApply',
        (row) => mapAutoApply(row, ctx))
      return rowsRead((await saveAutoApply(customerId, read.out.filter((row) => row !== null), seenAt)).upserted)
    }
    case 'AD_GROUP_DAYS':
    case 'KEYWORD_DAYS':
    case 'ASSET_GROUP_DAYS':
    case 'PRODUCT_DAYS':
    case 'SEARCH_TERM_DAYS':
      return readGrainDays(ctx, step)
    case 'AD_GROUPS': {
      const read = await collect<GoogleAdsAdGroupRow, ReturnType<typeof mapAdGroup>>(ctx, AD_GROUPS_QUERY, 'ads.search.adGroups', (row) => mapAdGroup(row, ctx))
      return rowsRead((await saveAdGroups(customerId, read.out.filter((row) => row !== null), seenAt)).upserted)
    }
    case 'KEYWORDS': {
      const read = await collect<GoogleAdsAdGroupCriterionRow, GoogleAdsKeywordData>(ctx, AD_GROUP_KEYWORDS_QUERY, 'ads.search.keywords', (row) => mapAdGroupKeyword(row, ctx))
      return rowsRead((await saveKeywords(customerId, 'AD_GROUP', read.out, seenAt)).upserted)
    }
    case 'CAMPAIGN_NEGATIVES': {
      const read = await collect<GoogleAdsCampaignCriterionRow, GoogleAdsKeywordData>(ctx, CAMPAIGN_NEGATIVES_QUERY, 'ads.search.campaignNegatives',
        (row) => mapCampaignNegative(row, ctx))
      return rowsRead((await saveKeywords(customerId, 'CAMPAIGN', read.out, seenAt)).upserted)
    }
    case 'ASSET_GROUPS': {
      const read = await collect<GoogleAdsAssetGroupRow, ReturnType<typeof mapAssetGroup>>(ctx, ASSET_GROUPS_QUERY, 'ads.search.assetGroups', (row) => mapAssetGroup(row, ctx))
      return rowsRead((await saveAssetGroups(customerId, read.out.filter((row) => row !== null), seenAt)).upserted)
    }
    case 'NEGATIVE_LISTS':
      return rowsRead(await readNegativeLists(ctx, seenAt))
    case 'RECOMMENDATIONS': {
      const read = await collectWithFallback<GoogleAdsRecommendationRow, ReturnType<typeof mapRecommendation>>(ctx, RECOMMENDATIONS_QUERY,
        RECOMMENDATIONS_QUERY_WITHOUT_IMPACT, 'ads.search.recommendations', (row, fellBack) => mapRecommendation(row, { customerId, impactRead: !fellBack }))
      return rowsRead(await replaceRecommendations(customerId, read.out.filter((row) => row !== null), askedAt))
    }
  }
}

/**
 * The negative keyword lists: their keywords, the campaigns they are attached to, and the list attached to the account
 * (three queries, one read state). Both kinds of list are kept, with their type: a list for campaigns
 * (NEGATIVE_KEYWORDS) and the account-level list (ACCOUNT_LEVEL_NEGATIVE_KEYWORDS), which Google applies to the whole
 * account only while a customer_negative_criterion points at it (`appliesToAccount`). Without the lists' details (the
 * fallback queries), the type is not read and an attachment counts only for a list known as a negative keyword list —
 * one whose keywords were just read, or one stored before.
 */
async function readNegativeLists(ctx: DetailContext, seenAt: Date): Promise<number> {
  // The attachments and account queries follow in this read: the plan counted them, so a fallback here may not spend them.
  const keywords = await collectWithFallback<GoogleAdsSharedCriterionRow, ReturnType<typeof mapListKeyword>>(ctx, NEGATIVE_LIST_KEYWORDS_QUERY,
    NEGATIVE_LIST_KEYWORDS_QUERY_WITHOUT_SET, 'ads.search.negativeListKeywords', (row) => mapListKeyword(row, ctx), undefined, 2)
  const attachments = await collectWithFallback<GoogleAdsCampaignSharedSetRow, ReturnType<typeof mapListAttachment>>(ctx, NEGATIVE_LIST_ATTACHMENTS_QUERY,
    NEGATIVE_LIST_ATTACHMENTS_QUERY_WITHOUT_SET, 'ads.search.negativeListAttachments', (row) => mapListAttachment(row), undefined, 1)
  const links = await collect<GoogleAdsCustomerNegativeCriterionRow, ReturnType<typeof mapAccountListLink>>(ctx, ACCOUNT_NEGATIVE_LIST_LINKS_QUERY,
    'ads.search.accountNegativeLists', (row) => mapAccountListLink(row))
  const lists = new Map<string, GoogleAdsNegativeListData>()
  const listOf = (sharedSetId: string) => {
    let list = lists.get(sharedSetId)
    if (!list) {
      list = { customerId: ctx.customerId, sharedSetId, name: null, status: null, memberCount: null, listType: null, appliesToAccount: null, campaignIds: [] }
      lists.set(sharedSetId, list)
    }
    return list
  }
  const details = (list: GoogleAdsNegativeListData, set: { name: string | null; status: string | null; memberCount: number | null; type: string | null } | null) => {
    if (!set) return
    list.name ??= set.name
    list.status ??= set.status
    list.memberCount ??= set.memberCount
    list.listType ??= set.type
  }
  const listKeywords: GoogleAdsKeywordData[] = []
  for (const row of keywords.out) {
    if (!row) continue
    listKeywords.push(row.keyword)
    details(listOf(row.keyword.sharedSetId!), row.set)
  }
  const stored = attachments.out.some((row) => row && !row.set) ? await activeNegativeListIds(ctx.customerId) : new Set<string>()
  for (const row of attachments.out) {
    if (!row) continue
    if (!row.set && !lists.has(row.sharedSetId) && !stored.has(row.sharedSetId)) continue
    const list = listOf(row.sharedSetId)
    details(list, row.set)
    if (!list.campaignIds.includes(row.campaignId)) list.campaignIds.push(row.campaignId)
  }
  // In force for the whole account: a list of THIS account a customer_negative_criterion points at. A list a manager
  // account attaches to this account lives in the manager account: its keywords cannot be read from here, so it is not
  // shown. A list of this account in force with no keyword holds nothing to show either.
  const inForce = new Set<string>()
  let elsewhere = 0
  for (const link of links.out) {
    if (!link) continue
    if (link.customerId === ctx.customerId) inForce.add(link.sharedSetId)
    else elsewhere++
  }
  if (elsewhere > 0) logger.info('[google-ads-sync] a negative keyword list of another account (a manager) applies to this account; it cannot be read from here', { customerId: ctx.customerId, lists: elsewhere })
  for (const list of lists.values()) list.appliesToAccount = inForce.has(list.sharedSetId)
  const saved = await saveNegativeLists(ctx.customerId, [...lists.values()], listKeywords, seenAt)
  return saved.lists.upserted
}

/** A run's result before it read anything. */
const emptyResult = (customerId: string, kind: GoogleAdsSyncKind): GoogleAdsSyncResult => ({
  customerId, kind, mode: null, status: 'FAILED', error: null, note: null, ops: 0, opsReserved: 0,
  campaigns: 0, campaignsRemoved: 0, removalBreaker: false, metricRows: 0, window: null, changeEvents: 0,
  details: [], tiersDropped: [], alertsRaised: null,
})

/**
 * Read one Google Ads account now. Never throws for a Google answer; the result and the account row say what happened.
 * One read of a business's account at a time: while another holds its lock this one is skipped (ALREADY_RUNNING) — no
 * call, no allowance, no row written; the running read records its own outcome.
 */
export async function syncGoogleAdsAccount(target: GoogleAdsTarget, options: { kind: GoogleAdsSyncKind; now?: Date }): Promise<GoogleAdsSyncResult> {
  const lock = await takeReadLock(target.customerId)
  if (!lock) {
    logger.info('[google-ads-sync] skipped: another read of this account is running', { customerId: target.customerId, kind: options.kind })
    return { ...emptyResult(target.customerId, options.kind), status: 'ALREADY_RUNNING', error: ALREADY_RUNNING_SENTENCE }
  }
  try {
    return await readAccount(target, options)
  } finally {
    await lock.release()
  }
}

/** The read itself (syncGoogleAdsAccount holds the account's lock around it). */
async function readAccount(target: GoogleAdsTarget, options: { kind: GoogleAdsSyncKind; now?: Date }): Promise<GoogleAdsSyncResult> {
  const now = options.now ?? new Date()
  const customerId = target.customerId
  const result = emptyResult(customerId, options.kind)
  const account = await ensureGoogleAdsCustomer({
    connectionId: target.connectionId, customerId, loginCustomerId: target.loginCustomerId,
    descriptiveName: null, currencyCode: null, timeZone: null, testAccount: false,
  })
  const states = await readStatesOf(customerId)
  const readThrough = Object.fromEntries(GRAINS.map((grain) => {
    const through = states.get(grain.resource)?.readThrough
    return [grain.resource, through ? dateToDay(through) : null]
  })) as Partial<Record<GoogleAdsDayResource, string | null>>
  // The plan the allowance is reserved for, in the time zone last read (a first read costs the same in any zone).
  const planned = planDetailRead({ timeZone: knownTimeZone(account.timeZone) ?? 'UTC', now, readThrough })

  /** Several step 1b reads ended the same way without being attempted (recorded best effort). */
  const notAttempted = async (resources: readonly GoogleAdsReadResource[], status: 'FAILED' | 'SKIPPED_BUDGET', sentence: string) => {
    for (const resource of resources) result.details.push({ resource, status, rows: 0, error: sentence })
    try {
      await recordReadStates(customerId, resources, { status, at: new Date(), error: sentence })
    } catch (err) {
      logger.error('[google-ads-sync] could not record the read state', { customerId, error: err instanceof Error ? err.message : String(err) })
    }
  }

  // 1 — the allowance first: a refused reservation sends nothing.
  const budget = await reserveRun(customerId, planned, now)
  const reservation = budget.reservation
  if (!reservation.ok) {
    result.status = 'SKIPPED_BUDGET'
    result.error = reservation.sentence
    await recordSyncOutcome(customerId, { status: 'SKIPPED_BUDGET', error: reservation.sentence, ops: 0, at: new Date() })
    await notAttempted(ALL_DETAIL_RESOURCES, 'SKIPPED_BUDGET', reservation.sentence)
    logger.info('[google-ads-sync] not started: no allowance', { customerId, reason: reservation.reason })
    return result
  }
  result.tiersDropped = ([2, 3, 4, 5] as GoogleAdsTier[]).filter((tier) => !budget.tiers.includes(tier))
  const droppedResources = new Set(DETAIL_STEPS.filter((s) => !budget.tiers.includes(s.tier)).map((s) => s.resource))
  /** What the step 1b reads were reserved: a core query the plan did not count may not spend it. */
  const plannedDetailOps = detailOps(planned, budget.tiers)
  let reserved = reservation.ops
  /** Operations of the step 1b reads this run plans and has not started yet (what `extra` may not hand out). */
  let detailPlannedLeft = 0
  /**
   * Queries the plan did not count go out only within the reservation: what is reserved and neither spent nor still
   * planned (the spare, or what a read that ended early left), else one more reservation of what is missing.
   */
  const extra = async (ops: number, stillPlanned: number): Promise<boolean> => {
    const free = reserved - result.ops - detailPlannedLeft - stillPlanned
    if (free >= ops) return true
    const more = await reserveOps(customerId, ops - Math.max(0, free), now)
    if (!more.ok) return false
    reserved += more.ops
    return true
  }
  const failures: StepFailure[] = []
  let stopped = false
  let stored = false
  let metricsStored = false
  const outcome: { structureSyncedAt?: Date; changesSyncedThrough?: Date; backfillCompletedAt?: Date } = {}

  /**
   * One step. Each read adds its operations as soon as it returns (so a later failure in the step still counts them); a
   * failed read adds what it cost. A Google failure is recorded in words, and decides whether the run goes on.
   */
  const step = async (name: string, work: () => Promise<void>): Promise<boolean> => {
    if (stopped) return false
    try {
      await work()
      return true
    } catch (err) {
      const failure = err instanceof GoogleAdsReadError
        ? err.failure
        : localFailure('Nexus could not finish this part of the read. It tries again at the next read.', 'INTERNAL')
      if (err instanceof GoogleAdsReadError) result.ops += err.opsSpent
      else logger.error('[google-ads-sync] step failed', { customerId, step: name, error: err instanceof Error ? err.message : String(err) })
      failures.push({ step: name, failure })
      if (stopsTheRun(failure)) stopped = true
      return false
    }
  }

  try {
    // 2 — the account.
    let details = null as ReturnType<typeof mapCustomer>
    await step('customer', async () => {
      const read = await searchRows<GoogleAdsCustomerRow>(target, CUSTOMER_QUERY, { operation: 'ads.search.customer' })
      result.ops += read.ops
      details = mapCustomer(read.rows[0])
      if (!details || details.customerId !== customerId) throw new GoogleAdsReadError(localFailure(NO_ACCOUNT_SENTENCE, 'NO_ACCOUNT'), 'ads.search.customer')
      try {
        accountYesterday(details.timeZone, now)
      } catch {
        throw new GoogleAdsReadError(localFailure('Google Ads sent a time zone Nexus does not know, so it cannot tell the account\'s days apart.', 'UNKNOWN_TIME_ZONE'), 'ads.search.customer')
      }
      await saveCustomerDetails(target, details)
    })
    const customer = details as ReturnType<typeof mapCustomer>
    if (!customer) {
      stopped = true
    } else if (customer.manager) {
      result.status = 'MANAGER'
      result.error = MANAGER_SENTENCE
      await recordSyncOutcome(customerId, { status: 'MANAGER', error: MANAGER_SENTENCE, ops: result.ops, at: new Date() })
      logger.info('[google-ads-sync] read stopped: a manager account', { customerId, kind: result.kind, ops: result.ops })
      return result
    }

    if (customer && !stopped) {
      const context = { customerId, currencyCode: customer.currencyCode }
      const backfill = !account.backfillCompletedAt
      result.mode = backfill ? 'BACKFILL' : 'DAILY'
      const window = backfill
        ? backfillWindow(customer.timeZone, now)
        : dailyReadWindow(customer.timeZone, now, account.metricsReadThrough ? dateToDay(account.metricsReadThrough) : null)
      result.window = window

      // 3 — campaigns and their budgets.
      await step('campaigns', async () => {
        // Stamped when Google was asked: a campaign that existed then and is not in the answer is removed (the read
        // service relies on this to tell a removed campaign from one added since).
        const askedAt = new Date()
        let campaigns: GoogleAdsCampaignData[] = []
        const read = await searchAll<GoogleAdsCampaignRow>(target, CAMPAIGNS_QUERY, (rows) => {
          for (const row of rows) {
            const campaign = mapCampaign(row, context)
            if (campaign) campaigns.push(campaign)
          }
        }, { operation: 'ads.search.campaigns', onRestart: () => { campaigns = [] } })
        result.ops += read.ops
        result.campaigns = await upsertCampaigns(campaigns, now)
        const removal = await markUnseenCampaignsRemoved(customerId, now, campaigns.length)
        result.campaignsRemoved = removal.removed
        result.removalBreaker = removal.breaker
        if (removal.breaker) logger.warn('[google-ads-sync] Google returned no campaign; none marked removed', { customerId })
        outcome.structureSyncedAt = askedAt
        stored = true
      })

      // 4 — daily campaign numbers.
      await step('campaignDays', async () => {
        const operation = 'ads.search.campaignDays'
        const readDays = async (asked: DayWindow): Promise<GoogleAdsDailyMetricData[]> => {
          let days: GoogleAdsDailyMetricData[] = []
          const read = await searchAll<GoogleAdsCampaignDayRow>(target, campaignDailyMetricsQuery(asked), (rows) => {
            for (const row of rows) {
              const day = mapCampaignDay(row, context)
              if (day) days.push(day)
            }
            // Thrown from a page: the query's one operation is spent.
            if (days.length > maxMetricRows) {
              throw new GoogleAdsReadError(localFailure(`Google sent more than ${rowCap()} rows of daily numbers for this account; Nexus kept none of this read.`, 'TOO_MANY_ROWS'), operation, 1)
            }
          }, { operation, onRestart: () => { days = [] } })
          result.ops += read.ops
          return days
        }
        // A catch-up after missed runs: the window reaches back past the regular daily one.
        const catchUp = !backfill && window.from < dailyWindow(customer.timeZone, now).from
        let readWindow = window
        let days: GoogleAdsDailyMetricData[]
        try {
          days = await readDays(window)
        } catch (err) {
          // Over the row cap, read once more over fewer days, all or nothing as before — never a third attempt. Without
          // it a very big account would fail every day and never complete its backfill or its catch-up. The backfill
          // reads its last 200 days (sync-plan.ts `shorterBackfill`); a catch-up its oldest half (`shorterCatchUp`), so
          // the days read stay in one piece and the next read goes on from there. A regular daily window is not cut.
          const shorter = !tooManyRows(err) ? null : backfill ? shorterBackfill(window) : catchUp ? shorterCatchUp(window) : null
          if (!shorter) throw err
          // The first attempt's operation is counted here (the step counts only what the retry throws).
          result.ops += (err as GoogleAdsReadError).opsSpent
          const n = dayCount(shorter)
          const words = backfill
            ? { why: `the first ${dayCount(window)} days`, part: `the last ${n} days`, done: `so Nexus read the last ${n} days instead. Older days are not read.` }
            : { why: `the ${dayCount(window)} days since the last day read`, part: `the first ${n} of them`, done: `so Nexus read the first ${n} of them. It reads the rest at the next read.` }
          const why = `Google sent more than ${rowCap()} rows of daily campaign numbers for ${words.why}`
          // The change history and the step 1b reads the plan counted still follow: the retry takes the spare (or what a
          // read that ended early left), else one more reservation.
          if (!(await extra(1, 1 + plannedDetailOps))) {
            throw new GoogleAdsReadError(localFailure(`${why}, and the Google Ads allowance ran short to read ${words.part} instead. Nexus kept none of this read and tries again at the next read.`, 'SKIPPED_BUDGET'), operation)
          }
          logger.warn('[google-ads-sync] campaign numbers had too many rows; reading a shorter window once', { customerId, mode: result.mode, days: n })
          try {
            days = await readDays(shorter)
          } catch (retryErr) {
            if (!tooManyRows(retryErr)) throw retryErr
            throw new GoogleAdsReadError(localFailure(`${why}, and more than ${rowCap()} even for ${words.part}. Nexus kept none of this read and tries again at the next read.`, 'TOO_MANY_ROWS'), operation, retryErr.opsSpent)
          }
          readWindow = shorter
          result.window = shorter
          result.note = `${why}, ${words.done}`
        }
        const saved = await replaceDailyMetrics(customerId, 'CAMPAIGN', readWindow, days, new Date())
        result.metricRows = saved.rows
        // The first read is done, over fewer days when it had to be: the older days stay outside the range read (not
        // read, never 0), and the daily reads go on from here.
        if (backfill) outcome.backfillCompletedAt = new Date()
        stored = true
        metricsStored = true
      })

      // 5 — Google's change history (30 days at Google; Nexus keeps what it read).
      await step('changeEvents', async () => {
        const span = changeHistoryWindow(customer.timeZone, now, account.changesSyncedThrough ?? null)
        let start = span.startLiteral
        let through: Date = span.end
        for (let pass = 0; pass <= CHANGE_HISTORY_CONTINUATIONS; pass++) {
          if (pass > 0) {
            const more = await reserveOps(customerId, 1, now)
            if (!more.ok) break
            reserved += more.ops
          }
          let events: GoogleAdsChangeEventData[] = []
          let lastLocal = null as string | null
          const read = await searchAll<GoogleAdsChangeEventRow>(target, changeEventsQuery(start, span.endLiteral), (rows) => {
            for (const row of rows) {
              const event = mapChangeEvent(row, { customerId, timeZone: customer.timeZone })
              if (!event) continue
              events.push(event)
              lastLocal = row.changeEvent?.changeDateTime ?? lastLocal
            }
          }, { operation: 'ads.search.changeEvents', onRestart: () => { events = []; lastLocal = null } })
          result.ops += read.ops
          result.changeEvents += await storeChangeEvents(events)
          stored = stored || events.length > 0
          if (read.rows < CHANGE_EVENT_LIMIT || !lastLocal) { through = span.end; break }
          // Google's LIMIT was hit: what was read reaches the last row; continue from that second.
          const last = events[events.length - 1]
          through = last.changedAt
          const next = lastLocal.slice(0, 19)
          if (next <= start) break
          start = next
        }
        outcome.changesSyncedThrough = through
      })
    }
    const coreSucceeded = !!customer && !stopped && failures.length === 0

    // 6 — step 1b, tier by tier, in the account's own days.
    if (customer && !stopped) {
      const steps = planDetailRead({ timeZone: customer.timeZone, now, readThrough })
      const ctx: DetailContext = {
        target, customerId, currencyCode: customer.currencyCode, timeZone: customer.timeZone, now, spend: (ops) => { result.ops += ops }, extra,
      }
      if (droppedResources.size > 0) failures.push({ step: 'budget', failure: localFailure(SHORT_BUDGET_RUN_SENTENCE, 'SKIPPED_BUDGET') })
      detailPlannedLeft = steps.filter((s) => !droppedResources.has(s.resource)).reduce((total, s) => total + s.ops, 0)
      let stop: GoogleAdsFailure | null = null
      for (const planned of steps) {
        const resource = planned.resource
        if (droppedResources.has(resource)) {
          await notAttempted([resource], 'SKIPPED_BUDGET', SHORT_BUDGET_SENTENCE)
          continue
        }
        detailPlannedLeft -= planned.ops
        if (stop) {
          await notAttempted([resource], 'FAILED', `${NOT_REACHED_PREFIX} ${stop.sentence}`)
          continue
        }
        const askedAt = new Date()
        try {
          const read = await readDetail(ctx, planned, now)
          stored = true
          await recordReadState(customerId, resource, { status: 'SUCCESS', at: new Date(), readAt: askedAt, rows: read.rows, error: read.note })
          result.details.push({ resource, status: 'SUCCESS', rows: read.rows, error: null, ...(read.note ? { note: read.note } : {}) })
        } catch (err) {
          const failure = err instanceof GoogleAdsReadError
            ? err.failure
            : localFailure('Nexus could not finish this part of the read. It tries again at the next read.', 'INTERNAL')
          if (err instanceof GoogleAdsReadError) result.ops += err.opsSpent
          else logger.error('[google-ads-sync] step failed', { customerId, step: resource, error: err instanceof Error ? err.message : String(err) })
          failures.push({ step: resource, failure, detail: resource })
          result.details.push({ resource, status: 'FAILED', rows: 0, error: failure.sentence })
          try {
            await recordReadState(customerId, resource, { status: 'FAILED', at: new Date(), error: failure.sentence })
          } catch (recordErr) {
            logger.error('[google-ads-sync] could not record the read state', { customerId, step: resource, error: recordErr instanceof Error ? recordErr.message : String(recordErr) })
          }
          if (stopsTheDetail(failure)) { stop = failure; stopped = true }
        }
      }
    } else {
      // The core stopped the run: the step 1b reads say why they were not read (or that the allowance left them out).
      const why = failures[failures.length - 1]?.failure.sentence ?? NO_ACCOUNT_SENTENCE
      await notAttempted(ALL_DETAIL_RESOURCES.filter((r) => droppedResources.has(r)), 'SKIPPED_BUDGET', SHORT_BUDGET_SENTENCE)
      await notAttempted(ALL_DETAIL_RESOURCES.filter((r) => !droppedResources.has(r)), 'FAILED', `${NOT_REACHED_PREFIX} ${why}`)
    }

    // 7 — retention, in the account's days (local only: no Google call); policy issues resolved more than 90 days ago.
    const zone = knownTimeZone(customer?.timeZone) ?? knownTimeZone(account.timeZone)
    if (zone) {
      for (const grain of GRAINS) {
        try {
          await pruneDailyMetrics(customerId, grain.entityType, retentionKeepFrom(grain, zone, now))
        } catch (err) {
          logger.warn('[google-ads-sync] could not prune old days', { customerId, grain: grain.entityType, error: err instanceof Error ? err.message : String(err) })
        }
      }
    }
    try {
      await pruneResolvedPolicyIssues(customerId, new Date(now.getTime() - RESOLVED_ISSUE_DAYS * 86_400_000))
    } catch (err) {
      logger.warn('[google-ads-sync] could not prune resolved policy issues', { customerId, error: err instanceof Error ? err.message : String(err) })
    }

    // 8 — the account's read state.
    if (failures.length === 0) result.status = 'SUCCESS'
    else if (failures.some((f) => f.failure.authLost)) result.status = 'AUTH_LOST'
    else result.status = stored ? 'PARTIAL' : 'FAILED'
    const first = failures[0]
    result.error = first ? (first.detail ? `${READ_RESOURCE_TEXT[first.detail]}: ${first.failure.sentence}` : first.failure.sentence) : null
    // A good read's note is kept where a failure would be (as a step 1b read state keeps its note); a failure wins.
    await recordSyncOutcome(customerId, { status: result.status, error: result.error ?? result.note, ops: result.ops, at: new Date(), coreSucceeded, ...outcome })
    if (metricsStored) {
      publishMarketingEvent({ type: 'campaign.metrics.refreshed', channel: 'GOOGLE', marketplace: null, rows: result.metricRows, ts: Date.now() })
    }
    result.alertsRaised = await raiseAlerts(customerId, now)
    logger.info('[google-ads-sync] read finished', {
      customerId, kind: result.kind, mode: result.mode, status: result.status, note: result.note, ops: result.ops, campaigns: result.campaigns,
      removed: result.campaignsRemoved, metricRows: result.metricRows, changeEvents: result.changeEvents,
      detailsRead: result.details.filter((d) => d.status === 'SUCCESS').length, tiersDropped: result.tiersDropped, alertsRaised: result.alertsRaised,
      failedSteps: failures.map((f) => `${f.step}:${f.failure.code ?? 'unknown'}`),
    })
    return result
  } finally {
    // What was reserved and not spent goes back; what was spent beyond it (a restart after an expired page token, a
    // retry) is counted as spent — added to the buckets, never a reservation a full cap could refuse.
    result.opsReserved = reserved
    if (reserved > result.ops) await releaseOps(customerId, reserved - result.ops, reservation.reservedAt)
    else if (result.ops > reserved) await addSpentOps(customerId, result.ops - reserved, reservation.reservedAt)
  }
}

/** The alerts over what is now stored (alerts.service.ts; no Google call). Never fails the run. */
async function raiseAlerts(customerId: string, now: Date): Promise<number | null> {
  try {
    const { raiseGoogleAdsAlerts } = await import('./alerts.service.js')
    return (await raiseGoogleAdsAlerts(customerId, now)).raised
  } catch (err) {
    logger.warn('[google-ads-sync] alerts not evaluated', { customerId, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/**
 * The worker's entry: read the account if this business still reads it. A business that no longer has the account
 * linked gets no call (NOT_LINKED).
 */
export async function syncGoogleAdsCustomer(customerId: string, kind: GoogleAdsSyncKind, now?: Date): Promise<GoogleAdsSyncResult> {
  const target = await readTargetFor(customerId)
  if (!target) return { ...emptyResult(customerId, kind), status: 'NOT_LINKED', error: 'This business no longer reads this Google Ads account.' }
  return syncGoogleAdsAccount(target, { kind, now })
}

/** One line for the cron's run record. */
export function syncSummaryLine(results: GoogleAdsSyncResult[]): string {
  if (results.length === 0) return 'no Google Ads account chosen'
  return results.map((r) => {
    const details = r.details?.length ? ` details=${r.details.filter((d) => d.status === 'SUCCESS').length}/${r.details.length}` : ''
    return `${r.customerId.slice(-4)}: ${r.status}${r.mode ? ` ${r.mode}` : ''} ops=${r.ops} campaigns=${r.campaigns} days=${r.metricRows} changes=${r.changeEvents}${details}`
  }).join(' | ')
}
