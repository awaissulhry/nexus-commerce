/**
 * Stock push heal (Owner 2026-10-06: "make sure that the stock updates in real time across profiles").
 *
 * The cascade queues a listing's quantity push when the listing's Nexus number MOVES. When that push then fails for
 * good — dead-lettered after its retries, refused by the channel, or left PENDING with nothing sending it — the
 * channel keeps the old number while Nexus holds the right one, and nothing pushes again until the stock moves. The
 * drift job (sync-drift-detection.job.ts) compares the Nexus number with the ledger only, so it never sees this: the
 * Nexus number is right. Measured: a listing showed 7 on eBay while Nexus said 4.
 *
 * Every 10 minutes, in each business (clustered cron), this job takes the listings whose LATEST quantity row (a
 * QUANTITY_UPDATE, or any row carrying a quantity) is one of:
 *   DEAD           FAILED and dead-lettered (isDead);
 *   STUCK_FAILED   FAILED, not dead, and the drain will never retry it (no retry time, or its retries spent and not an
 *                  account outage), or its retry time passed more than STALE ago;
 *   STALE_PENDING  PENDING and due (past its hold and retry time) for more than STALE, still not sent;
 * and queues ONE fresh QUANTITY_UPDATE for each, through the cascade's own path: under the product's stock lock, after
 * checking that no newer quantity row appeared, an older pending row of the listing is cancelled
 * (coalescePendingQuantityRows) and the row is created with createOutboundRowsAndReturn (the shared-account claim check,
 * the destination account, the trace), then handed to the instant lane. Dispatch re-reads the listing's quantity and
 * caps it to the routed stock (its own or the pool it borrows), as for every push.
 *
 * It never sends where the cascade would not: a listing paused (its own pause or the channel/market policy), with
 * selling paused or closed, ended, still a draft, Amazon-managed (FBA), with uncounted stock, on an account that is
 * off or needs signing in again, of a deleted product, or whose Nexus number is not the one its stock says (that is the
 * drift job's case: it recascades, which queues a fresh row). A listing with a fixed number is healed to that number.
 *
 * Budget per listing — the queue is the record: a heal row carries payload.source = 'STOCK_PUSH_HEAL', and why
 * (healOf, healReason, healClass, healAttempt, previousStatus, previousErrorCode, previousError):
 *   REFUSED    a dead row that died before its retries ran out, i.e. the channel refused it (a validation error):
 *              at most ONE heal per 24 h, so a permanent refusal is tried once a day and never loops;
 *   RETRYABLE  everything else (retries spent, an outage, a stuck row): at most 3 heals per 24 h, at least 1 h apart.
 *
 * Shared eBay variants (SharedListingMembership rows, no ChannelListing) are not covered: their pushes have no listing
 * to re-read, and the Trading read-back heals them.
 *
 * Opt out: NEXUS_STOCK_PUSH_HEAL=0. Schedule: NEXUS_STOCK_PUSH_HEAL_SCHEDULE (default every 10 minutes). Listings per
 * business per run: NEXUS_STOCK_PUSH_HEAL_MAX (default 100).
 */

import { Prisma } from '@prisma/client'
import { assertPushAllowed, isStillDraftListing } from '@nexus/shared/push-lock'
import cron from '../lib/cron/clustered.js'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { QUANTITY_PUSH_CHANNELS, resolveIntendedQuantity, type IntendedResolution } from '../services/sync-control-core.js'
import { loadChannelPolicies, policyFor, type PolicyMap } from '../services/sync-control-policy.service.js'
import { ledgerInputs, loadSyncLedgers, type ProductLedger } from '../services/stock-pool/sync-ledgers.js'
import { coalescePendingQuantityRows } from '../services/sync-coalesce.js'
import { createOutboundRowsAndReturn } from '../services/outbound-rows.js'
import { lockProductStock } from '../services/stock-lock.js'

export const JOB_NAME = 'stock-push-heal'
export const HEAL_SOURCE = 'STOCK_PUSH_HEAL'

/** A FAILED row whose retry time passed this long ago, or a PENDING row due this long, is not going to be sent. */
export const STALE_MS = 2 * 3600_000
/** Rows older than this are left to the channel read-backs: the heal is the fast loop, not an archaeologist. */
export const LOOKBACK_MS = 7 * 24 * 3600_000
const DAY_MS = 24 * 3600_000
export const HEAL_BUDGET = {
  REFUSED: { perDay: 1, spacingMs: DAY_MS },
  RETRYABLE: { perDay: 3, spacingMs: 3600_000 },
} as const
/** The drain's retry lane takes a FAILED row only while retryCount < 3, or for an account outage (outbound-sync). */
const DRAIN_RETRY_LIMIT = 3
/** Dead-letter codes that mean "it kept failing", not "the channel said no". */
const RETRYABLE_DEATH_CODES = new Set(['MAX_RETRIES_EXCEEDED', 'CIRCUIT_OPEN_DEFERRED', 'AUTH_REQUIRED', 'ETSY_LISTING_BUSY', 'RETRY_SCHEDULED', 'JANITOR_RECLAIMED'])
/** An account in one of these states cannot take a push until a person signs it in again. */
const ACCOUNT_DOWN = new Set(['needs_reauth', 'revoked', 'disconnected'])

export type HealReason = 'DEAD' | 'STUCK_FAILED' | 'STALE_PENDING'
export type HealClass = 'REFUSED' | 'RETRYABLE'
export type SkipReason =
  | 'listing_gone' | 'not_a_push_channel' | 'product_deleted' | 'push_locked' | 'still_draft' | 'account_down'
  | 'fba' | 'closed' | 'paused' | 'uncounted' | 'nexus_number_differs' | 'budget' | 'newer_row' | 'refused_by_claim' | 'error'

export interface CandidateRow {
  id: string
  listingId: string
  productId: string | null
  status: 'FAILED' | 'PENDING'
  isDead: boolean
  errorCode: string | null
  errorMessage: string | null
  retryCount: number
  maxRetries: number
  nextRetryAt: Date | null
}

export interface StockPushHealResult {
  candidates: number
  healed: number
  skipped: Partial<Record<SkipReason, number>>
  capped: boolean
  durationMs: number
}

/** Why this row needs a heal. Pure. */
export function healReasonOf(row: Pick<CandidateRow, 'status' | 'isDead'>): HealReason {
  if (row.status === 'PENDING') return 'STALE_PENDING'
  return row.isDead ? 'DEAD' : 'STUCK_FAILED'
}

/**
 * REFUSED: the row died with retries left, so its failure was not retryable — the channel refused the push (both the
 * drain and the BullMQ worker dead-letter a non-retryable failure at once). Everything else may pass on its own. Pure.
 */
export function healClassOf(row: Pick<CandidateRow, 'status' | 'isDead' | 'errorCode' | 'retryCount' | 'maxRetries'>): HealClass {
  if (row.status !== 'FAILED' || !row.isDead) return 'RETRYABLE'
  if (row.errorCode && RETRYABLE_DEATH_CODES.has(row.errorCode)) return 'RETRYABLE'
  if (row.errorCode === 'NON_RETRYABLE') return 'REFUSED'
  return row.retryCount < Math.max(1, row.maxRetries || 3) ? 'REFUSED' : 'RETRYABLE'
}

/** May this listing get another heal now, given the heals it had in the last 24 h? Pure. */
export function budgetAllows(healClass: HealClass, previousHeals: Date[], now: number): boolean {
  const budget = HEAL_BUDGET[healClass]
  const recent = previousHeals.map((d) => d.getTime()).filter((t) => now - t < DAY_MS)
  if (recent.length >= budget.perDay) return false
  return recent.every((t) => now - t >= budget.spacingMs)
}

interface HealListing {
  id: string
  productId: string
  channel: string
  marketplace: string
  region: string
  externalListingId: string | null
  quantity: number | null
  stockBuffer: number | null
  followMasterQuantity: boolean
  fulfillmentMethod: string | null
  syncPaused: boolean
  offerClosedAt: Date | null
  listingStatus: string
  isPublished: boolean
  sourceLocationCodes: string[]
  channelConnectionId: string | null
  product: { fulfillmentMethod: string | null; deletedAt: Date | null } | null
  channelConnection: { isActive: boolean; authStatus: string } | null
}

/**
 * The cascade's own decision for this listing (resolveIntendedQuantity over the ledger loadSyncLedgers gives — its
 * own stock or the pool), plus the gates every push takes. Null = heal it. Pure.
 */
export function listingGate(
  listing: HealListing | undefined,
  ledger: ProductLedger | undefined,
  policies: PolicyMap,
  pushMethod: (args: { listingFulfillmentMethod: string | null; channel: string; fbaBucket: number; productFulfillmentMethod: string | null }) => 'FBA' | 'FBM',
): SkipReason | null {
  if (!listing) return 'listing_gone'
  if (!QUANTITY_PUSH_CHANNELS.has(listing.channel)) return 'not_a_push_channel'
  if (!listing.product || listing.product.deletedAt) return 'product_deleted'
  if (isStillDraftListing(listing)) return 'still_draft'
  if (assertPushAllowed(listing)) return 'push_locked'
  const account = listing.channelConnection
  if (account && (!account.isActive || ACCOUNT_DOWN.has(account.authStatus))) return 'account_down'
  const resolution: IntendedResolution = resolveIntendedQuantity({
    channel: listing.channel,
    marketplace: listing.marketplace,
    isFba: pushMethod({
      listingFulfillmentMethod: listing.fulfillmentMethod,
      channel: listing.channel,
      fbaBucket: ledger?.fbaBucket ?? 0,
      productFulfillmentMethod: listing.product.fulfillmentMethod,
    }) === 'FBA',
    offerClosed: !!listing.offerClosedAt,
    followMasterQuantity: listing.followMasterQuantity,
    syncPaused: listing.syncPaused,
    pinnedQuantity: listing.quantity,
    stockBuffer: listing.stockBuffer ?? 0,
    channelPolicy: policyFor(policies, listing.channel, listing.marketplace, listing.channelConnectionId),
    ...ledgerInputs(ledger, listing.sourceLocationCodes ?? []),
  })
  switch (resolution.kind) {
    case 'FBA_EXCLUDED': return 'fba'
    case 'CLOSED': return 'closed'
    case 'PAUSED': return 'paused'
    case 'UNCOUNTED': return 'uncounted'
    case 'PINNED': return listing.quantity == null ? 'uncounted' : null
    case 'FOLLOW': return listing.quantity === resolution.quantity ? null : 'nexus_number_differs'
  }
}

const LISTING_SELECT = {
  id: true, productId: true, channel: true, marketplace: true, region: true, externalListingId: true, quantity: true,
  stockBuffer: true, followMasterQuantity: true, fulfillmentMethod: true, syncPaused: true, offerClosedAt: true,
  listingStatus: true, isPublished: true, sourceLocationCodes: true, channelConnectionId: true,
  product: { select: { fulfillmentMethod: true, deletedAt: true } },
  channelConnection: { select: { isActive: true, authStatus: true } },
} as const

/** A newer row that carries this listing's quantity than the given one. One statement, used twice. */
const newerQuantityRow = (listingRef: Prisma.Sql, rowRef: Prisma.Sql) => Prisma.sql`
  SELECT 1 FROM "OutboundSyncQueue" n
  WHERE n."channelListingId" = ${listingRef}
    AND (n."syncType" = 'QUANTITY_UPDATE' OR n.payload->'quantity' IS NOT NULL)
    AND (n."createdAt", n.id) > ${rowRef}`

/** Run once in the current business's context. Exported for the manual trigger and the tests. */
export async function runStockPushHeal(options: { max?: number } = {}): Promise<StockPushHealResult> {
  const startedAt = Date.now()
  const now = new Date()
  const envMax = Number.parseInt(process.env.NEXUS_STOCK_PUSH_HEAL_MAX ?? '', 10)
  const max = options.max ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : 100)
  const result: StockPushHealResult = { candidates: 0, healed: 0, skipped: {}, capped: false, durationMs: 0 }
  const skip = (reason: SkipReason) => { result.skipped[reason] = (result.skipped[reason] ?? 0) + 1 }

  // The database's clock for the row ages (a timestamp parameter would be read in the session's time zone).
  const staleBefore = Prisma.sql`(CURRENT_TIMESTAMP - ${STALE_MS}::double precision * interval '1 millisecond')`
  const lookback = Prisma.sql`(CURRENT_TIMESTAMP - ${LOOKBACK_MS}::double precision * interval '1 millisecond')`
  const channels = [...QUANTITY_PUSH_CHANNELS]
  // Narrow by status first (indexed), then keep only the newest quantity row per listing.
  const rows = await prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
    SELECT o.id, o."channelListingId" AS "listingId", o."productId", o."syncStatus"::text AS status, o."isDead",
           o."errorCode", o."errorMessage", o."retryCount", o."maxRetries", o."nextRetryAt"
    FROM "OutboundSyncQueue" o
    WHERE o."channelListingId" IS NOT NULL
      AND o."syncType" = 'QUANTITY_UPDATE'
      AND o."targetChannel"::text = ANY(${channels}::text[])
      AND o."syncStatus" IN ('FAILED', 'PENDING')
      AND o."createdAt" > ${lookback}
      AND (
        (o."syncStatus" = 'FAILED' AND (
          o."isDead"
          OR o."nextRetryAt" IS NULL
          OR (o."retryCount" >= ${DRAIN_RETRY_LIMIT} AND o."errorCode" IS DISTINCT FROM 'AUTH_REQUIRED')
          OR o."nextRetryAt" < ${staleBefore}))
        OR (o."syncStatus" = 'PENDING'
          AND o."updatedAt" < ${staleBefore}
          AND (o."holdUntil" IS NULL OR o."holdUntil" < ${staleBefore})
          AND (o."nextRetryAt" IS NULL OR o."nextRetryAt" < ${staleBefore})))
      AND NOT EXISTS (${newerQuantityRow(Prisma.sql`o."channelListingId"`, Prisma.sql`(o."createdAt", o.id)`)})
    ORDER BY o."updatedAt" ASC, o.id
    LIMIT ${max + 1}`)
  result.capped = rows.length > max
  const candidates = rows.slice(0, max)
  result.candidates = candidates.length
  if (candidates.length === 0) return finish(result, startedAt)

  const listingIds = candidates.map((c) => c.listingId)
  const listings = new Map((await prisma.channelListing.findMany({ where: { id: { in: listingIds } }, select: LISTING_SELECT }) as HealListing[]).map((l) => [l.id, l]))
  const ledgers = await loadSyncLedgers(prisma, [...new Set([...listings.values()].map((l) => l.productId))])
  const policies = await loadChannelPolicies()
  const { resolveCascadePushMethod } = await import('../services/stock-movement.service.js')
  const heals = await prisma.outboundSyncQueue.findMany({
    where: { channelListingId: { in: listingIds }, createdAt: { gte: new Date(now.getTime() - DAY_MS) }, payload: { path: ['source'], equals: HEAL_SOURCE } },
    select: { channelListingId: true, createdAt: true },
  })
  const healsByListing = new Map<string, Date[]>()
  for (const h of heals) if (h.channelListingId) healsByListing.set(h.channelListingId, [...(healsByListing.get(h.channelListingId) ?? []), h.createdAt])

  const queued: Array<{ id: string; productId: string | null; syncType: string | null; holdUntil: Date | null }> = []
  for (const row of candidates) {
    const listing = listings.get(row.listingId)
    const gate = listingGate(listing, listing ? ledgers.get(listing.productId) : undefined, policies, resolveCascadePushMethod)
    if (gate) { skip(gate); continue }
    const healClass = healClassOf(row)
    const previous = healsByListing.get(row.listingId) ?? []
    if (!budgetAllows(healClass, previous, now.getTime())) { skip('budget'); continue }
    const l = listing!
    const healReason = healReasonOf(row)
    try {
      const created = await prisma.$transaction(async (tx) => {
        // The cascade's lock: a stock change for this product queues under it, so the check below cannot miss one.
        await lockProductStock(tx, [l.productId])
        const newer = await tx.$queryRaw<unknown[]>(Prisma.sql`${newerQuantityRow(Prisma.sql`${l.id}`, Prisma.sql`(SELECT c."createdAt", c.id FROM "OutboundSyncQueue" c WHERE c.id = ${row.id})`)} LIMIT 1`)
        if (newer.length > 0) return null
        if (process.env.NEXUS_SYNC_ORDERING_V2 !== '0') await coalescePendingQuantityRows(tx, [l.id])
        return createOutboundRowsAndReturn(tx, {
          data: [{
            productId: l.productId,
            channelListingId: l.id,
            targetChannel: l.channel as never,
            targetRegion: l.region,
            syncStatus: 'PENDING' as never,
            syncType: 'QUANTITY_UPDATE',
            holdUntil: now,
            externalListingId: l.externalListingId,
            maxRetries: 3,
            payload: {
              source: HEAL_SOURCE,
              productId: l.productId,
              channel: l.channel,
              marketplace: l.marketplace,
              quantity: l.quantity,
              stockBuffer: l.stockBuffer ?? 0,
              healOf: row.id,
              healReason,
              healClass,
              healAttempt: previous.length + 1,
              previousStatus: row.status,
              previousErrorCode: row.errorCode,
              previousError: row.errorMessage ? row.errorMessage.slice(0, 300) : null,
            },
          }],
          select: { id: true, productId: true, syncType: true, holdUntil: true },
        })
      })
      if (!created) { skip('newer_row'); continue }
      if (created.length === 0) { skip('refused_by_claim'); continue }
      queued.push(...created)
      result.healed++
    } catch (error) {
      const code = (error as { code?: string })?.code
      skip(code === 'listing_coordinate_claimed' ? 'refused_by_claim' : 'error')
      logger.warn(`[${JOB_NAME}] could not queue a heal`, { listingId: row.listingId, rowId: row.id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  if (queued.length > 0) {
    // After commit, as the cascade: the instant lane; the drain's backup loop sends any row whose job is lost.
    const { fireOutboundJobs } = await import('../services/outbound-enqueue.js')
    await fireOutboundJobs(queued, { source: HEAL_SOURCE })
  }
  return finish(result, startedAt)
}

function finish(result: StockPushHealResult, startedAt: number): StockPushHealResult {
  result.durationMs = Date.now() - startedAt
  if (result.candidates > 0) logger.info(`[${JOB_NAME}] run`, { ...result })
  return result
}

export function summarizeStockPushHeal(r: StockPushHealResult): string {
  const skipped = Object.entries(r.skipped).map(([k, v]) => `${k}=${v}`).join(' ')
  return `candidates=${r.candidates} healed=${r.healed}${r.capped ? ' capped' : ''}${skipped ? ` skipped: ${skipped}` : ''} durationMs=${r.durationMs}`
}

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export function startStockPushHealCron(): void {
  if (process.env.NEXUS_STOCK_PUSH_HEAL === '0') {
    logger.info(`${JOB_NAME}: disabled via NEXUS_STOCK_PUSH_HEAL=0`)
    return
  }
  if (scheduledTask) return
  const schedule = process.env.NEXUS_STOCK_PUSH_HEAL_SCHEDULE ?? '*/10 * * * *'
  if (!cron.validate(schedule)) {
    logger.error(`${JOB_NAME}: invalid schedule`, { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, async () => {
    await recordCronRun(JOB_NAME, async () => summarizeStockPushHeal(await runStockPushHeal())).catch((error) =>
      logger.error(`${JOB_NAME} run failed`, { error: error instanceof Error ? error.message : String(error) }))
  })
  logger.info(`${JOB_NAME} cron: scheduled`, { schedule })
}

export function stopStockPushHealCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}
