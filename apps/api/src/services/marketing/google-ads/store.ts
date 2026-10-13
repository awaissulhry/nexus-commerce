/**
 * Google Ads steps 1a and 1b — what a read keeps, in the CURRENT business (every row carries it; row-level security keeps one
 * business from another's rows, and each unique key starts with it). Idempotent: running the same read twice leaves
 * the same rows.
 *
 *   account      one GoogleAdsCustomer row per Google Ads account the business reads, with the state of its read
 *   campaigns    upserted on (business, account, campaign); a campaign a FULL read no longer returns gets `removedAt`
 *                — unless the read returned none at all while more than 5 were active (an empty answer is more likely
 *                a fault than every campaign gone: the circuit breaker leaves them as they were)
 *   daily        the days of a window replace the stored days of that window, per grain, in ONE transaction (Google
 *                restates recent days); the contiguous range of days read moves in the same transaction — the
 *                campaign's on the account (`metricsReadFrom … metricsReadThrough`), every other grain's on its own
 *                GoogleAdsReadState (`readFrom … readThrough`) — so a day inside it with no row is a zero day and a
 *                day outside it was never read. Rows of a grain below the campaign on the same entity and day are
 *                summed (a search term under two spellings is one term)
 *   changes      stored once by Google's resource name (skipDuplicates); kept after Google forgets them (30 days)
 *
 * Nothing here calls Google. `userEmail` of a change is stored and never returned or logged.
 */
import type { GoogleAdsCustomer, Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { workspaceKey } from '../../../lib/workspace-context.js'
import { addDays, dateToDay, dayToDate, type DayWindow } from './dates.js'
import { addDailyRows } from './mappers.js'
import {
  DAY_RESOURCE_OF, type GoogleAdsCampaignData, type GoogleAdsChangeEventData, type GoogleAdsCustomerData, type GoogleAdsDailyMetricData,
  type GoogleAdsEntityType, type GoogleAdsTarget,
} from './types.js'

/** An empty campaign answer while more than this many campaigns are active is not believed (nothing is marked removed). */
export const REMOVAL_BREAKER_ACTIVE = 5
const CREATE_CHUNK = 1_000
const LONG_TX = { timeout: 120_000, maxWait: 10_000 } as const

/** How a read ended (GoogleAdsCustomer.lastSyncStatus). */
export type GoogleAdsSyncStatus = 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'SKIPPED_BUDGET' | 'AUTH_LOST' | 'MANAGER'

type CustomerDb = Pick<Prisma.TransactionClient, 'googleAdsCustomer'>

// ── the account ──────────────────────────────────────────────────────────────────────────────────────────────────

/** What the account picker knows of an account when a person chooses it (Google's discovery; details may be missing). */
export interface GoogleAdsCustomerSeed {
  connectionId: string
  customerId: string
  loginCustomerId: string | null
  descriptiveName: string | null
  currencyCode: string | null
  timeZone: string | null
  testAccount: boolean
}

/**
 * The account row a chosen Google Ads account reads into: created on the first choice (its read state empty: never
 * read), and on a later choice pointed at the chosen connection and manager. Details already read from Google are kept
 * when the picker has none. Pass a transaction to make it part of the choice.
 */
export async function ensureGoogleAdsCustomer(seed: GoogleAdsCustomerSeed, db: CustomerDb = prisma) {
  return db.googleAdsCustomer.upsert({
    where: { google_ads_customer: workspaceKey({ customerId: seed.customerId }) },
    create: {
      connectionId: seed.connectionId,
      customerId: seed.customerId,
      loginCustomerId: seed.loginCustomerId,
      descriptiveName: seed.descriptiveName,
      // The first read sets these from Google; until then the picker's values (or nothing known).
      currencyCode: seed.currencyCode ?? '',
      timeZone: seed.timeZone ?? '',
      testAccount: seed.testAccount,
      status: 'UNKNOWN',
    },
    update: {
      connectionId: seed.connectionId,
      loginCustomerId: seed.loginCustomerId,
      ...(seed.descriptiveName ? { descriptiveName: seed.descriptiveName } : {}),
    },
  })
}

/** This business's account rows for the given Google Ads ids. */
export async function googleAdsCustomersById(customerIds: string[]): Promise<Map<string, GoogleAdsCustomer>> {
  if (customerIds.length === 0) return new Map()
  const rows = await prisma.googleAdsCustomer.findMany({ where: { customerId: { in: customerIds } } })
  return new Map(rows.map((row) => [row.customerId, row]))
}

export async function getGoogleAdsCustomer(customerId: string) {
  return prisma.googleAdsCustomer.findUnique({ where: { google_ads_customer: workspaceKey({ customerId }) } })
}

/** The account as the read's `customer` query found it (name, currency, time zone, manager, test, status). */
export async function saveCustomerDetails(target: GoogleAdsTarget, data: GoogleAdsCustomerData) {
  const details = {
    connectionId: target.connectionId,
    loginCustomerId: target.loginCustomerId,
    descriptiveName: data.descriptiveName,
    currencyCode: data.currencyCode,
    timeZone: data.timeZone,
    manager: data.manager,
    testAccount: data.testAccount,
    status: data.status,
  }
  return prisma.googleAdsCustomer.upsert({
    where: { google_ads_customer: workspaceKey({ customerId: target.customerId }) },
    create: { customerId: target.customerId, ...details },
    update: details,
  })
}

export interface SyncOutcome {
  status: GoogleAdsSyncStatus
  /** A plain sentence for a person; null when the read went through. Never a token, a body or an e-mail address. */
  error: string | null
  ops: number
  /** When the read ended. */
  at: Date
  structureSyncedAt?: Date
  changesSyncedThrough?: Date
  backfillCompletedAt?: Date
  /**
   * The four step 1a reads (account, campaigns, campaign days, change history) succeeded: the account's data is as of
   * `at` (`lastSuccessAt`) even when a step 1b read did not (the run is then PARTIAL).
   */
  coreSucceeded?: boolean
}

/**
 * The Google sign-in's "Last sync" (`ChannelConnection.lastSyncAt / lastSyncStatus / lastSyncError`, the fields every
 * channel's own sync stamps and the channel page shows): the read's end in the connection's words. A run that never
 * reached Google (no allowance) is not a sync: it leaves them as they were (null).
 */
export function connectionSyncOf(outcome: Pick<SyncOutcome, 'status' | 'error' | 'at'>): { lastSyncAt: Date; lastSyncStatus: 'SUCCESS' | 'PARTIAL' | 'FAILED'; lastSyncError: string | null } | null {
  if (outcome.status === 'SKIPPED_BUDGET') return null
  const lastSyncStatus = outcome.status === 'SUCCESS' ? 'SUCCESS' : outcome.status === 'PARTIAL' ? 'PARTIAL' : 'FAILED'
  return { lastSyncAt: outcome.at, lastSyncStatus, lastSyncError: lastSyncStatus === 'SUCCESS' ? null : outcome.error?.slice(0, 500) ?? null }
}

/**
 * The account's read state after a run. `lastSyncAt` is when the last run that called Google ended (one that spent an
 * operation): a run that never reached Google (no allowance, or the gateway refused before sending) keeps the time of
 * the last real read and the last success, and says why in its status and sentence. The Google sign-in the account is
 * read through gets the same end as its "Last sync" (`connectionSyncOf`).
 */
export async function recordSyncOutcome(customerId: string, outcome: SyncOutcome) {
  const account = await prisma.googleAdsCustomer.update({
    where: { google_ads_customer: workspaceKey({ customerId }) },
    data: {
      ...(outcome.ops > 0 ? { lastSyncAt: outcome.at } : {}),
      lastSyncStatus: outcome.status,
      lastSyncError: outcome.error,
      opsUsedLastRun: outcome.ops,
      ...(outcome.status === 'SUCCESS' || outcome.coreSucceeded ? { lastSuccessAt: outcome.at } : {}),
      ...(outcome.structureSyncedAt ? { structureSyncedAt: outcome.structureSyncedAt } : {}),
      ...(outcome.changesSyncedThrough ? { changesSyncedThrough: outcome.changesSyncedThrough } : {}),
      ...(outcome.backfillCompletedAt ? { backfillCompletedAt: outcome.backfillCompletedAt } : {}),
    },
  })
  const sync = connectionSyncOf(outcome)
  if (sync) {
    try {
      await prisma.channelConnection.update({ where: { id: account.connectionId }, data: sync })
    } catch (err) {
      // The read's own state is recorded above; a connection that went away meanwhile only misses its "Last sync".
      logger.warn('[google-ads-sync] could not record the connection\'s last sync', { customerId, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return account
}

// ── campaigns ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Upsert every campaign the read returned; each is seen at `seenAt` (and no longer removed, if it was). */
export async function upsertCampaigns(campaigns: GoogleAdsCampaignData[], seenAt: Date): Promise<number> {
  if (campaigns.length === 0) return 0
  await prisma.$transaction(async (tx) => {
    for (const campaign of campaigns) {
      await tx.googleAdsCampaign.upsert({
        where: { google_ads_campaign: workspaceKey({ customerId: campaign.customerId, campaignId: campaign.campaignId }) },
        create: { ...campaign, firstSeenAt: seenAt, lastSeenAt: seenAt },
        update: { ...campaign, lastSeenAt: seenAt, removedAt: null },
      })
    }
  }, LONG_TX)
  return campaigns.length
}

/**
 * After a FULL campaign read: every campaign of the account it did not return (seen before `seenAt`) gets `removedAt`.
 * Its other columns stay as last read. Skipped when the read returned none while more than 5 were active.
 */
export async function markUnseenCampaignsRemoved(customerId: string, seenAt: Date, returned: number): Promise<{ removed: number; breaker: boolean }> {
  const unseen = { customerId, removedAt: null, lastSeenAt: { lt: seenAt } }
  if (returned === 0) {
    const active = await prisma.googleAdsCampaign.count({ where: { customerId, removedAt: null } })
    if (active > REMOVAL_BREAKER_ACTIVE) return { removed: 0, breaker: true }
  }
  const { count } = await prisma.googleAdsCampaign.updateMany({ where: unseen, data: { removedAt: seenAt } })
  return { removed: count, breaker: false }
}

// ── daily numbers ────────────────────────────────────────────────────────────────────────────────────────────────

export interface ReadRange { from: string; to: string }

/**
 * The contiguous range of days read after `window` was read in full. A window that touches or overlaps the range
 * extends it; a newer window with a gap replaces it (the days in between were never read, so the older days can no
 * longer be told apart from "not read" by one range); an older window with a gap leaves it as it was.
 */
export function mergeReadRange(current: ReadRange | null, window: DayWindow): ReadRange {
  if (!current) return { from: window.from, to: window.to }
  const touches = window.from <= addDays(current.to, 1) && window.to >= addDays(current.from, -1)
  if (touches) return { from: window.from < current.from ? window.from : current.from, to: window.to > current.to ? window.to : current.to }
  return window.to > current.to ? { from: window.from, to: window.to } : current
}

/**
 * Replace the stored days of `window` for one account and grain with `rows` (every row inside the window), and move the
 * grain's range of days read — in one transaction. A failure leaves the stored days and the range as they were.
 *
 * CAMPAIGN: one row per campaign and day (a repeated row keeps the last); the range is the account's
 * (`GoogleAdsCustomer.metricsReadFrom/Through`). Every other grain: rows on the same entity and day are summed; the range
 * is the grain's own read state (`GoogleAdsReadState.readFrom/readThrough` of AD_GROUP_DAYS, KEYWORD_DAYS, …).
 */
export async function replaceDailyMetrics(
  customerId: string,
  entityType: GoogleAdsEntityType,
  window: DayWindow,
  rows: GoogleAdsDailyMetricData[],
  pulledAt: Date,
): Promise<{ rows: number; range: ReadRange }> {
  const from = dayToDate(window.from)
  const to = dayToDate(window.to)
  // One row per entity and day, only days inside the window: the campaign's last row wins, other grains are summed.
  const byKey = new Map<string, GoogleAdsDailyMetricData>()
  for (const row of rows) {
    if (row.customerId !== customerId || row.entityType !== entityType || row.date < from || row.date > to) continue
    const key = `${row.entityId}|${dateToDay(row.date)}`
    const before = entityType === 'CAMPAIGN' ? undefined : byKey.get(key)
    byKey.set(key, before ? addDailyRows(before, row) : row)
  }
  const data = [...byKey.values()].map((row) => ({ ...row, pulledAt }))
  return prisma.$transaction(async (tx) => {
    await tx.googleAdsDailyMetric.deleteMany({ where: { customerId, entityType, date: { gte: from, lte: to } } })
    for (let i = 0; i < data.length; i += CREATE_CHUNK) {
      await tx.googleAdsDailyMetric.createMany({ data: data.slice(i, i + CREATE_CHUNK) })
    }
    if (entityType === 'CAMPAIGN') {
      const account = await tx.googleAdsCustomer.findUnique({
        where: { google_ads_customer: workspaceKey({ customerId }) },
        select: { metricsReadFrom: true, metricsReadThrough: true },
      })
      const current = account?.metricsReadFrom && account.metricsReadThrough
        ? { from: dateToDay(account.metricsReadFrom), to: dateToDay(account.metricsReadThrough) }
        : null
      const range = mergeReadRange(current, window)
      await tx.googleAdsCustomer.update({
        where: { google_ads_customer: workspaceKey({ customerId }) },
        data: { metricsReadFrom: dayToDate(range.from), metricsReadThrough: dayToDate(range.to) },
      })
      return { rows: data.length, range }
    }
    const resource = DAY_RESOURCE_OF[entityType]
    const key = { google_ads_read_state: workspaceKey({ customerId, resource }) }
    const state = await tx.googleAdsReadState.findUnique({ where: key, select: { readFrom: true, readThrough: true } })
    const current = state?.readFrom && state.readThrough ? { from: dateToDay(state.readFrom), to: dateToDay(state.readThrough) } : null
    const range = mergeReadRange(current, window)
    const moved = { readFrom: dayToDate(range.from), readThrough: dayToDate(range.to) }
    await tx.googleAdsReadState.upsert({ where: key, create: { customerId, resource, ...moved }, update: moved })
    return { rows: data.length, range }
  }, LONG_TX)
}

// ── change history ───────────────────────────────────────────────────────────────────────────────────────────────

/** Store the changes not stored yet (by resource name). Returns how many were new. */
export async function storeChangeEvents(rows: GoogleAdsChangeEventData[]): Promise<number> {
  let created = 0
  for (let i = 0; i < rows.length; i += CREATE_CHUNK) {
    const { count } = await prisma.googleAdsChangeEvent.createMany({ data: rows.slice(i, i + CREATE_CHUNK), skipDuplicates: true })
    created += count
  }
  return created
}
