/**
 * Google Ads step 1a — one read of one Google Ads account, in the CURRENT business (PLAN.md L9, L10; plan-2 §4).
 * Read-only: every call is a GoogleAdsService.Search through the gateway, which refuses anything else.
 *
 *   1. reserve the run's operations (customer 1 + campaigns 1 + daily numbers 1 + change history 1 + spare 1); a
 *      refused reservation means no call at all (SKIPPED_BUDGET)
 *   2. the account (`customer`): a MANAGER account holds no campaigns of its own — the run stops there (MANAGER)
 *   3. campaigns with their budgets; after a full read, campaigns no longer returned get `removedAt`
 *   4. daily campaign numbers: never read → the last 400 account days (BACKFILL); otherwise the last 14 days (35 on the
 *      account's Sundays), reaching back to the day after the last day read when the account missed runs
 *   5. Google's change history: never read → its whole 30 days; otherwise from where the last read stopped
 *   6. the account's read state, and `campaign.metrics.refreshed` (channel GOOGLE) when numbers were stored
 *
 * A step that fails is recorded in words and the next one still runs — unless the failure means nothing else can
 * work (sign-in lost, the day's allowance used up, access refused, the Nexus app not approved): the run stops. A
 * failed step deletes nothing: the stored days are replaced only by a complete read of them.
 */
import { logger } from '../../../utils/logger.js'
import { publishMarketingEvent } from '../../marketing-events.service.js'
import { accountYesterday, addDays, backfillWindow, changeHistoryWindow, dailyWindow, dateToDay, type DayWindow } from './dates.js'
import { GoogleAdsReadError, localFailure, type GoogleAdsFailure } from './errors.js'
import { CAMPAIGNS_QUERY, CHANGE_EVENT_LIMIT, CUSTOMER_QUERY, campaignDailyMetricsQuery, changeEventsQuery } from './gaql.js'
import { mapCampaign, mapCampaignDay, mapChangeEvent, mapCustomer } from './mappers.js'
import { addSpentOps, releaseOps, reserveOps } from './ops-budget.js'
import { searchAll, searchRows } from './read-client.js'
import {
  ensureGoogleAdsCustomer, markUnseenCampaignsRemoved, recordSyncOutcome, replaceDailyMetrics, saveCustomerDetails, storeChangeEvents,
  upsertCampaigns, type GoogleAdsSyncStatus,
} from './store.js'
import { readTargetFor } from './targets.js'
import type {
  GoogleAdsCampaignData, GoogleAdsCampaignDayRow, GoogleAdsCampaignRow, GoogleAdsChangeEventData, GoogleAdsChangeEventRow, GoogleAdsCustomerRow,
  GoogleAdsDailyMetricData, GoogleAdsTarget,
} from './types.js'

export type GoogleAdsSyncKind = 'BACKFILL' | 'DAILY' | 'MANUAL'

/** Operations a run reserves before its first call (PLAN.md L10: 4 + a spare). */
export const RUN_OPS = 5
/** A change history read that hits Google's LIMIT continues at most this many times (one more operation each). */
export const CHANGE_HISTORY_CONTINUATIONS = 2
/** More daily rows than this in one read is not kept (memory); the read says so. */
export const MAX_METRIC_ROWS = 200_000

const MANAGER_SENTENCE = 'This is a Google Ads manager account: it has no campaigns of its own. Choose one of the accounts under it in Settings, Channels, Google.'
const NO_ACCOUNT_SENTENCE = 'Google Ads sent no details for this account, so Nexus read nothing.'

export interface GoogleAdsSyncResult {
  customerId: string
  /** What was asked. */
  kind: GoogleAdsSyncKind
  /** What was read: the 400-day first read, or the daily window. Null when no number was asked for. */
  mode: 'BACKFILL' | 'DAILY' | null
  status: GoogleAdsSyncStatus | 'NOT_LINKED'
  /** The first failure in words, or null. */
  error: string | null
  ops: number
  campaigns: number
  campaignsRemoved: number
  removalBreaker: boolean
  metricRows: number
  window: DayWindow | null
  changeEvents: number
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

interface StepFailure { step: string; failure: GoogleAdsFailure }

/** Read one Google Ads account now. Never throws for a Google answer; the result and the account row say what happened. */
export async function syncGoogleAdsAccount(target: GoogleAdsTarget, options: { kind: GoogleAdsSyncKind; now?: Date }): Promise<GoogleAdsSyncResult> {
  const now = options.now ?? new Date()
  const customerId = target.customerId
  const result: GoogleAdsSyncResult = {
    customerId, kind: options.kind, mode: null, status: 'FAILED', error: null, ops: 0,
    campaigns: 0, campaignsRemoved: 0, removalBreaker: false, metricRows: 0, window: null, changeEvents: 0,
  }
  const account = await ensureGoogleAdsCustomer({
    connectionId: target.connectionId, customerId, loginCustomerId: target.loginCustomerId,
    descriptiveName: null, currencyCode: null, timeZone: null, testAccount: false,
  })

  // 1 — the allowance first: a refused reservation sends nothing.
  const reservation = await reserveOps(customerId, RUN_OPS, now)
  if (!reservation.ok) {
    result.status = 'SKIPPED_BUDGET'
    result.error = reservation.sentence
    await recordSyncOutcome(customerId, { status: 'SKIPPED_BUDGET', error: reservation.sentence, ops: 0, at: new Date() })
    logger.info('[google-ads-sync] not started: no allowance', { customerId, reason: reservation.reason })
    return result
  }
  let reserved = reservation.ops
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
        let days: GoogleAdsDailyMetricData[] = []
        const read = await searchAll<GoogleAdsCampaignDayRow>(target, campaignDailyMetricsQuery(window), (rows) => {
          for (const row of rows) {
            const day = mapCampaignDay(row, context)
            if (day) days.push(day)
          }
          // Thrown from a page: the query's one operation is spent.
          if (days.length > MAX_METRIC_ROWS) {
            throw new GoogleAdsReadError(localFailure(`Google sent more than ${MAX_METRIC_ROWS.toLocaleString('en-US')} rows of daily numbers for this account; Nexus kept none of this read.`, 'TOO_MANY_ROWS'), 'ads.search.campaignDays', 1)
          }
        }, { operation: 'ads.search.campaignDays', onRestart: () => { days = [] } })
        result.ops += read.ops
        const saved = await replaceDailyMetrics(customerId, 'CAMPAIGN', window, days, new Date())
        result.metricRows = saved.rows
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

    if (failures.length === 0) result.status = 'SUCCESS'
    else if (failures.some((f) => f.failure.authLost)) result.status = 'AUTH_LOST'
    else result.status = stored ? 'PARTIAL' : 'FAILED'
    result.error = failures[0]?.failure.sentence ?? null
    await recordSyncOutcome(customerId, { status: result.status, error: result.error, ops: result.ops, at: new Date(), ...outcome })
    if (metricsStored) {
      publishMarketingEvent({ type: 'campaign.metrics.refreshed', channel: 'GOOGLE', marketplace: null, rows: result.metricRows, ts: Date.now() })
    }
    logger.info('[google-ads-sync] read finished', {
      customerId, kind: result.kind, mode: result.mode, status: result.status, ops: result.ops, campaigns: result.campaigns,
      removed: result.campaignsRemoved, metricRows: result.metricRows, changeEvents: result.changeEvents,
      failedSteps: failures.map((f) => `${f.step}:${f.failure.code ?? 'unknown'}`),
    })
    return result
  } finally {
    // What was reserved and not spent goes back; what was spent beyond it (retries) is counted as spent — added to the
    // buckets, never a reservation that a full cap could refuse and give back uncounted.
    if (reserved > result.ops) await releaseOps(customerId, reserved - result.ops, reservation.reservedAt)
    else if (result.ops > reserved) await addSpentOps(customerId, result.ops - reserved, reservation.reservedAt)
  }
}

/**
 * The worker's entry: read the account if this business still reads it. A business that no longer has the account
 * linked gets no call (NOT_LINKED).
 */
export async function syncGoogleAdsCustomer(customerId: string, kind: GoogleAdsSyncKind, now?: Date): Promise<GoogleAdsSyncResult> {
  const target = await readTargetFor(customerId)
  if (!target) {
    return {
      customerId, kind, mode: null, status: 'NOT_LINKED', error: 'This business no longer reads this Google Ads account.', ops: 0,
      campaigns: 0, campaignsRemoved: 0, removalBreaker: false, metricRows: 0, window: null, changeEvents: 0,
    }
  }
  return syncGoogleAdsAccount(target, { kind, now })
}

/** One line for the cron's run record. */
export function syncSummaryLine(results: GoogleAdsSyncResult[]): string {
  if (results.length === 0) return 'no Google Ads account chosen'
  return results.map((r) => `${r.customerId.slice(-4)}: ${r.status}${r.mode ? ` ${r.mode}` : ''} ops=${r.ops} campaigns=${r.campaigns} days=${r.metricRows} changes=${r.changeEvents}`).join(' | ')
}
