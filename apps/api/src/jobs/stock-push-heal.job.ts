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
 *   REFUSED    a dead row the channel refused: its error code says so (anything but the "kept failing" codes), or, with
 *              no code, it died before its retries ran out: at most ONE heal per 24 h, so a permanent refusal is tried
 *              once a day and never loops — also when the refusal came on the row's last try;
 *   RETRYABLE  everything else (retries spent, an outage, a stuck row): at most 3 heals per 24 h, at least 1 h apart.
 *
 * Which rows it looks at: the candidate query itself leaves out every listing a column already holds (paused, selling
 * paused or closed, ended, still a draft, FBA by its own or its Amazon product's method, a fixed number that is empty,
 * an account that is off or needs signing in, a deleted product, a channel or market policy that pauses it) and every
 * listing whose budget is spent. listingGate checks all of it again on the rows it reads. What only the stock ledger
 * can say (FBA stock on hand, uncounted, the Nexus number) is decided in code; such rows do not block newer ones: the
 * job reads up to SCAN_PAGES pages, oldest first, until it has tried `max` heals. (A cheap gate checked only after a
 * LIMIT let 100 held rows hide every newer row that could be healed, run after run.)
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
import { loadChannelPolicies, parsePolicyKey, policyFor, type PolicyMap } from '../services/sync-control-policy.service.js'
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
const RETRYABLE_DEATH_CODE_LIST = ['MAX_RETRIES_EXCEEDED', 'CIRCUIT_OPEN_DEFERRED', 'AUTH_REQUIRED', 'ETSY_LISTING_BUSY', 'RETRY_SCHEDULED', 'JANITOR_RECLAIMED']
const RETRYABLE_DEATH_CODES = new Set(RETRYABLE_DEATH_CODE_LIST)
/** An account in one of these states cannot take a push until a person signs it in again. */
const ACCOUNT_DOWN_LIST = ['needs_reauth', 'revoked', 'disconnected']
const ACCOUNT_DOWN = new Set(ACCOUNT_DOWN_LIST)
/** Pages of `max` rows one run reads at most while rows the ledger holds back stand in front of rows it can heal. */
export const SCAN_PAGES = 5

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
 * REFUSED: the channel refused the push. The error code decides first: a dead row is written with
 * MAX_RETRIES_EXCEEDED (or an aged-out deferral code) when it kept failing, and with the refusal's own code
 * (EBAY_VALIDATION, NON_RETRYABLE, …) when the failure was not retryable (outbound-sync computeFailureDisposition) —
 * whichever try it came on, so a 400 on the third try is still a refusal. Only a dead row with no code falls back on
 * the count: it died with retries left, so it was refused. Everything else may pass on its own. Pure; the candidate
 * query repeats it as SQL (healClassSql) for the budget.
 */
export function healClassOf(row: Pick<CandidateRow, 'status' | 'isDead' | 'errorCode' | 'retryCount' | 'maxRetries'>): HealClass {
  if (row.status !== 'FAILED' || !row.isDead) return 'RETRYABLE'
  if (row.errorCode && RETRYABLE_DEATH_CODES.has(row.errorCode)) return 'RETRYABLE'
  if (row.errorCode) return 'REFUSED'
  return row.retryCount < Math.max(1, row.maxRetries || 3) ? 'REFUSED' : 'RETRYABLE'
}

/** healClassOf as SQL over the queue row `o`. */
const healClassSql = Prisma.sql`CASE
    WHEN NOT (o."syncStatus" = 'FAILED' AND o."isDead") THEN 'RETRYABLE'
    WHEN o."errorCode" = ANY(${RETRYABLE_DEATH_CODE_LIST}::text[]) THEN 'RETRYABLE'
    WHEN COALESCE(o."errorCode", '') <> '' THEN 'REFUSED'
    WHEN o."retryCount" < GREATEST(1, COALESCE(NULLIF(o."maxRetries", 0), 3)) THEN 'REFUSED'
    ELSE 'RETRYABLE' END`

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

/** Listing coordinates (channel, market as stored, account or '') that a channel or market policy pauses. */
export interface PausedCoordinates { channels: string[]; markets: string[]; accounts: string[] }

/**
 * Which listing coordinates the policies pause, decided by policyFor itself (its market and account precedence), so
 * the candidate query can leave them out exactly. Reads the business's coordinates only when some policy pauses.
 */
async function pausedCoordinates(policies: PolicyMap): Promise<PausedCoordinates> {
  const paused: PausedCoordinates = { channels: [], markets: [], accounts: [] }
  const channels = [...new Set([...policies].filter(([, p]) => p.pushesPaused).map(([key]) => parsePolicyKey(key).channel))]
  if (channels.length === 0) return paused
  const coordinates = await prisma.$queryRaw<Array<{ channel: string; marketplace: string; account: string }>>(Prisma.sql`
    SELECT DISTINCT l.channel, l.marketplace, COALESCE(l."channelConnectionId", '') AS account
    FROM "ChannelListing" l WHERE upper(l.channel) = ANY(${channels}::text[])`)
  for (const c of coordinates) {
    if (!policyFor(policies, c.channel, c.marketplace, c.account || null)?.pushesPaused) continue
    paused.channels.push(c.channel)
    paused.markets.push(c.marketplace)
    paused.accounts.push(c.account)
  }
  return paused
}

/** The cursor of a page: the last row's (updatedAt as the database wrote it, id). */
interface PageCursor { at: string; id: string }

/**
 * One page of candidates, oldest first: the latest quantity row of each listing, failed for good or stale, that no
 * column holds back and whose budget is not spent (see the header). listingGate and budgetAllows decide again.
 */
async function candidatePage(after: PageCursor | null, limit: number, paused: PausedCoordinates): Promise<Array<CandidateRow & { cursorAt: string }>> {
  // The database's clock, as the queue stores its times: UTC wall time (Prisma's timestamp(3)). A bare CURRENT_TIMESTAMP
  // would read those times in the session's time zone, and a timestamp parameter in this process's.
  const nowUtc = Prisma.sql`(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`
  const ago = (ms: number) => Prisma.sql`(${nowUtc} - ${ms}::double precision * interval '1 millisecond')`
  const channels = [...QUANTITY_PUSH_CHANNELS]
  const perDay = Prisma.sql`(CASE x."healClass" WHEN 'REFUSED' THEN ${HEAL_BUDGET.REFUSED.perDay}::int ELSE ${HEAL_BUDGET.RETRYABLE.perDay}::int END)`
  const spacing = Prisma.sql`(CASE x."healClass" WHEN 'REFUSED' THEN ${HEAL_BUDGET.REFUSED.spacingMs}::double precision ELSE ${HEAL_BUDGET.RETRYABLE.spacingMs}::double precision END)`
  return prisma.$queryRaw<Array<CandidateRow & { cursorAt: string }>>(Prisma.sql`
    SELECT x.* FROM (
      SELECT o.id, o."channelListingId" AS "listingId", o."productId", o."syncStatus"::text AS status, o."isDead",
             o."errorCode", o."errorMessage", o."retryCount", o."maxRetries", o."nextRetryAt",
             o."updatedAt", o."updatedAt"::text AS "cursorAt", ${healClassSql} AS "healClass"
      FROM "OutboundSyncQueue" o
      JOIN "ChannelListing" l ON l.id = o."channelListingId"
      JOIN "Product" p ON p.id = l."productId"
      LEFT JOIN "ChannelConnection" c ON c.id = l."channelConnectionId"
      WHERE o."syncType" = 'QUANTITY_UPDATE'
        AND o."targetChannel"::text = ANY(${channels}::text[])
        AND o."syncStatus" IN ('FAILED', 'PENDING')
        AND o."createdAt" > ${ago(LOOKBACK_MS)}
        AND (
          (o."syncStatus" = 'FAILED' AND (
            o."isDead"
            OR o."nextRetryAt" IS NULL
            OR (o."retryCount" >= ${DRAIN_RETRY_LIMIT} AND o."errorCode" IS DISTINCT FROM 'AUTH_REQUIRED')
            OR o."nextRetryAt" < ${ago(STALE_MS)}))
          OR (o."syncStatus" = 'PENDING'
            AND o."updatedAt" < ${ago(STALE_MS)}
            AND (o."holdUntil" IS NULL OR o."holdUntil" < ${ago(STALE_MS)})
            AND (o."nextRetryAt" IS NULL OR o."nextRetryAt" < ${ago(STALE_MS)})))
        -- What a column already says (listingGate checks each again): a push channel, a live product, not a still-draft,
        -- not paused, selling not paused or closed, not ended, not FBA, a fixed number that is set, an account that can
        -- take it, no policy pausing it.
        AND l.channel = ANY(${channels}::text[])
        AND p."deletedAt" IS NULL
        AND NOT (l."listingStatus" = 'DRAFT' AND l."isPublished" = false AND l."externalListingId" IS NULL)
        AND l."syncPaused" = false
        AND l."offerClosedAt" IS NULL
        AND upper(btrim(l."listingStatus")) <> 'ENDED'
        AND NOT (COALESCE(l."fulfillmentMethod"::text = 'FBA', false)
          OR (l.channel = 'AMAZON' AND COALESCE(p."fulfillmentMethod"::text = 'FBA', false)))
        AND (l."followMasterQuantity" OR l.quantity IS NOT NULL)
        AND (c.id IS NULL OR (c."isActive" AND c."authStatus" <> ALL(${ACCOUNT_DOWN_LIST}::text[])))
        AND (l.channel, l.marketplace, COALESCE(l."channelConnectionId", '')) NOT IN (
          SELECT * FROM unnest(${paused.channels}::text[], ${paused.markets}::text[], ${paused.accounts}::text[]))
        AND NOT EXISTS (${newerQuantityRow(Prisma.sql`o."channelListingId"`, Prisma.sql`(o."createdAt", o.id)`)})
    ) x
    -- The budget (budgetAllows): this listing's heals in the last 24 h, by the class of the row to heal.
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS n, max(h."createdAt") AS last
      FROM "OutboundSyncQueue" h
      WHERE h."channelListingId" = x."listingId"
        AND h.payload->>'source' = ${HEAL_SOURCE}
        AND h."createdAt" > ${ago(DAY_MS)}
    ) b
    WHERE (b.n = 0 OR (b.n < ${perDay} AND b.last <= ${nowUtc} - ${spacing} * interval '1 millisecond'))
      ${after ? Prisma.sql`AND (x."updatedAt", x.id) > (${after.at}::timestamp(3), ${after.id})` : Prisma.empty}
    ORDER BY x."updatedAt", x.id
    LIMIT ${limit}`)
}

/** Run once in the current business's context. Exported for the manual trigger and the tests. */
export async function runStockPushHeal(options: { max?: number } = {}): Promise<StockPushHealResult> {
  const startedAt = Date.now()
  const now = new Date()
  const envMax = Number.parseInt(process.env.NEXUS_STOCK_PUSH_HEAL_MAX ?? '', 10)
  const max = options.max ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : 100)
  const result: StockPushHealResult = { candidates: 0, healed: 0, skipped: {}, capped: false, durationMs: 0 }
  const skip = (reason: SkipReason) => { result.skipped[reason] = (result.skipped[reason] ?? 0) + 1 }

  const policies = await loadChannelPolicies()
  const paused = await pausedCoordinates(policies)
  const { resolveCascadePushMethod } = await import('../services/stock-movement.service.js')
  const queued: Array<{ id: string; productId: string | null; syncType: string | null; holdUntil: Date | null }> = []
  let tried = 0
  let after: PageCursor | null = null

  pages: for (let page = 0; page < SCAN_PAGES; page++) {
    const rows = await candidatePage(after, max + 1, paused)
    const more = rows.length > max
    const candidates = rows.slice(0, max)
    if (candidates.length === 0) break
    const last = candidates[candidates.length - 1]
    after = { at: last.cursorAt, id: last.id }

    const listingIds = candidates.map((c) => c.listingId)
    const listings = new Map((await prisma.channelListing.findMany({ where: { id: { in: listingIds } }, select: LISTING_SELECT }) as HealListing[]).map((l) => [l.id, l]))
    const ledgers = await loadSyncLedgers(prisma, [...new Set([...listings.values()].map((l) => l.productId))])
    const heals = await prisma.outboundSyncQueue.findMany({
      where: { channelListingId: { in: listingIds }, createdAt: { gte: new Date(now.getTime() - DAY_MS) }, payload: { path: ['source'], equals: HEAL_SOURCE } },
      select: { channelListingId: true, createdAt: true },
    })
    const healsByListing = new Map<string, Date[]>()
    for (const h of heals) if (h.channelListingId) healsByListing.set(h.channelListingId, [...(healsByListing.get(h.channelListingId) ?? []), h.createdAt])

    for (const row of candidates) {
      if (tried >= max) { result.capped = true; break pages }
      result.candidates++
      const listing = listings.get(row.listingId)
      const gate = listingGate(listing, listing ? ledgers.get(listing.productId) : undefined, policies, resolveCascadePushMethod)
      if (gate) { skip(gate); continue }
      const healClass = healClassOf(row)
      const previous = healsByListing.get(row.listingId) ?? []
      if (!budgetAllows(healClass, previous, now.getTime())) { skip('budget'); continue }
      tried++
      const created = await queueHeal(listing!, row, healClass, previous.length + 1, now, skip)
      if (created) { queued.push(...created); result.healed++ }
    }
    if (!more) break
    if (tried >= max || page === SCAN_PAGES - 1) { result.capped = true; break }
  }

  if (queued.length > 0) {
    // After commit, as the cascade: the instant lane; the drain's backup loop sends any row whose job is lost.
    const { fireOutboundJobs } = await import('../services/outbound-enqueue.js')
    await fireOutboundJobs(queued, { source: HEAL_SOURCE })
  }
  return finish(result, startedAt)
}

/** One heal, the cascade's way, in one transaction. Null when it queued nothing (the reason is counted). */
async function queueHeal(l: HealListing, row: CandidateRow, healClass: HealClass, healAttempt: number, now: Date, skip: (reason: SkipReason) => void) {
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
            healReason: healReasonOf(row),
            healClass,
            healAttempt,
            previousStatus: row.status,
            previousErrorCode: row.errorCode,
            previousError: row.errorMessage ? row.errorMessage.slice(0, 300) : null,
          },
        }],
        select: { id: true, productId: true, syncType: true, holdUntil: true },
      })
    })
    if (!created) { skip('newer_row'); return null }
    if (created.length === 0) { skip('refused_by_claim'); return null }
    return created
  } catch (error) {
    const code = (error as { code?: string })?.code
    skip(code === 'listing_coordinate_claimed' ? 'refused_by_claim' : 'error')
    logger.warn(`[${JOB_NAME}] could not queue a heal`, { listingId: row.listingId, rowId: row.id, error: error instanceof Error ? error.message : String(error) })
    return null
  }
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
