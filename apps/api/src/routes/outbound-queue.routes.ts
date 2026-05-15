/**
 * P3.1 — Outbound Sync Queue Monitor API.
 *
 * Exposes the OutboundSyncQueue table for the operator UI at
 * /sync-logs/outbound-queue. Supports pagination, multi-axis filters,
 * per-row retry/cancel, and bulk actions.
 */

import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { outboundSyncQueue } from '../lib/queue.js'
import { logger } from '../utils/logger.js'

export default async function outboundQueueRoutes(fastify: FastifyInstance) {

  // ── GET /api/outbound-queue ──────────────────────────────────────────────
  // Paginated list of queue rows + inline stats for the header cards.
  //
  // Query params:
  //   tab       active | dead | success   (default: active)
  //   status    PENDING | IN_PROGRESS | FAILED | CANCELLED (filter within active tab)
  //   channel   AMAZON | EBAY | SHOPIFY
  //   syncType  PRICE_UPDATE | QUANTITY_UPDATE | ...
  //   stuckOnly true → only PENDING rows older than 15 min past holdUntil
  //   limit     max 200 (default 50)
  //   cursor    cuid for cursor pagination
  fastify.get<{
    Querystring: {
      tab?: string
      status?: string
      channel?: string
      syncType?: string
      stuckOnly?: string
      limit?: string
      cursor?: string
    }
  }>('/api/outbound-queue', async (request, reply) => {
    const q = request.query
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

    return reply.send({
      items: items.map(formatRow),
      nextCursor,
      stats: {
        pending: totalPending,
        inProgress: totalInProgress,
        failed: totalFailed,
        dead: totalDead,
        byChannel,
      },
    })
  })

  // ── POST /api/outbound-queue/:id/retry ────────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/api/outbound-queue/:id/retry',
    async (request, reply) => {
      const { id } = request.params
      const row = await prisma.outboundSyncQueue.findUnique({ where: { id } })
      if (!row) return reply.code(404).send({ error: 'Not found' })

      const updated = await (prisma.outboundSyncQueue as any).update({
        where: { id },
        data: {
          syncStatus: 'PENDING',
          retryCount: 0,
          errorMessage: null,
          errorCode: null,
          nextRetryAt: null,
          isDead: false,
          diedAt: null,
        },
        include: { product: { select: { sku: true, name: true } } },
      })

      // Re-enqueue with deterministic jobId (no delay — operator wants it now)
      if (row.channelListingId && row.syncType) {
        await outboundSyncQueue.add(
          'sync-job',
          {
            queueId: id,
            productId: row.productId,
            channelListingId: row.channelListingId,
            targetChannel: row.targetChannel,
            syncType: row.syncType,
          },
          { jobId: `${row.channelListingId}:${row.syncType}:retry:${Date.now()}` },
        )
      }

      logger.info('Outbound queue job retried by operator', { id, channel: row.targetChannel })
      return reply.send({ ok: true, item: formatRow(updated) })
    },
  )

  // ── POST /api/outbound-queue/:id/cancel ──────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/api/outbound-queue/:id/cancel',
    async (request, reply) => {
      const { id } = request.params
      const row = await prisma.outboundSyncQueue.findUnique({ where: { id } })
      if (!row) return reply.code(404).send({ error: 'Not found' })

      const updated = await (prisma.outboundSyncQueue as any).update({
        where: { id },
        data: { syncStatus: 'CANCELLED' },
        include: { product: { select: { sku: true, name: true } } },
      })

      logger.info('Outbound queue job cancelled by operator', { id })
      return reply.send({ ok: true, item: formatRow(updated) })
    },
  )

  // ── POST /api/outbound-queue/bulk-retry ──────────────────────────────────
  fastify.post<{
    Body: { channel?: string; ids?: string[] }
  }>('/api/outbound-queue/bulk-retry', async (request, reply) => {
    const { channel, ids } = request.body ?? {}

    const where: any = {}
    if (ids?.length) {
      where.id = { in: ids }
    } else {
      where.OR = [
        { syncStatus: 'FAILED' },
        { isDead: true },
      ]
      if (channel) where.targetChannel = channel
    }

    const rows = await prisma.outboundSyncQueue.findMany({ where, select: { id: true, channelListingId: true, syncType: true, targetChannel: true, productId: true } })

    await (prisma.outboundSyncQueue as any).updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { syncStatus: 'PENDING', retryCount: 0, errorMessage: null, errorCode: null, nextRetryAt: null, isDead: false, diedAt: null },
    })

    // Re-enqueue all
    await Promise.all(
      rows.map((r) =>
        r.channelListingId && r.syncType
          ? outboundSyncQueue.add(
              'sync-job',
              { queueId: r.id, productId: r.productId, channelListingId: r.channelListingId, targetChannel: r.targetChannel, syncType: r.syncType },
              { jobId: `${r.channelListingId}:${r.syncType}:retry:${Date.now()}` },
            ).catch(() => {})
          : Promise.resolve(),
      ),
    )

    logger.info('Bulk retry by operator', { count: rows.length, channel })
    return reply.send({ ok: true, count: rows.length })
  })

  // ── POST /api/outbound-queue/bulk-cancel ─────────────────────────────────
  fastify.post<{
    Body: { channel?: string; ids?: string[] }
  }>('/api/outbound-queue/bulk-cancel', async (request, reply) => {
    const { channel, ids } = request.body ?? {}

    const where: any = { syncStatus: { in: ['PENDING', 'IN_PROGRESS'] } }
    if (ids?.length) where.id = { in: ids }
    else if (channel) where.targetChannel = channel

    const { count } = await (prisma.outboundSyncQueue as any).updateMany({
      where,
      data: { syncStatus: 'CANCELLED' },
    })

    logger.info('Bulk cancel by operator', { count, channel })
    return reply.send({ ok: true, count })
  })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatRow(row: any) {
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
