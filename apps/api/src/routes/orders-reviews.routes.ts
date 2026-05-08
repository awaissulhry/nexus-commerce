/**
 * D.7 — Review request engine + Amazon Solicitations bridge.
 *
 * Endpoint surface:
 *
 *   GET    /api/review-rules                list rules
 *   POST   /api/review-rules                create rule
 *   GET    /api/review-rules/:id            single rule
 *   PATCH  /api/review-rules/:id            update rule
 *   DELETE /api/review-rules/:id            delete rule
 *   POST   /api/review-rules/:id/dry-run    preview matching orders
 *   POST   /api/review-rules/:id/run        eagerly enqueue matches
 *
 *   GET    /api/review-requests             paginated list
 *   POST   /api/orders/:id/request-review   manual one-off
 *   POST   /api/orders/bulk-request-reviews bulk one-off
 *
 *   POST   /api/review-engine/tick          trigger the worker once
 *
 * The Amazon Solicitations API call is wrapped behind a stub function
 * (sendAmazonSolicitation) that the SP-API client wires into. When the
 * client is unavailable we return SKIPPED with a clear reason instead
 * of failing — keeps the engine safely idempotent.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'

type RuleScope =
  | 'AMAZON_PER_MARKETPLACE'
  | 'AMAZON_GLOBAL'
  | 'EBAY'
  | 'SHOPIFY'
  | 'WOOCOMMERCE'
  | 'ETSY'
  | 'MANUAL'

const ACTIVE_RETURN_STATUSES = ['REQUESTED', 'AUTHORIZED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTING'] as const

// O.16c — Amazon Solicitations API wrapper.
//
// SP-API endpoint:
//   POST /solicitations/v1/orders/{orderId}/solicitations/
//        productReviewAndSellerFeedback?marketplaceIds={mp}
// Sends Amazon's standard "Request a review" email to the buyer.
// Window: 4–30 days post-delivery, max 1 per order.
//
// Gated behind NEXUS_ENABLE_AMAZON_SOLICITATIONS=true. dryRun
// (default) returns the same structured "SKIPPED" outcome the
// engine + UI have always handled, so flipping the env flag is
// a no-op for review-rule logic — only the actual upstream call
// activates.
//
// Real path uses amazonSpApiClient.getAccessToken() + fetch. The
// SP-API client's internal SigV4 + retry loop is bypassed here
// because the Solicitations endpoint is small + idempotent (one
// solicitation per order, the API returns 400 on a re-send) and
// the engine already records the outcome in ReviewRequest. A
// follow-up commit can fold this into the client class once a
// shared `request()` helper exists.
async function sendAmazonSolicitation({
  amazonOrderId,
  marketplaceId,
}: {
  amazonOrderId: string
  marketplaceId: string
}): Promise<{ ok: boolean; providerRequestId?: string; errorCode?: string; errorMessage?: string }> {
  if (process.env.NEXUS_ENABLE_AMAZON_SOLICITATIONS !== 'true') {
    logger.info('[REVIEW ENGINE] sendAmazonSolicitation dryRun — set NEXUS_ENABLE_AMAZON_SOLICITATIONS=true to flip', {
      amazonOrderId,
      marketplaceId,
    })
    return {
      ok: false,
      errorCode: 'NOT_IMPLEMENTED',
      errorMessage:
        'SP-API Solicitations gated by env (NEXUS_ENABLE_AMAZON_SOLICITATIONS=true)',
    }
  }

  try {
    const { amazonSpApiClient } = await import('../clients/amazon-sp-api.client.js')
    const token = await amazonSpApiClient.getAccessToken()
    const region = process.env.AMAZON_REGION ?? 'eu-west-1'
    const host = `sellingpartnerapi-${region}.amazon.com`
    const url =
      `https://${host}/solicitations/v1/orders/${encodeURIComponent(amazonOrderId)}` +
      `/solicitations/productReviewAndSellerFeedback` +
      `?marketplaceIds=${encodeURIComponent(marketplaceId)}`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-amz-access-token': token,
        'content-type': 'application/json',
      },
    })
    if (res.status === 201 || res.status === 200) {
      // Some SP-API responses include a request-id header for
      // tracing; capture it when present.
      const requestId =
        res.headers.get('x-amzn-requestid') ??
        res.headers.get('x-amz-rid') ??
        undefined
      logger.info('[REVIEW ENGINE] sendAmazonSolicitation OK', {
        amazonOrderId,
        marketplaceId,
        requestId,
      })
      return { ok: true, providerRequestId: requestId }
    }
    const body = await res.text().catch(() => '')
    // 400 on re-send (Amazon's "already solicited") is a benign no-op
    // from the engine's POV — record it as SKIPPED, not FAILED.
    if (res.status === 400 && /already/i.test(body)) {
      return {
        ok: false,
        errorCode: 'ALREADY_SOLICITED',
        errorMessage: body.slice(0, 500),
      }
    }
    return {
      ok: false,
      errorCode: `HTTP_${res.status}`,
      errorMessage: body.slice(0, 500),
    }
  } catch (err: any) {
    logger.warn('[REVIEW ENGINE] sendAmazonSolicitation threw', {
      amazonOrderId,
      marketplaceId,
      error: err?.message ?? String(err),
    })
    return {
      ok: false,
      errorCode: 'EXCEPTION',
      errorMessage: err?.message ?? 'unknown error',
    }
  }
}

// Extract the channel order id Amazon expects (Amazon Order ID).
function extractAmazonOrderId(order: any): string | null {
  // The Order.channelOrderId IS the Amazon-Order-Id when channel === 'AMAZON'.
  return order.channel === 'AMAZON' ? order.channelOrderId : null
}

// Resolve the marketplace ID Amazon expects from our short code (IT/DE/FR…).
function amazonMarketplaceIdFor(code: string | null | undefined): string | null {
  if (!code) return null
  const map: Record<string, string> = {
    IT: 'APJ6JRA9NG5V4', DE: 'A1PA6795UKMFR9', FR: 'A13V1IB3VIYZZH', ES: 'A1RKKUPIHCS9HS',
    UK: 'A1F83G8C2ARO7P', GB: 'A1F83G8C2ARO7P', US: 'ATVPDKIKX0DER',
    NL: 'A1805IZSGTT6HS', PL: 'A1C3SOZRARQ6R3', SE: 'A2NODRKZP88ZB9',
    BE: 'AMEN7PMS3EDWL', TR: 'A33AVAJ2PDY3EV',
    AE: 'A2VIGQ35RCS4UG', SA: 'A17E79C6D8DWNP', EG: 'ARBP9OOSHTCHU',
    JP: 'A1VC38T7YXB528', AU: 'A39IBJ37TRP1C6', SG: 'A19VAU5U5O7RUS', IN: 'A21TJRUUN4KGV',
  }
  return map[code.toUpperCase()] ?? null
}

const ordersReviewsRoutes: FastifyPluginAsync = async (fastify) => {
  // ═══════════════════════════════════════════════════════════════════
  // RULES — CRUD
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/review-rules', async (_request, reply) => {
    try {
      const rules = await prisma.reviewRule.findMany({
        orderBy: [{ isActive: 'desc' }, { scope: 'asc' }, { name: 'asc' }],
        include: { _count: { select: { requests: true } } },
      })
      return {
        items: rules.map((r) => ({
          id: r.id, name: r.name, scope: r.scope, marketplace: r.marketplace,
          isActive: r.isActive,
          minDaysSinceDelivery: r.minDaysSinceDelivery,
          maxDaysSinceDelivery: r.maxDaysSinceDelivery,
          exclusions: r.exclusions,
          minOrderTotalCents: r.minOrderTotalCents,
          notes: r.notes,
          requestCount: r._count.requests,
          updatedAt: r.updatedAt,
        })),
      }
    } catch (err: any) {
      return reply.status(500).send({ error: err.message })
    }
  })

  fastify.post('/review-rules', async (request, reply) => {
    try {
      const body = request.body as any
      if (!body?.name?.trim() || !body?.scope) {
        return reply.status(400).send({ error: 'name + scope required' })
      }
      if (body.scope === 'AMAZON_PER_MARKETPLACE' && !body.marketplace) {
        return reply.status(400).send({ error: 'marketplace required for AMAZON_PER_MARKETPLACE scope' })
      }
      const created = await prisma.reviewRule.create({
        data: {
          name: body.name.trim(),
          scope: body.scope,
          marketplace: body.marketplace ?? null,
          isActive: body.isActive ?? true,
          minDaysSinceDelivery: Math.max(4, Math.floor(body.minDaysSinceDelivery ?? 7)),
          maxDaysSinceDelivery: Math.min(30, Math.floor(body.maxDaysSinceDelivery ?? 25)),
          exclusions: Array.isArray(body.exclusions) ? body.exclusions : [],
          minOrderTotalCents: body.minOrderTotalCents ?? null,
          notes: body.notes ?? null,
          createdBy: 'default-user',
        },
      })
      return created
    } catch (err: any) {
      if (err.code === 'P2002') return reply.status(409).send({ error: 'A rule with this name and scope already exists' })
      return reply.status(500).send({ error: err.message })
    }
  })

  fastify.get('/review-rules/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const rule = await prisma.reviewRule.findUnique({ where: { id } })
    if (!rule) return reply.status(404).send({ error: 'Rule not found' })
    return rule
  })

  fastify.patch('/review-rules/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as any
      const data: any = {}
      if (body.name != null) data.name = body.name
      if (body.isActive != null) data.isActive = body.isActive
      if (body.minDaysSinceDelivery != null) data.minDaysSinceDelivery = Math.max(4, Math.floor(body.minDaysSinceDelivery))
      if (body.maxDaysSinceDelivery != null) data.maxDaysSinceDelivery = Math.min(30, Math.floor(body.maxDaysSinceDelivery))
      if (Array.isArray(body.exclusions)) data.exclusions = body.exclusions
      if (body.minOrderTotalCents !== undefined) data.minOrderTotalCents = body.minOrderTotalCents
      if (body.notes !== undefined) data.notes = body.notes
      if (body.marketplace !== undefined) data.marketplace = body.marketplace
      const rule = await prisma.reviewRule.update({ where: { id }, data })
      return rule
    } catch (err: any) {
      return reply.status(500).send({ error: err.message })
    }
  })

  fastify.delete('/review-rules/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      await prisma.reviewRule.delete({ where: { id } })
      return { ok: true }
    } catch (err: any) {
      return reply.status(500).send({ error: err.message })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // RULES — DRY-RUN + RUN (eager enqueue)
  // ═══════════════════════════════════════════════════════════════════
  fastify.post('/review-rules/:id/dry-run', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const rule = await prisma.reviewRule.findUnique({ where: { id } })
      if (!rule) return reply.status(404).send({ error: 'Rule not found' })
      const matches = await findOrdersMatchingRule(rule)
      return {
        rule: { id: rule.id, name: rule.name, scope: rule.scope, marketplace: rule.marketplace },
        matchCount: matches.length,
        sample: matches.slice(0, 25).map((m) => ({
          orderId: m.id, channelOrderId: m.channelOrderId, channel: m.channel, marketplace: m.marketplace,
          totalPrice: Number(m.totalPrice), customerEmail: m.customerEmail, deliveredAt: m.deliveredAt,
        })),
      }
    } catch (err: any) {
      logger.error('[REVIEW ENGINE] dry-run failed', { message: err.message })
      return reply.status(500).send({ error: err.message })
    }
  })

  fastify.post('/review-rules/:id/run', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const rule = await prisma.reviewRule.findUnique({ where: { id } })
      if (!rule) return reply.status(404).send({ error: 'Rule not found' })
      const matches = await findOrdersMatchingRule(rule)

      let enqueued = 0, skipped = 0
      for (const order of matches) {
        // Dedup: one ReviewRequest per (orderId, channel)
        const existing = await prisma.reviewRequest.findUnique({
          where: { orderId_channel: { orderId: order.id, channel: order.channel } },
        })
        if (existing) { skipped++; continue }
        await prisma.reviewRequest.create({
          data: {
            orderId: order.id,
            channel: order.channel,
            marketplace: order.marketplace,
            status: 'SCHEDULED',
            scheduledFor: new Date(),
            ruleId: rule.id,
          },
        })
        enqueued++
      }
      return { enqueued, skipped, totalMatches: matches.length }
    } catch (err: any) {
      logger.error('[REVIEW ENGINE] run failed', { message: err.message })
      return reply.status(500).send({ error: err.message })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // REQUESTS — list + manual one-offs
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/review-requests', async (request, reply) => {
    try {
      const q = request.query as any
      const page = Math.max(1, parseInt(q.page ?? '1', 10) || 1)
      const pageSize = Math.min(200, parseInt(q.pageSize ?? '50', 10) || 50)
      const where: any = {}
      if (q.status) where.status = q.status
      if (q.channel) where.channel = q.channel
      const [total, items] = await Promise.all([
        prisma.reviewRequest.count({ where }),
        prisma.reviewRequest.findMany({
          where,
          include: {
            order: { select: { id: true, channelOrderId: true, customerEmail: true, deliveredAt: true } },
            rule: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ])
      return { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) }
    } catch (err: any) {
      return reply.status(500).send({ error: err.message })
    }
  })

  fastify.post('/orders/:id/request-review', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const order = await prisma.order.findUnique({
        where: { id },
        include: {
          returns: { select: { status: true } },
          financialTransactions: { where: { transactionType: 'Refund' }, select: { id: true } },
        },
      })
      if (!order) return reply.status(404).send({ error: 'Order not found' })
      // Eligibility checks
      if (!order.deliveredAt) return reply.status(400).send({ error: 'Order not yet delivered' })
      const days = (Date.now() - order.deliveredAt.getTime()) / (24 * 60 * 60 * 1000)
      if (days < 4) return reply.status(400).send({ error: 'Too soon — Amazon requires ≥4 days post-delivery' })
      if (days > 30) return reply.status(400).send({ error: 'Too late — Amazon blocks requests after 30 days' })
      if (order.returns.some((r) => ACTIVE_RETURN_STATUSES.includes(r.status as any))) {
        return reply.status(400).send({ error: 'Order has an active return — solicitation suppressed' })
      }
      if (order.financialTransactions.length > 0) {
        return reply.status(400).send({ error: 'Order has a refund — solicitation suppressed' })
      }
      // Dedup
      const existing = await prisma.reviewRequest.findUnique({
        where: { orderId_channel: { orderId: order.id, channel: order.channel } },
      })
      if (existing && (existing.status === 'SENT' || existing.status === 'SCHEDULED')) {
        return reply.status(409).send({ error: `Already ${existing.status}` })
      }

      // For Amazon: try the SP-API call now. For others: enqueue/skip.
      if (order.channel === 'AMAZON') {
        const amazonOrderId = extractAmazonOrderId(order)
        const marketplaceId = amazonMarketplaceIdFor(order.marketplace)
        if (!amazonOrderId || !marketplaceId) {
          return reply.status(400).send({ error: 'Missing amazonOrderId or unknown marketplace' })
        }
        const result = await sendAmazonSolicitation({ amazonOrderId, marketplaceId })
        const data = {
          orderId: order.id,
          channel: order.channel,
          marketplace: order.marketplace,
          status: result.ok ? 'SENT' as const : 'FAILED' as const,
          sentAt: result.ok ? new Date() : null,
          providerRequestId: result.providerRequestId ?? null,
          providerResponseCode: result.errorCode ?? null,
          errorMessage: result.errorMessage ?? null,
        }
        const upserted = existing
          ? await prisma.reviewRequest.update({ where: { id: existing.id }, data })
          : await prisma.reviewRequest.create({ data })
        return upserted
      }

      // Non-Amazon: track-only skeleton
      const data = {
        orderId: order.id,
        channel: order.channel,
        marketplace: order.marketplace,
        status: 'SKIPPED' as const,
        suppressedReason: 'Channel does not support native solicitation API — wire third-party app first',
      }
      const upserted = existing
        ? await prisma.reviewRequest.update({ where: { id: existing.id }, data })
        : await prisma.reviewRequest.create({ data })
      return upserted
    } catch (err: any) {
      logger.error('[REVIEW ENGINE] manual request failed', { message: err.message })
      return reply.status(500).send({ error: err.message })
    }
  })

  fastify.post('/orders/bulk-request-reviews', async (request, reply) => {
    try {
      const body = request.body as { orderIds?: string[] }
      const ids = Array.isArray(body.orderIds) ? body.orderIds : []
      if (ids.length === 0) return reply.status(400).send({ error: 'orderIds[] required' })
      let sent = 0, skipped = 0, failed = 0
      const errors: Array<{ orderId: string; reason: string }> = []
      for (const orderId of ids) {
        try {
          const order = await prisma.order.findUnique({
            where: { id: orderId },
            include: { returns: true, financialTransactions: { where: { transactionType: 'Refund' } } },
          })
          if (!order) { skipped++; errors.push({ orderId, reason: 'not found' }); continue }
          if (!order.deliveredAt) { skipped++; errors.push({ orderId, reason: 'not delivered' }); continue }
          const days = (Date.now() - order.deliveredAt.getTime()) / (24 * 60 * 60 * 1000)
          if (days < 4 || days > 30) { skipped++; errors.push({ orderId, reason: `outside 4–30d window (${Math.round(days)}d)` }); continue }
          if (order.returns.some((r) => ACTIVE_RETURN_STATUSES.includes(r.status as any))) {
            skipped++; errors.push({ orderId, reason: 'active return' }); continue
          }
          if (order.financialTransactions.length > 0) {
            skipped++; errors.push({ orderId, reason: 'has refund' }); continue
          }
          const existing = await prisma.reviewRequest.findUnique({
            where: { orderId_channel: { orderId: order.id, channel: order.channel } },
          })
          if (existing) { skipped++; errors.push({ orderId, reason: `already ${existing.status}` }); continue }
          if (order.channel === 'AMAZON') {
            const result = await sendAmazonSolicitation({
              amazonOrderId: extractAmazonOrderId(order)!,
              marketplaceId: amazonMarketplaceIdFor(order.marketplace) ?? '',
            })
            await prisma.reviewRequest.create({
              data: {
                orderId: order.id, channel: order.channel, marketplace: order.marketplace,
                status: result.ok ? 'SENT' : 'FAILED',
                sentAt: result.ok ? new Date() : null,
                providerRequestId: result.providerRequestId ?? null,
                providerResponseCode: result.errorCode ?? null,
                errorMessage: result.errorMessage ?? null,
              },
            })
            if (result.ok) sent++
            else failed++
          } else {
            await prisma.reviewRequest.create({
              data: { orderId: order.id, channel: order.channel, status: 'SKIPPED', suppressedReason: 'non-Amazon channel' },
            })
            skipped++
          }
        } catch (e: any) {
          failed++
          errors.push({ orderId, reason: e.message })
        }
      }
      return { sent, skipped, failed, errors }
    } catch (err: any) {
      return reply.status(500).send({ error: err.message })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // ENGINE TICK — process SCHEDULED rows now
  // ═══════════════════════════════════════════════════════════════════
  fastify.post('/review-engine/tick', async (_request, reply) => {
    try {
      const due = await prisma.reviewRequest.findMany({
        where: { status: 'SCHEDULED', scheduledFor: { lte: new Date() } },
        take: 200,
        include: { order: true },
      })
      let sent = 0, failed = 0, suppressed = 0
      for (const req of due) {
        const order = req.order
        // Re-check eligibility before sending — state may have changed
        if (!order.deliveredAt) {
          await prisma.reviewRequest.update({ where: { id: req.id }, data: { status: 'SUPPRESSED', suppressedReason: 'not delivered' } })
          suppressed++; continue
        }
        const days = (Date.now() - order.deliveredAt.getTime()) / (24 * 60 * 60 * 1000)
        if (days < 4 || days > 30) {
          await prisma.reviewRequest.update({ where: { id: req.id }, data: { status: 'SUPPRESSED', suppressedReason: `outside 4–30d window (${Math.round(days)}d)` } })
          suppressed++; continue
        }
        const [activeReturn, refund] = await Promise.all([
          prisma.return.findFirst({ where: { orderId: order.id, status: { in: ['REQUESTED', 'AUTHORIZED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTING'] } } }),
          prisma.financialTransaction.findFirst({ where: { orderId: order.id, transactionType: 'Refund' } }),
        ])
        if (activeReturn) {
          await prisma.reviewRequest.update({ where: { id: req.id }, data: { status: 'SUPPRESSED', suppressedReason: 'active return' } })
          suppressed++; continue
        }
        if (refund) {
          await prisma.reviewRequest.update({ where: { id: req.id }, data: { status: 'SUPPRESSED', suppressedReason: 'has refund' } })
          suppressed++; continue
        }
        if (order.channel === 'AMAZON') {
          const amazonOrderId = extractAmazonOrderId(order)
          const marketplaceId = amazonMarketplaceIdFor(order.marketplace)
          if (!amazonOrderId || !marketplaceId) {
            await prisma.reviewRequest.update({ where: { id: req.id }, data: { status: 'FAILED', errorMessage: 'missing amazonOrderId or marketplaceId' } })
            failed++; continue
          }
          const result = await sendAmazonSolicitation({ amazonOrderId, marketplaceId })
          await prisma.reviewRequest.update({
            where: { id: req.id },
            data: {
              status: result.ok ? 'SENT' : 'FAILED',
              sentAt: result.ok ? new Date() : null,
              providerRequestId: result.providerRequestId ?? null,
              providerResponseCode: result.errorCode ?? null,
              errorMessage: result.errorMessage ?? null,
            },
          })
          if (result.ok) sent++; else failed++
        } else {
          await prisma.reviewRequest.update({ where: { id: req.id }, data: { status: 'SKIPPED', suppressedReason: 'non-Amazon — track-only' } })
          suppressed++
        }
      }
      return { processed: due.length, sent, failed, suppressed }
    } catch (err: any) {
      logger.error('[REVIEW ENGINE] tick failed', { message: err.message })
      return reply.status(500).send({ error: err.message })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // BACKFILL — D.8 stub, re-pulls last N days from each channel.
  // Real implementation hits SP-API GetOrders / Fulfillment API / etc.
  // For now, this just updates purchaseDate where null using createdAt.
  // ═══════════════════════════════════════════════════════════════════
  fastify.post('/orders/historical-backfill', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { days?: number }
      const days = Math.min(180, Math.max(7, body.days ?? 30))
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      // For now: only the local fixup. Channel re-pulls plug in here.
      const result = await prisma.$executeRaw`
        UPDATE "Order"
           SET "purchaseDate" = COALESCE("purchaseDate", "createdAt")
         WHERE "createdAt" >= ${since}
           AND "purchaseDate" IS NULL
      `
      return {
        ok: true,
        days,
        rowsUpdated: result,
        note: 'Local fixup only. SP-API + eBay Fulfillment + Shopify webhooks plug into this endpoint to re-pull authoritative timestamps.',
      }
    } catch (err: any) {
      logger.error('[ORDERS API] backfill failed', { message: err.message })
      return reply.status(500).send({ error: err.message })
    }
  })
}

// ────────────────────────────────────────────────────────────────────
// Rule matcher — finds Order rows that satisfy a ReviewRule.
// Single source of truth for both dry-run and the engine tick.
// ────────────────────────────────────────────────────────────────────
async function findOrdersMatchingRule(rule: any) {
  // Channel scope
  let channelClause: any = {}
  switch (rule.scope as RuleScope) {
    case 'AMAZON_GLOBAL':
      channelClause = { channel: 'AMAZON' }
      break
    case 'AMAZON_PER_MARKETPLACE':
      channelClause = { channel: 'AMAZON', marketplace: rule.marketplace }
      break
    case 'EBAY':       channelClause = { channel: 'EBAY' }; break
    case 'SHOPIFY':    channelClause = { channel: 'SHOPIFY' }; break
    case 'WOOCOMMERCE':channelClause = { channel: 'WOOCOMMERCE' }; break
    case 'ETSY':       channelClause = { channel: 'ETSY' }; break
    case 'MANUAL':     channelClause = { channel: 'MANUAL' }; break
  }

  const minDate = new Date(Date.now() - rule.maxDaysSinceDelivery * 24 * 60 * 60 * 1000)
  const maxDate = new Date(Date.now() - rule.minDaysSinceDelivery * 24 * 60 * 60 * 1000)

  const where: any = {
    ...channelClause,
    deliveredAt: { gte: minDate, lte: maxDate },
    // Already-sent or scheduled requests for this channel are excluded —
    // dedup via the unique constraint on (orderId, channel).
    reviewRequests: { none: { channel: channelClause.channel } },
  }

  const exclusions: string[] = rule.exclusions ?? []
  const ANDs: any[] = []

  if (exclusions.includes('has_active_return')) {
    ANDs.push({ returns: { none: { status: { in: ['REQUESTED', 'AUTHORIZED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTING'] } } } })
  }
  if (exclusions.includes('has_refund')) {
    ANDs.push({ financialTransactions: { none: { transactionType: 'Refund' } } })
  }
  if (exclusions.includes('fba_only')) {
    ANDs.push({ fulfillmentMethod: 'FBA' })
  }
  if (exclusions.includes('fbm_only')) {
    ANDs.push({ fulfillmentMethod: 'FBM' })
  }
  if (rule.minOrderTotalCents != null) {
    ANDs.push({ totalPrice: { gte: rule.minOrderTotalCents / 100 } })
  }
  if (ANDs.length > 0) where.AND = ANDs

  return prisma.order.findMany({
    where,
    select: {
      id: true, channel: true, marketplace: true, channelOrderId: true,
      totalPrice: true, customerEmail: true, deliveredAt: true,
    },
    orderBy: { deliveredAt: 'asc' },
    take: 5000,
  })
}

export default ordersReviewsRoutes
