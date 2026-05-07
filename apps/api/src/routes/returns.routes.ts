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
      const [last30, prior30, byChannelRows, byReasonRows, fbaCount, totalCount] = await Promise.all([
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
      ])
      // % change vs prior window. null when prior window is 0 to
      // avoid divide-by-zero "+Infinity%" in the UI.
      const trendPct = prior30 > 0 ? ((last30 - prior30) / prior30) * 100 : null
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

  fastify.get('/fulfillment/returns/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const ret = await prisma.return.findUnique({ where: { id }, include: { items: true } })
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

  fastify.post('/fulfillment/returns/:id/inspect', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as {
        items: Array<{ itemId: string; conditionGrade: string; notes?: string }>
        overallCondition?: string
      }
      for (const it of body.items ?? []) {
        await prisma.returnItem.update({
          where: { id: it.itemId },
          data: { conditionGrade: it.conditionGrade as any, notes: it.notes ?? null },
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
  fastify.post('/fulfillment/returns/:id/refund', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = (request.body ?? {}) as {
        refundCents?: number
        skipChannelPush?: boolean
        reason?: string
      }

      // Snapshot refundCents up front so the publisher reads the
      // amount we intend to issue. If the body didn't carry one,
      // leave the existing value (the operator may have set it on
      // an earlier inspect step).
      if (typeof body.refundCents === 'number' && body.refundCents > 0) {
        await prisma.return.update({
          where: { id },
          data: { refundCents: body.refundCents },
        })
      }

      // Skip-channel path: operator already refunded in Seller
      // Central / eBay back office and just wants Nexus to reflect.
      if (body.skipChannelPush) {
        const updated = await prisma.return.update({
          where: { id },
          data: {
            status: 'REFUNDED',
            refundStatus: 'REFUNDED',
            refundedAt: new Date(),
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
            refundCents: updated.refundCents,
            channelOutcome: 'SKIPPED',
          },
        })
        return { ...updated, channelOutcome: 'SKIPPED' }
      }

      const { publishRefundToChannel } = await import(
        '../services/refunds/refund-publisher.service.js'
      )
      const publish = await publishRefundToChannel({
        returnId: id,
        reasonText: body.reason,
      })

      // Channel push failed → record the error, leave the row
      // unmodified status-wise so the operator can retry.
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
            refundStatus: updated.refundStatus,
            channelError: publish.error,
            channelOutcome: 'FAILED',
          },
        })
        return reply.code(502).send({
          ...updated,
          channelOutcome: 'FAILED',
          channelError: publish.error,
        })
      }

      // OK / OK_MANUAL_REQUIRED / NOT_IMPLEMENTED → mark REFUNDED
      // locally. NOT_IMPLEMENTED carries the operator-facing message
      // so the UI can prompt them to finish in the channel back
      // office. OK_MANUAL_REQUIRED (Amazon FBM) is the same shape.
      const updated = await prisma.return.update({
        where: { id },
        data: {
          status: 'REFUNDED',
          refundStatus: 'REFUNDED',
          refundedAt: new Date(),
          channelRefundId: publish.channelRefundId ?? null,
          channelRefundedAt:
            publish.outcome === 'OK' ? new Date() : null,
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
          refundCents: updated.refundCents,
          channelOutcome: publish.outcome,
          channelRefundId: publish.channelRefundId,
        },
      })
      return {
        ...updated,
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
}

export default returnsRoutes
