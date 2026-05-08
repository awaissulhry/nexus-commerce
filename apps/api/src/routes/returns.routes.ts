// Returns routes. R0.2 extracted them out of the 8358-line
// fulfillment.routes.ts; R0.3 layers on bug fixes — idempotency on
// create (B7), pagination on list (B6), AuditLog on every state
// transition (B1/B2/B8), and a post-restock scrap path that emits a
// real WRITE_OFF stock movement (the only B1 case where stock was
// ever credited).

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import prisma from '../db.js'
import { applyStockMovement } from '../services/stock-movement.service.js'
import { auditLogService } from '../services/audit-log.service.js'

function generateRmaNumber(): string {
  const d = new Date()
  const yymmdd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `RMA-${yymmdd}-${rand}`
}

// Pull a stable client identity off the request for AuditLog without
// pulling in the auth stack. userId comes from the existing
// x-user-id header convention (set by the web app's middleware);
// remoteAddress is the request IP. Both are nullable — auditing is
// fail-open and we never want a missing header to block a write.
function auditCtx(req: FastifyRequest): { userId: string | null; ip: string | null } {
  const userId = (req.headers['x-user-id'] as string | undefined) ?? null
  const ip = req.ip ?? null
  return { userId, ip }
}

const returnsRoutes: FastifyPluginAsync = async (fastify) => {
  // O.76: returns analytics. The returns surface had per-return
  // detail but no aggregate view — operators couldn't tell at a
  // glance which channel was generating the most returns or what
  // reasons dominated. Powers a KPI strip at the top of the
  // workspace; intentionally narrow set so it stays cheap on every
  // page load.
  fastify.get('/fulfillment/returns/analytics', async (_request, reply) => {
    try {
      const since = new Date(Date.now() - 30 * 86_400_000)
      const priorSince = new Date(Date.now() - 60 * 86_400_000)
      // R7.1 — additive: keep the original shape (workspace KPI
      // strip + audit/dashboard consumers depend on it) and append
      // returnRateByChannel / topReturnSkus / avgProcessingDays /
      // dailyTrend. The /fulfillment/returns/analytics page reads
      // the new fields; old consumers ignore them.
      const [last30, prior30, byChannelRows, byReasonRows, fbaCount, totalCount, ordersByChannel, topSkuRows, processingTimeAgg, dailyRows] = await Promise.all([
        prisma.return.count({ where: { createdAt: { gte: since } } }),
        prisma.return.count({
          where: { createdAt: { gte: priorSince, lt: since } },
        }),
        prisma.return.groupBy({
          by: ['channel'],
          _count: { _all: true },
          where: { createdAt: { gte: since } },
        }),
        prisma.return.groupBy({
          by: ['reason'],
          _count: { _all: true },
          where: { createdAt: { gte: since }, reason: { not: null } },
          orderBy: { _count: { reason: 'desc' } },
          take: 5,
        }),
        prisma.return.count({ where: { isFbaReturn: true } }),
        prisma.return.count(),
        // R7.1 — orders-per-channel for the rate-% denominator.
        prisma.order.groupBy({
          by: ['channel'],
          _count: { _all: true },
          where: { createdAt: { gte: since } },
        }),
        // R7.1 — top 10 SKUs by return count in the last 30d.
        prisma.returnItem.groupBy({
          by: ['sku'],
          _count: { _all: true },
          _sum: { quantity: true },
          where: { return: { createdAt: { gte: since } } },
          orderBy: { _count: { sku: 'desc' } },
          take: 10,
        }),
        // R7.1 — avg processing time (createdAt → refundedAt) in
        // ms, for refunded-only rows in the window. Used as a
        // basic SLA indicator on the page.
        prisma.$queryRaw<Array<{ avg_ms: number | null; n: bigint }>>`
          SELECT
            AVG(EXTRACT(EPOCH FROM ("refundedAt" - "createdAt"))) * 1000 AS avg_ms,
            COUNT(*)::bigint AS n
          FROM "Return"
          WHERE "refundedAt" IS NOT NULL
            AND "createdAt" >= ${since}
        `,
        // R7.1 — daily counts for the trend chart (last 30 days).
        // groupBy on day-truncated createdAt requires raw SQL because
        // Prisma's groupBy doesn't have a date_trunc helper.
        prisma.$queryRaw<Array<{ day: Date; count: bigint }>>`
          SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS count
          FROM "Return"
          WHERE "createdAt" >= ${since}
          GROUP BY day
          ORDER BY day ASC
        `,
      ])
      // % change vs prior window. null when prior window is 0 to
      // avoid divide-by-zero "+Infinity%" in the UI.
      const trendPct = prior30 > 0 ? ((last30 - prior30) / prior30) * 100 : null

      // R7.1 — fold orders count into the per-channel return rows.
      // Order.channel is an enum but the values are strings ('AMAZON'
      // / 'EBAY' / etc.) — coerce both sides to a string Map key.
      const ordersByCh = new Map<string, number>(
        ordersByChannel.map((r) => [String(r.channel), r._count._all]),
      )
      const returnRateByChannel = byChannelRows.map((r) => {
        const orders = ordersByCh.get(String(r.channel)) ?? 0
        const ratePct = orders > 0 ? (r._count._all / orders) * 100 : null
        return { channel: r.channel, returns: r._count._all, orders, ratePct }
      }).sort((a, b) => (b.ratePct ?? 0) - (a.ratePct ?? 0))

      const avgMs = processingTimeAgg[0]?.avg_ms ?? null
      const avgProcessingDays = avgMs != null ? Number(avgMs) / 86_400_000 : null

      // R7.1 — fill in zero-count days so the chart has a continuous
      // x-axis. Otherwise sparse-day periods misrepresent the trend.
      const trendByDay = new Map<string, number>()
      for (const r of dailyRows) {
        trendByDay.set(r.day.toISOString().slice(0, 10), Number(r.count))
      }
      const dailyTrend: Array<{ date: string; count: number }> = []
      for (let d = 29; d >= 0; d--) {
        const dt = new Date(Date.now() - d * 86_400_000)
        const key = dt.toISOString().slice(0, 10)
        dailyTrend.push({ date: key, count: trendByDay.get(key) ?? 0 })
      }

      return {
        windowDays: 30,
        last30,
        prior30,
        trendPct,
        byChannel: byChannelRows
          .map((r) => ({ channel: r.channel, count: r._count._all }))
          .sort((a, b) => b.count - a.count),
        topReasons: byReasonRows.map((r) => ({
          reason: r.reason ?? 'Unspecified',
          count: r._count._all,
        })),
        fbaCount,
        warehouseCount: totalCount - fbaCount,
        totalCount,
        // R7.1 — new fields. Workspace KPI strip ignores; analytics
        // page consumes.
        returnRateByChannel,
        topReturnSkus: topSkuRows.map((r) => ({
          sku: r.sku,
          returnCount: r._count._all,
          unitsReturned: r._sum.quantity ?? 0,
        })),
        avgProcessingDays,
        avgProcessingSampleSize: Number(processingTimeAgg[0]?.n ?? 0),
        dailyTrend,
      }
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // R1.1 — list endpoint upgrades:
  //   q       — case-insensitive search across rmaNumber, reason,
  //             notes, returnTrackingNumber, channelReturnId, and
  //             the parent Order's channelOrderId / customerName.
  //             Items SKU is intentionally NOT searched here — that
  //             requires a join + duplicates rows; we'll add it via
  //             a dedicated SKU lookup endpoint when search volume
  //             justifies the cost.
  //   sortBy  — whitelisted column. Default createdAt.
  //   sortDir — asc | desc. Default desc.
  //   page / pageSize — pagination (R0.3).
  fastify.get('/fulfillment/returns', async (request, reply) => {
    try {
      const q = request.query as any
      const where: any = {}
      if (q.status && q.status !== 'ALL') where.status = q.status
      if (q.channel) where.channel = q.channel
      if (q.fbaOnly === 'true') where.isFbaReturn = true
      if (q.fbaOnly === 'false') where.isFbaReturn = false
      if (q.refundStatus) where.refundStatus = q.refundStatus

      const search = typeof q.q === 'string' ? q.q.trim() : ''
      if (search) {
        where.OR = [
          { rmaNumber: { contains: search, mode: 'insensitive' } },
          { reason: { contains: search, mode: 'insensitive' } },
          { notes: { contains: search, mode: 'insensitive' } },
          { returnTrackingNumber: { contains: search, mode: 'insensitive' } },
          { channelReturnId: { contains: search, mode: 'insensitive' } },
          { order: { channelOrderId: { contains: search, mode: 'insensitive' } } },
          { order: { customerName: { contains: search, mode: 'insensitive' } } },
        ]
      }

      const SORT_WHITELIST = new Set([
        'createdAt', 'rmaNumber', 'channel', 'status', 'refundCents',
        'receivedAt', 'inspectedAt', 'refundedAt',
      ])
      const sortBy = SORT_WHITELIST.has(q.sortBy) ? q.sortBy : 'createdAt'
      const sortDir: 'asc' | 'desc' = q.sortDir === 'asc' ? 'asc' : 'desc'

      const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50))
      const page = Math.max(1, Number(q.page) || 1)
      const skip = (page - 1) * pageSize

      const [items, total] = await Promise.all([
        prisma.return.findMany({
          where,
          include: { items: true },
          orderBy: { [sortBy]: sortDir },
          skip,
          take: pageSize,
        }),
        prisma.return.count({ where }),
      ])
      return { items, total, page, pageSize, sortBy, sortDir }
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // R2.1 — drawer detail include. Pulls the parent Order's customer
  // info, shipping address, channelOrderId + the latest shipment for
  // back-link rendering. Narrow select keeps the payload small.
  fastify.get('/fulfillment/returns/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const ret = await prisma.return.findUnique({
      where: { id },
      include: {
        items: true,
        order: {
          select: {
            id: true,
            channel: true,
            marketplace: true,
            channelOrderId: true,
            customerName: true,
            customerEmail: true,
            shippingAddress: true,
            createdAt: true,
            shipments: {
              select: {
                id: true, status: true,
                trackingNumber: true, trackingUrl: true,
                carrierCode: true, shippedAt: true, deliveredAt: true,
              },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        },
      },
    })
    if (!ret) return reply.code(404).send({ error: 'Return not found' })
    return ret
  })

  // B7 — Idempotency. Operators on flaky mobile networks were double-
  // tapping "Create" on the new-return modal and getting two RMAs
  // for the same physical return. Pattern: client sends an
  // Idempotency-Key header (UUID); we look up Return.idempotencyKey
  // first; if found, return the existing row (HTTP 200) and skip the
  // create. Otherwise create with the key persisted, so a subsequent
  // retry with the same key short-circuits.
  fastify.post('/fulfillment/returns', async (request, reply) => {
    try {
      const body = request.body as {
        orderId?: string
        channel: string
        marketplace?: string
        reason?: string
        isFbaReturn?: boolean
        items?: Array<{ orderItemId?: string; productId?: string; sku: string; quantity: number }>
      }
      if (!body.channel) return reply.code(400).send({ error: 'channel required' })
      const items = Array.isArray(body.items) ? body.items : []

      const idemKey =
        (request.headers['idempotency-key'] as string | undefined)?.trim() || null

      if (idemKey) {
        const existing = await prisma.return.findUnique({
          where: { idempotencyKey: idemKey },
          include: { items: true },
        })
        if (existing) {
          return reply
            .header('Idempotent-Replay', 'true')
            .send(existing)
        }
      }

      const ret = await prisma.return.create({
        data: {
          orderId: body.orderId ?? null,
          channel: body.channel,
          marketplace: body.marketplace ?? null,
          rmaNumber: generateRmaNumber(),
          status: 'REQUESTED',
          reason: body.reason ?? null,
          isFbaReturn: !!body.isFbaReturn,
          idempotencyKey: idemKey,
          items: {
            create: items.map((it) => ({
              orderItemId: it.orderItemId ?? null,
              productId: it.productId ?? null,
              sku: it.sku,
              quantity: it.quantity,
            })),
          },
        },
        include: { items: true },
      })

      const ctx = auditCtx(request)
      void auditLogService.write({
        ...ctx,
        entityType: 'Return',
        entityId: ret.id,
        action: 'create',
        after: {
          rmaNumber: ret.rmaNumber,
          channel: ret.channel,
          status: ret.status,
          itemCount: ret.items.length,
        },
        metadata: idemKey ? { idempotencyKey: idemKey } : undefined,
      })

      return ret
    } catch (error: any) {
      // P2002 = unique-constraint violation on idempotencyKey, which
      // means a concurrent retry won the race. Treat as idempotent
      // hit: re-look-up and return the existing row.
      if (error?.code === 'P2002') {
        const idemKey =
          (request.headers['idempotency-key'] as string | undefined)?.trim()
        if (idemKey) {
          const existing = await prisma.return.findUnique({
            where: { idempotencyKey: idemKey },
            include: { items: true },
          })
          if (existing) {
            return reply
              .header('Idempotent-Replay', 'race')
              .send(existing)
          }
        }
      }
      fastify.log.error({ err: error }, '[POST /fulfillment/returns] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // B2 — Receive emits no StockMovement (the units aren't in our
  // inventory yet — they're customer property until inspection +
  // restock decides their fate). The fix is audit visibility: log
  // the state transition + receivedAt timestamp so operators can
  // answer "when did this come back?". Stock semantics unchanged.
  fastify.post('/fulfillment/returns/:id/receive', async (request, reply) => {
    const { id } = request.params as { id: string }
    const before = await prisma.return.findUnique({
      where: { id },
      select: { status: true },
    })
    const updated = await prisma.return.update({
      where: { id },
      data: { status: 'RECEIVED', receivedAt: new Date(), version: { increment: 1 } },
    })
    void auditLogService.write({
      ...auditCtx(request),
      entityType: 'Return',
      entityId: id,
      action: 'receive',
      before: { status: before?.status ?? null },
      after: { status: updated.status, receivedAt: updated.receivedAt },
    })
    return updated
  })

  // R3.2 — accepts per-item disposition + scrapReason. Auto-derives
  // disposition from grade when operator omits it (NEW/LIKE_NEW/GOOD
  // → SELLABLE; DAMAGED/UNUSABLE → SCRAP). Restock route uses
  // disposition to route per-item to the matching warehouse kind.
  fastify.post('/fulfillment/returns/:id/inspect', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as {
        items: Array<{
          itemId: string
          conditionGrade: string
          notes?: string
          disposition?: string
          scrapReason?: string
        }>
        overallCondition?: string
      }
      const VALID_DISPOSITIONS = new Set([
        'SELLABLE', 'SECOND_QUALITY', 'REFURBISH', 'QUARANTINE', 'SCRAP',
      ])
      const inferDisposition = (grade: string): string => {
        if (grade === 'NEW' || grade === 'LIKE_NEW' || grade === 'GOOD') return 'SELLABLE'
        return 'SCRAP'
      }
      for (const it of body.items ?? []) {
        const disposition = it.disposition && VALID_DISPOSITIONS.has(it.disposition)
          ? it.disposition
          : inferDisposition(it.conditionGrade)
        await prisma.returnItem.update({
          where: { id: it.itemId },
          data: {
            conditionGrade: it.conditionGrade as any,
            notes: it.notes ?? null,
            disposition,
            scrapReason: disposition === 'SCRAP' ? (it.scrapReason ?? null) : null,
          },
        })
      }
      const updated = await prisma.return.update({
        where: { id },
        data: {
          status: 'INSPECTING',
          conditionGrade: (body.overallCondition as any) ?? null,
          inspectedAt: new Date(),
          version: { increment: 1 },
        },
        include: { items: true },
      })
      void auditLogService.write({
        ...auditCtx(request),
        entityType: 'Return',
        entityId: id,
        action: 'inspect',
        after: {
          status: updated.status,
          overallCondition: updated.conditionGrade,
          itemGrades: (body.items ?? []).map((it) => ({
            itemId: it.itemId,
            grade: it.conditionGrade,
            disposition: it.disposition ?? inferDisposition(it.conditionGrade),
          })),
        },
      })
      return updated
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/returns/:id/restock', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { warehouseId?: string }
      const ret = await prisma.return.findUnique({ where: { id }, include: { items: true } })
      if (!ret) return reply.code(404).send({ error: 'Return not found' })

      const warehouseId = body.warehouseId ?? (await prisma.warehouse.findFirst({ where: { isDefault: true } }))?.id

      const restocked: Array<{ sku: string; productId: string; qty: number; grade: string | null }> = []
      const skipped: Array<{ sku: string; reason: string }> = []
      for (const item of ret.items) {
        if (!item.productId) {
          skipped.push({ sku: item.sku, reason: 'no-productId' })
          continue
        }
        // Only restock items graded NEW/LIKE_NEW/GOOD; DAMAGED and UNUSABLE go to write-off.
        const grade = item.conditionGrade
        if (grade === 'DAMAGED' || grade === 'UNUSABLE') {
          skipped.push({ sku: item.sku, reason: `grade-${grade}` })
          continue
        }
        await applyStockMovement({
          productId: item.productId,
          warehouseId,
          change: item.quantity,
          reason: 'RETURN_RESTOCKED',
          referenceType: 'Return',
          referenceId: ret.id,
          actor: 'return-restock',
        })
        restocked.push({ sku: item.sku, productId: item.productId, qty: item.quantity, grade })
      }
      const updated = await prisma.return.update({
        where: { id },
        data: { status: 'RESTOCKED', restockedAt: new Date(), version: { increment: 1 } },
      })
      void auditLogService.write({
        ...auditCtx(request),
        entityType: 'Return',
        entityId: id,
        action: 'restock',
        after: {
          status: updated.status,
          warehouseId,
          restockedItems: restocked,
          skippedItems: skipped,
        },
      })
      return updated
    } catch (error: any) {
      fastify.log.error({ err: error }, '[returns/:id/restock] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  /**
   * H.14 — refund publish.
   *
   * Was: flip Return.refundStatus to REFUNDED locally only — operator
   * had to re-issue the refund manually in the channel back office.
   *
   * Now: post the refund to the originating channel (eBay real,
   * Amazon manual-confirm, Shopify/Woo stubbed). On success, persist
   * channelRefundId + channelRefundedAt and mark local REFUNDED. On
   * channel failure, mark refundStatus=CHANNEL_FAILED with the error
   * message but DO NOT mark the row REFUNDED — the operator must
   * resolve before re-trying.
   *
   * Body:
   *   refundCents      — number, the amount in cents to refund. Used
   *                      to set Return.refundCents before publish.
   *   skipChannelPush  — boolean, when true marks local REFUNDED
   *                      without calling the channel. Use when the
   *                      refund was already issued in Seller Central
   *                      and we just need Nexus to reflect that.
   *   reason           — optional override for the channel reason
   *                      enum (passed through to publisher).
   */
  // R5.1 — refund engine cutover.
  //
  // Every /refund call (skip-channel + channel-push + failed)
  // creates a Refund row and a RefundAttempt row. Refund table
  // becomes the source of truth; Return.refund* columns are kept
  // as a write-through cache for fast list rendering. Multi-refund
  // history (partials, retries that finally posted, store-credit
  // alongside cash) all sit on the same Return as separate Refund
  // rows.
  //
  // Body shape:
  //   refundCents      number — amount to refund. Required (or stage
  //                     on Return.refundCents first).
  //   kind             'CASH' | 'STORE_CREDIT' | 'EXCHANGE'.
  //                     Defaults to CASH.
  //   skipChannelPush  true when the operator already refunded in
  //                     the channel back office and just wants
  //                     Nexus to reflect.
  //   reason           channel-reason text override (for eBay's
  //                     `comment` field, etc.).
  fastify.post('/fulfillment/returns/:id/refund', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = (request.body ?? {}) as {
        refundCents?: number
        kind?: 'CASH' | 'STORE_CREDIT' | 'EXCHANGE'
        skipChannelPush?: boolean
        reason?: string
      }

      // Resolve the Return so we know channel + currency.
      const ret = await prisma.return.findUnique({
        where: { id },
        select: { id: true, channel: true, currencyCode: true, refundCents: true },
      })
      if (!ret) return reply.code(404).send({ error: 'Return not found' })

      // Determine the amount: prefer body, fall back to staged
      // Return.refundCents (legacy callers + the inspect-then-
      // refund flow that stages the amount in advance).
      const amountCents = typeof body.refundCents === 'number' && body.refundCents > 0
        ? body.refundCents
        : ret.refundCents
      if (!amountCents || amountCents <= 0) {
        return reply.code(400).send({ error: 'refundCents required (or stage on Return first)' })
      }

      // Stage the cache up-front so the channel publisher (which
      // reads ret.refundCents) sees the amount we intend to issue.
      if (ret.refundCents !== amountCents) {
        await prisma.return.update({
          where: { id },
          data: { refundCents: amountCents },
        })
      }

      // 1) Always create the Refund row (PENDING). This is the
      //    canonical record; channel attempts decorate it.
      const refund = await prisma.refund.create({
        data: {
          returnId: id,
          amountCents,
          currencyCode: ret.currencyCode || 'EUR',
          kind: (body.kind ?? 'CASH') as any,
          reason: body.reason ?? null,
          channel: ret.channel,
          channelStatus: 'PENDING',
          actor: (request.headers['x-user-id'] as string | undefined) ?? null,
        },
      })

      // 2) Skip-channel path: operator already refunded externally.
      //    Mark Refund POSTED with no channelRefundId, project
      //    to Return cache, audit.
      if (body.skipChannelPush) {
        const now = new Date()
        await prisma.refundAttempt.create({
          data: { refundId: refund.id, outcome: 'SKIPPED' },
        })
        await prisma.refund.update({
          where: { id: refund.id },
          data: { channelStatus: 'POSTED', channelPostedAt: now },
        })
        const updated = await prisma.return.update({
          where: { id },
          data: {
            status: 'REFUNDED',
            refundStatus: 'REFUNDED',
            refundedAt: now,
            channelRefundError: null,
            version: { increment: 1 },
          },
        })
        void auditLogService.write({
          ...auditCtx(request),
          entityType: 'Return',
          entityId: id,
          action: 'refund',
          after: {
            status: updated.status,
            refundId: refund.id,
            refundCents: amountCents,
            channelOutcome: 'SKIPPED',
          },
        })
        return { ...updated, refundId: refund.id, channelOutcome: 'SKIPPED' }
      }

      // 3) Channel publish. The publisher returns a structured
      //    outcome and never throws (per its caller contract).
      const t0 = Date.now()
      const { publishRefundToChannel } = await import(
        '../services/refunds/refund-publisher.service.js'
      )
      const publish = await publishRefundToChannel({
        returnId: id,
        reasonText: body.reason,
      })
      const durationMs = Date.now() - t0

      // 4) Record the attempt (OK / OK_MANUAL_REQUIRED /
      //    NOT_IMPLEMENTED / FAILED) regardless of outcome.
      await prisma.refundAttempt.create({
        data: {
          refundId: refund.id,
          outcome: publish.outcome,
          channelRefundId: publish.channelRefundId ?? null,
          errorMessage: publish.error ?? null,
          durationMs,
          rawResponse: {
            outcome: publish.outcome,
            channelRefundId: publish.channelRefundId ?? null,
            channelMessage: publish.channelMessage ?? null,
          } as any,
        },
      })

      // 5) Update the Refund row from the publish result.
      const channelStatus =
        publish.outcome === 'FAILED' ? 'FAILED' :
        publish.outcome === 'NOT_IMPLEMENTED' ? 'NOT_IMPLEMENTED' :
        publish.outcome === 'OK_MANUAL_REQUIRED' ? 'MANUAL_REQUIRED' :
        'POSTED'
      await prisma.refund.update({
        where: { id: refund.id },
        data: {
          channelStatus: channelStatus as any,
          channelRefundId: publish.channelRefundId ?? null,
          channelError: publish.outcome === 'FAILED' ? (publish.error ?? 'Unknown channel error') : null,
          channelPostedAt: publish.outcome === 'OK' ? new Date() : null,
        },
      })

      // 6) FAILED → keep Return.status untouched so the operator
      //    can retry; mark refundStatus=CHANNEL_FAILED and surface
      //    the error.
      if (publish.outcome === 'FAILED') {
        const updated = await prisma.return.update({
          where: { id },
          data: {
            refundStatus: 'CHANNEL_FAILED',
            channelRefundError: publish.error ?? 'Unknown channel error',
            version: { increment: 1 },
          },
        })
        void auditLogService.write({
          ...auditCtx(request),
          entityType: 'Return',
          entityId: id,
          action: 'refund-failed',
          after: {
            refundId: refund.id,
            refundStatus: updated.refundStatus,
            channelError: publish.error,
            channelOutcome: 'FAILED',
          },
        })
        return reply.code(502).send({
          ...updated,
          refundId: refund.id,
          channelOutcome: 'FAILED',
          channelError: publish.error,
        })
      }

      // 7) OK / OK_MANUAL_REQUIRED / NOT_IMPLEMENTED → mark
      //    Return REFUNDED + project Refund channelRefundId to
      //    the cache.
      const updated = await prisma.return.update({
        where: { id },
        data: {
          status: 'REFUNDED',
          refundStatus: 'REFUNDED',
          refundedAt: new Date(),
          channelRefundId: publish.channelRefundId ?? null,
          channelRefundedAt: publish.outcome === 'OK' ? new Date() : null,
          channelRefundError: null,
          version: { increment: 1 },
        },
      })
      void auditLogService.write({
        ...auditCtx(request),
        entityType: 'Return',
        entityId: id,
        action: 'refund',
        after: {
          status: updated.status,
          refundId: refund.id,
          refundCents: amountCents,
          channelOutcome: publish.outcome,
          channelRefundId: publish.channelRefundId,
        },
      })
      return {
        ...updated,
        refundId: refund.id,
        channelOutcome: publish.outcome,
        channelMessage: publish.channelMessage,
        channelRefundId: publish.channelRefundId,
      }
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // Return label workflow — operator-driven for v0. The carrier
  // generates the actual label (Sendcloud dashboard, DHL portal,
  // etc.); operator pastes URL + tracking back here so the label
  // is auditable + customer-shareable + the "did we email it?"
  // status is tracked. Native Sendcloud return-label API
  // integration is the v1 follow-up — same data shape.
  //
  // POST /fulfillment/returns/:id/label
  //   Body: { url, carrier, trackingNumber }
  //   Stamps returnLabelGeneratedAt; does NOT mark emailed.
  //
  // POST /fulfillment/returns/:id/label/mark-emailed
  //   Records returnLabelEmailedAt without sending — assumes the
  //   operator emailed via their own channel (operator's own mail
  //   client). Real send-label-to-customer email is also v1.
  fastify.post<{
    Params: { id: string }
    Body: {
      url?: string
      carrier?: string
      trackingNumber?: string
    }
  }>('/fulfillment/returns/:id/label', async (request, reply) => {
    try {
      const { id } = request.params
      const body = request.body ?? {}
      if (!body.url?.trim()) {
        return reply.code(400).send({ error: 'url required' })
      }
      const updated = await prisma.return.update({
        where: { id },
        data: {
          returnLabelUrl: body.url.trim(),
          returnLabelCarrier: body.carrier?.trim() ?? null,
          returnTrackingNumber: body.trackingNumber?.trim() ?? null,
          returnLabelGeneratedAt: new Date(),
        },
      })
      void auditLogService.write({
        ...auditCtx(request),
        entityType: 'Return',
        entityId: id,
        action: 'attach-label',
        after: {
          carrier: updated.returnLabelCarrier,
          tracking: updated.returnTrackingNumber,
          source: 'operator-paste',
        },
      })
      return reply.send({ success: true, return: updated })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('Record to update not found')) {
        return reply.code(404).send({ error: 'Return not found' })
      }
      fastify.log.error({ err }, '[returns/:id/label] failed')
      return reply.code(500).send({ error: msg })
    }
  })

  fastify.post<{ Params: { id: string } }>(
    '/fulfillment/returns/:id/label/mark-emailed',
    async (request, reply) => {
      try {
        const { id } = request.params
        const updated = await prisma.return.update({
          where: { id },
          data: { returnLabelEmailedAt: new Date() },
        })
        void auditLogService.write({
          ...auditCtx(request),
          entityType: 'Return',
          entityId: id,
          action: 'mark-label-emailed',
          after: { returnLabelEmailedAt: updated.returnLabelEmailedAt },
        })
        return reply.send({ success: true, return: updated })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('Record to update not found')) {
          return reply.code(404).send({ error: 'Return not found' })
        }
        return reply.code(500).send({ error: msg })
      }
    },
  )

  fastify.delete<{ Params: { id: string } }>(
    '/fulfillment/returns/:id/label',
    async (request, reply) => {
      try {
        const { id } = request.params
        const updated = await prisma.return.update({
          where: { id },
          data: {
            returnLabelUrl: null,
            returnLabelCarrier: null,
            returnTrackingNumber: null,
            returnLabelGeneratedAt: null,
            returnLabelEmailedAt: null,
            sendcloudParcelId: null,
          },
        })
        void auditLogService.write({
          ...auditCtx(request),
          entityType: 'Return',
          entityId: id,
          action: 'remove-label',
        })
        return reply.send({ success: true, return: updated })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('Record to update not found')) {
          return reply.code(404).send({ error: 'Return not found' })
        }
        return reply.code(500).send({ error: msg })
      }
    },
  )

  // O.75: native Sendcloud return-label generation. Replaces the
  // operator-pastes-from-Sendcloud-dashboard flow with a one-click
  // call. dryRun-default via NEXUS_ENABLE_SENDCLOUD_REAL — when
  // false the parcel client returns a structurally-identical mock
  // (createParcel handles the branching), so this endpoint runs
  // end-to-end in CI without touching Sendcloud. Real mode requires
  // sandbox/production creds via /carriers/SENDCLOUD/connect.
  //
  // Sendcloud return semantics: the parcel "to" address is the
  // *customer* (whose box we want shipped back); is_return=true
  // tells Sendcloud to swap that with the integration's default
  // sender_address on the printed label so the customer sees a
  // pre-paid label going to our warehouse.
  fastify.post('/fulfillment/returns/:id/generate-label', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const ret = await prisma.return.findUnique({
        where: { id },
        include: {
          order: {
            include: {
              items: {
                include: {
                  product: {
                    select: {
                      sku: true,
                      hsCode: true,
                      countryOfOrigin: true,
                      weightValue: true,
                      weightUnit: true,
                    },
                  },
                },
              },
            },
          },
        },
      })
      if (!ret) return reply.code(404).send({ error: 'Return not found' })
      if (!ret.order) {
        return reply.code(400).send({ error: 'Return has no order — cannot generate label' })
      }
      if (ret.returnLabelUrl) {
        return reply.code(409).send({
          error: 'Label already exists — remove the existing label first',
          code: 'LABEL_EXISTS',
        })
      }

      const sendcloud = await import('../services/sendcloud/index.js')
      let creds
      try {
        creds = await sendcloud.resolveCredentials()
      } catch (e: any) {
        if (e instanceof sendcloud.SendcloudError) {
          return reply.code(e.status).send({ error: e.message, code: e.code })
        }
        throw e
      }

      const order = ret.order
      const ship = order.shippingAddress as any
      const addr = {
        name: order.customerName || 'Customer',
        address: ship?.AddressLine1 ?? ship?.addressLine1 ?? ship?.street ?? '',
        address_2: ship?.AddressLine2 ?? ship?.addressLine2 ?? undefined,
        city: ship?.City ?? ship?.city ?? '',
        postal_code: ship?.PostalCode ?? ship?.postalCode ?? '',
        country: ship?.CountryCode ?? ship?.countryCode ?? ship?.country ?? 'IT',
        country_state: ship?.StateOrRegion ?? ship?.stateOrProvince ?? ship?.state ?? undefined,
        telephone: ship?.Phone ?? ship?.phone ?? undefined,
        email: order.customerEmail || undefined,
      }

      // Weight: aggregate from product master if available, else 1.5kg
      // baseline (same fallback as outbound print-label).
      const summedKg = order.items.reduce((acc, it) => {
        const w = it.product?.weightValue ? Number(it.product.weightValue) : 0
        const factor = it.product?.weightUnit === 'g' ? 0.001 : 1
        return acc + w * factor * it.quantity
      }, 0)
      const weightKg = summedKg > 0 ? summedKg : 1.5

      const totalValue = order.items.reduce(
        (acc, it) => acc + Number(it.price) * it.quantity,
        0,
      )

      try {
        const parcel = await sendcloud.createParcel(creds, {
          ...addr,
          weight: weightKg.toFixed(3),
          order_number: ret.rmaNumber ?? ret.id,
          total_order_value: totalValue.toFixed(2),
          total_order_value_currency: ret.currencyCode ?? 'EUR',
          external_reference: `return-${ret.id}`,
          is_return: true,
          // Customs items only matter for international returns;
          // Sendcloud silently ignores them domestically.
          parcel_items: order.items.map((it) => ({
            description: it.product?.sku ?? it.sku,
            quantity: it.quantity,
            weight: '0.100',
            value: Number(it.price).toFixed(2),
            hs_code: it.product?.hsCode ?? undefined,
            origin_country: it.product?.countryOfOrigin ?? undefined,
            sku: it.sku,
          })),
        })

        const labelUrl = parcel.label?.normal_printer?.[0] ?? null
        if (!labelUrl) {
          return reply.code(502).send({
            error: 'Sendcloud accepted parcel but returned no label URL',
            parcelId: parcel.id,
          })
        }

        const updated = await prisma.return.update({
          where: { id },
          data: {
            returnLabelUrl: labelUrl,
            returnLabelCarrier: 'SENDCLOUD',
            returnTrackingNumber: parcel.tracking_number ?? null,
            returnLabelGeneratedAt: new Date(),
            // R0.3 (B3) — persist parcel id so the Sendcloud webhook
            // can resolve incoming carrier-scan events back to this
            // Return when the customer ships the box.
            sendcloudParcelId: parcel.id != null ? String(parcel.id) : null,
          },
        })
        // Audit trail — fail-open writer so a logging failure never
        // wedges the operator workflow.
        try {
          await prisma.auditLog.create({
            data: {
              entityType: 'Return',
              entityId: id,
              action: 'generate-return-label',
              metadata: {
                carrier: 'SENDCLOUD',
                tracking: parcel.tracking_number,
                parcelId: parcel.id,
                dryRun: process.env.NEXUS_ENABLE_SENDCLOUD_REAL !== 'true',
              } as any,
            },
          })
        } catch (e) {
          fastify.log.warn({ err: e }, '[returns/generate-label] audit write failed')
        }
        return reply.send({
          success: true,
          return: updated,
          dryRun: process.env.NEXUS_ENABLE_SENDCLOUD_REAL !== 'true',
        })
      } catch (e: any) {
        if (e instanceof sendcloud.SendcloudError) {
          return reply.code(e.status).send({ error: e.message, code: e.code })
        }
        throw e
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[returns/:id/generate-label] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // B1 — Scrap stock semantics. The pre-R0.3 code only flipped the
  // status; if items had previously been restocked (operator put
  // them back in inventory then later realized they were defective)
  // those units stayed on the StockLevel and overstated stock. The
  // common path is REQUESTED → INSPECTING → SCRAPPED with no restock
  // step — items never enter our inventory, so no movement is
  // needed (the rare case is what gets fixed here).
  //
  // Post-restock-scrap path (rare): when status was already
  // RESTOCKED when scrap fires, we emit one WRITE_OFF stock movement
  // per item with a negative delta to remove the units from stock.
  // applyStockMovement rejects change=0 so we only emit for the
  // grades that were restockable (NEW/LIKE_NEW/GOOD); damaged grades
  // were never restocked and don't need a write-off here.
  fastify.post('/fulfillment/returns/:id/scrap', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const ret = await prisma.return.findUnique({
        where: { id },
        include: { items: true },
      })
      if (!ret) return reply.code(404).send({ error: 'Return not found' })

      const writeOffs: Array<{ sku: string; qty: number }> = []
      if (ret.status === 'RESTOCKED') {
        const warehouseId =
          ret.restockWarehouseId ??
          (await prisma.warehouse.findFirst({ where: { isDefault: true } }))?.id
        for (const item of ret.items) {
          if (!item.productId) continue
          const grade = item.conditionGrade
          if (grade === 'DAMAGED' || grade === 'UNUSABLE') continue
          await applyStockMovement({
            productId: item.productId,
            warehouseId,
            change: -item.quantity,
            reason: 'WRITE_OFF',
            referenceType: 'Return',
            referenceId: ret.id,
            actor: 'return-scrap-after-restock',
            notes: 'Scrapped after prior restock — removing from stock',
          })
          writeOffs.push({ sku: item.sku, qty: item.quantity })
        }
      }

      const updated = await prisma.return.update({
        where: { id },
        data: { status: 'SCRAPPED', version: { increment: 1 } },
      })
      void auditLogService.write({
        ...auditCtx(request),
        entityType: 'Return',
        entityId: id,
        action: 'scrap',
        before: { status: ret.status },
        after: {
          status: updated.status,
          writeOffs,
          itemCount: ret.items.length,
        },
      })
      return updated
    } catch (error: any) {
      fastify.log.error({ err: error }, '[returns/:id/scrap] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ─── R6.3 — Italian customer comms ──────────────────────────────
  //
  // Two surfaces:
  //   1. GET /returns/:id/modulo-recesso.pdf
  //      Streams an A4 Italian withdrawal form (D.Lgs. 21/2014 +
  //      Direttiva 2011/83/UE) with the order's details pre-filled.
  //      Bilingual IT/EN copy. The drawer renders a "Download
  //      Modulo" button for direct-channel returns (Shopify);
  //      Amazon/eBay don't need it because those marketplaces
  //      enforce withdrawal rights independently.
  //
  //   2. POST /returns/:id/send-email
  //      Body: { kind: 'received' | 'refunded' | 'rejected', locale?: 'it' | 'en', reason? }
  //      Sends a transactional email to the buyer. dryRun by
  //      default (logs to console) until NEXUS_ENABLE_OUTBOUND_-
  //      EMAILS=true + RESEND_API_KEY are set in production.

  fastify.get('/fulfillment/returns/:id/modulo-recesso.pdf', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const ret = await prisma.return.findUnique({
        where: { id },
        include: {
          items: true,
          order: {
            select: {
              channelOrderId: true,
              customerName: true,
              customerEmail: true,
              shippingAddress: true,
              purchaseDate: true,
              deliveredAt: true,
            },
          },
        },
      })
      if (!ret) return reply.code(404).send({ error: 'Return not found' })

      const { buildModuloRecessoPdf } = await import(
        '../services/return-comms/modulo-recesso.service.js'
      )
      const pdf = await buildModuloRecessoPdf({
        rmaNumber: ret.rmaNumber,
        channelOrderId: ret.order?.channelOrderId ?? null,
        customerName: ret.order?.customerName ?? null,
        customerEmail: ret.order?.customerEmail ?? null,
        shippingAddress: (ret.order?.shippingAddress ?? null) as Record<string, unknown> | null,
        items: ret.items.map((it) => ({
          sku: it.sku,
          quantity: it.quantity,
          productName: null,
        })),
        orderDate: ret.order?.purchaseDate ?? null,
        deliveredAt: ret.order?.deliveredAt ?? null,
      })
      const filename = `modulo-recesso-${ret.rmaNumber ?? id.slice(-6)}.pdf`
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(pdf)
    } catch (error: any) {
      fastify.log.error({ err: error }, '[returns/:id/modulo-recesso] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/returns/:id/send-email', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = (request.body ?? {}) as {
        kind?: 'received' | 'refunded' | 'rejected'
        locale?: 'it' | 'en'
        reason?: string
        toOverride?: string
      }
      if (!body.kind || !['received', 'refunded', 'rejected'].includes(body.kind)) {
        return reply.code(400).send({ error: 'kind must be received | refunded | rejected' })
      }
      const ret = await prisma.return.findUnique({
        where: { id },
        include: {
          order: { select: { channelOrderId: true, customerName: true, customerEmail: true } },
        },
      })
      if (!ret) return reply.code(404).send({ error: 'Return not found' })

      const to = body.toOverride?.trim() || ret.order?.customerEmail
      if (!to) return reply.code(400).send({ error: 'Customer email unknown — pass toOverride' })

      // Resolve refund deadline for the receipt-stage copy.
      const { resolveReturnPolicy } = await import(
        '../services/return-policies/resolver.service.js'
      )
      const policy = await resolveReturnPolicy({
        channel: ret.channel,
        marketplace: ret.marketplace,
      })

      const { sendReturnEmail } = await import(
        '../services/return-comms/return-emails.service.js'
      )
      const result = await sendReturnEmail(body.kind, {
        to,
        customerName: ret.order?.customerName ?? null,
        rmaNumber: ret.rmaNumber,
        channelOrderId: ret.order?.channelOrderId ?? null,
        channel: ret.channel,
        refundCents: ret.refundCents,
        currencyCode: ret.currencyCode,
        reason: body.reason ?? ret.reason ?? null,
        refundDeadlineDays: policy.refundDeadlineDays,
        locale: body.locale ?? 'it',
      })

      void auditLogService.write({
        ...auditCtx(request),
        entityType: 'Return',
        entityId: id,
        action: `email-${body.kind}`,
        after: {
          to,
          locale: body.locale ?? 'it',
          provider: result.provider,
          dryRun: result.dryRun,
          ok: result.ok,
        },
      })
      return reply.send(result)
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // R7.2 — predictive risk: per-SKU return-rate scoring with
  // within-productType z-scores. Surfaces SKUs > category mean +
  // 2σ as candidates for PIM content review (wrong size chart,
  // bad photos, defective batch). The analytics page renders the
  // flagged subset; PIM can consume the same endpoint for inline
  // badges (follow-up).
  fastify.get('/fulfillment/returns/risk-scores', async (request, reply) => {
    try {
      const q = request.query as { windowDays?: string }
      const windowDays = q.windowDays ? Math.max(7, Math.min(365, Number(q.windowDays))) : 90
      const { computeReturnRiskScores } = await import(
        '../services/return-policies/risk-scores.service.js'
      )
      const result = await computeReturnRiskScores({ windowDays })
      return reply.send(result)
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // R6.2 — refund-deadline summary. Returns approaching/overdue
  // counts + 5-row preview lists so the workspace KPI strip can
  // render an "Italian compliance: X overdue" tile without a
  // second fetch.
  fastify.get('/fulfillment/returns/refund-deadline-summary', async (_request, reply) => {
    try {
      const { summarizeRefundDeadlines } = await import(
        '../services/return-policies/deadline-tracker.service.js'
      )
      const summary = await summarizeRefundDeadlines()
      return reply.send(summary)
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // R5.3 — manual retry for a failed refund. Bypasses the cron's
  // backoff window when force=true (default) so the operator can
  // try again immediately. Returns the same outcome shape the cron
  // sweep produces; the drawer surfaces channelMessage / error.
  fastify.post('/fulfillment/returns/:id/refund/retry', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = (request.body ?? {}) as { force?: boolean }
      const { retryRefund } = await import('../services/refunds/retry.service.js')
      const result = await retryRefund(id, {
        force: body.force !== false, // default true for manual button
        actor: (request.headers['x-user-id'] as string | undefined) ?? null,
      })
      // SKIPPED outcomes are 200 with the reason — operator UI
      // shows "still in backoff (next at HH:MM)". FAILED returns
      // 502 so the drawer can show a toast. OK and friends are
      // 200.
      if (result.outcome === 'FAILED') {
        return reply.code(502).send(result)
      }
      return reply.send(result)
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // R5.3 — retry status (used by the drawer to render "next retry
  // in 23m" badges + "give up" UI when max attempts reached).
  fastify.get('/fulfillment/returns/:id/refund/retry-status', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const { isRetryReady } = await import('../services/refunds/retry.service.js')
      const decision = await isRetryReady(id)
      return reply.send(decision)
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // R5.2 — refund-adapter status diagnostic.
  //
  // Tells operators which channels' refund button actually posts to
  // the channel vs returns a mock vs forces them to finish in the
  // back office. Surfaced in a settings/diagnostics tab so a
  // mocked-Shopify-refund situation is one click away from the
  // truth, not buried in source. Cheap pure read — no DB hit.
  fastify.get('/fulfillment/returns/refund-channel-status', async (_request, reply) => {
    try {
      const { getRefundChannelAdapterStatus } = await import(
        '../services/refunds/refund-publisher.service.js'
      )
      const items = getRefundChannelAdapterStatus()
      // Group by mode for the UI's "what's real / what's mocked"
      // summary card. Keep the raw list too.
      const byMode = items.reduce<Record<string, number>>((acc, it) => {
        acc[it.mode] = (acc[it.mode] ?? 0) + 1
        return acc
      }, {})
      return reply.send({ items, byMode })
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ─── R6.1 — Return policies CRUD + window resolution ─────────────
  //
  // ReturnPolicy rows drive: 14-day window enforcement (Italian
  // consumer law), refund-deadline tracking (R6.2), restocking-fee
  // math, and auto-approval rules. Seeded by R0.1 with EU defaults
  // for AMAZON / EBAY / SHOPIFY; operators add per-marketplace or
  // per-productType overrides through these endpoints.

  fastify.get('/fulfillment/return-policies', async (_request, reply) => {
    try {
      const items = await prisma.returnPolicy.findMany({
        orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }, { productType: 'asc' }],
      })
      return { items }
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/return-policies', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        channel?: string
        marketplace?: string | null
        productType?: string | null
        windowDays?: number
        refundDeadlineDays?: number
        buyerPaysReturn?: boolean
        restockingFeePct?: number | null
        autoApprove?: boolean
        highValueThresholdCents?: number | null
        notes?: string | null
      }
      if (!body.channel) return reply.code(400).send({ error: 'channel required' })
      const created = await prisma.returnPolicy.create({
        data: {
          channel: body.channel.toUpperCase(),
          marketplace: body.marketplace ?? null,
          productType: body.productType ?? null,
          windowDays: typeof body.windowDays === 'number' ? body.windowDays : 14,
          refundDeadlineDays: typeof body.refundDeadlineDays === 'number' ? body.refundDeadlineDays : 14,
          buyerPaysReturn: !!body.buyerPaysReturn,
          restockingFeePct: body.restockingFeePct ?? null,
          autoApprove: !!body.autoApprove,
          highValueThresholdCents: body.highValueThresholdCents ?? null,
          notes: body.notes ?? null,
        },
      })
      void auditLogService.write({
        ...auditCtx(request),
        entityType: 'ReturnPolicy',
        entityId: created.id,
        action: 'create',
        after: created as any,
      })
      return reply.send(created)
    } catch (error: any) {
      // P2002 = unique-constraint violation on (channel, marketplace, productType)
      if (error?.code === 'P2002') {
        return reply.code(409).send({
          error: 'A policy already exists for that (channel, marketplace, productType) tuple — edit it instead of creating a new one',
        })
      }
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.patch('/fulfillment/return-policies/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = (request.body ?? {}) as Record<string, unknown>
      const allowed = [
        'windowDays', 'refundDeadlineDays', 'buyerPaysReturn',
        'restockingFeePct', 'autoApprove', 'highValueThresholdCents',
        'isActive', 'notes',
      ] as const
      const data: Record<string, unknown> = {}
      for (const k of allowed) if (k in body) data[k] = body[k]
      const updated = await prisma.returnPolicy.update({
        where: { id },
        data,
      })
      void auditLogService.write({
        ...auditCtx(request),
        entityType: 'ReturnPolicy',
        entityId: id,
        action: 'update',
        after: { changedKeys: Object.keys(data) },
      })
      return reply.send(updated)
    } catch (error: any) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('Record to update not found')) {
        return reply.code(404).send({ error: 'Policy not found' })
      }
      return reply.code(500).send({ error: msg })
    }
  })

  fastify.delete('/fulfillment/return-policies/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      // Don't let operators delete the seeded baseline policies —
      // those are the "EU default" anchor; deleting them would
      // make the resolver fall back to the hard-coded baseline,
      // which is not what an operator typing "delete" wants.
      const row = await prisma.returnPolicy.findUnique({
        where: { id },
        select: { id: true, marketplace: true, productType: true },
      })
      if (!row) return reply.code(404).send({ error: 'Policy not found' })
      if (id.startsWith('seed_')) {
        return reply.code(409).send({
          error: 'Seeded baseline policy — toggle isActive instead of deleting',
        })
      }
      await prisma.returnPolicy.delete({ where: { id } })
      void auditLogService.write({
        ...auditCtx(request),
        entityType: 'ReturnPolicy',
        entityId: id,
        action: 'delete',
      })
      return reply.send({ ok: true })
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // Resolution helper exposed for the frontend so the create-return
  // modal can show "this return is 18 days post-delivery — outside
  // 14-day window" before the operator submits.
  fastify.get('/fulfillment/return-policies/resolve', async (request, reply) => {
    try {
      const q = request.query as {
        channel?: string
        marketplace?: string
        productType?: string
        deliveredAt?: string
      }
      if (!q.channel) return reply.code(400).send({ error: 'channel required' })
      const { resolveReturnPolicy, checkReturnWindow } = await import(
        '../services/return-policies/resolver.service.js'
      )
      const policy = await resolveReturnPolicy({
        channel: q.channel,
        marketplace: q.marketplace ?? null,
        productType: q.productType ?? null,
      })
      const window = await checkReturnWindow({
        channel: q.channel,
        marketplace: q.marketplace ?? null,
        productType: q.productType ?? null,
        deliveredAt: q.deliveredAt ? new Date(q.deliveredAt) : null,
      })
      return reply.send({ policy, window })
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // Per-return policy view: drawer shows the matched policy +
  // refund-deadline countdown for the loaded Return.
  fastify.get('/fulfillment/returns/:id/policy', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const ret = await prisma.return.findUnique({
        where: { id },
        include: {
          order: { select: { deliveredAt: true, purchaseDate: true } },
        },
      })
      if (!ret) return reply.code(404).send({ error: 'Return not found' })

      const { checkReturnWindow, checkRefundDeadline } = await import(
        '../services/return-policies/resolver.service.js'
      )
      const window = await checkReturnWindow({
        channel: ret.channel,
        marketplace: ret.marketplace,
        deliveredAt: ret.order?.deliveredAt ?? ret.order?.purchaseDate ?? null,
      })
      const deadline = await checkRefundDeadline({
        channel: ret.channel,
        marketplace: ret.marketplace,
        receivedAt: ret.receivedAt,
      })
      return reply.send({ window, deadline })
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ─── R2.1 — Per-return audit log (drawer activity timeline) ─────
  fastify.get('/fulfillment/returns/:id/audit-log', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const rows = await prisma.auditLog.findMany({
        where: { entityType: 'Return', entityId: id },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true, userId: true, action: true,
          before: true, after: true, metadata: true, createdAt: true,
        },
      })
      return { items: rows }
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ─── R2.2 — Operator notes + per-item PATCH + photo gallery ─────
  fastify.patch<{ Params: { id: string }; Body: { notes?: string | null } }>(
    '/fulfillment/returns/:id',
    async (request, reply) => {
      try {
        const { id } = request.params
        const body = request.body ?? {}
        const updated = await prisma.return.update({
          where: { id },
          data: { notes: body.notes ?? null, version: { increment: 1 } },
        })
        void auditLogService.write({
          ...auditCtx(request),
          entityType: 'Return',
          entityId: id,
          action: 'edit-notes',
          after: { notes: updated.notes },
        })
        return updated
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('Record to update not found')) return reply.code(404).send({ error: 'Return not found' })
        return reply.code(500).send({ error: msg })
      }
    },
  )

  fastify.patch<{
    Params: { id: string; itemId: string }
    Body: {
      notes?: string | null
      conditionGrade?: string | null
      inspectionChecklist?: Record<string, unknown> | null
      disposition?: string | null
      scrapReason?: string | null
    }
  }>('/fulfillment/returns/:id/items/:itemId', async (request, reply) => {
    try {
      const { id, itemId } = request.params
      const body = request.body ?? {}
      const item = await prisma.returnItem.findUnique({ where: { id: itemId }, select: { returnId: true } })
      if (!item) return reply.code(404).send({ error: 'Item not found' })
      if (item.returnId !== id) return reply.code(400).send({ error: 'Item does not belong to this return' })
      const data: Record<string, unknown> = {}
      for (const k of ['notes', 'conditionGrade', 'inspectionChecklist', 'disposition', 'scrapReason'] as const) {
        if (k in body) data[k] = body[k]
      }
      const updated = await prisma.returnItem.update({ where: { id: itemId }, data })
      void auditLogService.write({
        ...auditCtx(request),
        entityType: 'Return',
        entityId: id,
        action: 'edit-item',
        after: { itemId, sku: updated.sku, changedKeys: Object.keys(data) },
      })
      return updated
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/returns/:id/items/:itemId/upload-photo', async (request, reply) => {
    try {
      const { id, itemId } = request.params as { id: string; itemId: string }
      const { isCloudinaryConfigured, uploadBufferToCloudinary } = await import(
        '../services/cloudinary.service.js'
      )
      if (!isCloudinaryConfigured()) {
        return reply.code(503).send({ error: 'Cloudinary not configured (CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET)' })
      }
      const data = await (request as any).file?.()
      if (!data) return reply.code(400).send({ error: 'multipart file required' })
      const buffer = await data.toBuffer()
      if (buffer.length > 10 * 1024 * 1024) return reply.code(413).send({ error: 'file too large (max 10MB)' })
      const item = await prisma.returnItem.findUnique({
        where: { id: itemId },
        select: { id: true, returnId: true, photoUrls: true },
      })
      if (!item) return reply.code(404).send({ error: 'Item not found' })
      if (item.returnId !== id) return reply.code(400).send({ error: 'Item does not belong to this return' })
      if (item.photoUrls.length >= 10) return reply.code(409).send({ error: 'Photo cap reached (10 per item)' })
      const result = await uploadBufferToCloudinary(buffer, { folder: `returns/${id}/items/${itemId}` })
      const updated = await prisma.returnItem.update({
        where: { id: itemId },
        data: { photoUrls: { push: result.url } },
      })
      void auditLogService.write({
        ...auditCtx(request),
        entityType: 'Return', entityId: id, action: 'upload-item-photo',
        after: { itemId, sku: updated.sku, photoCount: updated.photoUrls.length },
      })
      return { ok: true, url: result.url, photoUrls: updated.photoUrls }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[returns/:id/items/:id/upload-photo] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.delete<{ Params: { id: string; itemId: string }; Body: { url: string } }>(
    '/fulfillment/returns/:id/items/:itemId/photos',
    async (request, reply) => {
      try {
        const { id, itemId } = request.params
        const body = request.body ?? ({} as any)
        if (!body.url) return reply.code(400).send({ error: 'url required' })
        const item = await prisma.returnItem.findUnique({
          where: { id: itemId },
          select: { returnId: true, photoUrls: true, sku: true },
        })
        if (!item) return reply.code(404).send({ error: 'Item not found' })
        if (item.returnId !== id) return reply.code(400).send({ error: 'Item does not belong to this return' })
        const next = item.photoUrls.filter((u) => u !== body.url)
        const updated = await prisma.returnItem.update({ where: { id: itemId }, data: { photoUrls: next } })
        void auditLogService.write({
          ...auditCtx(request),
          entityType: 'Return', entityId: id, action: 'remove-item-photo',
          after: { itemId, sku: item.sku, photoCount: updated.photoUrls.length },
        })
        return { ok: true, photoUrls: updated.photoUrls }
      } catch (error: any) {
        return reply.code(500).send({ error: error?.message ?? String(error) })
      }
    },
  )

  // ─── R1.2 — Bulk operations + CSV export ────────────────────────
  type BulkBody = { ids: string[] }

  async function bulkApply(
    request: FastifyRequest,
    body: BulkBody,
    apply: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>,
    auditAction: string,
  ) {
    const ids = Array.isArray(body.ids) ? body.ids.filter((s) => typeof s === 'string') : []
    if (ids.length === 0) return { ok: 0, failed: 0, results: [] as any[] }
    const ctx = auditCtx(request)
    const results: Array<{ id: string; ok: boolean; error?: string }> = []
    for (const id of ids) {
      try {
        const r = await apply(id)
        if (r.ok === true) {
          results.push({ id, ok: true })
          void auditLogService.write({
            ...ctx, entityType: 'Return', entityId: id,
            action: auditAction, metadata: { bulk: true },
          })
        } else {
          results.push({ id, ok: false, error: (r as { ok: false; error: string }).error })
        }
      } catch (e) {
        results.push({ id, ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    }
    return {
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    }
  }

  fastify.post<{ Body: BulkBody }>('/fulfillment/returns/bulk/approve', async (request) =>
    bulkApply(request, request.body, async (id) => {
      const r = await prisma.return.updateMany({
        where: { id, status: 'REQUESTED' },
        data: { status: 'AUTHORIZED', version: { increment: 1 } },
      })
      return r.count > 0 ? { ok: true } : { ok: false, error: 'Not in REQUESTED state' }
    }, 'bulk-approve'),
  )

  fastify.post<{ Body: BulkBody }>('/fulfillment/returns/bulk/deny', async (request) =>
    bulkApply(request, request.body, async (id) => {
      const r = await prisma.return.updateMany({
        where: { id, status: 'REQUESTED' },
        data: { status: 'REJECTED', version: { increment: 1 } },
      })
      return r.count > 0 ? { ok: true } : { ok: false, error: 'Not in REQUESTED state' }
    }, 'bulk-deny'),
  )

  fastify.post<{ Body: BulkBody }>('/fulfillment/returns/bulk/receive', async (request) =>
    bulkApply(request, request.body, async (id) => {
      const r = await prisma.return.updateMany({
        where: { id, status: { in: ['REQUESTED', 'AUTHORIZED', 'IN_TRANSIT'] } },
        data: { status: 'RECEIVED', receivedAt: new Date(), version: { increment: 1 } },
      })
      return r.count > 0 ? { ok: true } : { ok: false, error: 'Already received or not authorized' }
    }, 'bulk-receive'),
  )

  fastify.get('/fulfillment/returns/export.csv', async (request, reply) => {
    const q = request.query as any
    const where: any = {}
    if (q.status && q.status !== 'ALL') where.status = q.status
    if (q.channel) where.channel = q.channel
    if (q.fbaOnly === 'true') where.isFbaReturn = true
    if (q.fbaOnly === 'false') where.isFbaReturn = false
    if (q.refundStatus) where.refundStatus = q.refundStatus
    const search = typeof q.q === 'string' ? q.q.trim() : ''
    if (search) {
      where.OR = [
        { rmaNumber: { contains: search, mode: 'insensitive' } },
        { reason: { contains: search, mode: 'insensitive' } },
        { notes: { contains: search, mode: 'insensitive' } },
        { returnTrackingNumber: { contains: search, mode: 'insensitive' } },
        { channelReturnId: { contains: search, mode: 'insensitive' } },
        { order: { channelOrderId: { contains: search, mode: 'insensitive' } } },
        { order: { customerName: { contains: search, mode: 'insensitive' } } },
      ]
    }
    const rows = await prisma.return.findMany({
      where,
      include: {
        items: true,
        order: { select: { channelOrderId: true, customerName: true, customerEmail: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 10_000,
    })
    const esc = (v: unknown): string => {
      const s = v == null ? '' : String(v)
      if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return `"${s.replace(/"/g, '""')}"`
      }
      return s
    }
    const header = [
      'RMA', 'Order ID', 'Channel Order ID', 'Channel', 'Marketplace',
      'Status', 'Refund Status', 'Refund EUR', 'Currency', 'FBA',
      'Customer Name', 'Customer Email',
      'Reason', 'Items SKUs', 'Item Count',
      'Tracking Number', 'Carrier',
      'Created At', 'Received At', 'Inspected At', 'Refunded At', 'Restocked At',
      'Notes',
    ]
    const lines = [header.join(',')]
    for (const r of rows) {
      const skus = r.items.map((i) => `${i.sku}×${i.quantity}`).join(' | ')
      lines.push([
        esc(r.rmaNumber), esc(r.orderId), esc(r.order?.channelOrderId),
        esc(r.channel), esc(r.marketplace),
        esc(r.status), esc(r.refundStatus),
        esc(r.refundCents != null ? (r.refundCents / 100).toFixed(2) : ''),
        esc(r.currencyCode),
        esc(r.isFbaReturn ? 'true' : 'false'),
        esc(r.order?.customerName), esc(r.order?.customerEmail),
        esc(r.reason), esc(skus),
        esc(r.items.reduce((n, i) => n + i.quantity, 0)),
        esc(r.returnTrackingNumber), esc(r.returnLabelCarrier),
        esc(r.createdAt?.toISOString() ?? ''),
        esc(r.receivedAt?.toISOString() ?? ''),
        esc(r.inspectedAt?.toISOString() ?? ''),
        esc(r.refundedAt?.toISOString() ?? ''),
        esc(r.restockedAt?.toISOString() ?? ''),
        esc(r.notes),
      ].join(','))
    }
    const filename = `returns-export-${new Date().toISOString().slice(0, 10)}.csv`
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(lines.join('\n') + '\n')
  })

  // ─── R5.1 — Refund history (read-only list of Refund rows) ──────
  fastify.get('/fulfillment/returns/:id/refunds', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const refunds = await prisma.refund.findMany({
        where: { returnId: id },
        include: { attempts: { orderBy: { attemptedAt: 'desc' } } },
        orderBy: { createdAt: 'desc' },
      })
      return { items: refunds }
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ─── R4.2 / R4.3 — Channel webhook test endpoints (env-gated) ──
  fastify.post('/fulfillment/returns/ebay/ingest-test', async (request, reply) => {
    if ((process.env.NEXUS_ENV ?? '').toLowerCase() === 'production') {
      return reply.code(404).send({ error: 'Not found' })
    }
    try {
      const { ingestEbayReturn } = await import('../services/ebay-returns/ingest.service.js')
      const out = await ingestEbayReturn(request.body as any)
      return reply.send({ success: true, ...out })
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/returns/ebay/poll-test', async (request, reply) => {
    if ((process.env.NEXUS_ENV ?? '').toLowerCase() === 'production') {
      return reply.code(404).send({ error: 'Not found' })
    }
    try {
      const body = (request.body ?? {}) as { members?: unknown[] }
      const members = Array.isArray(body.members) ? body.members : []
      const fakeFetch: typeof fetch = async () =>
        new Response(JSON.stringify({ members }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      const { pollEbayReturns } = await import('../services/ebay-returns/ingest.service.js')
      const result = await pollEbayReturns({ fetchImpl: fakeFetch })
      return reply.send({ success: true, ...result })
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/returns/amazon/ingest-test', async (request, reply) => {
    if ((process.env.NEXUS_ENV ?? '').toLowerCase() === 'production') {
      return reply.code(404).send({ error: 'Not found' })
    }
    try {
      const body = (request.body ?? {}) as { row?: unknown; isFba?: boolean; marketplace?: string }
      const { ingestAmazonReturnRow } = await import('../services/amazon-returns/ingest.service.js')
      const out = await ingestAmazonReturnRow(body.row as any, {
        isFba: !!body.isFba,
        marketplace: body.marketplace,
      })
      return reply.send({ success: true, ...out })
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/returns/amazon/poll-test', async (request, reply) => {
    if ((process.env.NEXUS_ENV ?? '').toLowerCase() === 'production') {
      return reply.code(404).send({ error: 'Not found' })
    }
    try {
      const body = (request.body ?? {}) as {
        fbmRows?: unknown[]
        fbaRows?: unknown[]
        marketplaceId?: string
      }
      const { pollAmazonReturns } = await import('../services/amazon-returns/ingest.service.js')
      const result = await pollAmazonReturns({
        fbmRows: Array.isArray(body.fbmRows) ? (body.fbmRows as any[]) : undefined,
        fbaRows: Array.isArray(body.fbaRows) ? (body.fbaRows as any[]) : undefined,
        marketplaceId: body.marketplaceId,
      })
      return reply.send({ success: true, ...result })
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })
}

export default returnsRoutes
