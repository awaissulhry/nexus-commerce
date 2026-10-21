/**
 * Meta ads M1 — one read of one Meta ad account, in the CURRENT business. Read-only: every call is a GET through the
 * gateway, which refuses anything else (gateway/meta-calls.ts).
 *
 *   1. the account (`GET act_<id>`: name, currency, time zone, status, disable reason — required; then its money and its
 *      other settings, and the edges minimum_budgets, ads_volume, promote_pages, instagram_accounts — each optional,
 *      a failure kept in words in the settings)
 *   2. campaigns, 3. ad sets, 4. ads — every status but DELETED; after a full read, the ones Meta no longer returns
 *      get `removedAt`
 *   5–8. daily numbers of the account itself (level=account: Ads › Meta's totals and days, every child included, Meta's
 *      own reach), then per campaign, ad set and ad with an effective_status filter naming every status, ARCHIVED and
 *      DELETED included (review B1: without it Meta leaves them out); a piece Meta finds too big is halved, down to one
 *      day (review B4); a re-read never erases a stored day of an object Meta left out (store.ts)
 *      (`GET act_<id>/insights`, time_increment=1; Meta reports with each
 *      ad set's own attribution setting, as Ads Manager — since 2025-06-10 it ignores use_unified_attribution_setting and
 *      action_report_time, so neither is sent, facts F2 T1): never read → the last 180 account days in
 *      pieces of 30 (BACKFILL); otherwise the last 28 days, reaching back to the day after the last day read when runs
 *      were missed
 *   8. the account's read state, and `campaign.metrics.refreshed` (channel META) when numbers were stored
 *
 * A step that fails is recorded in words and the next one still runs — unless nothing else can work (the token lost,
 * Meta asking to slow down, access refused, or the gateway refusing): the run stops. A failed step deletes nothing.
 * Fields and params checked 2026-10-20 on developers.facebook.com/documentation/ads-commerce/marketing-api/reference
 * (ad-account, ad-account/campaigns, ad-campaign-group, ad-campaign, adgroup, ad-account/insights).
 */
import { logger } from '../../../utils/logger.js'
import { publishMarketingEvent } from '../../marketing-events.service.js'
import { accountYesterday, addDays, chunkWindow, dateToDay, dayCount, metaBackfillWindow, metaReadWindow, META_INSIGHTS_CHUNK_DAYS, type DayWindow } from './dates.js'
import { localFailure, MetaReadError, type MetaFailure } from './errors.js'
import {
  ACCOUNT_CORE_FIELDS, ACCOUNT_FUNDING_FIELDS, ACCOUNT_MONEY_FIELDS, ACCOUNT_SETTINGS_FIELDS, ADSET_FIELDS, ADSET_STATUSES_READ, AD_FIELDS, AD_STATUSES_READ, CAMPAIGN_FIELDS,
  CAMPAIGN_STATUSES_READ, insightFields, insightStatusFilter, mapAccount, mapAd, mapAdSet, mapCampaign, mapInsightDay,
} from './mappers.js'
import { metaReadAll, metaReadOne } from './read-client.js'
import {
  ensureMetaAdAccount, getReadStates, markUnseenRemoved, recordStructureRead, recordSyncOutcome, replaceDailyMetrics, saveAccountDetails, saveReadState, upsertAdSets, upsertAds,
  upsertCampaigns,
} from './store.js'
import { metaReadTargetFor } from './targets.js'
import { maskTakenAssets } from './taken.js'
import type { MetaAdData, MetaAdSetData, MetaAdsEntityType, MetaAdsReadResource, MetaAdsSyncStatus, MetaAdsTarget, MetaCampaignData, MetaDailyMetricData } from './types.js'

/**
 * TOKEN: the read queued at once after a good token, when the last read lost the token (review A2).
 * WEBHOOK (step 30): the re-read a verified Meta webhook asks for — the account and its campaigns, ad sets and ads, no
 * daily numbers (a push says an object changed, never its numbers); it moves only structureSyncedAt, never the account's
 * last read and its status (those stay the daily read's and "Read now"'s, so a push never blocks "Read now").
 */
export type MetaAdsSyncKind = 'BACKFILL' | 'DAILY' | 'MANUAL' | 'TOKEN' | 'WEBHOOK'

/** More daily rows than this in one grain's read is not kept (memory); the read says so. */
export const MAX_METRIC_ROWS = 200_000
/** Pages of a structure list (200 per page). */
const STRUCTURE_PAGE = 200
const INSIGHTS_PAGE = 500

export interface MetaAdsSyncResult {
  adAccountId: string
  kind: MetaAdsSyncKind
  mode: 'BACKFILL' | 'DAILY' | null
  status: MetaAdsSyncStatus | 'NOT_LINKED'
  error: string | null
  calls: number
  campaigns: number
  adSets: number
  ads: number
  removed: number
  metricRows: number
  window: DayWindow | null
  /** What the read could only do in part, in words (e.g. live objects only at one level); kept as a PARTIAL read. */
  notes: string[]
}

function stopsTheRun(failure: MetaFailure): boolean {
  return failure.authLost || failure.throttled || failure.permissionDenied || failure.origin === 'gateway'
}

interface StepFailure { step: string; failure: MetaFailure }

const act = (adAccountId: string) => `act_${adAccountId}`

/** Read one Meta ad account now. Never throws for a Meta answer; the result and the account row say what happened. */
export async function syncMetaAdAccount(target: MetaAdsTarget, options: { kind: MetaAdsSyncKind; now?: Date }): Promise<MetaAdsSyncResult> {
  const now = options.now ?? new Date()
  const { adAccountId } = target
  const result: MetaAdsSyncResult = {
    adAccountId, kind: options.kind, mode: null, status: 'FAILED', error: null, calls: 0,
    campaigns: 0, adSets: 0, ads: 0, removed: 0, metricRows: 0, window: null, notes: [],
  }
  /** The entities the structure read listed this run (review 2: an empty insights answer for them means zero days). */
  const listed: Partial<Record<MetaAdsEntityType, Set<string>>> = { ACCOUNT: new Set([adAccountId]) }
  const account = await ensureMetaAdAccount({ connectionId: target.connectionId, adAccountId, name: null, currencyCode: null, timeZone: null })
  const triggeredBy = options.kind === 'MANUAL' ? 'manual' as const : 'cron' as const
  const failures: StepFailure[] = []
  let stopped = false
  let stored = false
  let metricsStored = false
  const outcome: { structureSyncedAt?: Date; backfillCompletedAt?: Date } = {}
  const structureOnly = options.kind === 'WEBHOOK'

  const step = async (name: string, resource: MetaAdsReadResource | null, work: () => Promise<number>): Promise<boolean> => {
    if (stopped) return false
    try {
      const rows = await work()
      if (resource) await saveReadState(adAccountId, resource, { ok: true, rows, at: new Date() })
      return true
    } catch (err) {
      const failure = err instanceof MetaReadError ? err.failure : localFailure('Nexus could not finish this part of the read. It tries again at the next read.', 'INTERNAL')
      if (err instanceof MetaReadError) result.calls += err.callsSpent
      else logger.error('[meta-ads-sync] step failed', { adAccountId, step: name, error: err instanceof Error ? err.message : String(err) })
      failures.push({ step: name, failure })
      if (resource) await saveReadState(adAccountId, resource, { ok: false, error: failure.sentence, at: new Date() }).catch(() => undefined)
      if (stopsTheRun(failure)) stopped = true
      return false
    }
  }

  // 1 — the account.
  let ctx: { adAccountId: string; currencyCode: string; timeZone: string } | null = null
  await step('account', 'ACCOUNT', async () => {
    const core = await metaReadOne(target, { operation: 'adAccount.read', path: act(adAccountId), query: { fields: ACCOUNT_CORE_FIELDS }, triggeredBy })
    result.calls += core.calls
    const settings: Record<string, unknown> = {}
    const missing: Record<string, string> = {}
    const optional = async (key: string, operation: string, path: string, query: Record<string, string | number>) => {
      if (stopped) return null
      try {
        const read = await metaReadOne(target, { operation, path, query, triggeredBy })
        result.calls += read.calls
        return read.body
      } catch (err) {
        if (!(err instanceof MetaReadError)) throw err
        result.calls += err.callsSpent
        missing[key] = err.failure.sentence
        if (err.failure.authLost || err.failure.throttled || err.failure.origin === 'gateway') throw err
        return null
      }
    }
    const money = await optional('money', 'adAccount.money', act(adAccountId), { fields: ACCOUNT_MONEY_FIELDS })
    // Review A7 — the payment method on its own: it needs MANAGE, and a refusal must never null the money above.
    const funding = await optional('fundingSource', 'adAccount.fundingSource', act(adAccountId), { fields: ACCOUNT_FUNDING_FIELDS })
    const more = await optional('settings', 'adAccount.settings', act(adAccountId), { fields: ACCOUNT_SETTINGS_FIELDS })
    if (more) for (const [k, v] of Object.entries(more)) if (k !== 'id') settings[k] = v
    const edge = async (key: string, path: string, fields?: string) => {
      const body = await optional(key, `adAccount.${key}`, `${act(adAccountId)}/${path}`, { ...(fields ? { fields } : {}), limit: 100 })
      if (body) settings[key] = Array.isArray((body as { data?: unknown }).data) ? (body as { data: unknown[] }).data : body
    }
    await edge('minimumBudgets', 'minimum_budgets')
    await edge('adsVolume', 'ads_volume')
    await edge('promotePages', 'promote_pages', 'id,name')
    await edge('instagramAccounts', 'instagram_accounts', 'id,username')
    if (Object.keys(missing).length) settings.notRead = missing
    // Review A1 — a promoted Page or Instagram account another business in Nexus uses is kept by its id and the flag only.
    await maskTakenAssets(settings)
    const details = mapAccount(core.body, money, settings, funding)
    if (!details || details.adAccountId !== adAccountId) throw new MetaReadError(localFailure('Meta sent no usable details for this ad account (currency or time zone missing), so Nexus read nothing.', 'NO_ACCOUNT'), 'adAccount.read')
    try {
      accountYesterday(details.timeZone, now)
    } catch {
      throw new MetaReadError(localFailure('Meta sent a time zone Nexus does not know, so it cannot tell the account\'s days apart.', 'UNKNOWN_TIME_ZONE'), 'adAccount.read')
    }
    await saveAccountDetails(target.connectionId, details, new Date())
    ctx = { adAccountId, currencyCode: details.currencyCode, timeZone: details.timeZone }
    stored = true
    return 1
  })

  const context = ctx as { adAccountId: string; currencyCode: string; timeZone: string } | null
  if (context && !stopped) {
    const askedAt = new Date()
    // 2–4 — structure.
    await step('campaigns', 'CAMPAIGNS', async () => {
      let rows: MetaCampaignData[] = []
      const read = await metaReadAll(target, { operation: 'campaigns.list', path: `${act(adAccountId)}/campaigns`, query: { fields: CAMPAIGN_FIELDS, effective_status: CAMPAIGN_STATUSES_READ, limit: STRUCTURE_PAGE }, triggeredBy }, (page) => {
        for (const row of page) { const c = mapCampaign(row, context); if (c) rows.push(c) }
      })
      result.calls += read.calls
      result.campaigns = await upsertCampaigns(rows, now)
      if (!read.truncated) listed.CAMPAIGN = new Set(rows.map((r) => r.campaignId))
      if (!read.truncated) result.removed += (await markUnseenRemoved('campaign', adAccountId, now, rows.length)).removed
      stored = true
      rows = []
      return result.campaigns
    })
    await step('adSets', 'ADSETS', async () => {
      const rows: MetaAdSetData[] = []
      const read = await metaReadAll(target, { operation: 'adsets.list', path: `${act(adAccountId)}/adsets`, query: { fields: ADSET_FIELDS, effective_status: ADSET_STATUSES_READ, limit: STRUCTURE_PAGE }, triggeredBy }, (page) => {
        for (const row of page) { const a = mapAdSet(row, context); if (a) rows.push(a) }
      })
      result.calls += read.calls
      result.adSets = await upsertAdSets(rows, now)
      if (!read.truncated) listed.ADSET = new Set(rows.map((r) => r.adSetId))
      if (!read.truncated) result.removed += (await markUnseenRemoved('adSet', adAccountId, now, rows.length)).removed
      stored = true
      return result.adSets
    })
    await step('ads', 'ADS', async () => {
      const rows: MetaAdData[] = []
      const read = await metaReadAll(target, { operation: 'ads.list', path: `${act(adAccountId)}/ads`, query: { fields: AD_FIELDS, effective_status: AD_STATUSES_READ, limit: STRUCTURE_PAGE }, triggeredBy }, (page) => {
        for (const row of page) { const a = mapAd(row, context); if (a) rows.push(a) }
      })
      result.calls += read.calls
      result.ads = await upsertAds(rows, now)
      if (!read.truncated) listed.AD = new Set(rows.map((r) => r.adId))
      if (!read.truncated) result.removed += (await markUnseenRemoved('ad', adAccountId, now, rows.length)).removed
      stored = true
      return result.ads
    })
    if (failures.every((f) => !['campaigns', 'adSets', 'ads'].includes(f.step))) outcome.structureSyncedAt = askedAt

    // 5–7 — daily numbers per grain.
    const backfill = !account.backfillCompletedAt
    result.mode = structureOnly ? null : backfill ? 'BACKFILL' : 'DAILY'
    const states = await getReadStates(adAccountId)
    const readThroughOf = (grain: MetaAdsEntityType): string | null => {
      if (grain === 'CAMPAIGN') return account.metricsReadThrough ? dateToDay(account.metricsReadThrough) : null
      const state = states.get(grain === 'ACCOUNT' ? 'ACCOUNT_DAYS' : grain === 'ADSET' ? 'ADSET_DAYS' : 'AD_DAYS')
      return state?.readThrough ? dateToDay(state.readThrough) : null
    }
    const windowOf = (grain: MetaAdsEntityType): DayWindow => (backfill || !readThroughOf(grain)
      ? metaBackfillWindow(context.timeZone, now)
      : metaReadWindow(context.timeZone, now, readThroughOf(grain)))
    result.window = structureOnly ? null : windowOf('CAMPAIGN')
    const level = { ACCOUNT: 'account', CAMPAIGN: 'campaign', ADSET: 'adset', AD: 'ad' } as const
    const LEVEL_WORDS = { ACCOUNT: 'account', CAMPAIGN: 'campaign', ADSET: 'ad set', AD: 'ad' } as const
    /** Levels where Meta refused the status filter this run: read without it (live objects only), said in words. */
    const liveOnly = new Set<MetaAdsEntityType>()
    /** One piece of days at one grain; Meta's "too much at once" halves it, down to one day (review B4). */
    const readPiece = async (grain: MetaAdsEntityType, piece: DayWindow): Promise<number> => {
      const rows: MetaDailyMetricData[] = []
      // Review B1 — archived and deleted objects too: without the filter Meta returns live objects only.
      const filtered = grain !== 'ACCOUNT' && !liveOnly.has(grain)
      let read: Awaited<ReturnType<typeof metaReadAll>>
      try {
        read = await metaReadAll(target, {
          operation: `insights.${level[grain]}Days`,
          path: `${act(adAccountId)}/insights`,
          query: {
            level: level[grain], time_increment: 1, time_range: { since: piece.from, until: piece.to }, fields: insightFields(grain),
            ...(filtered ? { filtering: insightStatusFilter(grain as Exclude<MetaAdsEntityType, 'ACCOUNT'>) } : {}),
            limit: INSIGHTS_PAGE,
          },
          maxPages: 400,
          triggeredBy,
        }, (page) => {
          for (const row of page) { const d = mapInsightDay(row, { ...context, level: grain }); if (d) rows.push(d) }
          if (rows.length > MAX_METRIC_ROWS) {
            throw new MetaReadError(localFailure(`Meta sent more than ${MAX_METRIC_ROWS.toLocaleString('en-US')} rows of daily numbers for one piece of this read; Nexus kept none of that piece.`, 'TOO_MANY_ROWS'), 'insights')
          }
        })
      } catch (err) {
        if (err instanceof MetaReadError && err.failure.shrink && dayCount(piece) > 1) {
          result.calls += err.callsSpent
          const half = Math.floor(dayCount(piece) / 2)
          const first = { from: piece.from, to: addDays(piece.from, half - 1) }
          const second = { from: addDays(piece.from, half), to: piece.to }
          return (await readPiece(grain, first)) + (await readPiece(grain, second))
        }
        // Review 2 (B1) — the campaign and ad set forms of the status filter are not documented: a #100 refusal that is
        // not "too much at once" reads the piece once more without the filter (live objects only), and says so.
        if (err instanceof MetaReadError && filtered && !err.failure.shrink && !err.failure.permissionDenied && /^100(\/|$)/.test(err.failure.code ?? '')) {
          result.calls += err.callsSpent
          liveOnly.add(grain)
          result.notes.push(`Meta refused the filter that also reads archived and deleted ${LEVEL_WORDS[grain]}s (${err.failure.code}); the ${LEVEL_WORDS[grain]} numbers of this read are of live ${LEVEL_WORDS[grain]}s only.`)
          return readPiece(grain, piece)
        }
        throw err
      }
      result.calls += read.calls
      if (read.truncated) throw new MetaReadError(localFailure('Meta sent more pages of numbers than Nexus reads at once; Nexus kept none of that piece.', 'TOO_MANY_PAGES'), 'insights', 0)
      // Review 2 (A3/B5) — an entity the structure read listed and Meta sent no row for has zero days in this piece (Meta
      // leaves out days with no delivery); not when reading live objects only (an archived one would look like zero).
      const zeroFor = filtered ? listed[grain] : undefined
      const saved = await replaceDailyMetrics(adAccountId, grain, piece, rows, new Date(), { zeroFor })
      metricsStored = true
      stored = true
      return saved.rows
    }
    const days = async (grain: MetaAdsEntityType): Promise<number> => {
      let total = 0
      for (const piece of chunkWindow(windowOf(grain), META_INSIGHTS_CHUNK_DAYS)) total += await readPiece(grain, piece)
      result.metricRows += total
      return total
    }
    // Review B1 — the account's own days first: its totals include every child (live, archived, deleted) and its reach
    // is Meta's own; Ads › Meta's totals and days come from these, never from a sum of campaigns.
    if (!structureOnly) {
      const accountDaysOk = await step('accountDays', null, () => days('ACCOUNT'))
      const campaignDaysOk = await step('campaignDays', null, () => days('CAMPAIGN'))
      await step('adSetDays', null, () => days('ADSET'))
      await step('adDays', null, () => days('AD'))
      if (backfill && campaignDaysOk && accountDaysOk) outcome.backfillCompletedAt = new Date()
    }
  }

  if (failures.length === 0) result.status = result.notes.length ? 'PARTIAL' : 'SUCCESS'
  else if (failures.some((f) => f.failure.authLost)) result.status = 'AUTH_LOST'
  else if (failures.some((f) => f.failure.throttled)) result.status = 'THROTTLED'
  else result.status = stored ? 'PARTIAL' : 'FAILED'
  result.error = failures[0]?.failure.sentence ?? result.notes[0] ?? null
  if (structureOnly) await recordStructureRead(adAccountId, outcome.structureSyncedAt ?? null)
  else await recordSyncOutcome(adAccountId, { status: result.status, error: result.error, calls: result.calls, at: new Date(), ...outcome })
  if (metricsStored) publishMarketingEvent({ type: 'campaign.metrics.refreshed', channel: 'META', marketplace: null, rows: result.metricRows, ts: Date.now() })
  logger.info('[meta-ads-sync] read finished', {
    adAccountId: adAccountId.slice(-4), kind: result.kind, mode: result.mode, status: result.status, calls: result.calls,
    campaigns: result.campaigns, adSets: result.adSets, ads: result.ads, removed: result.removed, metricRows: result.metricRows,
    failedSteps: failures.map((f) => `${f.step}:${f.failure.code ?? 'unknown'}`),
  })
  return result
}

/** The worker's entry: read the account if this business still reads it (NOT_LINKED otherwise, no call). */
export async function syncMetaAdAccountById(adAccountId: string, kind: MetaAdsSyncKind, now?: Date): Promise<MetaAdsSyncResult> {
  const target = await metaReadTargetFor(adAccountId)
  if (!target) {
    return {
      adAccountId, kind, mode: null, status: 'NOT_LINKED', error: 'This business no longer reads this Meta ad account.', calls: 0,
      campaigns: 0, adSets: 0, ads: 0, removed: 0, metricRows: 0, window: null, notes: [],
    }
  }
  return syncMetaAdAccount(target, { kind, now })
}

/** One line for the cron's run record (the account's last 4 digits only). */
export function metaSyncSummaryLine(results: MetaAdsSyncResult[]): string {
  if (results.length === 0) return 'no Meta ad account chosen'
  return results.map((r) => `${r.adAccountId.slice(-4)}: ${r.status}${r.mode ? ` ${r.mode}` : ''} calls=${r.calls} campaigns=${r.campaigns} adsets=${r.adSets} ads=${r.ads} days=${r.metricRows}`).join(' | ')
}
