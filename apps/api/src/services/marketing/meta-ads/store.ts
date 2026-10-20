/**
 * Meta ads M1 — what a read keeps, in the CURRENT business (every row carries it; row-level security keeps one
 * business from another's rows, and each unique key starts with it). Idempotent: the same read twice leaves the same rows.
 *
 *   account     one MetaAdAccount row per ad account the business reads, with its settings and the state of its read
 *   structure   campaigns, ad sets and ads upserted on (business, account, Meta id); after a FULL read, the ones Meta no
 *               longer returns get `removedAt` — unless the read returned none at all while more than 5 were live (an
 *               empty answer is more likely a fault than everything gone: the circuit breaker leaves them as they were)
 *   daily       the days of a window replace the stored days of that window, per grain, in ONE transaction (Meta restates
 *               recent days); the contiguous range of days read moves in the same transaction (the campaign grain's on
 *               MetaAdAccount, the others' in MetaAdsReadState), so a day inside it with no row is a zero day and a day
 *               outside it was never read
 * Nothing here calls Meta.
 */
import type { MetaAdAccount, Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { workspaceKey } from '../../../lib/workspace-context.js'
import { addDays, dateToDay, dayToDate, type DayWindow } from './dates.js'
import type {
  MetaAdAccountData, MetaAdData, MetaAdSetData, MetaAdsEntityType, MetaAdsReadResource, MetaAdsSyncStatus, MetaCampaignData, MetaDailyMetricData,
} from './types.js'

export const REMOVAL_BREAKER_LIVE = 5
const CREATE_CHUNK = 1_000
const LONG_TX = { timeout: 120_000, maxWait: 10_000 } as const

type AccountDb = Pick<Prisma.TransactionClient, 'metaAdAccount'>

// ── the account ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface MetaAdAccountSeed {
  connectionId: string
  adAccountId: string
  name: string | null
  currencyCode: string | null
  timeZone: string | null
}

/**
 * The account row a chosen ad account reads into: created on the first choice (its read state empty: never read), and on
 * a later choice pointed at the chosen connection. Details already read from Meta are kept when the picker has none.
 */
export async function ensureMetaAdAccount(seed: MetaAdAccountSeed, db: AccountDb = prisma) {
  return db.metaAdAccount.upsert({
    where: { meta_ad_account: workspaceKey({ adAccountId: seed.adAccountId }) },
    create: {
      connectionId: seed.connectionId,
      adAccountId: seed.adAccountId,
      name: seed.name,
      currencyCode: seed.currencyCode ?? '',
      timeZone: seed.timeZone ?? '',
    },
    update: {
      connectionId: seed.connectionId,
      ...(seed.name ? { name: seed.name } : {}),
    },
  })
}

export async function getMetaAdAccount(adAccountId: string): Promise<MetaAdAccount | null> {
  return prisma.metaAdAccount.findUnique({ where: { meta_ad_account: workspaceKey({ adAccountId }) } })
}

export async function metaAdAccountsById(adAccountIds: string[]): Promise<Map<string, MetaAdAccount>> {
  if (adAccountIds.length === 0) return new Map()
  const rows = await prisma.metaAdAccount.findMany({ where: { adAccountId: { in: adAccountIds } } })
  return new Map(rows.map((row) => [row.adAccountId, row]))
}

/** The account as the read found it (settings, money, state at Meta). */
export async function saveAccountDetails(connectionId: string, data: MetaAdAccountData, readAt: Date) {
  const details = {
    connectionId,
    name: data.name,
    currencyCode: data.currencyCode,
    timeZone: data.timeZone,
    timezoneOffsetHoursUtc: data.timezoneOffsetHoursUtc,
    accountStatus: data.accountStatus,
    disableReason: data.disableReason,
    businessId: data.businessId,
    businessName: data.businessName,
    amountSpentMicros: data.amountSpentMicros,
    spendCapMicros: data.spendCapMicros,
    balanceMicros: data.balanceMicros,
    minDailyBudgetMicros: data.minDailyBudgetMicros,
    isPrepayAccount: data.isPrepayAccount,
    settings: data.settings as Prisma.InputJsonValue,
    settingsReadAt: readAt,
  }
  return prisma.metaAdAccount.upsert({
    where: { meta_ad_account: workspaceKey({ adAccountId: data.adAccountId }) },
    create: { adAccountId: data.adAccountId, ...details },
    update: details,
  })
}

export interface MetaSyncOutcome {
  status: MetaAdsSyncStatus
  /** A plain sentence for a person; null when the read went through. */
  error: string | null
  calls: number
  at: Date
  structureSyncedAt?: Date
  backfillCompletedAt?: Date
}

/**
 * The account's read state after a run, and the Meta connection's "Last sync" (the fields every channel's own sync
 * stamps). `lastSyncAt` moves only when the run called Meta.
 */
export async function recordSyncOutcome(adAccountId: string, outcome: MetaSyncOutcome) {
  const account = await prisma.metaAdAccount.update({
    where: { meta_ad_account: workspaceKey({ adAccountId }) },
    data: {
      ...(outcome.calls > 0 ? { lastSyncAt: outcome.at } : {}),
      lastSyncStatus: outcome.status,
      lastSyncError: outcome.error?.slice(0, 500) ?? null,
      callsLastRun: outcome.calls,
      ...(outcome.status === 'SUCCESS' ? { lastSuccessAt: outcome.at } : {}),
      ...(outcome.structureSyncedAt ? { structureSyncedAt: outcome.structureSyncedAt } : {}),
      ...(outcome.backfillCompletedAt ? { backfillCompletedAt: outcome.backfillCompletedAt } : {}),
    },
  })
  if (outcome.calls > 0) {
    const lastSyncStatus = outcome.status === 'SUCCESS' ? 'SUCCESS' : outcome.status === 'PARTIAL' ? 'PARTIAL' : 'FAILED'
    try {
      await prisma.channelConnection.update({
        where: { id: account.connectionId },
        data: { lastSyncAt: outcome.at, lastSyncStatus, lastSyncError: lastSyncStatus === 'SUCCESS' ? null : outcome.error?.slice(0, 500) ?? null },
      })
    } catch (err) {
      logger.warn('[meta-ads-sync] could not record the connection\'s last sync', { adAccountId, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return account
}

// ── read state per step ──────────────────────────────────────────────────────────────────────────────────────────

export async function getReadStates(adAccountId: string) {
  const rows = await prisma.metaAdsReadState.findMany({ where: { adAccountId } })
  return new Map(rows.map((row) => [row.resource as MetaAdsReadResource, row]))
}

/** One step's outcome (a failure keeps the last success's time and range). */
export async function saveReadState(adAccountId: string, resource: MetaAdsReadResource, outcome: { ok: true; rows: number; at: Date } | { ok: false; error: string; at: Date }) {
  const data = outcome.ok === true
    ? { readAt: outcome.at, lastAttemptAt: outcome.at, lastStatus: 'SUCCESS', lastError: null, rows: outcome.rows }
    : { lastAttemptAt: outcome.at, lastStatus: 'FAILED', lastError: (outcome as { error: string }).error.slice(0, 500) }
  await prisma.metaAdsReadState.upsert({
    where: { meta_ads_read_state: workspaceKey({ adAccountId, resource }) },
    create: { adAccountId, resource, ...data },
    update: data,
  })
}

// ── structure ────────────────────────────────────────────────────────────────────────────────────────────────────

export async function upsertCampaigns(rows: MetaCampaignData[], seenAt: Date): Promise<number> {
  if (rows.length === 0) return 0
  await prisma.$transaction(async (tx) => {
    for (const row of rows) {
      await tx.metaAdsCampaign.upsert({
        where: { meta_ads_campaign: workspaceKey({ adAccountId: row.adAccountId, campaignId: row.campaignId }) },
        create: { ...row, firstSeenAt: seenAt, lastSeenAt: seenAt },
        update: { ...row, lastSeenAt: seenAt, removedAt: null },
      })
    }
  }, LONG_TX)
  return rows.length
}

export async function upsertAdSets(rows: MetaAdSetData[], seenAt: Date): Promise<number> {
  if (rows.length === 0) return 0
  await prisma.$transaction(async (tx) => {
    for (const row of rows) {
      const data = { ...row, targeting: (row.targeting ?? undefined) as Prisma.InputJsonValue | undefined }
      await tx.metaAdsAdSet.upsert({
        where: { meta_ads_ad_set: workspaceKey({ adAccountId: row.adAccountId, adSetId: row.adSetId }) },
        create: { ...data, firstSeenAt: seenAt, lastSeenAt: seenAt },
        update: { ...data, lastSeenAt: seenAt, removedAt: null },
      })
    }
  }, LONG_TX)
  return rows.length
}

export async function upsertAds(rows: MetaAdData[], seenAt: Date): Promise<number> {
  if (rows.length === 0) return 0
  await prisma.$transaction(async (tx) => {
    for (const row of rows) {
      const data = { ...row, creative: (row.creative ?? undefined) as Prisma.InputJsonValue | undefined, issues: (row.issues ?? undefined) as Prisma.InputJsonValue | undefined }
      await tx.metaAdsAd.upsert({
        where: { meta_ads_ad: workspaceKey({ adAccountId: row.adAccountId, adId: row.adId }) },
        create: { ...data, firstSeenAt: seenAt, lastSeenAt: seenAt },
        update: { ...data, lastSeenAt: seenAt, removedAt: null },
      })
    }
  }, LONG_TX)
  return rows.length
}

type Grain = 'campaign' | 'adSet' | 'ad'

/**
 * After a FULL read of a grain: every row of the account it did not return (seen before `seenAt`) gets `removedAt`.
 * Skipped when the read returned none while more than 5 were live.
 */
export async function markUnseenRemoved(grain: Grain, adAccountId: string, seenAt: Date, returned: number): Promise<{ removed: number; breaker: boolean }> {
  const where = { adAccountId, removedAt: null, lastSeenAt: { lt: seenAt } }
  const live = { adAccountId, removedAt: null }
  const count = grain === 'campaign' ? () => prisma.metaAdsCampaign.count({ where: live })
    : grain === 'adSet' ? () => prisma.metaAdsAdSet.count({ where: live })
      : () => prisma.metaAdsAd.count({ where: live })
  if (returned === 0 && (await count()) > REMOVAL_BREAKER_LIVE) return { removed: 0, breaker: true }
  const data = { removedAt: seenAt }
  const { count: removed } = grain === 'campaign' ? await prisma.metaAdsCampaign.updateMany({ where, data })
    : grain === 'adSet' ? await prisma.metaAdsAdSet.updateMany({ where, data })
      : await prisma.metaAdsAd.updateMany({ where, data })
  return { removed, breaker: false }
}

// ── daily numbers ────────────────────────────────────────────────────────────────────────────────────────────────

export interface ReadRange { from: string; to: string }

/** The contiguous range read after `window` was read in full (the same rule as Google's: a gap restarts the range). */
export function mergeReadRange(current: ReadRange | null, window: DayWindow): ReadRange {
  if (!current) return { from: window.from, to: window.to }
  const touches = window.from <= addDays(current.to, 1) && window.to >= addDays(current.from, -1)
  if (touches) return { from: window.from < current.from ? window.from : current.from, to: window.to > current.to ? window.to : current.to }
  return window.to > current.to ? { from: window.from, to: window.to } : current
}

const DAYS_RESOURCE: Record<Exclude<MetaAdsEntityType, 'CAMPAIGN'>, MetaAdsReadResource> = { ADSET: 'ADSET_DAYS', AD: 'AD_DAYS' }

/**
 * Replace the stored days of `window` for one account and grain with `rows`, and move that grain's range of days read —
 * in one transaction. A failure leaves the stored days and the range as they were.
 */
export async function replaceDailyMetrics(adAccountId: string, entityType: MetaAdsEntityType, window: DayWindow, rows: MetaDailyMetricData[], pulledAt: Date): Promise<{ rows: number; range: ReadRange }> {
  const from = dayToDate(window.from)
  const to = dayToDate(window.to)
  const byKey = new Map<string, MetaDailyMetricData>()
  for (const row of rows) {
    if (row.adAccountId !== adAccountId || row.entityType !== entityType || row.date < from || row.date > to) continue
    byKey.set(`${row.entityId}|${dateToDay(row.date)}`, row)
  }
  const data = [...byKey.values()].map((row) => ({ ...row, extra: (row.extra ?? undefined) as Prisma.InputJsonValue | undefined, pulledAt }))
  return prisma.$transaction(async (tx) => {
    await tx.metaAdsDailyMetric.deleteMany({ where: { adAccountId, entityType, date: { gte: from, lte: to } } })
    for (let i = 0; i < data.length; i += CREATE_CHUNK) await tx.metaAdsDailyMetric.createMany({ data: data.slice(i, i + CREATE_CHUNK) })
    let range: ReadRange
    if (entityType === 'CAMPAIGN') {
      const account = await tx.metaAdAccount.findUnique({ where: { meta_ad_account: workspaceKey({ adAccountId }) }, select: { metricsReadFrom: true, metricsReadThrough: true } })
      const current = account?.metricsReadFrom && account.metricsReadThrough ? { from: dateToDay(account.metricsReadFrom), to: dateToDay(account.metricsReadThrough) } : null
      range = mergeReadRange(current, window)
      await tx.metaAdAccount.update({ where: { meta_ad_account: workspaceKey({ adAccountId }) }, data: { metricsReadFrom: dayToDate(range.from), metricsReadThrough: dayToDate(range.to) } })
    } else {
      const resource = DAYS_RESOURCE[entityType]
      const state = await tx.metaAdsReadState.findUnique({ where: { meta_ads_read_state: workspaceKey({ adAccountId, resource }) }, select: { readFrom: true, readThrough: true } })
      const current = state?.readFrom && state.readThrough ? { from: dateToDay(state.readFrom), to: dateToDay(state.readThrough) } : null
      range = mergeReadRange(current, window)
      const stateData = { readFrom: dayToDate(range.from), readThrough: dayToDate(range.to), readAt: pulledAt, lastAttemptAt: pulledAt, lastStatus: 'SUCCESS', lastError: null, rows: data.length }
      await tx.metaAdsReadState.upsert({
        where: { meta_ads_read_state: workspaceKey({ adAccountId, resource }) },
        create: { adAccountId, resource, ...stateData },
        update: stateData,
      })
    }
    return { rows: data.length, range }
  }, LONG_TX)
}
