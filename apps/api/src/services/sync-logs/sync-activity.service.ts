/**
 * MCP full control P3 — the sync activity reads, in one place: the outbound API call ledger (recent calls), the error
 * groups, the webhook event list and the outbound sync queue. The sync-logs and outbound-queue routes call these, and
 * so does Claude's `sync-activity` read.
 *
 * Moved from sync-logs.routes.ts and outbound-queue.routes.ts without a change in behaviour: the routes keep their
 * cache headers, errors and status codes, and answer byte for byte as before (sync-activity.service.vitest.test.ts).
 * Every read runs in the caller's business (row-level security and the business-scoped client).
 */

import { Prisma } from '@prisma/client'
import prisma from '../../db.js'

export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000

export interface CallsQuery {
  since?: string
  until?: string
  channel?: string
  operation?: string
  success?: string
  errorType?: string
  /** P3.3 — the account. Its absence was why no screen could ask about one. */
  connectionId?: string
  requestId?: string
  productId?: string
  listingId?: string
  orderId?: string
  limit?: string
  cursor?: string
}

export function parseWindow(q: CallsQuery): { since: Date; until: Date } {
  const until = q.until ? new Date(q.until) : new Date()
  const since = q.since
    ? new Date(q.since)
    : new Date(until.getTime() - DEFAULT_WINDOW_MS)
  return { since, until }
}

export function buildWhere(
  q: CallsQuery,
  range: { since: Date; until: Date },
): Prisma.OutboundApiCallLogWhereInput {
  const where: Prisma.OutboundApiCallLogWhereInput = {
    createdAt: { gte: range.since, lte: range.until },
  }
  if (q.channel) where.channel = q.channel
  if (q.operation) where.operation = q.operation
  if (q.success === 'true') where.success = true
  else if (q.success === 'false') where.success = false
  if (q.errorType) where.errorType = q.errorType
  // P3.3 — every other identifier on the row was filterable and this one was not, so
  // the call ledger could be asked about a product, a listing or an order but never
  // about the account that made the call.
  if (q.connectionId) where.connectionId = q.connectionId
  if (q.requestId) where.requestId = q.requestId
  if (q.productId) where.productId = q.productId
  if (q.listingId) where.listingId = q.listingId
  if (q.orderId) where.orderId = q.orderId
  return where
}

/** GET /api/sync-logs/api-calls/recent — the newest outbound API calls in a window, filtered, by cursor. */
export async function recentApiCalls(query: CallsQuery) {
  const range = parseWindow(query)
  const where = buildWhere(query, range)
  const limit = Math.min(
    Math.max(Number(query.limit ?? 50), 1),
    200,
  )

  const rows = await prisma.outboundApiCallLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(query.cursor
      ? { cursor: { id: query.cursor }, skip: 1 }
      : {}),
  })
  const hasNext = rows.length > limit
  const items = hasNext ? rows.slice(0, limit) : rows
  const nextCursor = hasNext ? items[items.length - 1].id : null

  return {
    items,
    nextCursor,
    window: { since: range.since, until: range.until },
  }
}

export interface ErrorGroupsQuery {
  status?: string
  channel?: string
  since?: string
  limit?: string
  cursor?: string
}

/**
 * GET /api/sync-logs/error-groups — error groups seen since `since` (default the last 7 days), ACTIVE unless a status
 * (or ALL) is named, newest first by cursor, with a count per resolution status for the filter chips.
 */
export async function listErrorGroups(q: ErrorGroupsQuery) {
  const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 200)
  const status = q.status ?? 'ACTIVE'
  const since = q.since
    ? new Date(q.since)
    : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  const where: Prisma.SyncLogErrorGroupWhereInput = {
    lastSeen: { gte: since },
  }
  if (status !== 'ALL') where.resolutionStatus = status
  if (q.channel) where.channel = q.channel

  const [rows, totals] = await Promise.all([
    prisma.syncLogErrorGroup.findMany({
      where,
      orderBy: { lastSeen: 'desc' },
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    }),
    // Counts per resolution status for the filter chip badges.
    prisma.syncLogErrorGroup.groupBy({
      by: ['resolutionStatus'],
      where: { lastSeen: { gte: since } },
      _count: { _all: true },
    }),
  ])
  const hasNext = rows.length > limit
  const items = hasNext ? rows.slice(0, limit) : rows
  const nextCursor = hasNext ? items[items.length - 1].id : null

  return {
    items,
    nextCursor,
    totals: totals.map((t) => ({
      status: t.resolutionStatus,
      count: t._count._all,
    })),
  }
}

export interface WebhookEventsQuery {
  channel?: string
  processed?: string
  /** P2.8 — one or more of pending,done,failed,dlq (comma separated). */
  status?: string
  eventType?: string
  since?: string
  limit?: string
  cursor?: string
}

/**
 * GET /api/sync-logs/webhooks — webhook events received since `since` (default the last 24 hours), newest first by
 * cursor, without their payload or signature, with totals per channel, processed flag and lifecycle state.
 */
export async function listWebhookEvents(q: WebhookEventsQuery) {
  const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 200)
  const since = q.since
    ? new Date(q.since)
    : new Date(Date.now() - 24 * 60 * 60 * 1000)

  const where: Prisma.WebhookEventWhereInput = {
    createdAt: { gte: since },
  }
  if (q.channel) where.channel = q.channel
  if (q.eventType) where.eventType = q.eventType
  if (q.processed === 'true') where.isProcessed = true
  else if (q.processed === 'false') where.isProcessed = false
  // P2.8 — filter on the LIFECYCLE, not just the old boolean.
  //
  // `isProcessed` has two values and the lifecycle has four: pending, done, failed
  // and dlq. Reading the list through the boolean cannot tell a dead letter from an
  // event that arrived a second ago, which is the single distinction an operator
  // opens this screen to make.
  if (q.status) {
    const wanted = q.status.split(',').map((value) => value.trim()).filter(Boolean)
    if (wanted.length) where.status = { in: wanted }
  }

  const [rows, byChannel, byProcessed, byStatus] = await Promise.all([
    prisma.webhookEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        channel: true,
        eventType: true,
        externalId: true,
        isProcessed: true,
        processedAt: true,
        error: true,
        createdAt: true,
        updatedAt: true,
        // RT.4 — needed by the latency column on /sync-logs/webhooks.
        providerTimestamp: true,
        // P2.8 — the lifecycle the Ingress tab is built on. Every one of these was
        // added by CX.4a or P2.1 and none of them was ever read by an API: the
        // screen could show that something went wrong but not what, how often it
        // had been tried, when it would be tried again, or whether the signature
        // had been checked at all.
        status: true,
        attempts: true,
        deliveries: true,
        nextAttemptAt: true,
        lastError: true,
        signatureOk: true,
        verifiedBy: true,
        archivedAt: true,
        // Skip the heavy payload + signature fields on the list.
      },
    }),
    prisma.webhookEvent.groupBy({
      by: ['channel'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.webhookEvent.groupBy({
      by: ['isProcessed'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    // P2.8 — counted over the WHOLE window, not just the page, and not filtered by
    // the caller's own status filter. A tally that moves when you click a filter is
    // describing the page rather than the system, which is the opposite of what the
    // number is for.
    prisma.webhookEvent.groupBy({
      by: ['status'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
  ])
  const hasNext = rows.length > limit
  const items = hasNext ? rows.slice(0, limit) : rows
  const nextCursor = hasNext ? items[items.length - 1].id : null

  return {
    items,
    nextCursor,
    totals: {
      byChannel: byChannel.map((g) => ({
        channel: g.channel,
        count: g._count._all,
      })),
      processed:
        byProcessed.find((g) => g.isProcessed === true)?._count._all ?? 0,
      unprocessed:
        byProcessed.find((g) => g.isProcessed === false)?._count._all ?? 0,
      byStatus: byStatus.map((g) => ({ status: g.status, count: g._count._all })),
    },
  }
}

export interface OutboundQueueQuery {
  tab?: string
  status?: string
  channel?: string
  syncType?: string
  stuckOnly?: string
  limit?: string
  cursor?: string
}

/**
 * GET /api/outbound-queue — one page of queue rows (tab active | dead | success, default active; filters within it)
 * and the header-card stats over the last 7 days plus every dead row.
 */
export async function listOutboundQueue(q: OutboundQueueQuery) {
  const tab = q.tab ?? 'active'
  const limit = Math.min(200, parseInt(q.limit ?? '50', 10) || 50)

  // Build where clause per tab
  const where: any = {}

  if (tab === 'dead') {
    where.isDead = true
  } else if (tab === 'success') {
    where.syncStatus = 'SUCCESS'
    where.syncedAt = { gte: new Date(Date.now() - 2 * 60 * 60 * 1000) }
  } else {
    // active tab: non-dead rows, last 7 days
    where.isDead = false
    where.createdAt = { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
    if (q.status) where.syncStatus = q.status
    if (q.stuckOnly === 'true') {
      const stuckCutoff = new Date(Date.now() - 15 * 60 * 1000)
      where.AND = [
        { syncStatus: 'PENDING' },
        {
          OR: [
            { holdUntil: null, createdAt: { lt: stuckCutoff } },
            { holdUntil: { lt: stuckCutoff } },
          ],
        },
      ]
      delete where.syncStatus // already set in AND
    }
  }

  if (q.channel) where.targetChannel = q.channel
  if (q.syncType) where.syncType = q.syncType
  if (q.cursor) {
    where.id = { lt: q.cursor } // createdAt desc → id lt works for cuid ordering
  }

  const [items, statsRaw] = await Promise.all([
    prisma.outboundSyncQueue.findMany({
      where,
      include: { product: { select: { sku: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    }),
    // Stats rollup for header cards (always over last 7d + dead)
    (prisma.outboundSyncQueue as any).groupBy({
      by: ['syncStatus', 'targetChannel', 'isDead'],
      _count: { id: true },
      where: {
        OR: [
          { isDead: true },
          { createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
        ],
      },
    }) as Promise<Array<{ syncStatus: string; targetChannel: string; isDead: boolean; _count: { id: number } }>>,
  ])
  const stats = statsRaw

  const hasMore = items.length > limit
  if (hasMore) items.pop()
  const nextCursor = hasMore ? items[items.length - 1]?.id ?? null : null

  // Aggregate stats into card-friendly shape
  const channels = ['AMAZON', 'EBAY', 'SHOPIFY'] as const
  const byChannel: Record<string, { pending: number; inProgress: number; failed: number; dead: number }> = {}
  for (const ch of channels) {
    byChannel[ch] = { pending: 0, inProgress: 0, failed: 0, dead: 0 }
  }
  let totalPending = 0, totalInProgress = 0, totalFailed = 0, totalDead = 0
  for (const g of stats) {
    const ch = g.targetChannel as string
    const count = g._count.id
    if (g.isDead) {
      totalDead += count
      if (byChannel[ch]) byChannel[ch].dead += count
    } else if (g.syncStatus === 'PENDING') {
      totalPending += count
      if (byChannel[ch]) byChannel[ch].pending += count
    } else if (g.syncStatus === 'IN_PROGRESS') {
      totalInProgress += count
      if (byChannel[ch]) byChannel[ch].inProgress += count
    } else if (g.syncStatus === 'FAILED') {
      totalFailed += count
      if (byChannel[ch]) byChannel[ch].failed += count
    }
  }

  return {
    items: items.map(formatOutboundQueueRow),
    nextCursor,
    stats: {
      pending: totalPending,
      inProgress: totalInProgress,
      failed: totalFailed,
      dead: totalDead,
      byChannel,
    },
  }
}

/** One queue row as the outbound queue screen shows it (the list, and the answer of a retry or a cancel). */
export function formatOutboundQueueRow(row: any) {
  return {
    id: row.id,
    productId: row.productId ?? null,
    sku: row.product?.sku ?? null,
    productName: row.product?.name ?? null,
    channelListingId: row.channelListingId ?? null,
    targetChannel: row.targetChannel,
    syncType: row.syncType,
    syncStatus: row.syncStatus,
    isDead: row.isDead ?? false,
    diedAt: row.diedAt?.toISOString() ?? null,
    retryCount: row.retryCount ?? 0,
    maxRetries: row.maxRetries ?? 3,
    errorMessage: row.errorMessage ?? null,
    errorCode: row.errorCode ?? null,
    payload: row.payload ?? null,
    createdAt: row.createdAt?.toISOString() ?? null,
    holdUntil: row.holdUntil?.toISOString() ?? null,
    syncedAt: row.syncedAt?.toISOString() ?? null,
    nextRetryAt: row.nextRetryAt?.toISOString() ?? null,
  }
}
