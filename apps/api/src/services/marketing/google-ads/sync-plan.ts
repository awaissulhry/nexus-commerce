/**
 * Google Ads step 1b — what one read of an account asks Google for, and what it costs (plan-1b-backend §2). Pure: the
 * windows come from the account's time zone and the days already read; nothing here calls Google or the database.
 *
 *   core      the four step 1a reads (account, campaigns, campaign days, change history) + 1 spare operation; never dropped
 *   tier 2    safety: campaign settings, ad approvals, product status, auto-apply                       4 operations
 *   tier 3    numbers per day: ad groups, keywords, asset groups, products, search terms              5 (first reads more)
 *   tier 4    structure: ad groups, keywords + ad-group negatives, campaign negatives, asset groups   4
 *   tier 5    slow: negative keyword lists (their keywords, their campaigns, the account's list),     4
 *             recommendations
 *
 * A regular run costs 22 (RUN_OPS). When the allowance is short the run drops tier 5, then 4, 3 and 2; what it drops is
 * not read this time (SKIPPED_BUDGET) and nothing it read before moves. A grain's first read is reserved whole or not
 * at all: ad groups and keywords read 90 days in three 30-day pieces, search terms 30 days in two 15-day pieces, asset
 * groups 90 days and products 30 days in one — so the first run of an account costs 27.
 *
 * Windows, in the account's days, always ending yesterday (never today): 14 days (35 on the account's Sundays), search
 * terms 7 (14 on Sundays). A grain that missed runs reaches back to the day after its last day read, never further back
 * than its first read. A window longer than the Sunday window is read in pieces. A first read over the row cap is read
 * once more over half its window (`shorterFirstRead`; the campaign numbers' 400-day backfill: `shorterBackfill`), never
 * shorter than the daily window; the campaign numbers' catch-up after missed runs, over its oldest half (`shorterCatchUp`).
 */
import { BACKFILL_DAYS, DAILY_WINDOW_DAYS, accountToday, accountYesterday, addDays, chunkWindow, dayCount, weekdayOf, type DayWindow } from './dates.js'
import type { GoogleAdsDayResource, GoogleAdsDetailEntityType, GoogleAdsReadResource } from './types.js'

export type GoogleAdsTier = 2 | 3 | 4 | 5

/** The four step 1a reads: account, campaigns, campaign days, change history (one operation each). */
export const CORE_OPS = 4
/**
 * One operation for a retry, or for a safety-net query sent again without the field Google refused (every such field is
 * verified valid in v25: https://developers.google.com/google-ads/api/fields/v25/<resource>).
 */
export const SPARE_OPS = 1

/** A grain below the campaign: its windows, how its first read is cut, how long its days are kept. */
export interface GrainSpec {
  resource: GoogleAdsDayResource
  entityType: GoogleAdsDetailEntityType
  dailyDays: number
  sundayDays: number
  firstReadDays: number
  /** A window longer than `sundayDays` is read in pieces of this many days (one operation each). */
  chunkDays: number
  /** Days kept, ending yesterday; older days are deleted and the range read moves with them. */
  retentionDays: number
}

export const GRAINS: readonly GrainSpec[] = [
  { resource: 'AD_GROUP_DAYS', entityType: 'AD_GROUP', dailyDays: 14, sundayDays: 35, firstReadDays: 90, chunkDays: 30, retentionDays: 400 },
  { resource: 'KEYWORD_DAYS', entityType: 'KEYWORD', dailyDays: 14, sundayDays: 35, firstReadDays: 90, chunkDays: 30, retentionDays: 400 },
  { resource: 'ASSET_GROUP_DAYS', entityType: 'ASSET_GROUP', dailyDays: 14, sundayDays: 35, firstReadDays: 90, chunkDays: 90, retentionDays: 400 },
  { resource: 'PRODUCT_DAYS', entityType: 'PRODUCT', dailyDays: 14, sundayDays: 35, firstReadDays: 30, chunkDays: 30, retentionDays: 400 },
  { resource: 'SEARCH_TERM_DAYS', entityType: 'SEARCH_TERM', dailyDays: 7, sundayDays: 14, firstReadDays: 30, chunkDays: 15, retentionDays: 180 },
]

export const grainOf = (resource: GoogleAdsReadResource): GrainSpec | null => GRAINS.find((g) => g.resource === resource) ?? null

/** Every step 1b read, in the order a run takes them, with its tier and what a regular run spends on it. */
export const DETAIL_STEPS: ReadonlyArray<{ resource: GoogleAdsReadResource; tier: GoogleAdsTier; ops: number }> = [
  { resource: 'CAMPAIGN_SETTINGS', tier: 2, ops: 1 },
  { resource: 'AD_POLICY', tier: 2, ops: 1 },
  { resource: 'PRODUCT_STATUS', tier: 2, ops: 1 },
  { resource: 'AUTO_APPLY', tier: 2, ops: 1 },
  { resource: 'AD_GROUP_DAYS', tier: 3, ops: 1 },
  { resource: 'KEYWORD_DAYS', tier: 3, ops: 1 },
  { resource: 'ASSET_GROUP_DAYS', tier: 3, ops: 1 },
  { resource: 'PRODUCT_DAYS', tier: 3, ops: 1 },
  { resource: 'SEARCH_TERM_DAYS', tier: 3, ops: 1 },
  { resource: 'AD_GROUPS', tier: 4, ops: 1 },
  { resource: 'KEYWORDS', tier: 4, ops: 1 },
  { resource: 'CAMPAIGN_NEGATIVES', tier: 4, ops: 1 },
  { resource: 'ASSET_GROUPS', tier: 4, ops: 1 },
  // Their keywords, the campaigns they are attached to, and the list attached to the account (sync.service.ts).
  { resource: 'NEGATIVE_LISTS', tier: 5, ops: 3 },
  { resource: 'RECOMMENDATIONS', tier: 5, ops: 1 },
]

/** What a regular run reserves: core 4 + step 1b 17 + 1 spare. */
export const RUN_OPS = CORE_OPS + DETAIL_STEPS.reduce((total, step) => total + step.ops, 0) + SPARE_OPS

/** The tiers a run tries to reserve, largest first: everything, then without tier 5, without 5 and 4, … , core only. */
export const TIER_CANDIDATES: ReadonlyArray<readonly GoogleAdsTier[]> = [[2, 3, 4, 5], [2, 3, 4], [2, 3], [2], []]

/** The days a grain reads in this run. */
export interface GrainRead {
  window: DayWindow
  /** Pieces of the window, oldest first: one query (one operation) each. */
  chunks: DayWindow[]
  /** Never read before: the whole first read, stored all or nothing. */
  first: boolean
}

/** A time zone Intl knows, else null. */
export function knownTimeZone(timeZone: string | null | undefined): string | null {
  if (!timeZone) return null
  try {
    accountToday(timeZone, new Date(0))
    return timeZone
  } catch {
    return null
  }
}

/**
 * The window a grain reads now. Never read → its first read (ending yesterday). Otherwise the regular window, reaching
 * back to the day after its last day read when runs were missed, but never further back than a first read.
 */
export function grainRead(spec: GrainSpec, timeZone: string, now: Date, readThrough: string | null): GrainRead {
  const yesterday = accountYesterday(timeZone, now)
  const oldest = addDays(yesterday, -(spec.firstReadDays - 1))
  let window: DayWindow
  if (!readThrough) {
    window = { from: oldest, to: yesterday }
  } else {
    const regular = weekdayOf(accountToday(timeZone, now)) === 0 ? spec.sundayDays : spec.dailyDays
    let from = addDays(yesterday, -(regular - 1))
    const next = addDays(readThrough, 1)
    if (next < from) from = next > oldest ? next : oldest
    window = { from, to: yesterday }
  }
  return { window, chunks: dayCount(window) > spec.sundayDays ? chunkWindow(window, spec.chunkDays) : [window], first: !readThrough }
}

/** Half of a first read's days, ending where it ended, never shorter than the daily window; null when not shorter. */
function halfOf(window: DayWindow, firstReadDays: number, dailyDays: number): DayWindow | null {
  const days = Math.max(dailyDays, Math.floor(firstReadDays / 2))
  if (days >= dayCount(window)) return null
  return { from: addDays(window.to, -(days - 1)), to: window.to }
}

/**
 * A first read that Google answered with too many rows (sync.service.ts): read once more over half the first window,
 * never shorter than the daily window, ending yesterday as before (90 days → 45; 30 → 15). Null when it would not be
 * shorter, so a run retries at most once and never loops.
 */
export function shorterFirstRead(spec: GrainSpec, read: GrainRead): GrainRead | null {
  const window = read.first ? halfOf(read.window, spec.firstReadDays, spec.dailyDays) : null
  if (!window) return null
  return { window, chunks: dayCount(window) > spec.sundayDays ? chunkWindow(window, spec.chunkDays) : [window], first: true }
}

/**
 * The same for the campaign numbers' first read (the 400-day backfill, one query): once more over half of it, never
 * shorter than the daily window, ending yesterday as before (400 days → 200). Null when it would not be shorter.
 */
export function shorterBackfill(window: DayWindow): DayWindow | null {
  return halfOf(window, BACKFILL_DAYS, DAILY_WINDOW_DAYS)
}

/**
 * The campaign numbers' catch-up after missed runs (the daily read reaching back to the day after the last day read, up
 * to 400 days, one query) over the row cap: once more over its OLDEST half, never shorter than the daily window — the
 * days right after the last day read, so the range of days read stays in one piece and the next read goes on from
 * there. (Its newest half would leave a gap, and store.ts `mergeReadRange` then drops the older range: every day read
 * before would count as not read.) Null when it would not be shorter.
 */
export function shorterCatchUp(window: DayWindow): DayWindow | null {
  const days = Math.max(DAILY_WINDOW_DAYS, Math.floor(dayCount(window) / 2))
  if (days >= dayCount(window)) return null
  return { from: window.from, to: addDays(window.from, days - 1) }
}

export interface PlannedStep {
  resource: GoogleAdsReadResource
  tier: GoogleAdsTier
  /** Operations this step spends in this run (its first query of each piece; later pages are free). */
  ops: number
  /** *_DAYS steps only. */
  grain?: GrainRead & { spec: GrainSpec }
}

/** Every step 1b read of this run, with its windows and cost. `readThrough` = each grain's last day read (null = never). */
export function planDetailRead(input: { timeZone: string; now: Date; readThrough: Partial<Record<GoogleAdsDayResource, string | null>> }): PlannedStep[] {
  return DETAIL_STEPS.map((step) => {
    const spec = grainOf(step.resource)
    if (!spec) return { ...step }
    const read = grainRead(spec, input.timeZone, input.now, input.readThrough[spec.resource] ?? null)
    return { ...step, ops: read.chunks.length, grain: { ...read, spec } }
  })
}

/** Operations of the steps in these tiers. */
export function detailOps(steps: readonly PlannedStep[], tiers: readonly GoogleAdsTier[]): number {
  return steps.filter((step) => tiers.includes(step.tier)).reduce((total, step) => total + step.ops, 0)
}

/** What a run with these tiers reserves before its first call. */
export const runOps = (steps: readonly PlannedStep[], tiers: readonly GoogleAdsTier[]): number => CORE_OPS + SPARE_OPS + detailOps(steps, tiers)

/** The first day a grain keeps: older days are deleted (CAMPAIGN days are kept forever). */
export const retentionKeepFrom = (spec: GrainSpec, timeZone: string, now: Date): string =>
  addDays(accountYesterday(timeZone, now), -(spec.retentionDays - 1))

/** Each step 1b read in words (the run's sentence names the part that was not read). */
export const READ_RESOURCE_TEXT: Readonly<Record<GoogleAdsReadResource, string>> = {
  CAMPAIGN_SETTINGS: 'Campaign settings',
  AD_POLICY: 'Ad approvals',
  PRODUCT_STATUS: 'Product status',
  AUTO_APPLY: 'Auto-apply settings',
  AD_GROUP_DAYS: 'Ad group numbers',
  KEYWORD_DAYS: 'Keyword numbers',
  ASSET_GROUP_DAYS: 'Asset group numbers',
  PRODUCT_DAYS: 'Product numbers',
  SEARCH_TERM_DAYS: 'Search terms',
  AD_GROUPS: 'Ad groups',
  KEYWORDS: 'Keywords',
  CAMPAIGN_NEGATIVES: 'Campaign negative keywords',
  ASSET_GROUPS: 'Asset groups',
  NEGATIVE_LISTS: 'Negative keyword lists',
  RECOMMENDATIONS: 'Recommendations',
}
