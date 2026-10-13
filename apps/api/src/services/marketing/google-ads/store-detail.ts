/**
 * Google Ads step 1b — what the reads below the campaign keep, in the CURRENT business (every row carries it; row-level
 * security keeps one business from another's rows, and each unique key starts with it). Idempotent: the same read twice
 * leaves the same rows. Nothing here calls Google.
 *
 *   read state     one GoogleAdsReadState per account and resource: when it was last read (readAt), the last attempt
 *                  and how it ended (SUCCESS | FAILED | SKIPPED_BUDGET, a sentence), the rows read; *_DAYS also hold the
 *                  range of days read (moved by store.replaceDailyMetrics, and by the retention prune here)
 *   structure      ad groups, asset groups, keywords (per level), negative keyword lists, auto-apply settings: upserted
 *                  on their named key; what a full read no longer returns gets `removedAt` — unless the read returned
 *                  none while more than 5 were active (the circuit breaker of step 1a: an empty answer is more likely a
 *                  fault than everything gone)
 *   campaign flags the settings by which Google acts on its own, on GoogleAdsCampaign, with `flagsReadAt`
 *   policy issues  ads Google disapproved or limited, products not eligible or limited: an issue no longer returned
 *                  gets `resolvedAt`; one that comes back (or changes status) starts again (`firstSeenAt`)
 *   recommendations a snapshot, replaced whole by each read
 *   retention      SEARCH_TERM days 180, the other grains below the campaign 400 (campaign days are kept forever); the
 *                  grain's `readFrom` moves in the same transaction as the delete
 */
import { Prisma, type GoogleAdsReadState } from '@prisma/client'
import prisma from '../../../db.js'
import { workspaceKey } from '../../../lib/workspace-context.js'
import { dateToDay, dayToDate } from './dates.js'
import { REMOVAL_BREAKER_ACTIVE } from './store.js'
import {
  DAY_RESOURCE_OF, type GoogleAdsAdGroupData, type GoogleAdsAssetGroupData, type GoogleAdsAutoApplyData, type GoogleAdsCampaignFlagsData,
  type GoogleAdsDetailEntityType, type GoogleAdsKeywordData, type GoogleAdsKeywordLevel, type GoogleAdsNegativeListData, type GoogleAdsPolicyIssueData,
  type GoogleAdsPolicyKind, type GoogleAdsReadResource, type GoogleAdsReadStatus, type GoogleAdsRecommendationData,
} from './types.js'

/** Rows upserted per transaction (a big account's keywords are written in several). */
const UPSERT_CHUNK = 500
const CREATE_CHUNK = 1_000
const LONG_TX = { timeout: 120_000, maxWait: 10_000 } as const
const MAX_ERROR = 500

// ── read state ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Every read state of one account, by resource. */
export async function readStatesOf(customerId: string): Promise<Map<string, GoogleAdsReadState>> {
  const rows = await prisma.googleAdsReadState.findMany({ where: { customerId } })
  return new Map(rows.map((row) => [row.resource, row]))
}

export interface ReadStateOutcome {
  status: GoogleAdsReadStatus
  /** When the attempt ended. */
  at: Date
  /** SUCCESS: when Google was asked (default `at`). */
  readAt?: Date
  /** SUCCESS: rows the read returned. */
  rows?: number
  /** FAILED / SKIPPED_BUDGET: a plain sentence for a person. */
  error?: string | null
}

function stateData(outcome: ReadStateOutcome) {
  return outcome.status === 'SUCCESS'
    ? { readAt: outcome.readAt ?? outcome.at, lastAttemptAt: outcome.at, lastStatus: 'SUCCESS', lastError: null, rows: outcome.rows ?? null }
    : { lastAttemptAt: outcome.at, lastStatus: outcome.status, lastError: outcome.error?.slice(0, MAX_ERROR) ?? null }
}

/**
 * How one step ended. A success moves `readAt`; a failure or a skip records the attempt and its sentence, and leaves
 * when it was last read (and its range of days) as they were.
 */
export async function recordReadState(customerId: string, resource: GoogleAdsReadResource, outcome: ReadStateOutcome): Promise<GoogleAdsReadState> {
  const data = stateData(outcome)
  return prisma.googleAdsReadState.upsert({
    where: { google_ads_read_state: workspaceKey({ customerId, resource }) },
    create: { customerId, resource, ...data },
    update: data,
  })
}

/** The same outcome for several steps at once (a run that skipped them, or stopped before them). */
export async function recordReadStates(customerId: string, resources: readonly GoogleAdsReadResource[], outcome: ReadStateOutcome): Promise<void> {
  if (resources.length === 0) return
  const data = stateData(outcome)
  await prisma.$transaction(async (tx) => {
    for (const resource of resources) {
      await tx.googleAdsReadState.upsert({
        where: { google_ads_read_state: workspaceKey({ customerId, resource }) },
        create: { customerId, resource, ...data },
        update: data,
      })
    }
  }, LONG_TX)
}

// ── shared ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Run `each` for every row, UPSERT_CHUNK rows per transaction. */
async function inChunks<T>(rows: readonly T[], each: (tx: Prisma.TransactionClient, row: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const slice = rows.slice(i, i + UPSERT_CHUNK)
    await prisma.$transaction(async (tx) => {
      for (const row of slice) await each(tx, row)
    }, LONG_TX)
  }
}

export interface RemovalOutcome { upserted: number; removed: number; breaker: boolean }

/** After a FULL read: mark what it did not return, unless it returned none while more than 5 were active. */
async function markUnseen(returned: number, active: () => Promise<number>, mark: () => Promise<{ count: number }>): Promise<{ removed: number; breaker: boolean }> {
  if (returned === 0 && (await active()) > REMOVAL_BREAKER_ACTIVE) return { removed: 0, breaker: true }
  return { removed: (await mark()).count, breaker: false }
}

// ── structure ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every ad group the read returned (seen at `seenAt`), then the ones it no longer returned marked removed. */
export async function saveAdGroups(customerId: string, rows: GoogleAdsAdGroupData[], seenAt: Date): Promise<RemovalOutcome> {
  await inChunks(rows, (tx, row) => tx.googleAdsAdGroup.upsert({
    where: { google_ads_ad_group: workspaceKey({ customerId, adGroupId: row.adGroupId }) },
    create: { ...row, firstSeenAt: seenAt, lastSeenAt: seenAt },
    update: { ...row, lastSeenAt: seenAt, removedAt: null },
  }))
  const unseen = { customerId, removedAt: null, lastSeenAt: { lt: seenAt } }
  const removal = await markUnseen(rows.length,
    () => prisma.googleAdsAdGroup.count({ where: { customerId, removedAt: null } }),
    () => prisma.googleAdsAdGroup.updateMany({ where: unseen, data: { removedAt: seenAt } }))
  return { upserted: rows.length, ...removal }
}

export async function saveAssetGroups(customerId: string, rows: GoogleAdsAssetGroupData[], seenAt: Date): Promise<RemovalOutcome> {
  await inChunks(rows, (tx, row) => tx.googleAdsAssetGroup.upsert({
    where: { google_ads_asset_group: workspaceKey({ customerId, assetGroupId: row.assetGroupId }) },
    create: { ...row, firstSeenAt: seenAt, lastSeenAt: seenAt },
    update: { ...row, lastSeenAt: seenAt, removedAt: null },
  }))
  const unseen = { customerId, removedAt: null, lastSeenAt: { lt: seenAt } }
  const removal = await markUnseen(rows.length,
    () => prisma.googleAdsAssetGroup.count({ where: { customerId, removedAt: null } }),
    () => prisma.googleAdsAssetGroup.updateMany({ where: unseen, data: { removedAt: seenAt } }))
  return { upserted: rows.length, ...removal }
}

/**
 * The keywords of one level, from a full read of that level: AD_GROUP (keywords and ad-group negatives), CAMPAIGN
 * (campaign negatives and brand lists) or LIST (the negative keyword lists' keywords). Each level is marked on its own.
 */
export async function saveKeywords(customerId: string, level: GoogleAdsKeywordLevel, rows: GoogleAdsKeywordData[], seenAt: Date): Promise<RemovalOutcome> {
  const own = rows.filter((row) => row.level === level && row.customerId === customerId)
  await inChunks(own, (tx, row) => tx.googleAdsKeyword.upsert({
    where: { google_ads_keyword: workspaceKey({ customerId, parentKey: row.parentKey, criterionId: row.criterionId }) },
    create: { ...row, firstSeenAt: seenAt, lastSeenAt: seenAt },
    update: { ...row, lastSeenAt: seenAt, removedAt: null },
  }))
  const unseen = { customerId, level, removedAt: null, lastSeenAt: { lt: seenAt } }
  const removal = await markUnseen(own.length,
    () => prisma.googleAdsKeyword.count({ where: { customerId, level, removedAt: null } }),
    () => prisma.googleAdsKeyword.updateMany({ where: unseen, data: { removedAt: seenAt } }))
  return { upserted: own.length, ...removal }
}

/** The ids of the account's negative keyword lists that are not removed. */
export async function activeNegativeListIds(customerId: string): Promise<Set<string>> {
  const rows = await prisma.googleAdsNegativeList.findMany({ where: { customerId, removedAt: null }, select: { sharedSetId: true } })
  return new Set(rows.map((row) => row.sharedSetId))
}

/**
 * The negative keyword lists and their keywords, from one full read of both. A detail this read did not get (the
 * queries without shared_set.*) keeps what was stored; a new list without a name gets "" (not read).
 */
export async function saveNegativeLists(
  customerId: string,
  lists: GoogleAdsNegativeListData[],
  keywords: GoogleAdsKeywordData[],
  seenAt: Date,
): Promise<{ lists: RemovalOutcome; keywords: RemovalOutcome }> {
  await inChunks(lists, (tx, list) => {
    const known = {
      campaignIds: [...new Set(list.campaignIds)].sort(),
      ...(list.name !== null ? { name: list.name } : {}),
      ...(list.status !== null ? { status: list.status } : {}),
      ...(list.memberCount !== null ? { memberCount: list.memberCount } : {}),
    }
    return tx.googleAdsNegativeList.upsert({
      where: { google_ads_negative_list: workspaceKey({ customerId, sharedSetId: list.sharedSetId }) },
      create: { customerId, sharedSetId: list.sharedSetId, name: '', status: 'UNKNOWN', ...known, firstSeenAt: seenAt, lastSeenAt: seenAt },
      update: { ...known, lastSeenAt: seenAt, removedAt: null },
    })
  })
  const unseen = { customerId, removedAt: null, lastSeenAt: { lt: seenAt } }
  const listRemoval = await markUnseen(lists.length,
    () => prisma.googleAdsNegativeList.count({ where: { customerId, removedAt: null } }),
    () => prisma.googleAdsNegativeList.updateMany({ where: unseen, data: { removedAt: seenAt } }))
  return { lists: { upserted: lists.length, ...listRemoval }, keywords: await saveKeywords(customerId, 'LIST', keywords, seenAt) }
}

/** Google's auto-apply settings; a type no longer returned is marked removed (breaker as above). */
export async function saveAutoApply(customerId: string, rows: GoogleAdsAutoApplyData[], seenAt: Date): Promise<RemovalOutcome> {
  await inChunks(rows, (tx, row) => tx.googleAdsAutoApply.upsert({
    where: { google_ads_auto_apply: workspaceKey({ customerId, type: row.type }) },
    create: { ...row, firstSeenAt: seenAt, lastSeenAt: seenAt },
    update: { ...row, lastSeenAt: seenAt, removedAt: null },
  }))
  const unseen = { customerId, removedAt: null, lastSeenAt: { lt: seenAt } }
  const removal = await markUnseen(rows.length,
    () => prisma.googleAdsAutoApply.count({ where: { customerId, removedAt: null } }),
    () => prisma.googleAdsAutoApply.updateMany({ where: unseen, data: { removedAt: seenAt } }))
  return { upserted: rows.length, ...removal }
}

/**
 * The campaigns' settings by which Google acts on its own, stamped `flagsReadAt`. A campaign Nexus has no row for yet
 * is left out (the campaign read creates it). `assetAutomation` null = not read (stored as SQL NULL).
 */
export async function saveCampaignFlags(customerId: string, flags: GoogleAdsCampaignFlagsData[], readAt: Date): Promise<number> {
  let updated = 0
  await inChunks(flags, async (tx, flag) => {
    const { campaignId, assetAutomation, ...rest } = flag
    const { count } = await tx.googleAdsCampaign.updateMany({
      where: { customerId, campaignId },
      data: { ...rest, assetAutomation: assetAutomation === null ? Prisma.DbNull : assetAutomation, flagsReadAt: readAt },
    })
    updated += count
  })
  return updated
}

// ── policy issues ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The open issues of one kind from a full read. `returnedRows` = every row Google returned (approved ads and eligible
 * products included): an answer with no row at all while more than 5 issues are open resolves nothing (breaker).
 */
export async function savePolicyIssues(
  customerId: string,
  kind: GoogleAdsPolicyKind,
  issues: GoogleAdsPolicyIssueData[],
  seenAt: Date,
  returnedRows: number,
): Promise<{ open: number; resolved: number; breaker: boolean }> {
  const own = issues.filter((issue) => issue.kind === kind && issue.customerId === customerId)
  const before = new Map((await prisma.googleAdsPolicyIssue.findMany({
    where: { customerId, kind },
    select: { entityKey: true, status: true, resolvedAt: true },
  })).map((row) => [row.entityKey, row]))
  await inChunks(own, (tx, issue) => {
    const was = before.get(issue.entityKey)
    // New, back after it was resolved, or another status: "since" starts now.
    const restarts = !was || was.resolvedAt !== null || was.status !== issue.status
    return tx.googleAdsPolicyIssue.upsert({
      where: { google_ads_policy_issue: workspaceKey({ customerId, kind, entityKey: issue.entityKey }) },
      create: { ...issue, firstSeenAt: seenAt, lastSeenAt: seenAt },
      update: { ...issue, lastSeenAt: seenAt, resolvedAt: null, ...(restarts ? { firstSeenAt: seenAt } : {}) },
    })
  })
  const stillOpen = { customerId, kind, resolvedAt: null, lastSeenAt: { lt: seenAt } }
  const removal = await markUnseen(returnedRows,
    () => prisma.googleAdsPolicyIssue.count({ where: { customerId, kind, resolvedAt: null } }),
    () => prisma.googleAdsPolicyIssue.updateMany({ where: stillOpen, data: { resolvedAt: seenAt } }))
  return { open: own.length, resolved: removal.removed, breaker: removal.breaker }
}

// ── recommendations ──────────────────────────────────────────────────────────────────────────────────────────────

/** The account's recommendations become exactly this read's, in one transaction. */
export async function replaceRecommendations(customerId: string, rows: GoogleAdsRecommendationData[], readAt: Date): Promise<number> {
  const byName = new Map(rows.filter((row) => row.customerId === customerId).map((row) => [row.resourceName, row]))
  const data = [...byName.values()].map((row) => ({ ...row, readAt }))
  await prisma.$transaction(async (tx) => {
    await tx.googleAdsRecommendation.deleteMany({ where: { customerId } })
    for (let i = 0; i < data.length; i += CREATE_CHUNK) {
      await tx.googleAdsRecommendation.createMany({ data: data.slice(i, i + CREATE_CHUNK) })
    }
  }, LONG_TX)
  return data.length
}

// ── retention ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Delete a grain's days before `keepFrom` and move its range of days read with them, in one transaction: the range then
 * starts at `keepFrom`, or is empty (never read) when every day of it was older.
 */
export async function pruneDailyMetrics(customerId: string, entityType: GoogleAdsDetailEntityType, keepFrom: string): Promise<{ deleted: number; readFrom: string | null }> {
  const cutoff = dayToDate(keepFrom)
  const resource = DAY_RESOURCE_OF[entityType]
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.googleAdsDailyMetric.deleteMany({ where: { customerId, entityType, date: { lt: cutoff } } })
    const key = { google_ads_read_state: workspaceKey({ customerId, resource }) }
    const state = await tx.googleAdsReadState.findUnique({ where: key, select: { readFrom: true, readThrough: true } })
    if (!state?.readFrom || state.readFrom >= cutoff) return { deleted: count, readFrom: state?.readFrom ? dateToDay(state.readFrom) : null }
    if (state.readThrough && state.readThrough >= cutoff) {
      await tx.googleAdsReadState.update({ where: key, data: { readFrom: cutoff } })
      return { deleted: count, readFrom: keepFrom }
    }
    await tx.googleAdsReadState.update({ where: key, data: { readFrom: null, readThrough: null } })
    return { deleted: count, readFrom: null }
  }, LONG_TX)
}
