/**
 * PES.5 — the product-scoped view of `OutboundSyncQueue`, for the Errors & Sync
 * console. Read-only: nothing here enqueues, retries or cancels.
 *
 * ── Why `syncedAt` is REQUIRED in the response, not optional ───────────────
 * It is the only thing separating "old" from "STUCK", and the gap is enormous.
 * Measured on production 2026-09-01:
 *
 *   rows created > 24 h ago                                  36,844
 *   of those, actually stuck (never synced, still runnable)        0
 *
 * A "stuck" filter written as `createdAt < now - 24h` flags **36,844 rows**,
 * essentially the whole table — 31,999 SUCCESS and 2,198 SKIPPED rows that
 * completed weeks ago and have a `syncedAt` proving it. A console that reports
 * thirty-six thousand stuck syncs is not a slightly-wrong console; it is one an
 * operator immediately stops believing.
 *
 * So `stuck` here means all of: never synced, still in a runnable state, older
 * than the threshold, and not sitting in its grace period.
 *
 * ── ⚠ This endpoint can only ever see a MINORITY of the queue ──────────────
 * `OutboundSyncQueue`'s comment says "At least one must be set" of `productId`
 * / `channelListingId`. Measured, that is false: of 37,846 rows,
 *
 *   both              1,805
 *   product only      1,649
 *   listing only      1,727
 *   NEITHER          32,665   ← 86%
 *
 * 86% of the queue is attached to no product at all, so a product-scoped read
 * is structurally incomplete. `scope.coverageNote` says so in the payload
 * rather than letting a quiet list imply "this product has nothing queued".
 */
import { resolveWorkspaceDestination, workspaceListingWhere } from './workspace-destination.js'
import type { OutboundSyncStatus } from '@prisma/client'
import { deriveFailureReason, type SyncFailureReason } from './sync-failure-reason.js'

export type SyncQueueFilter = 'all' | 'dead' | 'retrying' | 'stuck'

/** Statuses a row can still move out of on its own. */
const RUNNABLE: OutboundSyncStatus[] = ['PENDING', 'IN_PROGRESS'] as OutboundSyncStatus[]

export const STUCK_THRESHOLD_HOURS = 24

export interface SyncQueueRow {
  id: string
  productId: string | null
  channelListingId: string | null
  /**
   * The SKU this row belongs to. Without it an operator staring at a cause
   * group of 21 products cannot tell WHICH product a failed write is for —
   * the queue row's own ids are opaque.
   */
  sku: string | null
  /**
   * Which listing ALIAS the row targets, when that is knowable.
   *
   * Only the server can answer this: the queue row carries no alias, but a row
   * linked to a `channelListingId` reaches one through `ChannelListing.aliasKey`.
   * Measured on the GALE-JACKET family — 396 of 441 rows (90%) resolve this way;
   * the remaining 45 are product-only and the alias is genuinely unknowable.
   *
   * `aliasResolved: false` means EXACTLY that — unknown, not "primary". Guessing
   * `primary` is correct today and silently wrong the moment a second alias
   * exists, which is the trap PES.3 avoided by shipping scope-only jumping.
   *
   * ⚠ Deliberately returned as COMPONENTS, not as a composed sheet row id. The
   * sheet owns its row-id format (`alias:productId`); encoding that here would
   * couple the two and break quietly if it ever changed. The server supplies
   * the one piece only it can know; the sheet composes.
   */
  aliasId: string | null
  aliasKey: string | null
  aliasResolved: boolean
  targetChannel: string
  targetRegion: string | null
  syncType: string
  syncStatus: string
  /** REQUIRED. Null = never synced; a value = it completed, so it is not stuck. */
  syncedAt: string | null
  createdAt: string
  updatedAt: string
  nextRetryAt: string | null
  holdUntil: string | null
  retryCount: number
  maxRetries: number
  isDead: boolean
  diedAt: string | null
  errorCode: string | null
  errorMessage: string | null
  /**
   * Derived from `errorMessage`, NOT `errorCode` — 2,490 failed rows share the
   * single code `MAX_RETRIES_EXCEEDED`, covering both deliberate gating and
   * genuine marketplace refusals. See `sync-failure-reason.ts`.
   */
  reason: SyncFailureReason
  reasonSummary: string
  /** False when nothing is wrong and no operator action exists. */
  reasonActionable: boolean
  /** False when the row can no longer progress on its own (retries exhausted). */
  reasonWillRetry: boolean
  externalListingId: string | null
}

export interface SyncQueueSource {
  source: 'OutboundSyncQueue' | 'ListingIssue' | 'AmazonSuppression' | 'ChannelListing.validationStatus'
  queried: boolean
  status: 'ok' | 'unavailable' | 'not-queried'
  sentence: string
}

export interface SyncQueuePage {
  sources: SyncQueueSource[]
  scope: {
    productId: string
    familyIds: string[]
    channel: string | null
    marketplace: string | null
    filter: SyncQueueFilter
    /** Stated in the payload — a quiet list must not imply completeness. */
    coverageNote: string
  }
  counts: { all: number; dead: number; retrying: number; stuck: number }
  rows: SyncQueueRow[]
  stuckThresholdHours: number
  /**
   * True per-cause totals across the WHOLE filtered set — not the returned page
   * (#353).
   *
   * The console grouped causes client-side over whatever page it received, and
   * `rows` is capped at 200, so for any coordinate with more than 200 queue rows
   * the cause count could never be complete and had no way to say so. These
   * totals let it state "3 causes across 269 writes" and mean it.
   *
   * Derived through the SAME `deriveFailureReason` the rows use — grouped in SQL
   * by the raw (message, code, isDead) triple, then classified ONCE per distinct
   * triple. A second classifier written in SQL would be a copy that drifts from
   * the one the row list uses, and the two would disagree on the same data.
   * Measured 2026-09-02: 38,365 queue rows carry only 659 distinct triples, so
   * this is one small grouped read, not a scan of the rows it summarises.
   */
  causes: SyncQueueCause[]
  /** Rows the `causes` totals were computed over — the filter's true size. */
  causesTotal: number
}

export interface SyncQueueCause {
  reason: SyncFailureReason
  /** Every row carrying this reason, across the whole filter. */
  count: number
  /**
   * How many of those still need a human. Counted rather than inferred from the
   * reason: the same cause is actionable or not depending on whether the row can
   * still PROGRESS — a throttled row that is dead exhausted its retries and the
   * write never landed, while a throttled row still runnable needs nobody.
   */
  actionableCount: number
  /** Most recent occurrence, so a stale cause can be told from a live one. */
  mostRecent: string | null
  /** The summary of the largest contributing message — an example, not a total. */
  sampleSummary: string
}

export async function getProductSyncQueue(input: {
  productId: string
  accountId?: string
  listingId?: string
  channel?: string
  marketplace?: string
  filter?: SyncQueueFilter
  limit?: number
}): Promise<SyncQueuePage> {
  const { default: prisma } = await import('../../db.js')
  const destination = input.channel ? await resolveWorkspaceDestination({ productId: input.productId, channel: input.channel, marketplace: input.marketplace ?? '', accountId: input.accountId, listingId: input.listingId }) : null
  const filter: SyncQueueFilter = input.filter ?? 'all'
  const limit = Math.min(200, Math.max(1, input.limit ?? 50))

  const seed = await prisma.product.findFirst({
    where: { id: input.productId, deletedAt: null },
    select: { id: true, parentId: true },
  })
  if (!seed) {
    const { UnknownProductError } = await import('./studio-sheet.service.js')
    throw new UnknownProductError(input.productId)
  }
  const rootId = seed.parentId ?? seed.id
  const family = await prisma.product.findMany({
    where: { OR: [{ id: rootId }, { parentId: rootId }], deletedAt: null },
    select: { id: true },
  })
  const familyIds = family.map((f) => f.id)

  // A queue row reaches this product EITHER directly or through one of its
  // listings. Querying productId alone would miss the 1,727 listing-only rows.
  const listings = await prisma.channelListing.findMany({
    where: {
      productId: { in: familyIds },
      ...(destination ? workspaceListingWhere(destination) : {}),
      ...(input.channel ? { channel: input.channel } : {}),
      ...(input.marketplace ? { marketplace: input.marketplace } : {}),
    },
    select: { id: true },
  })
  const listingIds = listings.map((l) => l.id)

  const scopeWhere = {
    OR: [
      ...(input.channel || input.marketplace ? [] : [{ productId: { in: familyIds } }]),
      { channelListingId: { in: listingIds } },
    ],
    ...(input.channel ? { targetChannel: input.channel as never } : {}),
    ...(input.marketplace ? { targetRegion: input.marketplace } : {}),
    // A listing can be reassigned. Its current owner cannot attribute an old job.
    ...(destination ? { AND: [{ OR: [
      { payload: { path: ['accountId'], equals: destination.accountId } },
      { payload: { path: ['channelConnectionId'], equals: destination.accountId } },
    ] }] } : {}),
  }

  const now = new Date()
  const stuckBefore = new Date(now.getTime() - STUCK_THRESHOLD_HOURS * 3600_000)

  const DEAD = { isDead: true }
  const RETRYING = { isDead: false, syncStatus: 'FAILED' as OutboundSyncStatus }
  const STUCK = {
    // Never completed. This clause alone removes 34,197 settled rows that a
    // naive age filter would report as stuck.
    syncedAt: null,
    syncStatus: { in: RUNNABLE },
    createdAt: { lt: stuckBefore },
    // A row inside its grace window is waiting on purpose, not stuck.
    OR: [{ holdUntil: null }, { holdUntil: { lt: now } }],
  }

  const whereFor = (f: SyncQueueFilter) =>
    f === 'dead' ? { AND: [scopeWhere, DEAD] }
    : f === 'retrying' ? { AND: [scopeWhere, RETRYING] }
    : f === 'stuck' ? { AND: [scopeWhere, STUCK] }
    : scopeWhere

  const [all, dead, retrying, stuck, rows, causeGroups] = await Promise.all([
    prisma.outboundSyncQueue.count({ where: scopeWhere as never }),
    prisma.outboundSyncQueue.count({ where: whereFor('dead') as never }),
    prisma.outboundSyncQueue.count({ where: whereFor('retrying') as never }),
    prisma.outboundSyncQueue.count({ where: whereFor('stuck') as never }),
    prisma.outboundSyncQueue.findMany({
      where: whereFor(filter) as never,
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    // #353 — grouped over the whole filter, NOT the page. Grouping by the raw
    // triple keeps a single classifier: the distinct messages are classified in
    // TS below, exactly as each row is.
    // The delegate is cast, not the argument: Prisma's `groupBy` generic
    // resolves `where` through GetHavingFields and reports AND/OR/NOT as
    // circular against a `where` of this shape (TS2615). Rebuilding the scope
    // filter in raw SQL instead would be a SECOND copy of it, drifting from the
    // one every count and the row list already use — the same reason the
    // classifier is not reimplemented in SQL above.
    (prisma.outboundSyncQueue as unknown as {
      groupBy: (args: unknown) => Promise<unknown>
    }).groupBy({
      by: ['errorMessage', 'errorCode', 'isDead'],
      where: whereFor(filter),
      _count: { _all: true },
      _max: { createdAt: true },
    }) as Promise<Array<{
      errorMessage: string | null
      errorCode: string | null
      isDead: boolean
      _count: { _all: number }
      _max: { createdAt: Date | null }
    }>>,
  ])

  // Fold the distinct triples into one entry per reason. `actionableCount` is
  // summed from the classifier's own verdict per triple rather than inferred
  // from the reason, because the same cause is actionable or not depending on
  // whether that row can still progress.
  const causeAcc = new Map<SyncFailureReason, {
    count: number; actionableCount: number; mostRecent: Date | null; topCount: number; sampleSummary: string
  }>()
  for (const g of causeGroups) {
    const verdict = deriveFailureReason(g.errorCode, g.errorMessage, { isDead: g.isDead })
    const n = g._count._all
    const cur = causeAcc.get(verdict.reason) ?? { count: 0, actionableCount: 0, mostRecent: null, topCount: -1, sampleSummary: verdict.summary }
    cur.count += n
    if (verdict.actionable) cur.actionableCount += n
    if (g._max.createdAt && (!cur.mostRecent || g._max.createdAt > cur.mostRecent)) cur.mostRecent = g._max.createdAt
    // The example comes from the LARGEST contributing message, so a one-off does
    // not get to speak for a cause carrying thousands of rows.
    if (n > cur.topCount) { cur.topCount = n; cur.sampleSummary = verdict.summary }
    causeAcc.set(verdict.reason, cur)
  }
  const causes: SyncQueueCause[] = [...causeAcc.entries()]
    .map(([reason, v]) => ({
      reason,
      count: v.count,
      actionableCount: v.actionableCount,
      mostRecent: v.mostRecent ? v.mostRecent.toISOString() : null,
      sampleSummary: v.sampleSummary,
    }))
    .sort((a, b) => b.count - a.count)
  const causesTotal = causes.reduce((n, c) => n + c.count, 0)

  // ── Resolve SKU + alias for the returned page, in two batched reads ───────
  // Never per row: a 200-row page would otherwise be 400 queries.
  const pageListingIds = [...new Set(rows.map((r) => r.channelListingId).filter((v): v is string => !!v))]
  const pageListings = pageListingIds.length
    ? await prisma.channelListing.findMany({
        where: { id: { in: pageListingIds } },
        select: { id: true, productId: true, aliasId: true, aliasKey: true },
      })
    : []
  const listingById = new Map(pageListings.map((l) => [l.id, l]))

  const skuIds = [...new Set([
    ...rows.map((r) => r.productId).filter((v): v is string => !!v),
    ...pageListings.map((l) => l.productId),
  ])]
  const skuRows = skuIds.length
    ? await prisma.product.findMany({ where: { id: { in: skuIds } }, select: { id: true, sku: true } })
    : []
  const skuById = new Map(skuRows.map((p) => [p.id, p.sku]))

  return {
    sources: [
      { source: 'OutboundSyncQueue', queried: true, status: 'ok', sentence: 'This console reads queued writes linked to this product family.' },
      { source: 'ListingIssue', queried: false, status: 'not-queried', sentence: 'Listing issues are not queried by this console.' },
      { source: 'AmazonSuppression', queried: false, status: 'not-queried', sentence: 'Amazon suppressions are not queried by this console.' },
      { source: 'ChannelListing.validationStatus', queried: false, status: 'not-queried', sentence: 'Listing validation status is not queried by this console.' },
    ],
    scope: {
      productId: rootId,
      familyIds,
      channel: input.channel ?? null,
      marketplace: input.marketplace ?? null,
      filter,
      coverageNote:
        destination ? 'Only queue entries with a matching listing and recorded account are shown. Older jobs without account attribution are excluded, including jobs linked to a listing that has since changed accounts.' : 'Only queue entries linked to this product family are shown. Entries without product or listing attribution are excluded.',
    },
    counts: { all, dead, retrying, stuck },
    stuckThresholdHours: STUCK_THRESHOLD_HOURS,
    causes,
    causesTotal,
    rows: rows.map((r) => {
      const listing = r.channelListingId ? listingById.get(r.channelListingId) : undefined
      // A listing-linked row names its product more precisely than the queue
      // row's own productId, which may be absent.
      const effectiveProductId = listing?.productId ?? r.productId
      return {
      id: r.id,
      productId: effectiveProductId ?? null,
      channelListingId: r.channelListingId,
      sku: effectiveProductId ? skuById.get(effectiveProductId) ?? null : null,
      aliasId: listing ? listing.aliasId : null,
      aliasKey: listing ? listing.aliasKey : null,
      // TRUE only when a listing actually supplied the alias. Product-only rows
      // stay false rather than defaulting to the primary listing.
      aliasResolved: Boolean(listing),
      targetChannel: String(r.targetChannel),
      targetRegion: r.targetRegion,
      syncType: r.syncType,
      syncStatus: String(r.syncStatus),
      syncedAt: r.syncedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      nextRetryAt: r.nextRetryAt?.toISOString() ?? null,
      holdUntil: r.holdUntil?.toISOString() ?? null,
      retryCount: r.retryCount,
      maxRetries: r.maxRetries,
      isDead: r.isDead,
      diedAt: r.diedAt?.toISOString() ?? null,
      errorCode: r.errorCode,
      errorMessage: r.errorMessage,
      ...(() => { const d = deriveFailureReason(r.errorCode, r.errorMessage, { isDead: r.isDead }); return { reason: d.reason, reasonSummary: d.summary, reasonActionable: d.actionable, reasonWillRetry: d.willRetry } })(),
      externalListingId: r.externalListingId,
      }
    }),
  }
}
