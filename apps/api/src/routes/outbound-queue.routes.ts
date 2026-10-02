/**
 * P3.1 — Outbound Sync Queue Monitor API.
 *
 * Exposes the OutboundSyncQueue table for the operator UI at
 * /sync-logs/outbound-queue. Supports pagination, multi-axis filters,
 * per-row retry/cancel, and bulk actions.
 */

import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { outboundSyncQueue, adsSyncQueue, addJobSafely } from '../lib/queue.js'
import { logger } from '../utils/logger.js'
import { isHeldPriceRow } from '../services/pim/follower-price.js'
// MCP full control P3 — the list read and the row shape live in sync-activity.service.ts (retry and cancel answer
// with the same row shape).
import { formatOutboundQueueRow as formatRow, listOutboundQueue } from '../services/sync-logs/sync-activity.service.js'

/**
 * Round 6 — a HELD price change (a price kept while its listing is paused or a draft, `pim/follower-price.ts`) is not
 * a failed send: it is sent once, at the listing's price then, when the listing resumes or goes live. Retrying it by
 * hand would send the number it recorded, possibly stale, to a listing that may still be paused — so it is refused.
 */
const HELD_RETRY_REFUSAL = 'This price is kept in Nexus while the listing is paused or still a draft. It is sent when the listing resumes or is published. Resume the listing to send it now.'

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
    return reply.send(await listOutboundQueue(request.query))
  })

  // ── POST /api/outbound-queue/:id/retry ────────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/api/outbound-queue/:id/retry',
    async (request, reply) => {
      const { id } = request.params
      const row = await prisma.outboundSyncQueue.findUnique({ where: { id } })
      if (!row) return reply.code(404).send({ error: 'Not found' })
      if (isHeldPriceRow(row)) return reply.code(409).send({ error: HELD_RETRY_REFUSAL, code: 'PRICE_HELD' })

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

      // Re-enqueue with deterministic jobId (no delay — operator wants it now).
      // RT.2 — addJobSafely: a bare .add() against an unreachable Redis blocks
      // forever (maxRetriesPerRequest null) and would hang this request.
      if (row.channelListingId && row.syncType) {
        await addJobSafely(
          outboundSyncQueue,
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
      } else if (row.syncType?.startsWith('AD_')) {
        // B2 — ads rows carry no channelListingId, so the generic re-enqueue above skips them and
        // they'd wait for the ~1-min drain cron. Re-enqueue on the ads queue for an immediate retry.
        await adsSyncQueue.add('ads-sync', { queueId: id, syncType: row.syncType }, { jobId: `ads-sync:${id}:retry:${Date.now()}` }).catch(() => {})
      }

      logger.info('Outbound queue job retried by operator', { id, channel: row.targetChannel })
      return reply.send({ ok: true, item: formatRow(updated) })
    },
  )

  // ── POST /api/outbound-queue/purge-failed (B3) ───────────────────────────
  // Delete terminal FAILED queue rows (historical cross-channel cruft that masks real failures
  // in the dashboard count). SAFE: only ever touches syncStatus=FAILED — never PENDING/IN_PROGRESS/
  // SUCCESS/SKIPPED. Pass {dryRun:true} to see the channel/syncType breakdown without deleting;
  // optional {channel, olderThanDays} to scope.
  fastify.post<{ Body: { dryRun?: boolean; channel?: string; olderThanDays?: number } }>(
    '/api/outbound-queue/purge-failed',
    async (request, reply) => {
      const { dryRun, channel, olderThanDays } = request.body ?? {}
      const where: any = { syncStatus: 'FAILED' }
      if (channel) where.targetChannel = channel
      if (olderThanDays != null) where.updatedAt = { lt: new Date(Date.now() - olderThanDays * 86_400_000) }
      const breakdown = await (prisma.outboundSyncQueue as any).groupBy({ by: ['targetChannel', 'syncType'], where, _count: { id: true } })
      const matched = breakdown.reduce((s: number, b: { _count: { id: number } }) => s + b._count.id, 0)
      if (dryRun) return reply.send({ dryRun: true, matched, breakdown })
      const res = await prisma.outboundSyncQueue.deleteMany({ where })
      logger.info('[outbound-queue] purged terminal FAILED rows', { deleted: res.count, channel: channel ?? 'all', olderThanDays: olderThanDays ?? 'any' })
      return reply.send({ ok: true, deleted: res.count, breakdown })
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

    const found = await prisma.outboundSyncQueue.findMany({ where, select: { id: true, channelListingId: true, syncType: true, targetChannel: true, productId: true, syncStatus: true, errorCode: true } })
    // A held price change waits for its listing's resume or go-live (see HELD_RETRY_REFUSAL): never retried in bulk.
    const rows = found.filter((r) => !isHeldPriceRow(r))
    const heldSkipped = found.length - rows.length

    await (prisma.outboundSyncQueue as any).updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { syncStatus: 'PENDING', retryCount: 0, errorMessage: null, errorCode: null, nextRetryAt: null, isDead: false, diedAt: null },
    })

    // Re-enqueue all
    // RT.2 — addJobSafely (bounded, circuit-broken); a bare .add() against an
    // unreachable Redis blocks forever and would hang the bulk request.
    await Promise.all(
      rows.map((r) =>
        r.channelListingId && r.syncType
          ? addJobSafely(
              outboundSyncQueue,
              'sync-job',
              { queueId: r.id, productId: r.productId, channelListingId: r.channelListingId, targetChannel: r.targetChannel, syncType: r.syncType },
              { jobId: `${r.channelListingId}:${r.syncType}:retry:${Date.now()}` },
            )
          : r.syncType?.startsWith('AD_') // B2 — ads rows go on the ads queue
            ? adsSyncQueue.add('ads-sync', { queueId: r.id, syncType: r.syncType }, { jobId: `ads-sync:${r.id}:retry:${Date.now()}` }).catch(() => {})
            : Promise.resolve(),
      ),
    )

    logger.info('Bulk retry by operator', { count: rows.length, heldSkipped, channel })
    return reply.send({ ok: true, count: rows.length, ...(heldSkipped ? { heldSkipped, note: `${heldSkipped} held price change${heldSkipped === 1 ? ' was' : 's were'} not retried: ${heldSkipped === 1 ? 'it is' : 'they are'} sent when the listing resumes or is published.` } : {}) })
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
